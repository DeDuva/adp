import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { intents, issues } from "../db/schema.js";
import { recordOperation } from "./operations.js";

// Ingest for a mirrored repo's upstream issues — the other half of "what was
// this for", beside core/pull-request-ingest.ts.
//
// The gap this closes is narrower than it looks and matters more. `intents`
// already had `source: "issue"`, so ADP knew an intent had come from an issue
// and could not say *which* issue, on whose host. A team organising its work in
// GitHub Issues therefore got an ADP intent universe beside theirs rather than
// under it, and nothing could join the two except by comparing titles.
//
// Two rows are written, exactly as the native create path writes two
// (http-rest/issues.ts): an `intents` row, which is the thing a change's
// provenance links back to and the thing the evidence bundle names by title,
// and an `issues` row, which is the compat projection and — more importantly —
// what makes a commit trailer bind. `resolveTrailers` in core/change-recorder.ts
// resolves `ADP-Intent: #92` by looking up issue 92 in this repository and
// taking its intent. In companion mode #92 is a GitHub issue number, so
// without the issue row the trailer a developer actually writes resolves to
// nothing.

export interface IssuePayload {
  action?: string;
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    state?: string;
    html_url?: string;
    closed_at?: string | null;
    /** Present on a pull request delivered over the `issues` event; skipped. */
    pull_request?: unknown;
  };
  repository?: { html_url?: string };
}

const HANDLED_ACTIONS = new Set(["opened", "reopened", "edited", "closed"]);

export interface IssueIngestResult {
  recorded: boolean;
  reason?: string;
  number?: number;
  change?: "created" | "updated";
  intentId?: string;
}

// The host an upstream reference belongs to. Taken from the issue's own URL
// rather than from a configured value, because the URL is what the delivery
// actually asserts — an instance whose mirror points at GitHub Enterprise gets
// that hostname without anyone having configured a second thing that could
// disagree with the first.
export function upstreamHostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Ingest one `issues` delivery as an intent with an upstream identity, plus the
 * issue row that makes a commit trailer naming its number resolve.
 *
 * `actorId` is the mirror's system identity — `issues.authorId` is a hard
 * foreign key and the person who filed it upstream has no identity row here.
 * #230 is where that stops being true.
 */
