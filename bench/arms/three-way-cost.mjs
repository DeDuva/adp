#!/usr/bin/env node
// CLI driver for arm 2 — the agent-backed three-way cost comparison
// (docs/m3-readiness-review.md M3-5): the same task suite completed via
// (a) GitHub + `gh`, (b) ADP's native plane over MCP, (c) ADP via `gh` (the
// compat plane, unmodified). One trial (method x task x rep) per invocation,
// same shape as arms/merge-contention.mjs: a fixture is set up, a real agent
// (the `claude` CLI, non-interactively) does the work, and a run record is
// written to bench/runs/ with everything the report derives its numbers from.
//
// The agent's tool boundary is drawn per method:
//   github-gh  git + gh, against a real GitHub repo.
//   adp-gh     git + gh, unmodified, pointed at ADP via GH_HOST (the compat
//              plane) — the MVP's own success criterion.
//   adp-mcp    git + ADP's native MCP tools (server/src/mcp/server.ts, run
//              as its own stdio process) instead of gh. Until #144 the native
//              plane had no MCP tool that opened a proposal — only
//              candidate-set open/select/resolve, which act on a proposal
//              that already exists — and none that read the intent, so the
//              instructions told the agent how to hand-assemble `curl` calls
//              for those steps, and the report called the gap out rather than
//              hiding it. Those tools exist now (adp_intent_get,
//              adp_proposal_open, adp_proposal_review, adp_proposal_merge)
//              and the instructions name them instead.
//
//              `curl` stays on the tool list, and that is a deliberate
//              reversal. Removing it alongside the new tools would have
//              changed two things at once: the re-run could show a cost drop
//              without separating "the tools are cheaper" from "the agent can
//              no longer burn turns on HTTP it was told to assemble". Worse,
//              a withdrawn escape hatch turns a step the tools still do not
//              cover into a failed trial rather than an observation. So the
//              hatch stays open and unadvertised — the instructions teach the
//              MCP path and never mention curl — and every trial records what
//              the agent actually reached for (measurement.toolBreakdown,
//              measurement.escapeHatchCalls). An agent that reaches for curl
//              anyway is then a finding about the tools, which is the useful
//              version of this experiment.
//
//   ADP_SERVER_URL=... ADP_TOKEN=... node arms/three-way-cost.mjs \
//     --method=github-gh|adp-gh|adp-mcp --task=clamp|titlecase --rep=1 \
//     --out=../runs/three-way-cost-<method>-<task>-r1.json
//     [--gh-host=localhost:8843] [--model=claude-haiku-4-5]
//     [--max-budget-usd=1.5] [--root=/tmp/adp-arm2]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { adpClient } from "./lib/adp-rest.mjs";
// The ADP fixture, shared with arms/recorder-overhead.mjs — see that file
// for why it moved rather than being copied.
import {
  checkLanded,
  loadTask,
  parseArgs,
  seedAdpRepo,
  setupAdpGh,
  sh,
  work_placeholder,
} from "./lib/adp-fixture.mjs";
import { parseAgentTranscript } from "../lib/transcript.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// ─── Fixture setup, per method ─────────────────────────────────────────────

/**
 * GitHub + gh. Uses one persistent scratch repo (created ahead of time), a
 * per-task/per-rep immutable base branch pointing at the task's pristine
 * starter commit (so reps never see a previous rep's landed file), and a
 * work branch the agent commits to. Base branches are driver-created, not
 * agent-created, so the agent's job is an ordinary "branch, PR against the
 * base I was given" flow, identical in shape across all three methods.
 */
function setupGithub({ owner, repo, taskId, rep, runId, task }) {
  const base = `arm2/base-${taskId}-r${rep}-${runId}`;
  const work = `arm2/work-${taskId}-r${rep}-${runId}`;
  const pristineBranch = `arm2/base-${taskId}`; // seeded once, see seed-github.mjs
  // Server-side ref copy over the API — no local clone or push credential
  // needed, and it is atomic: the new base is exactly the pristine sha, so a
  // rep never sees another rep's landed file.
  const pristineSha = sh("gh", ["api", `repos/${owner}/${repo}/git/refs/heads/${pristineBranch}`, "--jq", ".object.sha"]);
  sh("gh", ["api", `repos/${owner}/${repo}/git/refs`, "-f", `ref=refs/heads/${base}`, "-f", `sha=${pristineSha}`]);

  const issue = sh("gh", ["issue", "create", "--repo", `${owner}/${repo}`, "--title", `arm2 ${taskId} r${rep}`, "--body", task.goal]);
  const issueNumber = Number(issue.match(/\/issues\/(\d+)\s*$/)?.[1]);

  return {
    cloneUrl: `https://github.com/${owner}/${repo}.git`,
    owner,
    repo,
    base,
    work,
    issueNumber,
    issueRef: `${owner}/${repo}#${issueNumber}`,
    env: {},
    allowedTools: ["Bash(git *)", "Bash(gh *)", "Bash(node *)", "Bash(npm *)", "Read", "Edit", "Write"],
    mcpConfig: null,
    instructions: [
      `The repo is ${owner}/${repo}. Read the task in issue #${issueNumber} with`,
      `\`gh issue view ${issueNumber} --repo ${owner}/${repo}\`.`,
      `You are already on a branch (${work}) checked out from the base branch`,
      `${base}. Do the work, commit, and push with \`git push origin ${work}\`.`,
      `Then open a pull request with \`gh pr create --repo ${owner}/${repo} --base ${base} --head ${work} --title ... --body ...\`,`,
      `and land it with \`gh pr merge --repo ${owner}/${repo} --merge <number>\`.`,
    ].join(" "),
  };
}

