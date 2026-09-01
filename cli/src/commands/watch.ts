import { parseFlags, splitRepo } from "../args.js";
import { apiRequest } from "../api.js";

interface UnmetRequirement {
  requirement: string;
  problem: string;
  remedy: string;
  command?: string;
}

interface Proposal {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  head: { ref: string; sha: string };
  base: { ref: string };
  land?: { allowed: boolean; unmet: string[]; unmet_detail: UnmetRequirement[]; advisories: string[] };
}

interface GateResult {
  name: string;
  status: "success" | "failure" | "pending";
  summary: string;
}

interface RunRow {
  runId: string;
  status: string;
  labels: Record<string, string>;
  events: number;
  costMicroUsd: number;
  toolCalls: number;
  toolFailures: number;
  eval: { name: string; score: number | null } | null;
}

// #155. The command a person leaves open while an agent works.
//
// Everything here was already readable — `gh pr checks` for the gates, the
// native plane for the runs — but only by polling three surfaces and holding
// the join in your head. What was *not* readable anywhere was the land verdict:
// the only way to find out why a change would not land was to try to land it,
// which is a strange thing to have to do to ask a question.
//
// That is why this exists, and why #145's refusal is the part rendered most
// carefully. A refusal is the moment the product proves itself, and it carries
// a remedy and often the literal command that satisfies it — a watcher that
// printed "blocked" would be throwing away the half that helps.
export async function watch(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (!flags.repo) {
    throw new Error("usage: adp watch --repo <owner>/<repo> [--pr <n>] [--interval <seconds>] [--once]");
  }
  const { owner, repo } = splitRepo(flags.repo);
  const interval = Number(flags.interval ?? 5);
  if (!Number.isFinite(interval) || interval < 1) {
    throw new Error(`--interval must be at least 1 second, got '${flags.interval}'`);
  }
  const once = flags.once === "true";

  let number = flags.pr ? Number(flags.pr) : undefined;
  if (number !== undefined && !Number.isInteger(number)) {
    throw new Error(`--pr must be a number, got '${flags.pr}'`);
  }

  for (;;) {
    if (number === undefined) {
      // No proposal named: watch the newest open one, which is what somebody
      // running this beside an agent means. Said out loud rather than guessed
      // silently, so the answer is never about a pull request they forgot.
      const open = await apiRequest<Proposal[]>("GET", `/api/v3/repos/${owner}/${repo}/pulls`);
      const newest = open.filter((p) => p.state === "open").sort((a, b) => b.number - a.number)[0];
      if (!newest) {
        console.log(`${owner}/${repo}: no open pull request yet.`);
        if (once) return;
        await sleep(interval);
        continue;
      }
      number = newest.number;
      console.log(`watching #${number} — the newest open pull request in ${owner}/${repo}`);
    }

    await render(owner, repo, number);
    if (once) return;
    await sleep(interval);
    console.log("");
  }
}

async function render(owner: string, repo: string, number: number): Promise<void> {
  // `?land=1` is the opt-in that makes the policy verdict readable without
  // attempting the merge (#155). Everything else is an ordinary read.
  const proposal = await apiRequest<Proposal>("GET", `/api/v3/repos/${owner}/${repo}/pulls/${number}?land=1`);
  const gates = await apiRequest<GateResult[]>(
    "GET",
    `/api/v3/repos/${owner}/${repo}/commits/${proposal.head.sha}/gates`,
  ).catch(() => [] as GateResult[]);

  console.log(`#${proposal.number} ${proposal.title}`);
  console.log(
    `  ${proposal.state}  ${proposal.head.ref} → ${proposal.base.ref}  ${proposal.head.sha.slice(0, 10)}`,
  );

  if (gates.length === 0) {
    console.log("  gates: none reported yet");
  } else {
    for (const gate of gates) {
      console.log(`  ${symbolFor(gate.status)} ${gate.name}${gate.summary ? ` — ${gate.summary}` : ""}`);
    }
  }

  const runs = await runsFor(owner, repo).catch(() => [] as RunRow[]);
  for (const run of runs) {
    const arm = [run.labels.harness, run.labels.provider, run.labels.model].filter(Boolean).join(" · ");
    console.log(
      `  run ${run.runId.slice(0, 8)} ${arm || run.status}: ${run.events} events, ` +
        `${run.toolCalls} tool calls${run.toolFailures ? ` (${run.toolFailures} failed)` : ""}, ` +
        `${(run.costMicroUsd / 1_000_000).toFixed(4)} USD` +
        `${run.eval?.score !== null && run.eval ? `, score ${run.eval.score}` : ""}`,
    );
  }

  if (proposal.state !== "open") {
    console.log(`  ${proposal.state}.`);
    return;
  }
  if (!proposal.land) return;

  if (proposal.land.allowed) {
    console.log("  ready to land:");
    console.log(`    adp pr merge --repo ${owner}/${repo} --number ${number}`);
  } else {
    console.log("  not landable yet:");
    // The remedy, and where one exists the literal command. #145's whole point
    // is that a refusal which names the unmet requirement and stops there sends
    // the reader back to the documentation at exactly the moment the product
    // was about to prove itself.
    for (const unmet of proposal.land.unmet_detail) {
      console.log(`    ${unmet.requirement}: ${unmet.problem}`);
      console.log(`      → ${unmet.remedy}`);
      if (unmet.command) console.log(`      $ ${unmet.command}`);
    }
  }
  for (const advisory of proposal.land.advisories) console.log(`  note: ${advisory}`);
}

// The runs against this repo's newest work. Best-effort: a repo whose agents do
// not record trajectories still has gates and a land verdict, and failing the
// whole view over an empty native plane would be the wrong trade.
async function runsFor(owner: string, repo: string): Promise<RunRow[]> {
  const res = await apiRequest<{ runs?: RunRow[] }>("GET", `/api/adp/repos/${owner}/${repo}/runs/compare?limit=3`);
  // `?? []` rather than trusting the shape: this is the best-effort part of the
  // view, and a surprise here must degrade the run lines rather than take the
  // land verdict — the thing this command exists for — down with them.
  return res.runs ?? [];
}

function symbolFor(status: string): string {
  return status === "success" ? "ok  " : status === "failure" ? "FAIL" : "..  ";
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}
