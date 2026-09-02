import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseFlags, splitRepo } from "../args.js";
import { apiRequest, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { addRemote, currentBranch, gitRemotes, remoteRepo, repoRoot } from "../git.js";
import { detectToolchain, renderAdpYaml, type RepoFiles } from "../toolchain.js";

// #153. The strongest brake on adoption is not scepticism about signed evidence
// — it is that moving repositories is unthinkable. ADP already had the answer:
// mirror mode makes it additive to a repo that already lives on GitHub. But
// mirror mode was documented as an operator feature, reached through
// `adp repo mirror` with a remote URL, a secret and a credential to assemble by
// hand. It was not offered as the way in.
//
// So: one command. **Mirror is the default**, because native mode asks a team
// to agree and mirror mode asks one developer to add a remote — and evaluation
// happens at the second price and never at the first. It is detected rather
// than asked for: a checkout with a GitHub remote gets mirrored, one without
// gets a native repository, and `--no-mirror` is how somebody overrides that.
export async function init(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dir = process.cwd();

  const root = repoRoot(dir);
  if (!root) {
    throw new Error(
      "not a git repository. `adp init` attaches ADP to a repository that already exists —\n" +
        "  run it from inside one, or `git init` first.",
    );
  }

  const config = await loadConfig().catch(() => null);
  if (!config) {
    throw new Error("not logged in: run `adp login --server <url> --token <token>` first");
  }

  // Where this repository lives now, which decides both its name and whether
  // there is anything to mirror.
  const upstream = flags.mirror && flags.mirror !== "true" ? flags.mirror : detectUpstream(root, config.serverUrl);
  const target = flags.repo ? splitRepo(flags.repo) : nameFrom(upstream, root);

  console.log(`adp init — ${target.owner}/${target.repo}`);

  // 1. The org, then the repo. Both idempotent: `adp init` run twice is a
  //    repair, not a collision, which is the only way a command that does five
  //    things can be safe to re-run after one of them failed.
  const inferred = !flags.repo;
  await ensureOrg(target.owner);
  const repoState = await ensureRepo(target.owner, target.repo).catch((err: unknown) =>
    explainTargetFailure(err, target, inferred),
  );
  console.log(`  repo:      ${repoState.created ? "created" : "already there"}`);

  // 1b. The remote, without which nothing else here reaches the repository
  //     just created. See git.ts `addRemote` for why this is `adp` and not
  //     `origin`, and why it never takes a name that is already in use.
  const alreadyPointed = remoteRepo(root, config.serverUrl) !== null;
  let pushRemote: string | null = null;
  if (alreadyPointed) {
    console.log("  remote:    already points at this server");
  } else if (repoState.cloneUrl) {
    pushRemote = addRemote(root, repoState.cloneUrl);
    if (pushRemote) {
      console.log(`  remote:    added '${pushRemote}' → ${repoState.cloneUrl}`);
    } else {
      console.log(`  remote:    add one by hand — git remote add adp ${repoState.cloneUrl}`);
    }
  }

  // 2. Mirror, unless told not to. This is the step that makes adoption
  //    additive rather than a migration.
  const wantsMirror = flags["no-mirror"] !== "true" && upstream !== null;
  if (wantsMirror) {
    await configureMirror(target, upstream!, flags.credential ?? process.env.GITHUB_TOKEN);
  } else if (upstream === null) {
    console.log("  mirror:    no upstream remote found — this is a native ADP repository");
  } else {
    console.log("  mirror:    skipped (--no-mirror)");
  }

  // 3. The toolchain, written rather than asked about.
  writeAdpYaml(root);

  // 4. The runner. #153 asked for this to be started; #155 then decided a
  //    runner must not start without being told this is the right host, because
  //    it mounts the Docker socket and a mounted daemon socket is root on the
  //    machine it is mounted from. The later decision wins, and `--runner` is
  //    how one command still does it: the flag *is* the acknowledgement.
  reportRunner(flags.runner === "true");

  // The push is the step that was missing, and its absence was invisible: every
  // line above succeeded, and then `adp watch` answered "no open pull request
  // yet" — correct, and describing a repository nothing had ever been pushed to.
  console.log("");
  console.log("Next:");
  console.log(`  git add adp.yaml && git commit -m "add adp.yaml"   # review it first`);
  if (pushRemote) {
    const branch = currentBranch(root);
    console.log(`  git push -u ${pushRemote} ${branch ?? "<branch>"}`);
    // The remote is added without a credential in it, so the first push asks
    // for one — and "Username for https://…" is not a question whose answer is
    // obvious, since the answer is a token in the password field and any string
    // at all in the username. Saying it here costs a line; not saying it turns
    // the step this command exists to unblock into a prompt nobody can answer.
    //
    // Deliberately not embedded in the remote URL. `adp connect` does write live
    // tokens into the working tree, and gets away with it by excluding those
    // files per clone — but a URL in `.git/config` is echoed by `git remote -v`
    // and by every push's error output, which is a different exposure.
    console.log("             git authenticates with your token as the password");
    console.log("             (any username), or use a credential helper");
  }
  console.log(`  adp watch --repo ${target.owner}/${target.repo}`);
}

// Any remote that is not this ADP server is an upstream worth mirroring.
//
// Deliberately not limited to github.com: mirror mode speaks the git wire
// protocol and a webhook shape, and GitLab and Gitea serve both. And matched by
// *host against the configured server*, the same way `remoteRepo` decides the
// opposite question — a shape test would have called a `file://` upstream no
// remote at all, which is what the first version of this did.
function detectUpstream(root: string, serverUrl: string): string | null {
  let serverHost: string | null = null;
  try {
    serverHost = new URL(serverUrl).host;
  } catch {
    serverHost = null;
  }
  for (const { url } of gitRemotes(root)) {
    let host: string | null = null;
    try {
      // `git@github.com:acme/x.git` is not a URL any parser accepts; its host
      // is the part before the colon.
      host = url.startsWith("git@") ? (url.slice(4).split(":")[0] ?? null) : new URL(url).host;
    } catch {
      host = null;
    }
    // A `file://` upstream has no host and is still an upstream — it is what
    // the acceptance suite mirrors against, and a developer with a bare repo on
    // a shared filesystem is the same case.
    if (serverHost !== null && host === serverHost) continue;
    return url;
  }
  return null;
}

// The repository's name, from the upstream if there is one and from the
// directory if there is not. Never prompted for: the answer is written down in
// two places already.
function nameFrom(upstream: string | null, root: string): { owner: string; repo: string } {
  if (upstream) {
    const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(upstream);
    if (match) return { owner: sanitize(match[1]!), repo: sanitize(match[2]!) };
  }
  return { owner: sanitize(path.basename(path.dirname(root))), repo: sanitize(path.basename(root)) };
}

// The server's own rule for a path segment (server/src/core/git-backend.ts):
// letters, digits, dot, underscore, hyphen. A GitHub org with a character
// outside that would otherwise fail at the create call with a 422 naming a
// constraint the user never chose.
function sanitize(segment: string): string {
  const cleaned = segment.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[.]+$/, "repo");
  return cleaned || "repo";
}

