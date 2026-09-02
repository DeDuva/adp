import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";
import { loadConfig } from "../config.js";
import { repoRoot } from "../git.js";
import { loadRepoIdentity } from "../repo-identity.js";
import { armWorktree, harnessAvailable, harnessCommand, runArms } from "../launch.js";
import { installRoot, recorderBin } from "../recorder-bin.js";
import path from "node:path";

// #241. "This landed change was produced by an older model, it turned out
// badly, do it again properly and show me the difference."
//
// **The sentence did not exist; every ingredient did.** ADP holds `undo`,
// candidate sets and bake-off, cross-harness resume, run lineage and the
// comparison table, and asked the developer to compose them — which is the
// difference between a substrate and a product. The 2026-09-02 review named it
// exactly: there was no product verb.
//
// This is that verb, and it is deliberately a *composition* rather than a new
// mechanism. It reads the evidence bundle for the landed change, recovers the
// intent, finds the base the change was made on, opens a second run related to
// the first as `reimplement` (#240), and prints the comparison. It reverts
// nothing itself: `adp undo <sha>` already takes a merge back out *through the
// land policy*, which is what 2-2 requires, and a verb that reimplemented undo
// in order to feel complete would be a second path to the one operation that
// most needs exactly one.

interface EvidenceBundle {
  git_sha: string;
  change: {
    intent_id: string | null;
    intent: { id: string; title: string; issue_number: number | null; upstream_url: string | null } | null;
    provenance: Record<string, unknown>;
  } | null;
  produced_by: {
    models: { observed: string[]; asserted: string | null; source: string };
    runs: { id: string; orchestrator: string; labels: Record<string, string>; status: string }[];
  };
}

interface Operation {
  verb: string;
  before: unknown;
  after: unknown;
}

interface Commit {
  sha: string;
  message: string;
  parents: { sha: string }[];
}

interface Run {
  id: string;
}

interface CompareRow {
  runId: string;
  status: string;
  labels: Record<string, string>;
  events: number;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  durationMs: number;
  toolCalls: number;
  toolFailures: number;
  finalGitSha: string | null;
  eval: { name: string; score: number | null; passed: boolean | null } | null;
}

export async function reimplement(argv: string[]): Promise<void> {
  const [sha, ...rest] = argv;
  const flags = parseFlags(rest);
  if (!sha || sha.startsWith("--")) {
    throw new Error("usage: adp reimplement <sha> [--harness <name>] [--model <name>] [--repo <owner>/<repo>]");
  }
  // `--compare` is the same verb asked about the same change after the work,
  // rather than a second command with its own name: what a developer wants to
  // type twice is `adp reimplement <sha>`.
  if (flags.compare === "true") return reimplementCompare(argv);

  const { owner, repo } = await resolveRepo(flags.repo);

  // 1. What was this change, and what was it for.
  const bundle = await apiRequest<EvidenceBundle>("GET", `/api/adp/repos/${owner}/${repo}/evidence/${sha}`);
  if (!bundle.change) {
    throw new Error(`no signed change record for ${sha} — there is nothing here to reimplement`);
  }
  if (!bundle.change.intent_id || !bundle.change.intent) {
    // The one thing a reimplementation cannot do without. An intent is what the
    // second attempt is an attempt *at*, and a run against no intent is a
    // number nobody can interpret later — which is why `runs.intentId` is not
    // nullable in the first place.
    throw new Error(
      `${sha.slice(0, 8)} is bound to no intent, so there is nothing to try again. ` +
        "Bind one with a commit trailer or POST /changes, then reimplement it.",
    );
  }

  const original = bundle.produced_by.runs[0] ?? null;
  const models = bundle.produced_by.models;
  const wasModel =
    models.source === "observed" ? models.observed.join(" → ") : (models.asserted ?? "unrecorded");

  console.log(`reimplementing ${sha.slice(0, 8)}`);
  console.log(`  intent:    ${bundle.change.intent.title}`);
  console.log(`  produced:  ${wasModel}${models.source === "asserted" ? " (asserted, not observed)" : ""}`);
  console.log(`  run:       ${original ? original.id : "none recorded — the comparison will have one side"}`);

  // 2. The base immediately before the change.
  const base = await findBase(owner, repo, sha);
  console.log(`  base:      ${base.sha.slice(0, 8)} (${base.source})`);

  // 3. A second run against the same intent, related to the first.
  //
  // `reimplement` rather than `continue` is the whole reason #240 is a
  // prerequisite: this attempt deliberately does not look at what the first
  // produced, and an independent second attempt is evidence in a way a
  // continuation is not.
  const harness = flags.harness ?? "claude-code";
  const run = await apiRequest<Run>("POST", `/api/adp/repos/${owner}/${repo}/runs`, {
    intent_id: bundle.change.intent_id,
    orchestrator: "adp-reimplement",
    external_ref: `reimplement:${sha}:${Date.now()}`,
    labels: {
      harness,
      ...(flags.model ? { model: flags.model } : {}),
      reimplements: sha,
    },
    ...(original ? { parent_run: original.id, relationship: "reimplement" } : {}),
  });
  console.log(`  new run:   ${run.id}${original ? ` — reimplements ${original.id}` : ""}`);
  if (!original) {
    // Said rather than silently dropped. A run with no parent is a complete and
    // ordinary record; a comparison with one side is not what this command
    // promises, and the developer should know which they are getting.
    console.log("             (no lineage recorded — the original change names no run)");
  }

  console.log("");
  if (flags.launch === "true") {
    // #242: run it, rather than printing what to run. Opt-in, and the flag is
    // the acknowledgement — the same shape `adp init --runner` settled, because
    // launching a harness spends money and edits files and does both without
    // asking again.
    await launchOne(owner, repo, sha, base.sha, harness, run.id, bundle.change.intent_id!);
  } else {
    console.log("Next:");
    console.log(`  git checkout -b reimplement-${sha.slice(0, 8)} ${base.sha}`);
    console.log(
      `  ADP_RUN_ID=${run.id} adp-recorder wrap --repo ${owner}/${repo} --run ${run.id} -- <${harness}>`,
    );
    console.log(`  adp reimplement ${sha} --compare        # the table, once both sides have run`);
    console.log("  …or pass --launch and let this run it.");
  }
  console.log("");
  // The original is taken back out by the verb that already does that safely.
  // `adp undo` resolves the merge and goes through the land policy, which is
  // what 2-2 requires — reimplementing it here would be a second path to the
  // one operation that most needs exactly one.
  console.log(`If the second attempt is better: adp undo ${sha.slice(0, 8)}, then land the replacement.`);
  console.log("");

  await compare(owner, repo, bundle.change.intent_id, sha);
}

