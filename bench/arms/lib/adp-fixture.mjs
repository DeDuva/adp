// The fixture an ADP-backed bench arm needs: a repo, a seeded starter, an
// intent, and the `gh`-against-ADP environment that reaches them.
//
// Extracted from `three-way-cost.mjs` when a second arm needed the same
// fixture. It could not be imported from there — that file runs `main()` on
// import, which is the same reason `lib/transcript.mjs` exists — and copying
// it would have left two definitions of "how a bench arm sets up an ADP repo"
// to drift apart. The functions below are moved rather than rewritten, so arm
// 2's published records stay reproducible by the code that produced them.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { adpClient } from "./adp-rest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const benchRoot = path.resolve(here, "..", "..");

export function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) args[arg.slice(2)] = true;
    else args[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return args;
}

export function sh(cmd, args, opts = {}) {
  const res = execFileSync(cmd, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts });
  return res.trim();
}

export function loadTask(taskId) {
  const dir = path.join(benchRoot, "tasks/arm2", taskId);
  const goal = readFileSync(path.join(dir, "goal.md"), "utf8");
  const starterDir = path.join(dir, "starter");
  const outputFile = { clamp: "clamp.js", titlecase: "titlecase.js" }[taskId];
  if (!outputFile) throw new Error(`unknown task ${taskId}`);
  return { dir, goal, starterDir, outputFile };
}

export function seedAdpRepo({ owner, repo, task, adpUrl, token }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "adp-arm2-seed-"));
  const url = adpClient(adpUrl, token).cloneUrl(owner, repo);
  sh("git", ["clone", url, dir]);
  execFileSync("cp", ["-r", `${task.starterDir}/.`, dir]);
  sh("git", ["add", "-A"], { cwd: dir });
  sh("git", ["-c", "user.email=bench@adp.invalid", "-c", "user.name=adp-bench", "commit", "-q", "-m", "seed: starter"], { cwd: dir });
  sh("git", ["push", "origin", "HEAD:main"], { cwd: dir });
  rmSync(dir, { recursive: true, force: true });
}

// `owner` is a parameter with arm 2's value as its default, so arm 2's
// behaviour is unchanged and an arm running against an instance that has a
// different org — a fresh `make local`, which provisions `local` and nothing
// else — can say so rather than 404.
export async function setupAdpGh({ adpUrl, ghHost, certFile, token, taskId, rep, runId, task, owner = "duvabench" }) {
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

export function work_placeholder(taskId, rep, runId) {
  return `arm2/work-${taskId}-r${rep}-${runId}`;
}

export function checkLanded({ cloneDir, base, outputFile, env }) {
  try {
    execFileSync("git", ["fetch", "origin", base], { cwd: cloneDir, stdio: "pipe", env: { ...process.env, ...env } });
    execFileSync("git", ["show", `origin/${base}:${outputFile}`], { cwd: cloneDir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}
