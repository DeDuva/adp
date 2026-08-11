import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFileAsync = promisify(execFile);

// Extracts onto the *runner host's* filesystem, not into a container —
// docker.ts's `docker cp` is the step that gets these files into the
// isolated container. Real `tar` (already a hard dependency of this package
// via `docker cp`'s own tar-stream wire format) rather than a pure-JS
// extractor, so this stays a small, auditable shell-out matching every other
// external-program seam in this codebase (git, docker).
export async function materializeCheckout(tar: Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "adp-runner-checkout-"));
  const tarPath = path.join(dir, "checkout.tar");
  await writeFile(tarPath, tar);
  try {
    await execFileAsync("tar", ["-xf", tarPath], { cwd: dir });
  } finally {
    await rm(tarPath, { force: true });
  }
  return dir;
}
