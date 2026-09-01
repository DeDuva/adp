import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlags } from "../args.js";
import { loadConfig } from "../config.js";

// #155. Starting a gate runner meant knowing two environment variable names, a
// host decision nobody stated, and where the built artifact lives.
//
// The host decision is the part that matters, and it is why this command
// refuses rather than defaults. The runner mounts a Docker socket, and a
// mounted daemon socket is root on the host it is mounted from — so "run it
// wherever you are" is advice that quietly hands root over the machine holding
// the operator's ADP credentials. `--here` is how somebody says they know.
export async function runnerUp(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);

  const serverUrl = flags["server"] ?? process.env.ADP_SERVER_URL ?? (await serverFromLogin());
  if (!serverUrl) {
    throw new Error(
      "no server URL: pass --server <url>, set ADP_SERVER_URL, or run `adp login` first",
    );
  }

  // Deliberately not the login token. That one is the developer's, scoped to
  // repositories they can write; a runner is infrastructure and gets a token
  // scoped to nothing but `runner` (server/src/auth/plugin.ts). Handing it the
  // developer's credential is exactly the mistake the scope exists to prevent,
  // so this refuses rather than falls back to one that would work.
  const token = flags.token ?? process.env.ADP_RUNNER_TOKEN;
  if (!token) {
    throw new Error(
      "no runner token: pass --token <token> or set ADP_RUNNER_TOKEN.\n" +
        "  A runner token is scoped to `runner` and nothing else — do not reuse your own login token,\n" +
        "  which can write to every repository you can.",
    );
  }

  if (flags.here !== "true") {
    throw new Error(
      "refusing to start a runner here without --here.\n" +
        "\n" +
        "  The runner mounts the Docker socket so it can execute a repository's own gates in an\n" +
        "  isolated container. A mounted daemon socket is root on this host, and a gate image is\n" +
        "  named by whoever can push an adp.yaml — so the runner belongs on a host that holds no\n" +
        "  ADP signing key, no database credential, and nothing else you care about.\n" +
        "\n" +
        "  If this machine is that host, say so: adp runner up --here",
    );
  }

  const main = runnerEntrypoint();
  if (!main) {
    throw new Error(
      "the runner is not built. From a checkout of this repository:\n" +
        "  npm ci --prefix runner && npm run build --prefix runner",
    );
  }

  console.log(`starting adp-runner against ${serverUrl}`);
  console.log("  network-deny, no host mounts, no ambient secrets, resource caps — see runner/src/docker.ts");
  const child = spawn(process.execPath, [main], {
    stdio: "inherit",
    env: { ...process.env, ADP_SERVER_URL: serverUrl, ADP_RUNNER_TOKEN: token },
  });
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`adp-runner exited with ${code}`))));
  });
}

// Reuses the server the developer already logged into, so the ordinary case
// needs no flag. Absent is not an error here — the caller decides.
async function serverFromLogin(): Promise<string | undefined> {
  try {
    return (await loadConfig()).serverUrl;
  } catch {
    return undefined;
  }
}

// The built runner, relative to this CLI. Both live in the same repository and
// are built by the same `make deps`; looking for it rather than assuming it is
// what lets the refusal above name the command that fixes it.
function runnerEntrypoint(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../runner/dist/main.js"),
    path.resolve(here, "../../runner/dist/main.js"),
  ];
  return candidates.find((c) => existsSync(c));
}