/** `adp reimplement <sha> --compare` — the table on its own, for after the work. */
export async function reimplementCompare(argv: string[]): Promise<void> {
  const [sha, ...rest] = argv;
  const flags = parseFlags(rest);
  if (!sha) throw new Error("usage: adp reimplement <sha> --compare [--repo <owner>/<repo>]");
  const { owner, repo } = await resolveRepo(flags.repo);
  const bundle = await apiRequest<EvidenceBundle>("GET", `/api/adp/repos/${owner}/${repo}/evidence/${sha}`);
  if (!bundle.change?.intent_id) throw new Error(`${sha.slice(0, 8)} is bound to no intent`);
  await compare(owner, repo, bundle.change.intent_id, sha);
}

async function resolveRepo(flag: string | undefined): Promise<{ owner: string; repo: string }> {
  if (flag) return splitRepo(flag);
  // #238: read what `adp init` recorded, rather than inferring it from a git
  // remote that may have been renamed since.
  const config = await loadConfig();
  const root = repoRoot(process.cwd());
  const recorded = root ? loadRepoIdentity(root, config.serverUrl) : null;
  if (!recorded) {
    throw new Error(
      "this checkout is not attached to an ADP repository — run `adp init`, or name it with --repo <owner>/<repo>",
    );
  }
  return { owner: recorded.owner, repo: recorded.repo };
}

/**
 * The commit the change was made on top of.
 *
 * The merge operation first, because it is the *recorded* fact: `proposal.merge`
 * carries the base sha before and after, and #225 makes that true for a merge
 * that happened on GitHub as well as one ADP performed. The commit's first
 * parent is the fallback and is right for an ordinary commit — and wrong for a
 * squash of several, which is exactly why the recorded fact is preferred rather
 * than the convenient one.
 */
async function findBase(owner: string, repo: string, sha: string): Promise<{ sha: string; source: string }> {
  // A bare array, which is what this route returns — the same shape `adp undo`
  // reads, and worth pinning here because the two are the only readers of it.
  const ops = await apiRequest<Operation[]>(
    "GET",
    `/api/adp/repos/${owner}/${repo}/operations?verb=proposal.merge&limit=200`,
  );
  for (const op of ops ?? []) {
    const after = op.after as { baseSha?: string } | null;
    const before = op.before as { baseSha?: string } | null;
    if (after?.baseSha === sha && before?.baseSha) {
      return { sha: before.baseSha, source: "the recorded merge" };
    }
  }

  const commit = await apiRequest<Commit>("GET", `/api/v3/repos/${owner}/${repo}/git/commits/${sha}`);
  const parent = commit.parents[0]?.sha;
  if (!parent) {
    throw new Error(`${sha.slice(0, 8)} has no parent — there is no base to reimplement from`);
  }
  return { sha: parent, source: "its first parent" };
}

