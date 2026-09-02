import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseFlags, splitRepo } from "../args.js";
import { apiRequest, ApiError } from "../api.js";
import { loadConfig } from "../config.js";
import { gitRemotes, repoRoot } from "../git.js";
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
  await ensureOrg(target.owner);
  const created = await ensureRepo(target.owner, target.repo);
  console.log(`  repo:      ${created ? "created" : "already there"}`);

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

  console.log("");
  console.log("Next:");
  console.log(`  git add adp.yaml && git commit -m "add adp.yaml"   # review it first`);
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

async function ensureRepo(owner: string, repo: string): Promise<boolean> {
  try {
    await apiRequest("POST", `/api/v3/repos/${owner}`, { name: repo });
    return true;
  } catch (err) {
    if (isAlreadyExists(err)) return false;
    throw err;
  }
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