/** ADP-MCP — the native plane. git + ADP's own MCP tools, no gh. */
async function setupAdpMcp({ adpUrl, token, taskId, rep, runId, task }) {
  const owner = "duvabench";
  const repo = `arm2-mcp-${taskId}-r${rep}-${runId}`;
  const client = adpClient(adpUrl, token);
  await client.createRepo(owner, repo);
  seedAdpRepo({ adpUrl, owner, repo, token, task });

  const issue = await client.createIssue(owner, repo, `arm2 ${taskId} r${rep}`, task.goal);
  const issueNumber = issue.number;
  const intentId = issue.intent_id ?? issue.intentId;
  const work = work_placeholder(taskId, rep, runId);

  // The direct tsx binary, not `npx tsx` — npx's own resolution adds a cold-start
  // delay that raced Claude Code's MCP connect timeout often enough (observed
  // "adp-native" landing status "failed" from a cwd with no local tsx) to be
  // worth avoiding rather than tuning a timeout around.
  const mcpConfig = {
    mcpServers: {
      "adp-native": {
        command: path.resolve(here, "..", "..", "server/node_modules/.bin/tsx"),
        args: [path.resolve(here, "..", "..", "server/src/mcp/server.ts")],
        env: { ADP_SERVER_URL: adpUrl, ADP_TOKEN: token },
      },
    },
  };

  return {
    cloneUrl: client.cloneUrl(owner, repo),
    owner,
    repo,
    base: "main",
    work,
    issueNumber,
    issueRef: `${adpUrl}/repos/${owner}/${repo}#${issueNumber}`,
    env: {},
    // `Bash(curl *)` is here on purpose and is not taught. See the header:
    // the arm needs the fallback to be *available and visible*, not absent —
    // absent makes an uncovered step look like a failed trial, and makes the
    // re-run a two-variable change. `measurement.escapeHatchCalls` is what
    // turns "available" into "visible".
    allowedTools: [
      "Bash(git *)",
      "Bash(curl *)",
      "Bash(node *)",
      "Bash(npm *)",
      "Read",
      "Edit",
      "Write",
      "mcp__adp-native__adp_intent_get",
      "mcp__adp-native__adp_proposal_open",
      "mcp__adp-native__adp_proposal_review",
      "mcp__adp-native__adp_candidates_open",
      "mcp__adp-native__adp_candidates_resolve",
      "mcp__adp-native__adp_candidates_select",
      "mcp__adp-native__adp_history_query",
      "mcp__adp-native__adp_evidence_get",
    ],
    mcpConfig,
    // Every step is one named tool call now. What this used to say — how to
    // hand-assemble three curl invocations, with headers and a JSON body,
    // correctly, every time — is the cost #144 was filed against.
    instructions: [
      `The repo lives on ADP at ${adpUrl}, owner "${owner}", repo "${repo}". Do not use \`gh\` — it is`,
      `not available for this task. Read the task with adp_intent_get, owner="${owner}" repo="${repo}"`,
      `number=${issueNumber}; its "intent_id" field is what the next step needs.`,
      `You are already on a branch (${work}) checked out from main.`,
      `Do the work, commit, and push with git. To land it, use the ADP native-plane MCP tools:`,
      `call adp_candidates_open with owner="${owner}" repo="${repo}" intent_id="${intentId ?? "(the intent_id you just read)"}"`,
      `to get a candidate_set_id. Then adp_proposal_open with title, head="${work}", base="main" and that`,
      `candidate_set_id — the response's "number" field is the proposal number. This instance's land`,
      `policy requires one approving review before a candidate can resolve (a real constraint of this`,
      `server, not optional): submit one with adp_proposal_review for that number, state="approved".`,
      `Only then call adp_candidates_resolve with the candidate_set_id to land it. Make no further tool`,
      `calls once it has landed.`,
    ].join(" "),
  };
}

// ─── stream-json parsing ────────────────────────────────────────────────────
//
// In lib/ so it can be tested: this file runs main() on import, so anything
// that needs assertions has to live beside it. bench/test/transcript.test.mjs
// drives that module directly.

// ─── landed check ───────────────────────────────────────────────────────────

