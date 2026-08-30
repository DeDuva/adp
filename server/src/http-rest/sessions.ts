import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationErrors } from "./validation-errors.js";
import type { Db } from "../db/client.js";
import type { GitBackend } from "../core/git-backend.js";
import { KeyRegistry, type Signer } from "../core/signing.js";
import { requireScope } from "../auth/plugin.js";
import { findRepoAuthorized } from "../core/repos-lookup.js";
import { checkStorageQuota, storageQuotaMessage } from "../core/storage-usage.js";
import {
  checkCheckpointState,
  checkEventPayloads,
  INGEST_BODY_LIMIT_BYTES,
} from "../core/payload-limits.js";
import { redactEventPayloads } from "../core/trajectory-redaction.js";
import { structureEventPayloads } from "../core/trajectory-structure.js";
import { loadRepoPolicy } from "../core/repo-policy.js";
import {
  appendEvents,
  listEvents,
  serializeEvent,
  EVENT_KINDS,
  EVENT_STATUSES,
  type EventKind,
} from "../core/trajectory.js";
import {
  startSession,
  createCheckpoint,
  resumeSession,
  closeSession,
  listCheckpoints,
  sessionLineage,
  type SessionRow,
  type CheckpointRow,
} from "../core/sessions.js";

const StartSessionBody = z.object({
  // Free-form on purpose: ADP never branches on the value, which is what makes
  // the protocol harness-neutral rather than harness-aware. "claude-code",
  // "openhands", or something that doesn't exist yet are all equally valid.
  harness: z.string().min(1),
  intent_id: z.string().uuid().optional(),
  workspace_id: z.string().uuid().optional(),
  // The orchestrator's run this session belongs to. Optional: a developer
  // checkpointing their own work is still a session, and requiring a run would
  // make the orchestrated case the only supported one.
  run_id: z.string().uuid().optional(),
});