// Both creates are idempotent, and both say "already exists" with a **422**
// rather than a 409 — `/api/adp/orgs` and `/api/v3/repos/{owner}` each use 422
// for a conflict as well as for a malformed name. So this matches the sentence
// rather than the status: swallowing every 422 would also swallow "owner 'x' is
// not a valid repository owner", which is the one failure here a person has to
// see, because it means the name was guessed wrong.
function isAlreadyExists(err: unknown): boolean {
  return err instanceof ApiError && /already exists/i.test(err.message);
}

async function ensureOrg(owner: string): Promise<void> {
  try {
    await apiRequest("POST", "/api/adp/orgs", { name: owner });
  } catch (err) {
    if (isAlreadyExists(err)) return;
    // An instance whose token lacks `admin` cannot provision an org at all,
    // which is not a reason to stop: the org may well exist already, and the
    // repo create below says so precisely if it does not.
    if (err instanceof ApiError && err.status === 403) return;
    throw err;
  }
}

type RepoState = { created: boolean; cloneUrl: string | null };

function cloneUrlOf(body: unknown): string | null {
  const url = (body as { clone_url?: unknown } | null)?.clone_url;
  return typeof url === "string" && url ? url : null;
}

async function ensureRepo(owner: string, repo: string): Promise<RepoState> {
  try {
    const body = await apiRequest("POST", `/api/v3/repos/${owner}`, { name: repo });
    return { created: true, cloneUrl: cloneUrlOf(body) };
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    // Re-reading it is what makes a second `adp init` a repair rather than a
    // half-run: the remote below needs the clone URL whether or not this
    // invocation is the one that created the repository.
    const body = await apiRequest("GET", `/api/v3/repos/${owner}/${repo}`).catch(() => null);
    return { created: false, cloneUrl: cloneUrlOf(body) };
  }
}

