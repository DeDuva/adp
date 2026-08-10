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
//              as its own stdio process) instead of gh. The native plane has
//              no MCP tool that opens a proposal (only candidate-set
//              open/select/resolve, which act on a proposal that already
//              exists) so this arm also allows one scoped `curl` for that one
//              REST call — everything else goes through MCP. That gap is
//              real and is called out in the report, not hidden.
//
//   ADP_SERVER_URL=... ADP_TOKEN=... node arms/three-way-cost.mjs \
//     --method=github-gh|adp-gh|adp-mcp --task=clamp|titlecase --rep=1 \
//     --out=../runs/three-way-cost-<method>-<task>-r1.json
//     [--gh-host=localhost:8843] [--model=claude-haiku-4-5]
//     [--max-budget-usd=1.5] [--root=/tmp/adp-arm2]

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { adpClient } from "./lib/adp-rest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..");

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) args[arg.slice(2)] = true;
    else args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return args;
}

function sh(cmd, args, opts = {}) {
  const res = execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
  return res.trim();
}

function loadTask(taskId) {
  const dir = path.join(benchRoot, "tasks/arm2", taskId);
  const goal = readFileSync(path.join(dir, "goal.md"), "utf8");
  const starterDir = path.join(dir, "starter");
  const outputFile = { clamp: "clamp.js", titlecase: "titlecase.js" }[taskId];
  if (!outputFile) throw new Error(`unknown task ${taskId}`);
  return { dir, goal, starterDir, outputFile };
}

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

/** ADP via gh — the compat plane, unmodified `gh`, GH_HOST pointed at the proxy. */
async function setupAdpGh({ adpUrl, ghHost, certFile, token, taskId, rep, runId, task }) {
  const owner = "duvabench";
  const repo = `arm2-gh-${taskId}-r${rep}-${runId}`;
  const client = adpClient(adpUrl, token);
  await client.createRepo(owner, repo);
  seedAdpRepo({ adpUrl, owner, repo, token, task });

  const issue = await client.createIssue(owner, repo, `arm2 ${taskId} r${rep}`, task.goal);
  const issueNumber = issue.number;

  return {
    cloneUrl: client.cloneUrl(owner, repo),
    owner,
    repo,
    base: "main",
    work: work_placeholder(taskId, rep, runId),
    issueNumber,
    issueRef: `${ghHost}/${owner}/${repo}#${issueNumber}`,
    env: { GH_HOST: ghHost, GH_ENTERPRISE_TOKEN: token, SSL_CERT_FILE: certFile },
    allowedTools: ["Bash(git *)", "Bash(gh *)", "Bash(node *)", "Bash(npm *)", "Read", "Edit", "Write"],
    mcpConfig: null,
    instructions: [
      `The repo is ${ghHost}/${owner}/${repo}. GH_HOST, GH_ENTERPRISE_TOKEN and SSL_CERT_FILE are`,
      `already set in your environment — do not export or inspect them, just use \`gh\` directly.`,
      `Pass \`--repo ${ghHost}/${owner}/${repo}\` on every \`gh\` command below; do not rely on the`,
      `git remote to pick the host. Read the task with`,
      `\`gh issue view ${issueNumber} --repo ${ghHost}/${owner}/${repo}\`.`,
      `You are already on a branch (${work_placeholder(taskId, rep, runId)}) checked out from main.`,
      `Do the work, commit, and push with \`git push origin ${work_placeholder(taskId, rep, runId)}\`.`,
      `Open the PR with \`gh pr create --repo ${ghHost}/${owner}/${repo} --base main --head`,
      `${work_placeholder(taskId, rep, runId)} --title "..." --body "one short paragraph, inline, no`,
      `--body-file"\`. This instance's land policy requires one approving review before merge (a real`,
      `constraint of this server, not optional) — approve it yourself with \`gh pr review <number>`,
      `--repo ${ghHost}/${owner}/${repo} --approve\`, then land it with \`gh pr merge <number> --repo`,
      `${ghHost}/${owner}/${repo} --merge\`.`,
    ].join(" "),
  };
}
function work_placeholder(taskId, rep, runId) {
  return `arm2/work-${taskId}-r${rep}-${runId}`;
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
    allowedTools: [
      "Bash(git *)",
      "Bash(curl *)",
      "Bash(node *)",
      "Bash(npm *)",
      "Read",
      "Edit",
      "Write",
      "mcp__adp-native__adp_candidates_open",
      "mcp__adp-native__adp_candidates_resolve",
      "mcp__adp-native__adp_candidates_select",
      "mcp__adp-native__adp_history_query",
      "mcp__adp-native__adp_evidence_get",
    ],
    mcpConfig,
    instructions: [
      `The repo lives on ADP at ${adpUrl}, owner "${owner}", repo "${repo}". Do not use \`gh\` — it is`,
      `not available for this task. Read the task by fetching`,
      `\`curl -s -H "Authorization: Bearer ${token}" ${adpUrl}/api/v3/repos/${owner}/${repo}/issues/${issueNumber}\`.`,
      `You are already on a branch (${work}) checked out from main.`,
      `Do the work, commit, and push with git. To land it, use the ADP native-plane MCP tools:`,
      `call adp_candidates_open with owner="${owner}" repo="${repo}" intent_id="${intentId ?? "(read it off the issue you fetched above)"}"`,
      `to get a candidate_set_id. There is no MCP tool to open the proposal itself, so open it with one`,
      `REST call: \`curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json"`,
      `-d '{"title":"...","head":"${work}","base":"main","candidate_set_id":"<id>"}'`,
      `${adpUrl}/api/v3/repos/${owner}/${repo}/pulls\` — the response's "number" field is the proposal`,
      `number. This instance's land policy requires one approving review before a candidate can resolve`,
      `(a real constraint of this server, not optional): submit one yourself with`,
      `\`curl -s -X POST -H "Authorization: Bearer ${token}" -H "Content-Type: application/json"`,
      `-d '{"state":"approved","body":"looks good"}'`,
      `${adpUrl}/api/v3/repos/${owner}/${repo}/pulls/<number>/reviews\`. Only then call adp_candidates_resolve`,
      `with the candidate_set_id to land it. Make no further tool calls once it has landed.`,
    ].join(" "),
  };
}

