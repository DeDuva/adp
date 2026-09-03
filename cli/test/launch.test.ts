import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { harnessCommand, runArms, type LaunchSpec } from "../src/launch.js";

// #242 — launching the harnesses, rather than printing what to run.
//
// `adp bakeoff` created the candidate set and the labelled runs and then
// explicitly did not launch anything: it printed one `adp-recorder wrap …` line
// per harness and left the developer to wire each one in. That is a defensible
// boundary for a substrate and the wrong one for a product — the comparison a
// bake-off exists to produce is exactly what nobody assembles by hand N times,
// so the feature was used least where it is worth most.
//
// Nothing here spawns a real agent. What is under test is the composition: the
// argv each harness gets, the boundedness, and the behaviour when an arm cannot
// start — which is the part that decides whether a bake-off with one missing
// harness produces a comparison or nothing.
describe("#242: launching a harness", () => {
  describe("the command per harness", () => {
    it("asks each one for the stream its reader expects", () => {
      // The other half of this knowledge lives in `recorder/src/readers/`, and
      // these have to agree: a harness launched without its machine-readable
      // output flag records a session with nothing in it.
      expect(harnessCommand("claude-code", "fix it")).toMatchObject({
        command: "claude",
        args: expect.arrayContaining(["--output-format", "stream-json"]),
      });
      expect(harnessCommand("codex", "fix it")).toMatchObject({
        command: "codex",
        args: expect.arrayContaining(["exec", "--json"]),
      });
      expect(harnessCommand("gemini-cli", "fix it")).toMatchObject({
        command: "gemini",
        args: expect.arrayContaining(["--output-format", "json"]),
      });
    });

    it("carries the prompt through", () => {
      for (const harness of ["claude-code", "codex", "gemini-cli"]) {
        expect(harnessCommand(harness, "gate the job lease")!.args).toContain("gate the job lease");
      }
    });

    // Not an error: it degrades to the printed instructions, which is the path
    // that existed before #242 and has to keep existing.
    it("returns nothing for a harness it does not know how to run", () => {
      expect(harnessCommand("something-new", "x")).toBeNull();
    });
  });

  describe("running the arms", () => {
    function spec(harness: string): LaunchSpec {
      return {
        arm: { harness, runId: `run-${harness}`, label: harness },
        command: "node",
        args: ["-e", ""],
        cwd: process.cwd(),
        env: {},
      };
    }

    /** A spawn that never runs anything, and reports what it was asked to run. */
    function fakeSpawn(outcome: (command: string) => { code: number } | { error: string }) {
      const calls: { command: string; args: string[]; cwd?: string }[] = [];
      let live = 0;
      let peak = 0;
      const impl = ((command: string, args: string[], options: { cwd?: string }) => {
        calls.push({ command, args, cwd: options?.cwd });
        live += 1;
        peak = Math.max(peak, live);
        const child = new EventEmitter();
        setTimeout(() => {
          live -= 1;
          const result = outcome(command);
          if ("error" in result) child.emit("error", new Error(result.error));
          else child.emit("close", result.code);
        }, 5);
        return child;
      }) as unknown as typeof import("node:child_process").spawn;
      return { impl, calls, peak: () => peak };
    }

    it("runs every arm and reports each one", async () => {
      const { impl, calls } = fakeSpawn(() => ({ code: 0 }));
      const results = await runArms([spec("claude-code"), spec("codex")], { spawnImpl: impl });
      expect(calls).toHaveLength(2);
      expect(results.map((r) => r.status)).toEqual(["finished", "finished"]);
    });

    // Unbounded fan-out does not fail by being slow. It is N agents against one
    // machine's rate limits, all of them degrading — a comparison of how each
    // harness behaves under contention rather than of how it does the work.
    it("bounds how many run at once", async () => {
      const fake = fakeSpawn(() => ({ code: 0 }));
      await runArms([spec("a"), spec("b"), spec("c"), spec("d")], { spawnImpl: fake.impl, concurrency: 2 });
      expect(fake.peak()).toBeLessThanOrEqual(2);
    });

    // A bake-off where one harness is not installed should still produce the
    // comparison between the ones that are.
    it("keeps going when an arm cannot start", async () => {
      const { impl } = fakeSpawn((command) =>
        command === "node" ? { code: 0 } : { error: "spawn ENOENT" },
      );
      const missing = { ...spec("codex"), command: "not-installed" };
      const results = await runArms([spec("claude-code"), missing], { spawnImpl: impl, concurrency: 1 });

      const byHarness = Object.fromEntries(results.map((r) => [r.arm.harness, r]));
      expect(byHarness["claude-code"]!.status).toBe("finished");
      expect(byHarness.codex!.status).toBe("unavailable");
      expect(byHarness.codex!.reason).toContain("ENOENT");
    });

    it("reports a non-zero exit as failed rather than finished", async () => {
      const { impl } = fakeSpawn(() => ({ code: 1 }));
      const [result] = await runArms([spec("claude-code")], { spawnImpl: impl });
      expect(result).toMatchObject({ status: "failed", code: 1 });
    });

    it("announces each arm before it starts, so the cost is visible in advance", async () => {
      const { impl } = fakeSpawn(() => ({ code: 0 }));
      const started: string[] = [];
      await runArms([spec("claude-code"), spec("codex")], {
        spawnImpl: impl,
        concurrency: 1,
        onStart: (s) => started.push(s.arm.harness),
      });
      expect(started).toEqual(["claude-code", "codex"]);
    });

    it("does nothing at all when there is nothing to run", async () => {
      const { impl, calls } = fakeSpawn(() => ({ code: 0 }));
      expect(await runArms([], { spawnImpl: impl })).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });
});
