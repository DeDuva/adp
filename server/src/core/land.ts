import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { GitBackend } from "./git-backend.js";
import type { Signer } from "./signing.js";
import { proposals } from "../db/schema.js";
import { recordOperation } from "./operations.js";
import { evaluateLandPolicy, type UnmetRequirement } from "./land-policy.js";
import type { LandRequirement } from "./repo-policy.js";
import { findOrgLandContext } from "./org-lookup.js";
import { performMerge, type MergeMethod } from "./merge.js";
import { recordSbomEvidence } from "./sbom.js";

export type ProposalRow = typeof proposals.$inferSelect;

export interface LandDeps {
  db: Db;
  gitBackend: GitBackend;
  instanceFloor: LandRequirement[];
  // SBOM-per-land is opt-in the same way it is at every other call site: a
  // deployment without a signer simply doesn't record one.
  sbom?: { signer: Signer; publicUrl: string };
  // REST has `req.log`, GraphQL has none, and the candidate-set resolver is
  // called from both — so the caller supplies the sink rather than this module
  // reaching for one.
  logError: (message: string, err: unknown) => void;
}

export type LandResult =
  | { ok: true; proposal: ProposalRow; sha: string; baseShaBefore: string }
  | { ok: false; status: 409 | 422; message: string; unmet?: UnmetRequirement[] };