// Batched on purpose. A busy agent emits events far faster than one HTTP round
// trip each, and an emitter that has to choose between recording and going fast
// stops recording — which is the failure this whole table exists to prevent.
const AppendEventsBody = z.object({
  events: z
    .array(
      z.object({
        kind: z.enum(EVENT_KINDS),
        type: z.string().default(""),
        // Opaque to ADP, exactly like `checkpoints.state`.
        payload: z.unknown().default(null),
        status: z.enum(EVENT_STATUSES).optional(),
        model: z.string().optional(),
        tokens_in: z.number().int().nonnegative().optional(),
        tokens_out: z.number().int().nonnegative().optional(),
        cost_micro_usd: z.number().int().nonnegative().optional(),
        duration_ms: z.number().int().nonnegative().optional(),
        git_sha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
        related_session_id: z.string().uuid().optional(),
        client_event_id: z.string().min(1).max(200).optional(),
        // The emitter's own contiguous counter. Set it on every event in the
        // batch or on none — core/trajectory.ts rejects a half-counted batch.
        producer_seq: z.number().int().positive().optional(),
        occurred_at: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(1000),
  producer_id: z.string().min(1).max(200).optional(),
});

const CheckpointBody = z.object({
  git_sha: z.string().regex(/^[0-9a-f]{40}$/),
  harness: z.string().min(1).optional(),
  // Opaque to ADP. Never parsed, never validated beyond "it is JSON" — a
  // harness storing its own format must not need an ADP change to do so.
  state: z.unknown().default(null),
});

const ResumeBody = z.object({
  harness: z.string().min(1),
  checkpoint_id: z.string().uuid().optional().describe("Defaults to the session's latest checkpoint"),
});

function serializeSession(row: SessionRow) {
  return {
    id: row.id,
    harness: row.harness,
    intent_id: row.intentId,
    run_id: row.runId,
    workspace_id: row.workspaceId,
    status: row.status,
    resumed_from_session_id: row.resumedFromSessionId,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function serializeCheckpoint(row: CheckpointRow) {
  return {
    id: row.id,
    session_id: row.sessionId,
    seq: row.seq,
    git_sha: row.gitSha,
    harness: row.harness,
    state: row.state,
    // The envelope is the evidence, not a projection of it — returned whole so
    // a caller can verify a checkpoint without trusting this server's summary
    // of it, same as the evidence bundle does for gate results.
    envelope: row.envelope,
    created_at: row.createdAt.toISOString(),
  };
}

// M3 (D2): session state as a first-class ADP
// object, so a task started under one harness can be resumed under another with
// one continuous signed history.
//
// Native plane only — there is no GitHub analogue, and per A18 sessions hang off
// `operations` and `changes` rather than off `proposal`, which is a compat-plane
// shape that may erode.
export function registerSessionRoutes(
  app: FastifyInstance,
  db: Db,
  gitBackend: GitBackend,
  signer: Signer,
  publicUrl: string,
  // #102: resume verifies checkpoint envelopes through the registry, so a
  // checkpoint signed before a key rotation stays resumable after it.
  keyRegistry: KeyRegistry = new KeyRegistry(signer),
) {
  app.post(
    "/api/adp/repos/:owner/:repo/sessions",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName } = req.params as { owner: string; repo: string };
      const parsed = StartSessionBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const result = await startSession(
        db,
        { id: repo.id, owner, name: repoName },
        {
          harness: parsed.data.harness,
          intentId: parsed.data.intent_id,
          workspaceId: parsed.data.workspace_id,
          runId: parsed.data.run_id,
        },
        req.identity!.identityId,
      );
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.code(201).send(serializeSession(result.session));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/sessions/:id",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const lineage = await sessionLineage(db, repo.id, id);
      if (lineage.length === 0) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }

      const session = lineage[lineage.length - 1]!;
      reply.send({
        ...serializeSession(session),
        // The whole chain back to the session that started the work, so a
        // caller never has to walk resumed_from_session_id by hand to answer
        // "where did this come from".
        lineage: lineage.map(serializeSession),
        checkpoints: (await listCheckpoints(db, session.id)).map(serializeCheckpoint),
      });
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/sessions/:id/checkpoints",
    // #146: above Fastify's 1 MiB default so the typed refusal below is what a
    // producer meets, rather than a bare 413 from the transport naming nothing.
    { preHandler: requireScope("repo:write"), bodyLimit: INGEST_BODY_LIMIT_BYTES },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const parsed = CheckpointBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      // #146: before the quota read and before anything is written. Refused,
      // not truncated — a truncated payload that is still hash-chained is
      // worse than a rejected one, because it is a durable record that looks
      // complete.
      const stateSize = checkCheckpointState(parsed.data.state);
      if (!stateSize.ok) {
        reply.code(422).send({ message: "Validation failed", errors: stateSize.errors });
        return;
      }
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      // M4-3: `state` is `z.unknown()` and checkpoints are the largest single
      // row this schema writes, so this is one of the two paths the storage
      // ceiling exists for.
      const cpQuota = await checkStorageQuota(db, repo.orgId);
      if (!cpQuota.ok) {
        reply.code(403).send({ message: storageQuotaMessage(cpQuota) });
        return;
      }

      const result = await createCheckpoint(
        db,
        gitBackend,
        signer,
        publicUrl,
        { id: repo.id, owner, name: repoName },
        id,
        { gitSha: parsed.data.git_sha, harness: parsed.data.harness, state: parsed.data.state },
        req.identity!.identityId,
      );
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.code(201).send(serializeCheckpoint(result.checkpoint));
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/sessions/:id/checkpoints",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const lineage = await sessionLineage(db, repo.id, id);
      if (lineage.length === 0) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }
      // #97: bounded. Checkpoints are ordered by seq, so the "cursor" is
      // simply the last seq seen — exposed as plain query params rather than
      // the opaque created_at cursor other native lists use.
      const { limit, after_seq } = z
        .object({
          limit: z.coerce.number().int().positive().max(200).default(50),
          after_seq: z.coerce.number().int().nonnegative().default(0),
        })
        .parse(req.query ?? {});
      const checkpointRows = (await listCheckpoints(db, id)).filter((c) => c.seq > after_seq).slice(0, limit);
      reply.send(checkpointRows.map(serializeCheckpoint));
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/sessions/:id/resume",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const parsed = ResumeBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }

      const result = await resumeSession(
        db,
        gitBackend,
        signer,
        { id: repo.id, owner, name: repoName, orgId: repo.orgId },
        id,
        { harness: parsed.data.harness, checkpointId: parsed.data.checkpoint_id },
        req.identity!.identityId,
        keyRegistry,
      );
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }

      reply.code(201).send({
        ...serializeSession(result.session),
        resumed_from: {
          session_id: result.previousSessionId,
          checkpoint_id: result.checkpoint.id,
          git_sha: result.checkpoint.gitSha,
          harness: result.checkpoint.harness,
        },
        workspace: { id: result.workspace.id, branch: result.workspace.branch },
      });
    },
  );

  app.post(
    "/api/adp/repos/:owner/:repo/sessions/:id/close",
    { preHandler: requireScope("repo:write") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const result = await closeSession(db, { id: repo.id, owner, name: repoName }, id, req.identity!.identityId);
      if (!result.ok) {
        reply.code(result.status).send({ message: result.message });
        return;
      }
      reply.send(serializeSession(result.session));
    },
  );

  // The trajectory append path: every message, model call, tool execution,
  // handoff, commit, and test result, hash-chained in order (core/trajectory.ts).
  app.post(
    "/api/adp/repos/:owner/:repo/sessions/:id/events",
    // #146: see the checkpoint route — the typed refusal has to be reachable.
    { preHandler: requireScope("repo:write"), bodyLimit: INGEST_BODY_LIMIT_BYTES },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const parsed = AppendEventsBody.safeParse(req.body);
      if (!parsed.success) {
        reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
        return;
      }
      // #146: the batch is checked as a batch and refused as a batch, before
      // any of it is chained — appendEvents is all-or-nothing by design, and a
      // refusal that let the earlier events through would leave a chain the
      // producer cannot reason about.
      const payloadSize = checkEventPayloads(parsed.data.events);
      if (!payloadSize.ok) {
        reply.code(422).send({ message: "Validation failed", errors: payloadSize.errors });
        return;
      }

      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      // M4-3: the dominant source of growth the storage analysis measured, and
      // therefore the path a byte ceiling has to cover or it covers nothing.
      // Refused before the append rather than after, so a batch that would
      // cross the ceiling leaves the chain untouched — a partially-appended
      // batch is exactly what appendEvents' own all-or-nothing rule exists to
      // prevent.
      const eventQuota = await checkStorageQuota(db, repo.orgId);
      if (!eventQuota.ok) {
        reply.code(403).send({ message: storageQuotaMessage(eventQuota) });
        return;
      }

      // #148: the secret detector, at the second path by which untrusted text
      // enters the system. Push protection guards the diff; a trajectory
      // records what the agent *read*, so a `.env` it opened and correctly
      // declined to commit never reaches a diff and would land here verbatim.
      //
      // Before the chain, never after: what gets hashed has to be what gets
      // stored, or the redaction is an edit to a record that already vouched
      // for the original.
      //
      // One `adp.yaml` read per *batch*, not per event — this endpoint is
      // batched precisely because an emitter that has to choose between
      // recording and going fast stops recording, and a git read amortised
      // over up to 1000 events does not change that arithmetic.
      const repoPolicy = await loadRepoPolicy(gitBackend, owner, repoName, repo.defaultBranch);
      const scanned = redactEventPayloads(parsed.data.events);
      if (scanned.redactions.length > 0 && repoPolicy.trajectory.on_secret === "refuse") {
        reply.code(422).send({
          message: "Trajectory rejected: a secret was detected and this repository's adp.yaml sets trajectory.on_secret: refuse",
          errors: scanned.redactions.map((r) => ({
            path: ["events", r.index, ...r.path.replace(/^\$\.?/, "").split(/[.[\]]+/).filter(Boolean)],
            message: `${r.pattern} detected; the batch was refused rather than redacted, per adp.yaml`,
            code: "secret_detected",
          })),
        });
        return;
      }
      // #199: what is stored when the detector fired on *nothing*, which is
      // the larger surface — source no pattern covers, customer data in a tool
      // result, a prompt a human typed. The default is `structure`: the
      // payload's shape is kept and its string content is replaced by a marker
      // naming how many bytes were there, with a digest of what was supplied
      // recorded beside the event. A repo opts into `full` when it has read
      // what a trajectory holds and wants all of it.
      //
      // After redaction, never before. The digest has to name what `full`
      // would have stored, and under `on_secret: redact` that is the redacted
      // text — a digest over the original would be a durable commitment to the
      // secret #148 exists to keep out of this table.
      let structured: { events: typeof scanned.events; digests: (string | null)[] } = {
        events: scanned.events,
        digests: scanned.events.map(() => null),
      };
      if (repoPolicy.trajectory.payloads === "structure") {
        structured = structureEventPayloads(scanned.events);

        // #146's ceiling, re-checked on the form that will actually be stored.
        // The projection is nearly always far smaller than what arrived, but
        // it is not smaller for a payload built from thousands of very short
        // strings, where a ~19-byte marker replaces a 3-byte one. That is rare
        // and it is not impossible, and "no stored event exceeds the ceiling"
        // has to hold unconditionally or #146 bounds nothing. Only here: under
        // `full` the check above already measured what will be stored.
        const storedSize = checkEventPayloads(structured.events);
        if (!storedSize.ok) {
          reply.code(422).send({
            // Named as the stored form, because the producer's own bytes were
            // under the ceiling and a refusal it cannot account for is one it
            // cannot act on.
            message:
              "Validation failed: under this repository's trajectory.payloads: structure, " +
              "the stored form of this batch exceeds the payload ceiling",
            errors: storedSize.errors,
          });
          return;
        }
      }
      const events = structured.events;

      const result = await appendEvents(
        db,
        repo.id,
        id,
        events.map((e, index) => ({
          kind: e.kind,
          type: e.type,
          payload: e.payload,
          redactions: scanned.redactions
            .filter((r) => r.index === index)
            .map((r) => ({ path: r.path, pattern: r.pattern })),
          payloadDigest: structured.digests[index] ?? null,
          status: e.status ?? null,
          model: e.model ?? null,
          tokensIn: e.tokens_in ?? null,
          tokensOut: e.tokens_out ?? null,
          costMicroUsd: e.cost_micro_usd ?? null,
          durationMs: e.duration_ms ?? null,
          gitSha: e.git_sha ?? null,
          relatedSessionId: e.related_session_id ?? null,
          clientEventId: e.client_event_id ?? null,
          producerSeq: e.producer_seq ?? null,
          occurredAt: e.occurred_at ? new Date(e.occurred_at) : undefined,
        })),
        { producerId: parsed.data.producer_id ?? null },
      );
      if (!result.ok) {
        reply.code(result.status).send({
          message: result.message,
          // Present only on a contiguity rejection: where the emitter's spool
          // should replay from.
          ...(result.expectedNextSeq !== undefined ? { expected_next_seq: result.expectedNextSeq } : {}),
        });
        return;
      }

      reply.code(201).send({
        session_id: id,
        appended: result.appended.length,
        // Reported, not swallowed: an emitter re-sending a batch it already
        // landed has a bug, and silence would let it stay one.
        duplicates: result.duplicates,
        count: result.count,
        head: result.head,
        // The mark an emitter trims its spool against; null when untracked.
        accepted_through: result.acceptedThrough,
        events: result.appended.map(serializeEvent),
      });
    },
  );

  app.get(
    "/api/adp/repos/:owner/:repo/sessions/:id/events",
    { preHandler: requireScope("repo:read") },
    async (req, reply) => {
      const { owner, repo: repoName, id } = req.params as { owner: string; repo: string; id: string };
      const query = req.query as { kinds?: string; since?: string; limit?: string };
      const repo = await findRepoAuthorized(db, req.identity!, owner, repoName);
      if (!repo) {
        reply.code(404).send({ message: `Repository ${owner}/${repoName} not found` });
        return;
      }
      const lineage = await sessionLineage(db, repo.id, id);
      if (lineage.length === 0) {
        reply.code(404).send({ message: "Not Found" });
        return;
      }

      const kinds = query.kinds
        ?.split(",")
        .filter((k): k is EventKind => (EVENT_KINDS as readonly string[]).includes(k));
      const events = await listEvents(db, id, {
        kinds: kinds && kinds.length > 0 ? kinds : undefined,
        since: query.since !== undefined ? Number(query.since) : undefined,
        limit: Number(query.limit ?? 500) || 500,
      });
      reply.send({ session_id: id, events: events.map(serializeEvent) });
    },
  );
}
