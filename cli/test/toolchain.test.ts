import { describe, it, expect } from "vitest";
import { detectToolchain, renderAdpYaml, type RepoFiles } from "../src/toolchain.js";

const repo = (files: Record<string, string>): RepoFiles => ({
  has: (p) => p in files,
  read: (p) => files[p] ?? null,
});

// #153's argument is that `adp.yaml` asks for four things a repository has
// already written down. These tests are about whether it reads them correctly,
// because a wrong detection is not a neutral default — it produces a gate that
// can only ever fail, which is worse than no gate at all.
describe("detectToolchain", () => {
  it("reads the gates off the scripts block, in the order a reader would run them", () => {
    const t = detectToolchain(
      repo({
        "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", build: "tsc" } }),
        "package-lock.json": "{}",
      }),
    );
    expect(t.ecosystem).toBe("node");
    expect(t.gates.map((g) => g.name)).toEqual(["lint", "build", "test"]);
    expect(t.gates.find((g) => g.name === "test")!.run).toBe("npm run test");
  });

  // `npm ci` requires a lockfile and fails loudly without one — the right
  // command when there is one and the wrong one when there is not.
  it("chooses the setup command the lockfile's presence decides", () => {
    expect(detectToolchain(repo({ "package.json": "{}", "package-lock.json": "{}" })).setup).toBe("npm ci");
    expect(detectToolchain(repo({ "package.json": "{}" })).setup).toBe("npm install");
  });

  // A gate naming a script the repository does not have can only ever fail,
  // which is a worse starting state than having no gate.
  it("never names a script the repository does not have", () => {
    const t = detectToolchain(repo({ "package.json": JSON.stringify({ scripts: { start: "node ." } }) }));
    expect(t.gates).toEqual([]);
  });

  it("degrades rather than failing on a package.json that does not parse", () => {
    const t = detectToolchain(repo({ "package.json": "{ not json" }));
    expect(t.ecosystem).toBe("node");
    expect(t.gates).toEqual([]);
  });

  it("recognises the other ecosystems by their own markers", () => {
    expect(detectToolchain(repo({ "go.mod": "module x" })).ecosystem).toBe("go");
    expect(detectToolchain(repo({ "Cargo.toml": "" })).ecosystem).toBe("rust");
    expect(detectToolchain(repo({ "Gemfile": "" })).ecosystem).toBe("ruby");
    expect(detectToolchain(repo({ "pyproject.toml": "" })).setup).toBe("pip install -e .");
    expect(detectToolchain(repo({ "requirements.txt": "" })).setup).toBe("pip install -r requirements.txt");
  });

  // A polyglot repository gets one answer and not a merged guess: a merged one
  // produces an adp.yaml that runs neither toolchain correctly.
  it("picks one ecosystem rather than merging two", () => {
    const t = detectToolchain(repo({ "package.json": "{}", "go.mod": "module x" }));
    expect(t.ecosystem).toBe("node");
  });

  // Nothing recognised is an answer, not a failure. A repository ADP cannot
  // read is still one ADP can host.
  it("returns a usable answer for a repository it does not recognise", () => {
    const t = detectToolchain(repo({ "README.md": "# hi" }));
    expect(t.ecosystem).toBeNull();
    expect(t.gates).toEqual([]);
    expect(t.evidence).toEqual([]);
  });
});

describe("renderAdpYaml", () => {
  it("writes a runner block only when there is something to run", () => {
    const withGates = renderAdpYaml(
      detectToolchain(repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }) })),
      { landRequire: [] },
    );
    expect(withGates).toContain("runner:");
    expect(withGates).toContain("image: node:22");
    expect(withGates).toContain("run: npm run test");

    const without = renderAdpYaml(detectToolchain(repo({ "README.md": "" })), { landRequire: [] });
    expect(without).not.toContain("runner:");
    expect(without).toContain("gates: []");
  });

  // #174: `one_approval` is author-independent, so a solo evaluator cannot
  // satisfy it — writing it in by default would hand the audience least able to
  // absorb a refusal one they structurally cannot clear.
  it("leaves the land requirements empty, and says when to add the one that matters", () => {
    const yaml = renderAdpYaml(detectToolchain(repo({})), { landRequire: [] });
    expect(yaml).toContain("require: []");
    expect(yaml).toContain("second principal");
  });

  it("says it was generated and asks to be reviewed", () => {
    expect(renderAdpYaml(detectToolchain(repo({})), { landRequire: [] })).toContain("adp init");
    expect(renderAdpYaml(detectToolchain(repo({})), { landRequire: [] })).toContain("Review it");
  });
});