export async function ingestIssue(
  db: Db,
  repo: { id: string; owner: string; name: string },
  actorId: string,
  payload: IssuePayload,
): Promise<IssueIngestResult> {
  const issue = payload.issue;
  if (!payload.action || !HANDLED_ACTIONS.has(payload.action)) {
    return { recorded: false, reason: `ignored action '${payload.action ?? "(none)"}'` };
  }
  if (!issue?.number || !issue.title) {
    return { recorded: false, reason: "malformed issue payload" };
  }
  if (issue.pull_request) {
    // GitHub delivers `issues` events for pull requests too, because upstream
    // they are the same object. Here they are not: a pull request is a
    // proposal (#224), and ingesting it a second time as an issue would give
    // one piece of work two intents and put an issue row on a number a
    // proposal already holds.
    return { recorded: false, reason: "pull request delivered as an issue — handled by pull_request ingest" };
  }

  const number = issue.number;
  const title = issue.title;
  const body = issue.body ?? "";
  const state = issue.state === "closed" ? "closed" : "open";
  const closedAt = state === "closed" ? (issue.closed_at ? new Date(issue.closed_at) : new Date()) : null;
  const url = issue.html_url ?? null;
  const host = upstreamHostOf(url) ?? upstreamHostOf(payload.repository?.html_url);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(issues)
      .where(and(eq(issues.repoId, repo.id), eq(issues.number, number)))
      .for("update");

    if (existing) {
      const [intent] = existing.intentId
        ? await tx.select().from(intents).where(eq(intents.id, existing.intentId))
        : [];
      if (intent && intent.upstreamNumber === null) {
        return {
          recorded: false,
          number,
          reason:
            `#${number} in this repository is a natively filed issue, not a shadow of ` +
            `upstream #${number} — refusing to overwrite it`,
        };
      }

      const issueNext: Partial<typeof issues.$inferSelect> = {};
      if (existing.title !== title) issueNext.title = title;
      if (existing.body !== body) issueNext.body = body;
      if (existing.state !== state) issueNext.state = state;
      if ((existing.closedAt?.getTime() ?? null) !== (closedAt?.getTime() ?? null)) issueNext.closedAt = closedAt;

      // The intent tracks the issue's title and body and nothing else. State
      // is deliberately not mirrored onto it: an intent has no state column,
      // because "what was wanted" does not stop being true when the issue
      // asking for it is closed.
      const intentNext: Partial<typeof intents.$inferSelect> = {};
      if (intent) {
        if (intent.title !== title) intentNext.title = title;
        if (intent.body !== body) intentNext.body = body;
        if (intent.upstreamUrl !== url) intentNext.upstreamUrl = url;
      }

      if (Object.keys(issueNext).length === 0 && Object.keys(intentNext).length === 0) {
        return { recorded: false, number, reason: "no change", intentId: intent?.id };
      }

      if (Object.keys(issueNext).length > 0) {
        await tx.update(issues).set(issueNext).where(eq(issues.id, existing.id));
      }
      if (intent && Object.keys(intentNext).length > 0) {
        await tx.update(intents).set(intentNext).where(eq(intents.id, intent.id));
      }

      const verb =
        issueNext.state === "closed" ? "issue.close" : issueNext.state === "open" ? "issue.reopen" : "issue.update";
      await recordOperation(tx, {
        repoId: repo.id,
        actorId,
        verb,
        target: `${repo.owner}/${repo.name}#${number}`,
        before: { title: existing.title, state: existing.state },
        after: { id: existing.id, ...issueNext, via: "mirror-inbound", action: payload.action },
      });
      return { recorded: true, number, change: "updated", intentId: intent?.id };
    }

    // Every issue is intent from the moment it is filed — the same sentence
    // the native create path is written under, and the reason this ingests as
    // two rows rather than one.
    const [intent] = await tx
      .insert(intents)
      .values({
        repoId: repo.id,
        title,
        body,
        source: "issue",
        upstreamHost: host,
        upstreamNumber: number,
        upstreamUrl: url,
      })
      .onConflictDoNothing()
      .returning();

    if (!intent) {
      return { recorded: false, number, reason: "concurrent delivery already ingested this issue" };
    }

    const [row] = await tx
      .insert(issues)
      .values({
        repoId: repo.id,
        number,
        title,
        body,
        state,
        closedAt,
        authorId: actorId,
        intentId: intent.id,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) {
      // The issue number is taken but the intent insert did not conflict,
      // which means the number belongs to something that is not a shadow of
      // this issue. Rolling back is the only safe answer: leaving the intent
      // behind would produce an intent nothing can reach through a trailer.
      throw new Error(`issue #${number} already exists in ${repo.owner}/${repo.name} and is not a shadow of it`);
    }

    await recordOperation(tx, {
      repoId: repo.id,
      actorId,
      verb: "issue.create",
      target: `${repo.owner}/${repo.name}#${number}`,
      after: {
        id: row.id,
        title,
        state,
        intentId: intent.id,
        via: "mirror-inbound",
        upstreamHost: host,
        upstreamUrl: url,
      },
    });

    return { recorded: true, number, change: "created", intentId: intent.id };
  });
}

/**
 * The refusal a native issue-create gets on an ingesting repository.
 *
 * The same shape and the same grounds as #224's proposal refusal: a shadow
 * issue adopts the upstream number, `issues` is unique on `(repo_id, number)`,
 * and a natively filed issue on an ingesting repository is a collision waiting
 * for upstream to reach the same number.
 *
 * It is worth noting what this incidentally fixes. ADP numbers issues and
 * proposals from two independent sequences, which schema.ts records as a
 * deliberate fidelity gap against GitHub's single shared one. On an ingesting
 * repository the gap closes for free: both numbers come from upstream, and
 * upstream never issues the same one twice.
 */
export function nativeIssueRefusal(owner: string, repoName: string) {
  return {
    message: `${owner}/${repoName} takes its issues from its upstream mirror, so an issue cannot be filed here`,
    reason: "issue_ingest_enabled",
    remedy:
      "file the issue on GitHub — it is ingested as an intent with the same number, which is what " +
      "lets a commit trailer naming that number bind to it. Disable the mirror first if this " +
      "repository should own its own issues.",
  };
}
