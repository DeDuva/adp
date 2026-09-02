import { describe, it, expect } from "vitest";
import { COMMANDS, match, usage } from "../src/index.js";

// #153's "this is where the CLI earns a subcommand framework", answered with
// the half that is actually earned: one list, so the dispatcher and the usage
// text cannot drift apart. These are the assertions that make that true rather
// than merely intended.
describe("the command table", () => {
  it("documents every command it dispatches, and dispatches every one it documents", () => {
    const help = usage();
    for (const command of COMMANDS) {
      const line = `adp ${command.path.join(" ")}`;
      expect(help, `${line} is dispatchable but undocumented`).toContain(line);
      expect(match(command.path), `${line} is documented but unreachable`).not.toBeNull();
      expect(match(command.path)!.command).toBe(command);
    }
  });

  // `bakeoff results` must not be swallowed by `bakeoff`, and `runner up` must
  // not be swallowed by a bare `runner` — which is the one thing a flat table
  // gets wrong if it matches in declaration order.
  it("prefers the longer path when two commands share a prefix", () => {
    expect(match(["bakeoff", "results", "--repo", "a/b"])!.command.path).toEqual(["bakeoff", "results"]);
    expect(match(["bakeoff", "--repo", "a/b"])!.command.path).toEqual(["bakeoff"]);
    expect(match(["runner", "up"])!.command.path).toEqual(["runner", "up"]);
  });

  it("passes on only the arguments after the command's own words", () => {
    expect(match(["pr", "merge", "--repo", "a/b"])!.rest).toEqual(["--repo", "a/b"]);
    expect(match(["bakeoff", "results", "--repo", "a/b"])!.rest).toEqual(["--repo", "a/b"]);
  });

  it("matches nothing for a word that is not a command", () => {
    expect(match(["nonsense"])).toBeNull();
    // A bare `runner` is not a command: `runner up` is. Matching it to
    // something would run the wrong thing rather than print the usage.
    expect(match(["runner"])).toBeNull();
  });

  it("gives every command a summary that says what it does", () => {
    for (const command of COMMANDS) {
      expect(command.summary.length, `${command.path.join(" ")} has no summary`).toBeGreaterThan(10);
      // Present tense, lower case: this reads as a list, and one entry
      // capitalised differently is the kind of thing nobody fixes later.
      expect(command.summary[0]).toBe(command.summary[0]!.toLowerCase());
    }
  });
});