// ─── main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const method = args.method;
  const taskId = args.task;
  const rep = Number(args.rep ?? 1);
  const adpUrl = process.env.ADP_SERVER_URL;
  const token = process.env.ADP_TOKEN;
  const model = args.model ?? "claude-haiku-4-5";
  const maxBudgetUsd = args["max-budget-usd"] ?? "1.5";
  const ghHost = args["gh-host"] ?? "localhost:8843";
  const certFile = args["cert-file"];
  const root = args.root ?? mkdtempSync(path.join(os.tmpdir(), "adp-arm2-"));
  const runId = crypto.randomBytes(3).toString("hex");
  // Which sitting of the arm this trial belongs to. The report groups by it and
  // never pools across it: averaging trials taken against different tool
  // surfaces produces a mean describing neither, and a re-run that quietly
  // joined the previous run's pile would destroy the only comparison it exists
  // to make. Records without one are the original pre-#144 pilot.
  const cohort = args.cohort ?? null;

  if (!["github-gh", "adp-gh", "adp-mcp"].includes(method)) {
    console.error("Usage: --method=github-gh|adp-gh|adp-mcp --task=clamp|titlecase --rep=N --cohort=NAME --out=FILE");
    process.exit(2);
  }
  if ((method === "adp-gh" || method === "adp-mcp") && (!adpUrl || !token)) {
    console.error("ADP_SERVER_URL and ADP_TOKEN are required for adp-gh / adp-mcp");
    process.exit(2);
  }

  const task = loadTask(taskId);
  mkdirSync(root, { recursive: true });
  const trialDir = path.join(root, `${method}-${taskId}-r${rep}-${runId}`);

  let target;
  if (method === "github-gh") {
    target = setupGithub({ owner: args["gh-owner"] ?? "DeDuva", repo: args["gh-repo"] ?? "adp-bench-arm2-scratch", taskId, rep, runId, task });
  } else if (method === "adp-gh") {
    target = await setupAdpGh({ adpUrl, ghHost, certFile, token, taskId, rep, runId, task });
  } else {
    target = await setupAdpMcp({ adpUrl, token, taskId, rep, runId, task });
  }

  execFileSync("git", ["clone", target.cloneUrl, trialDir], { stdio: "pipe", env: { ...process.env, ...target.env } });
  execFileSync("git", ["checkout", "-b", target.work, `origin/${target.base}`], { cwd: trialDir, stdio: "pipe" });
  execFileSync("git", ["config", "--local", "user.email", "agent@adp-bench.invalid"], { cwd: trialDir });
  execFileSync("git", ["config", "--local", "user.name", "arm2-agent"], { cwd: trialDir });

  const prompt = `${task.goal}\n\n---\n\nHow to open and land the PR in this environment: ${target.instructions}`;

  const claudeArgs = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--max-budget-usd", String(maxBudgetUsd),
    "--allowedTools", ...target.allowedTools,
  ];
  if (target.mcpConfig) claudeArgs.push("--mcp-config", JSON.stringify(target.mcpConfig), "--strict-mcp-config");

  const startedAt = Date.now();
  const proc = spawnSync("claude", claudeArgs, {
    cwd: trialDir,
    env: { ...process.env, ...target.env },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const wallClockMs = Date.now() - startedAt;

  writeFileSync(path.join(trialDir, "transcript.jsonl"), proc.stdout ?? "");
  writeFileSync(path.join(trialDir, "stderr.log"), proc.stderr ?? "");
  const { toolCalls, toolErrors, permissionDenials, escapeHatchCalls, toolBreakdown, finalResult } =
    parseAgentTranscript(proc.stdout ?? "");
  const landed = checkLanded({ cloneDir: trialDir, base: target.base, outputFile: task.outputFile, env: target.env });

  const record = {
    recordedAt: new Date().toISOString(),
    arm: "three-way-cost",
    ...(cohort ? { cohort } : {}),
    deterministic: false,
    method,
    taskId,
    rep,
    runId,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      model,
      adpUrl: method === "github-gh" ? null : adpUrl,
      target: { owner: target.owner, repo: target.repo, issueRef: target.issueRef },
    },
    measurement: {
      wallClockMs,
      totalCostUsd: finalResult?.total_cost_usd ?? null,
      usage: finalResult?.usage ?? null,
      numTurns: finalResult?.num_turns ?? null,
      toolCalls,
      toolErrors,
      permissionDenials,
      // What the agent actually reached for, not just how often. The published
      // pilot records predate these two fields; anything reading them has to
      // treat absence as "not measured" rather than as zero, which is what the
      // report does.
      toolBreakdown,
      escapeHatchCalls,
      isError: finalResult?.is_error ?? proc.status !== 0,
      terminalReason: finalResult?.terminal_reason ?? null,
      landed,
      processExitCode: proc.status,
    },
  };

  const output = JSON.stringify(record, null, 2);
  console.log(output);
  if (args.out) {
    const target2 = path.resolve(String(args.out));
    mkdirSync(path.dirname(target2), { recursive: true });
    writeFileSync(target2, `${output}\n`);
    console.error(`wrote ${target2}`);
  }

  if (!landed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
