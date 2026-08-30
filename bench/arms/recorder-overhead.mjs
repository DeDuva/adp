#!/usr/bin/env node
// Arm 5 — what recording costs the agent.
//
// #149's fourth exit criterion: "Measured agent cost with the recorder
// attached is indistinguishable from a run without it — the arm 2 method,
// paired, recorder on versus off."
//
// **Why this needs measuring even though the answer is structural.** The
// recorder is out of band: it reads a stream the harness already produces, and
// the agent emits nothing about recording, so no token of it enters the
// context window. That argument says the cost must be identical, and it is the
// argument the whole design rests on — which is exactly why it is worth a
// number rather than a paragraph. Arm 2 is the cautionary case: the project's
// own bet was that the native plane would be cheaper, and its first sitting
// measured ADP-MCP at $0.1435/trial against $0.0848 via `gh`. A first-party
// number contradicting a first-party bet is the reason this harness exists.
//
// **Paired, and one variable.** Each trial is the same task, the same model,
// the same tool boundary, the same ADP-via-`gh` fixture arm 2 uses. The only
// difference is whether the `claude` invocation is wrapped in
// `adp-recorder wrap`. Everything the agent can see is identical; what changes
// is that a second process is reading its stdout.
//
// The `on` condition also opens an ADP run and, after the trial, asks
// `GET /runs/{id}/verify` whether the trajectory arrived intact — so a trial
// that recorded *nothing* cannot pass as a trial that recorded for free. That
// check is the difference between measuring the recorder and measuring its
// absence.
//
//   ADP_SERVER_URL=... ADP_TOKEN=... node arms/recorder-overhead.mjs \
//     --condition=off|on --task=clamp|titlecase --rep=1 --cohort=NAME \
//     --out=../runs/recorder-overhead-<cohort>-<condition>-<task>-r1.json
//     [--gh-host=localhost:8843] [--cert-file=...] [--adp-owner=local]
//     [--model=claude-haiku-4-5]
//     [--max-budget-usd=1.5] [--root=/tmp/adp-arm5]
//
// **`--root` must be outside any git repository the agent could mistake for
// its project.** The default is a fresh `os.tmpdir()` directory for that
// reason. Pointed inside this repo's own worktree during development, the
// agent's edits were denied by the harness's permission boundary — eight to
// twelve denials per trial — and the `on` condition failed to land three times
// running while `off` landed twice, which looks exactly like "the recorder
// breaks the agent" and is nothing of the kind. The instrument was reading its
// own scaffolding.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkLanded, loadTask, parseArgs, setupAdpGh } from "./lib/adp-fixture.mjs";
import { parseAgentTranscript } from "../lib/transcript.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const RECORDER_MAIN = path.resolve(here, "..", "..", "recorder", "dist", "main.js");

/** The run the recorder records into, and the verdict on what it recorded. */
async function openRun(adpUrl, token, owner, repo, issueNumber) {
  const res = await fetch(`${adpUrl}/api/adp/repos/${owner}/${repo}/runs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ intent_id: await intentOf(adpUrl, token, owner, repo, issueNumber), orchestrator: "arm5" }),
  });
  if (!res.ok) throw new Error(`open run failed: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).id;
}

