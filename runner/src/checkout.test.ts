import { describe, it, expect, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { materializeCheckout } from "./checkout.js";

const execFileAsync = promisify(execFile);

// Real `tar`, both to build the fixture and to prove materializeCheckout —
// the server produces these bytes with `git archive --format=tar`
// (core/git-backend.ts), so a fixture built any other way would only prove
// this function reads what it wrote, not what the real producer writes.
describe("materializeCheckout", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function buildTar(files: Record<string, string>): Promise<Buffer> {
    const srcDir = await mkdtemp(path.join(tmpdir(), "adp-runner-checkout-fixture-"));
    dirs.push(srcDir);
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(srcDir, name), content);
    }
    const { stdout } = await execFileAsync("tar", ["-cf", "-", "-C", srcDir, ...Object.keys(files)], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout as unknown as Buffer;
  }

  it("extracts a tarball into a fresh directory it returns", async () => {
    const tar = await buildTar({ "hello.txt": "world" });
    const dir = await materializeCheckout(tar);
    dirs.push(dir);
    expect(await readFile(path.join(dir, "hello.txt"), "utf8")).toBe("world");
  });

  it("extracts multiple files preserving their content", async () => {
    const tar = await buildTar({ "a.txt": "one", "b.txt": "two" });
    const dir = await materializeCheckout(tar);
    dirs.push(dir);
    expect(await readFile(path.join(dir, "a.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(dir, "b.txt"), "utf8")).toBe("two");
  });

  it("returns a different directory each call, so concurrent jobs never collide", async () => {
    const tar = await buildTar({ "f.txt": "x" });
    const dir1 = await materializeCheckout(tar);
    const dir2 = await materializeCheckout(tar);
    dirs.push(dir1, dir2);
    expect(dir1).not.toBe(dir2);
  });
});
