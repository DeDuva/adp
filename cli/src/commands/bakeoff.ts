import path from "node:path";
import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";
import { repoRoot } from "../git.js";
import { armWorktree, harnessAvailable, harnessCommand, runArms, type LaunchSpec } from "../launch.js";
import { recorderBin, installRoot } from "../recorder-bin.js";

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
// structurally cannot express was the one with no way to ask for it.
//
// **#242 changed the boundary.** This opened the set and the runs, printed one
// `adp-recorder wrap …` line per harness, and explicitly did not launch
// anything: what runs under each label is the harness's business, and a bakeoff
// that owned it would be an orchestrator rather than a command. That is a
// defensible boundary for a substrate and the wrong one for a product — the
// comparison a bake-off exists to produce is exactly what nobody will assemble
// by hand N times, so the feature was used least where it is worth most.
//
// So `--launch` runs them, and the printed instructions remain the answer
// without it and for any harness that cannot be launched here. The flag is the
// acknowledgement, exactly as `--runner` is on `adp init`: launching a harness
// spends money and edits files, and does both without asking again.
export async function bakeoff(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (!flags.repo || !flags.intent || !flags.harness) {
    throw new Error(
      "usage: adp bakeoff --repo <owner>/<repo> --intent <uuid|#issue> --harness <a,b,c> " +
        "[--orchestrator <name>] [--launch] [--concurrency <n>]",
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

  if (flags.launch === "true") {
    await launch(owner, repo, intentId, opened, flags);
  } else {
    console.log("");
    console.log("Point each harness at its run, then read the table:");
    for (const { harness, runId } of opened) {
      console.log(`  ADP_RUN_ID=${runId} adp-recorder wrap --repo ${owner}/${repo} --run ${runId} -- <${harness}>`);
    }
    console.log(`  adp bakeoff results --repo ${owner}/${repo} --intent ${intentId}`);
    console.log("  …or pass --launch and let this run them.");
  }
  console.log("");
  await results(owner, repo, intentId);
}

/**
 * Run each arm, in its own worktree, through the recorder.
 *
 * The prompt is the intent, because that is what the arms are attempts at: a
 * bake-off whose arms were each given a different instruction would compare the
 * instructions rather than the harnesses.
 */
async function launch(
  owner: string,
  repo: string,
  intentId: string,
  opened: { harness: string; runId: string }[],
  flags: Record<string, string | undefined>,
): Promise<void> {
  const root = repoRoot(process.cwd());
  if (!root) throw new Error("--launch needs a git checkout to work in — run it inside the repository");

  const recorder = recorderBin(installRoot());
  if (!recorder) {
    // Degrades to the path that existed before rather than failing: the runs
    // are open and correct, and a developer with no built recorder can still
    // drive them by hand.
    console.log("");
    console.log("no built recorder found — run `npm run build --prefix recorder`, then:");
    for (const { harness, runId } of opened) {
      console.log(`  ADP_RUN_ID=${runId} adp-recorder wrap --repo ${owner}/${repo} --run ${runId} -- <${harness}>`);
    }
    return;
  }

  const intent = await apiRequest<{ title: string; body: string }>(
    "GET",
    `/api/adp/repos/${owner}/${repo}/intents/${intentId}`,
  ).catch(() => null);
  const prompt = intent ? `${intent.title}\n\n${intent.body}`.trim() : `Work towards intent ${intentId}.`;
  const base = flags.base ?? "HEAD";

  const specs: LaunchSpec[] = [];
  const skipped: { harness: string; runId: string; why: string }[] = [];
  for (const { harness, runId } of opened) {
    const command = harnessCommand(harness, prompt);
    if (!command) {
      skipped.push({ harness, runId, why: "no launch command is known for this harness" });
      continue;
    }
    if (!harnessAvailable(command.command)) {
      skipped.push({ harness, runId, why: `\`${command.command}\` is not on PATH here` });
      continue;
    }
    // A worktree per arm. N agents cannot share one checkout: they edit the
    // same files at the same time, and the comparison that results is of two
    // agents fighting rather than of two agents working — a worse answer than
    // no answer, because it looks like a real one.
    const cwd = armWorktree(root, path.join(".adp", "arms", harness), `bakeoff/${harness}`, base);
    specs.push({
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
        command.command,
        ...command.args,
      ],
      cwd,
      env: { ADP_RUN_ID: runId },
    });
  }

  for (const s of skipped) {
    console.log(`  ${s.harness}: not launched — ${s.why}`);
    console.log(`             ADP_RUN_ID=${s.runId} adp-recorder wrap --repo ${owner}/${repo} --run ${s.runId} -- <${s.harness}>`);
  }
  if (specs.length === 0) {
    console.log("nothing to launch here — the runs are open and can be driven by hand.");
    return;
  }

  // **The cost is visible before the run rather than after.** N agents against
  // one intent is the most expensive thing this CLI can do, and a command that
  // spends it silently is one nobody runs twice.
  const concurrency = Math.max(1, Number(flags.concurrency ?? 2));
  console.log("");
  console.log(`launching ${specs.length} arm(s), ${concurrency} at a time — each is a real agent session:`);
  for (const spec of specs) console.log(`  ${spec.arm.harness} in ${path.relative(root, spec.cwd)}`);
  console.log("");

  const results = await runArms(specs, {
    concurrency,
    onStart: (spec) => console.log(`  ${spec.arm.harness}: started`),
    onFinish: (r) =>
      console.log(`  ${r.arm.harness}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`),
  });

  const failed = results.filter((r) => r.status !== "finished");
  if (failed.length > 0) {
    // Reported, not thrown: a bake-off where one harness fell over still has a
    // comparison worth reading, and the table below is where that shows.
    console.log("");
    console.log(`${failed.length} arm(s) did not finish cleanly — their runs stay open and say so.`);
  }
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