async function intentOf(adpUrl, token, owner, repo, issueNumber) {
  const res = await fetch(`${adpUrl}/api/v3/repos/${owner}/${repo}/issues/${issueNumber}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`read issue failed: HTTP ${res.status}`);
  const body = await res.json();
  return body.intent_id ?? body.intentId;
}

async function verifyRun(adpUrl, token, owner, repo, runId) {
  const res = await fetch(`${adpUrl}/api/adp/repos/${owner}/${repo}/runs/${runId}/verify`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return { ok: false, reachable: false, status: res.status };
  const body = await res.json();
  return {
    reachable: true,
    ok: body.ok,
    chainsOk: body.chains_ok,
    emittersOk: body.emitters_ok,
    sessions: (body.sessions ?? []).length,
    events: (body.sessions ?? []).reduce((n, s) => n + (s.event_count ?? 0), 0),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const condition = args.condition;
  const taskId = args.task;
  const rep = Number(args.rep ?? 1);
  const cohort = args.cohort ?? null;
  const adpUrl = process.env.ADP_SERVER_URL;
  const token = process.env.ADP_TOKEN;
  const model = args.model ?? "claude-haiku-4-5";
  const maxBudgetUsd = args["max-budget-usd"] ?? "1.5";
  const ghHost = args["gh-host"] ?? "localhost:8843";
  const certFile = args["cert-file"];
  const root = args.root ?? mkdtempSync(path.join(os.tmpdir(), "adp-arm5-"));
  const runId = crypto.randomBytes(3).toString("hex");

  if (!["off", "on"].includes(condition)) {
    console.error("Usage: --condition=off|on --task=clamp|titlecase --rep=N --cohort=NAME --out=FILE");
    process.exit(2);
  }
  if (!adpUrl || !token) {
    console.error("ADP_SERVER_URL and ADP_TOKEN are required");
    process.exit(2);
  }
  // Refused rather than skipped. A trial that quietly ran without the recorder
  // because the artifact was missing would land in the `on` column as evidence
  // that recording is free, which is the one wrong answer this arm can give.
  if (condition === "on" && !existsSync(RECORDER_MAIN)) {
    console.error(`recorder not built at ${RECORDER_MAIN} — run: npm run build --prefix recorder`);
    process.exit(2);
  }

  const task = loadTask(taskId);
  mkdirSync(root, { recursive: true });
  const trialDir = path.join(root, `${condition}-${taskId}-r${rep}-${runId}`);

  // Whose org the fixture repos live under. Arm 2 hardcoded `duvabench`
  // because that is what its instance had; a fresh `make local` provisions
  // `local` and nothing else, so this is a flag rather than a constant.
  const target = await setupAdpGh({
    adpUrl, ghHost, certFile, token, taskId, rep, runId, task,
    owner: args["adp-owner"] ?? "duvabench",
  });

  let adpRunId = null;
  if (condition === "on") {
    adpRunId = await openRun(adpUrl, token, target.owner, target.repo, target.issueNumber);
  }

  execFileSync("git", ["clone", target.cloneUrl, trialDir], { stdio: "pipe", env: { ...process.env, ...target.env } });
  execFileSync("git", ["checkout", "-b", target.work, `origin/${target.base}`], { cwd: trialDir, stdio: "pipe" });
  execFileSync("git", ["config", "--local", "user.email", "agent@adp-bench.invalid"], { cwd: trialDir });
  execFileSync("git", ["config", "--local", "user.name", "arm5-agent"], { cwd: trialDir });

  const prompt = `${task.goal}\n\n---\n\nHow to open and land the PR in this environment: ${target.instructions}`;
  const claudeArgs = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--max-budget-usd", String(maxBudgetUsd),
    "--allowedTools", ...target.allowedTools,
  ];

  // The one variable. `wrap` spawns the same `claude` with the same arguments
  // and passes its stdout through unchanged, so the transcript parsed below is
  // the same document in both conditions — which is what makes the two columns
  // comparable rather than merely adjacent.
  // Absolute, because the recorder runs with `cwd: trialDir` and `flush` runs
  // from here — a relative spool path put them in two different directories,
  // and the flush then reported "nothing spooled" about a spool that existed.
  const spoolDir = path.resolve(root, `spool-${condition}-${taskId}-r${rep}-${runId}`);
  const [command, commandArgs] =
    condition === "on"
      ? [
          process.execPath,
          [
            RECORDER_MAIN, "wrap",
            "--repo", `${target.owner}/${target.repo}`,
            "--run", adpRunId,
            "--harness", "claude-code",
            "--", "claude", ...claudeArgs,
          ],
        ]
      : ["claude", claudeArgs];

  const startedAt = Date.now();
  const proc = spawnSync(command, commandArgs, {
    cwd: trialDir,
    env: {
      ...process.env,
      ...target.env,
      ADP_SERVER_URL: adpUrl,
      ADP_TOKEN: token,
      ADP_RECORDER_SPOOL: spoolDir,
      ADP_RECORDER_ID: `arm5-${condition}-${taskId}-r${rep}`,
      ADP_RECORDER_FLUSH_INTERVAL_MS: "2000",
    },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const wallClockMs = Date.now() - startedAt;

  // The raw stream, kept beside the record. Arm 2 does not keep transcripts and
  // did not need to; this arm compares two conditions whose only difference is
  // a wrapper, so when the two columns disagree the transcript is the only
  // place the reason can be. Written under --root, which is scratch, not
  // committed.
  const transcriptPath = path.join(root, `transcript-${condition}-${taskId}-r${rep}-${runId}.jsonl`);
  writeFileSync(transcriptPath, proc.stdout ?? "");

  const { toolCalls, toolErrors, permissionDenials, escapeHatchCalls, toolBreakdown, finalResult } =
    parseAgentTranscript(proc.stdout ?? "");

  // Anything the recorder could not deliver during the trial. Drained here
  // rather than left, so the verification below is about what the recorder
  // captured and not about how long its timer happened to have.
  let flush = null;
  if (condition === "on") {
    const drained = spawnSync(process.execPath, [RECORDER_MAIN, "flush"], {
      env: { ...process.env, ADP_SERVER_URL: adpUrl, ADP_TOKEN: token, ADP_RECORDER_SPOOL: spoolDir },
      encoding: "utf8",
    });
    flush = { status: drained.status, stderr: (drained.stderr ?? "").trim().split("\n").slice(-2).join(" ") };
  }

  const landed = checkLanded({ cloneDir: trialDir, base: target.base, outputFile: task.outputFile, env: target.env });
  const trajectory =
    condition === "on"
      ? { runId: adpRunId, ...(await verifyRun(adpUrl, token, target.owner, target.repo, adpRunId)) }
      : null;

  const record = {
    recordedAt: new Date().toISOString(),
    arm: "recorder-overhead",
    cohort,
    deterministic: false,
    // The paired variable, named the same way in every record so the report
    // can pair on (task, rep) and difference the columns.
    condition,
    taskId,
    rep,
    runId,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      model,
      adpUrl,
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
      toolBreakdown,
      escapeHatchCalls,
      isError: finalResult?.is_error ?? proc.status !== 0,
      terminalReason: finalResult?.terminal_reason ?? null,
      landed,
    },
    // Null in the `off` condition by construction. Present and checked in
    // `on`, because "the recorder cost nothing" is only interesting alongside
    // "and it recorded the session".
    trajectory,
    flush,
  };

  const out = args.out ?? path.join(here, "..", "runs", `recorder-overhead-${cohort ?? "adhoc"}-${condition}-${taskId}-r${rep}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
  console.error(
    `arm5 ${condition} ${taskId} r${rep}: ` +
      `$${(record.measurement.totalCostUsd ?? 0).toFixed(4)}, ${toolCalls} tool calls, ` +
      `landed=${landed}` +
      (trajectory ? `, trajectory ${trajectory.events} events chains_ok=${trajectory.chainsOk}` : ""),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
