import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validationErrors } from "./validation-errors.js";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { identities } from "../db/schema.js";
import { requireScope } from "../auth/plugin.js";
import { mintToken } from "../auth/tokens.js";
import { recordOperation } from "../core/operations.js";

// #90 (audit §P0-4): the first REST path that can mint a token at all.
// Before this, the only mint was bootstrap.ts — which always mints
// ["repo:read","repo:write","admin"] — so a real deployment had no way to
// hand its runner anything *but* an admin token, and the runner's whole
// least-privilege design (runner/src/config.test.ts) was undeliverable.
//
// The scope set is bounded on purpose: "admin" is not in the enum, so this
// route can never escalate or multiply admins. Creating an admin stays a
// host-level operator action (bootstrap.ts, at the box, with DATABASE_URL),
// which is the same trust level the first admin needed anyway.
const MintTokenBody = z.object({
  // The identity the token authenticates as — found by principal, created
  // (default kind "agent": runners and harnesses are the expected callers'
  // targets) when unseen.
  principal: z.string().min(1),
  kind: z.enum(["human", "agent"]).default("agent"),
  scopes: z.array(z.enum(["repo:read", "repo:write", "runner"])).nonempty(),
  expires_at: z.string().datetime({ offset: true }).optional(),
  // #141: the three provenance fields. The columns, mintToken(), the
  // authenticate() reader and provenanceOf() (http-rest/changes.ts) all
  // carried these already; this route accepted none of them, so every token
  // in existence held null for all three and every signed change omitted the
  // fields that make its provenance worth having.
  //
  // The grain question, answered here so the next reader does not collapse
  // the two: `model` on a *token* says which model the integration this
  // credential belongs to is built around — "this is the Codex integration's
  // token". It is not a claim about which model produced any particular
  // attempt, because a harness can switch models mid-session and the token
  // outlives the switch. That claim belongs on `runs.labels`, per attempt.
  // Both, not either: the token answers "whose credential is this", the run
  // answers "what actually ran".
  harness: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
  session_id: z.string().min(1).max(200).optional(),
});

export function registerTokenRoutes(app: FastifyInstance, db: Db) {
  app.post("/api/adp/tokens", { preHandler: requireScope("admin") }, async (req, reply) => {
    const parsed = MintTokenBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(422).send({ message: "Validation failed", errors: validationErrors(parsed.error) });
      return;
    }
    const { principal, kind, scopes, expires_at, harness, model, session_id } = parsed.data;

    // Org-scoped by construction: the minted token carries the *caller's*
    // org, not one named in the request — an org-scoped admin can only mint
    // within their own org, and there is no parameter with which to reach
    // for another one. An instance-level bootstrap token (orgId null) mints
    // instance-wide, which is the operator case.
    const orgId = req.identity!.orgId;

    const [existing] = await db.select({ id: identities.id }).from(identities).where(eq(identities.principal, principal));
    const identityId =
      existing?.id ??
      (await db.insert(identities).values({ kind, principal }).returning({ id: identities.id }))[0]!.id;

    // The op-log row records that a credential was created, for whom, by
    // whom, with what scopes — never the token itself, which exists only in
    // this one response. repoId null: like org.kill_switch, this is not
    // about one repo.
    const token = await db.transaction(async (tx) => {
      const token = await mintToken(tx, identityId, [...scopes], {
        orgId: orgId ?? undefined,
        expiresAt: expires_at ? new Date(expires_at) : undefined,
        harness,
        model,
        sessionId: session_id,
      });
      await recordOperation(tx, {
        repoId: null,
        orgId,
        actorId: req.identity!.identityId,
        verb: "token.mint",
        target: principal,
        after: {
          identity_id: identityId,
          scopes: [...scopes],
          org_id: orgId,
          harness: harness ?? null,
          model: model ?? null,
          session_id: session_id ?? null,
        },
      });
      return token;
    });

    reply.code(201).send({
      token,
      identity_id: identityId,
      principal,
      scopes,
      org_id: orgId,
      expires_at: expires_at ?? null,
      // Echoed back so a caller can confirm what it was issued rather than
      // minting blind: these are unreadable afterwards except by using the
      // token, and a typo in `harness` is otherwise invisible until a signed
      // change carries the wrong one.
      harness: harness ?? null,
      model: model ?? null,
      session_id: session_id ?? null,
    });
  });
}