// The land sequence, in one place. Three callers reach a merge — the REST merge
// route, the GraphQL `mergePullRequest` mutation, and (M3) candidate-set
// resolution — and before this they each carried their own copy of the policy
// check, the fast-forward precondition, the TOCTOU re-check, and the
// post-merge bookkeeping. A third copy is how the gate quietly stops matching
// on one path, so the sequence lives here and the callers keep only their own
// error shapes and webhook payloads (which genuinely differ on the wire).
//
// What is deliberately *not* here: speculative merge batching. Land is serial
// (a diverged base is a 409 and the agent
// rebases), and batching stays an M5 item gated on the telemetry M3's
// merge-contention benchmark exists to produce.
export async function landProposal(
  deps: LandDeps,
  repo: { id: string; owner: string; name: string; orgId: string | null },
  proposal: ProposalRow,
  method: MergeMethod,
  actor: { identityId: string; principal: string },
): Promise<LandResult> {
  const { db, gitBackend, instanceFloor } = deps;

  if (proposal.state === "merged") {
    return { ok: false, status: 422, message: "Already merged" };
  }
  if (proposal.state === "closed") {
    return { ok: false, status: 422, message: "Cannot merge a closed proposal" };
  }

  // 5c's second open decision, settled: an ingested proposal is **evaluable and
  // not landable**.
  //
  // A shadow proposal is an ordinary row precisely so that `evaluateLandPolicy`
  // and `undo` can take it — which also makes it one this function could merge.
  // It must not. The branch lives on GitHub, GitHub's own merge button is the
  // thing a companion-mode developer uses, and two writers against one branch is
  // the failure mode mirror mode exists to avoid. So the verdict acts through
  // #234's check run — a thing GitHub already knows how to require — rather than
  // through a second merge authority.
  //
  // The refusal names the reason rather than only refusing, on #145's grounds:
  // a user told only that something is refused goes back to the documentation
  // at the moment the product was about to explain itself.
  if (proposal.upstreamNumber !== null) {
    return {
      ok: false,
      status: 409,
      message:
        `#${proposal.number} is a shadow of an upstream pull request, and ADP does not merge on ` +
        "GitHub's behalf. Merge it there — ADP's verdict is published as the `ADP / policy` check " +
        "run, and requiring that check in branch protection is what makes it binding.",
    };
  }

  // M4-2: one lookup, reused by both evaluateLandPolicy calls below — the org
  // context (kill switch, policy repo) doesn't change within one land attempt.
  const org = await findOrgLandContext(db, repo.orgId);

  const policy = await evaluateLandPolicy(db, gitBackend, instanceFloor, repo, proposal, org);
  if (!policy.allowed) {
    return { ok: false, status: 422, message: "Land policy not satisfied", unmet: policy.unmet };
  }

  const currentBaseSha = await gitBackend.resolveRef(repo.owner, repo.name, proposal.baseRef);
  if (!currentBaseSha) {
    return { ok: false, status: 422, message: `base branch '${proposal.baseRef}' no longer exists` };
  }

  const isFastForward = await gitBackend.isAncestor(repo.owner, repo.name, currentBaseSha, proposal.headSha);
  if (!isFastForward) {
    return {
      ok: false,
      status: 409,
      message: `base '${proposal.baseRef}' has diverged from head '${proposal.headRef}' — not a fast-forward, rebase and retry`,
    };
  }

  // Re-check immediately before the ref CAS. evaluateLandPolicy above and
  // performMerge below aren't one atomic step across git and Postgres, so this
  // narrows the window a superseding gate result could land in to the width of
  // one query rather than the whole request — it does not close it
  // (the TOCTOU item).
  const policyAtCas = await evaluateLandPolicy(db, gitBackend, instanceFloor, repo, proposal, org);
  if (!policyAtCas.allowed) {
    return { ok: false, status: 422, message: "Land policy not satisfied", unmet: policyAtCas.unmet };
  }

  const author = { name: actor.principal, email: `${actor.principal}@adp.local` };
  const result = await performMerge(
    gitBackend,
    {
      owner: repo.owner,
      name: repo.name,
      baseRef: proposal.baseRef,
      headSha: proposal.headSha,
      headRef: proposal.headRef,
      number: proposal.number,
      title: proposal.title,
      body: proposal.body,
    },
    currentBaseSha,
    method,
    author,
  );
  if (!result.ok) {
    return { ok: false, status: result.status, message: result.message };
  }

  const merged = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(proposals)
      .set({ state: "merged", mergedAt: new Date() })
      .where(eq(proposals.id, proposal.id))
      .returning();

    // Quarantine is recorded here — at the one point where it actually took
    // effect, in the same transaction as the land it permitted — rather than
    // inside evaluateLandPolicy, which runs several times per merge and once
    // per candidate during a 50-way fan-out. A gate that quietly stopped
    // mattering is the failure this whole feature must not have, so the log
    // gets exactly one durable record per land that a quarantine allowed.
    for (const gate of policyAtCas.quarantined) {
      await recordOperation(tx, {
        repoId: repo.id,
        actorId: actor.identityId,
        verb: "gate.quarantine",
        target: `${repo.owner}/${repo.name}@${proposal.headSha}#${gate.name}`,
        after: {
          gate: gate.name,
          flakeRate: gate.flakeRate,
          flips: gate.flips,
          distinctShas: gate.distinctShas,
          latestStatus: gate.latestStatus,
          landedProposal: proposal.number,
        },
      });
    }

    await recordOperation(tx, {
      repoId: repo.id,
      actorId: actor.identityId,
      verb: "proposal.merge",
      target: `${repo.owner}/${repo.name}#${proposal.number}`,
      before: { baseSha: currentBaseSha },
      after: { baseSha: result.sha, mergedInto: proposal.baseRef, mergeMethod: method },
    });

    return row!;
  });

  if (deps.sbom) {
    try {
      // Keyed by the PR's head sha, not the resulting merge commit — the same
      // convention every other gate result uses (land-policy.ts's gates_green
      // looks up by proposal.headSha too), since that is the commit whose tree
      // the SBOM actually describes.
      await recordSbomEvidence(
        db,
        gitBackend,
        deps.sbom.signer,
        deps.sbom.publicUrl,
        repo,
        proposal.headSha,
        actor.identityId,
      );
    } catch (err) {
      // Bookkeeping about a merge that already succeeded, same as
      // post-receive's auto-record — logged, never a reason to fail the caller.
      deps.logError(`SBOM generation for ${repo.owner}/${repo.name}@${proposal.headSha} failed`, err);
    }
  }

  return { ok: true, proposal: merged, sha: result.sha, baseShaBefore: currentBaseSha };
}