/**
 * Say which organization was tried, where the name came from, and what
 * overrides it.
 *
 * With no `--repo` and no upstream, the owner is inferred from the *parent
 * directory name* — which is a reasonable default and a terrible thing to fail
 * on silently. Run in `~/scratch/trial` against an instance whose org is
 * `local`, `adp init` reported `Not a member of this organization (HTTP 403)`
 * and stopped: no organization named, no hint that a directory name had been
 * turned into one, and no mention of the flag that fixes it.
 *
 * The house standard is set twice over — `adp connect`'s refusal names both
 * remedies, and the land-policy 422 names the command that satisfies each unmet
 * requirement. This is that standard applied to the first command anyone runs.
 */
function explainTargetFailure(err: unknown, target: { owner: string; repo: string }, inferred: boolean): never {
  if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
    const source = inferred
      ? "That name was inferred from the directory this repository sits in, not chosen."
      : "That name came from --repo.";
    throw new Error(
      `${err.message}\n` +
        `  organization: ${target.owner}   (repository ${target.repo})\n` +
        `  ${source}\n` +
        `  Name it explicitly with:  adp init --repo <owner>/${target.repo}\n` +
        `  The owner has to be an organization your token is a member of.`,
    );
  }
  throw err;
}

async function configureMirror(
  target: { owner: string; repo: string },
  remoteUrl: string,
  credential: string | undefined,
): Promise<void> {
  if (!credential) {
    // Named rather than prompted for, and the command that finishes the job is
    // printed. A credential is the one input here that is genuinely
    // irreducible — only a human can supply it — so stopping is correct; going
    // silent about how to resume is not.
    console.log(`  mirror:    ${remoteUrl}`);
    console.log("             needs a credential ADP can push with — pass --credential or set GITHUB_TOKEN:");
    console.log(`             adp init --credential <token>`);
    return;
  }

  // Generated rather than asked for: it is a shared secret between two machines
  // and neither of them is the person typing.
  const secret = randomBytes(24).toString("hex");
  try {
    await apiRequest("POST", `/api/v3/repos/${target.owner}/${target.repo}/mirror`, {
      remote_url: remoteUrl,
      direction: "both",
      credential,
      webhook_secret: secret,
    });
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    console.log(`  mirror:    ${remoteUrl} (already configured)`);
    return;
  }
  console.log(`  mirror:    ${remoteUrl}, both directions`);
  console.log("             your remote and your pull requests do not change — the ADP record fills anyway.");
  console.log("             Point a GitHub webhook at this ADP instance to make inbound immediate:");
  console.log(`             ${webhookUrlFor(target)}`);
  console.log(`             secret: ${secret}`);
}

function webhookUrlFor(target: { owner: string; repo: string }): string {
  return `<your ADP public URL>/webhooks/github/${target.owner}/${target.repo}`;
}

function writeAdpYaml(root: string): void {
  const file = path.join(root, "adp.yaml");
  if (existsSync(file)) {
    console.log("  adp.yaml:  already there, left alone");
    return;
  }

  const files: RepoFiles = {
    has: (p) => existsSync(path.join(root, p)),
    read: (p) => {
      try {
        return readFileSync(path.join(root, p), "utf8");
      } catch {
        return null;
      }
    },
  };
  const toolchain = detectToolchain(files);
  // Written, not committed. Committing on a user's behalf is the one step here
  // that would put something in their history they did not read — and the
  // whole design position is "write it, print it, tell them to review it".
  writeFileSync(file, renderAdpYaml(toolchain, { landRequire: [] }), "utf8");

  const detected = toolchain.ecosystem
    ? `${toolchain.ecosystem} (${toolchain.evidence.join(", ")})`
    : "nothing recognised";
  console.log(`  adp.yaml:  written — ${detected}`);
  for (const gate of toolchain.gates) console.log(`             gate ${gate.name}: ${gate.run}`);
  if (toolchain.gates.length === 0) {
    console.log("             no gates — review it and add what this repository actually runs");
  }
}

function reportRunner(wanted: boolean): void {
  if (wanted) {
    console.log("  runner:    start it with the command below — `adp init --runner` does not fork one for you,");
    console.log("             because a runner that outlives this command is a process you did not choose to keep.");
  } else {
    // The one line #153 asked for.
    console.log("  runner:    not started — a runner mounts the Docker socket, which is root on this host.");
  }
  console.log(`             adp runner up --here    # on a host that holds nothing you care about`);
}
