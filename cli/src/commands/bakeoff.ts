import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";

interface Issue {
  number: number;
  title: string;
  intent_id: string | null;
}

interface CandidateSet {
  id: string;
}

interface Run {
  id: string;
}

interface RunRow {
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

// #155. One intent, N harnesses, one table at the end.
//
// Every server piece for this already existed — candidate sets, runs, labels,
// `runs/compare` — and nothing drove them, so the capability GitHub
// structurally cannot express was the one with no way to ask for it. This is
// the driver, and deliberately nothing more: it opens the set and the runs, and
// prints the comparison. It does not launch agents. What runs under each label
// is the harness's business, and a bakeoff that owned that would be an
// orchestrator rather than a command.
export async function bakeoff(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (!flags.repo || !flags.intent || !flags.harness) {
    throw new Error(
      "usage: adp bakeoff --repo <owner>/<repo> --intent <uuid|#issue> --harness <a,b,c> [--orchestrator <name>]",
    );
  }
  const { owner, repo } = splitRepo(flags.repo);
  const harnesses = flags.harness
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (harnesses.length < 2) {
    // One arm is not a comparison, and opening a candidate set for it would
    // leave a set nobody can resolve against anything.
    throw new Error(`--harness needs at least two, comma-separated; got '${flags.harness}'`);
  }
  if (new Set(harnesses).size !== harnesses.length) {
    // Two runs under one label produce two rows the comparison cannot tell
    // apart, which is the one result a bakeoff must not produce.
    throw new Error(`--harness has a duplicate: ${harnesses.join(",")}`);
  }

  const intentId = await resolveIntent(owner, repo, flags.intent);
  const orchestrator = flags.orchestrator ?? "adp-bakeoff";

  const set = await apiRequest<CandidateSet>("POST", `/api/adp/repos/${owner}/${repo}/candidate-sets`, {
    intent_id: intentId,
    selection_policy: "best_score",
  });
  console.log(`candidate set ${set.id} — best_score`);

  const opened: { harness: string; runId: string }[] = [];
  for (const harness of harnesses) {
    const run = await apiRequest<Run>("POST", `/api/adp/repos/${owner}/${repo}/runs`, {
      intent_id: intentId,
      orchestrator,
      external_ref: `bakeoff:${set.id}:${harness}`,
      // Labels ride inside the signed run attestation, which is what makes
      // "this result came from claude-code" attested rather than annotated —
      // the difference between an A/B test and a table someone can edit later.
      labels: { harness },
    });
    opened.push({ harness, runId: run.id });
    console.log(`  ${harness}: run ${run.id}`);
  }

  console.log("");
  console.log("Point each harness at its run, then read the table:");
  for (const { harness, runId } of opened) {
    console.log(`  ADP_RUN_ID=${runId} adp-recorder wrap --repo ${owner}/${repo} --run ${runId} -- <${harness}>`);
  }
  console.log(`  adp bakeoff results --repo ${owner}/${repo} --intent ${intentId}`);
  console.log("");
  await results(owner, repo, intentId);
}

export async function bakeoffResults(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (!flags.repo || !flags.intent) {
    throw new Error("usage: adp bakeoff results --repo <owner>/<repo> --intent <uuid|#issue>");
  }
  const { owner, repo } = splitRepo(flags.repo);
  await results(owner, repo, await resolveIntent(owner, repo, flags.intent));
}

// `#7` or a uuid. The issue number is what a person has; the uuid is what the
// API is keyed by, and asking somebody to convert between them by hand is the
// kind of friction this whole item exists to remove.
async function resolveIntent(owner: string, repo: string, given: string): Promise<string> {
  if (!given.startsWith("#")) return given;
  const number = Number(given.slice(1));
  if (!Number.isInteger(number)) throw new Error(`--intent '${given}' is neither a uuid nor #<issue>`);
  const issue = await apiRequest<Issue>("GET", `/api/v3/repos/${owner}/${repo}/issues/${number}`);
  if (!issue.intent_id) throw new Error(`issue #${number} carries no intent`);
  return issue.intent_id;
}

async function results(owner: string, repo: string, intentId: string): Promise<void> {
  const res = await apiRequest<{ runs: RunRow[] }>(
    "GET",
    `/api/adp/repos/${owner}/${repo}/runs/compare?intent_id=${intentId}`,
  );
  if (res.runs.length === 0) {
    console.log("no runs against this intent yet.");
    return;
  }

  const rows = res.runs.map((r) => [
    r.labels.harness ?? r.labels.model ?? "—",
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
  printTable(["arm", "status", "events", "tools", "usd", "took", "score", "landed"], rows);
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log(line(header));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(row));
}