async function compare(owner: string, repo: string, intentId: string, sha: string): Promise<void> {
  const res = await apiRequest<{ runs: CompareRow[] }>(
    "GET",
    `/api/adp/repos/${owner}/${repo}/runs/compare?intent_id=${intentId}`,
  );
  if (res.runs.length === 0) {
    console.log("no runs against this intent yet.");
    return;
  }

  // **The comparison is the deliverable as much as the reimplementation is.**
  // Two attempts at one intent with the deltas side by side is the argument
  // this product makes about itself, in one table.
  const rows = res.runs.map((r) => [
    r.labels.reimplements ? "new" : "original",
    r.labels.model ?? r.labels.harness ?? "—",
    r.status,
    String(r.events),
    `${r.toolCalls}${r.toolFailures ? `/${r.toolFailures}f` : ""}`,
    (r.costMicroUsd / 1_000_000).toFixed(4),
    `${(r.durationMs / 1000).toFixed(1)}s`,
    // Unmeasured is not zero: a run with no score gate was never ranked, which
    // is a different claim from ranking at the bottom.
    r.eval?.score === null || !r.eval ? "—" : String(r.eval.score),
    r.finalGitSha ? r.finalGitSha.slice(0, 8) : "—",
  ]);
  printTable(["attempt", "model", "status", "events", "tools", "usd", "took", "score", "landed"], rows);
  console.log("");
  console.log(`original: ${sha.slice(0, 8)}`);
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log(line(header));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(row));
}

/**
 * Run the second attempt, in its own worktree at the base.
 *
 * At the base rather than at HEAD, and that is the whole method: a
 * reimplementation that started from the branch containing the change it is
 * replacing would be looking at the answer. `runs.parentRelationship` says
 * `reimplement` precisely because this attempt is independent, and a worktree
 * cut from the pre-change base is what makes that true rather than asserted.
 */
async function launchOne(
  owner: string,
  repo: string,
  sha: string,
  base: string,
  harness: string,
  runId: string,
  intentId: string,
): Promise<void> {
  const root = repoRoot(process.cwd());
  if (!root) throw new Error("--launch needs a git checkout to work in — run it inside the repository");

  const recorder = recorderBin(installRoot());
  const command = harnessCommand(harness, "");
  const printFallback = (why: string) => {
    // Degrades to the path that existed before rather than failing: the run is
    // open and correct, and it can still be driven by hand.
    console.log(`not launched — ${why}`);
    console.log(`  git checkout -b reimplement-${sha.slice(0, 8)} ${base}`);
    console.log(`  ADP_RUN_ID=${runId} adp-recorder wrap --repo ${owner}/${repo} --run ${runId} -- <${harness}>`);
  };
  if (!recorder) return printFallback("no built recorder found — run `npm run build --prefix recorder`");
  if (!command) return printFallback(`no launch command is known for '${harness}'`);
  if (!harnessAvailable(command.command)) return printFallback(`\`${command.command}\` is not on PATH here`);

  const intent = await apiRequest<{ title: string; body: string }>(
    "GET",
    `/api/adp/repos/${owner}/${repo}/intents/${intentId}`,
  ).catch(() => null);
  const prompt = intent ? `${intent.title}\n\n${intent.body}`.trim() : `Work towards intent ${intentId}.`;
  const withPrompt = harnessCommand(harness, prompt)!;

  const cwd = armWorktree(root, path.join(".adp", "arms", `reimplement-${sha.slice(0, 8)}`), `reimplement/${sha.slice(0, 8)}`, base);
  console.log(`launching ${harness} in ${path.relative(root, cwd)} — a real agent session, at ${base.slice(0, 8)}`);
  console.log("");

  const [result] = await runArms([
    {
      arm: { harness, runId, label: harness },
      command: process.execPath,
      args: [
        recorder,
        "wrap",
        "--repo",
        `${owner}/${repo}`,
        "--run",
        runId,
        "--harness",
        harness,
        "--dir",
        cwd,
        "--",
        withPrompt.command,
        ...withPrompt.args,
      ],
      cwd,
      env: { ADP_RUN_ID: runId },
    },
  ]);
  console.log(`${harness}: ${result!.status}${result!.reason ? ` — ${result!.reason}` : ""}`);
}