function seedAdpRepo({ owner, repo, task, adpUrl, token }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adp-arm2-seed-"));
  const url = adpClient(adpUrl, token).cloneUrl(owner, repo);
  sh("git", ["clone", url, dir]);
  execFileSync("cp", ["-r", `${task.starterDir}/.`, dir]);
  sh("git", ["add", "-A"], { cwd: dir });
  sh("git", ["-c", "user.email=bench@adp.invalid", "-c", "user.name=adp-bench", "commit", "-q", "-m", "seed: starter"], { cwd: dir });
  sh("git", ["push", "origin", "HEAD:main"], { cwd: dir });
  rmSync(dir, { recursive: true, force: true });
}

// ─── stream-json parsing ────────────────────────────────────────────────────

function parseAgentTranscript(stdout) {
  let toolCalls = 0;
  let toolErrors = 0;
  let permissionDenials = 0;
  let finalResult = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") toolCalls++;
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_result" && block.is_error) toolErrors++;
      }
    } else if (event.type === "result") {
      finalResult = event;
      permissionDenials = (event.permission_denials ?? []).length;
    }
  }
  return { toolCalls, toolErrors, permissionDenials, finalResult };
}

// ─── landed check ───────────────────────────────────────────────────────────

function checkLanded({ cloneDir, base, outputFile, env }) {
  try {
    execFileSync("git", ["fetch", "origin", base], { cwd: cloneDir, stdio: "pipe", env: { ...process.env, ...env } });
    execFileSync("git", ["show", `origin/${base}:${outputFile}`], { cwd: cloneDir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

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

  if (!["github-gh", "adp-gh", "adp-mcp"].includes(method)) {
    console.error("Usage: --method=github-gh|adp-gh|adp-mcp --task=clamp|titlecase --rep=N --out=FILE");
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
  const { toolCalls, toolErrors, permissionDenials, finalResult } = parseAgentTranscript(proc.stdout ?? "");
  const landed = checkLanded({ cloneDir: trialDir, base: target.base, outputFile: task.outputFile, env: target.env });

  const record = {
    recordedAt: new Date().toISOString(),
    arm: "three-way-cost",
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
