import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLAUDE_SETTINGS,
  removeSessionStartHook,
  writeSessionStartHook,
} from "../src/harnesses.js";

// #237 — `adp connect claude-code` leaves nothing for the developer to edit.
//
// It used to write the launcher and then *tell* them to add it as a
// `SessionStart` hook themselves, which failed silently when skipped: sessions
// simply do not appear, and that looks identical to nothing having happened.
//
// The reason it was not written before is real, and is answered rather than
// ignored — `.claude/settings.json` may already hold the developer's own hooks.
// So the discipline is the one the MCP config already follows: **ADP owns one
// entry and never the file.**
describe("#237: the SessionStart hook", () => {
  let root: string;
  const command = "./.adp/record-claude-code";

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "adp-hook-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const settings = () => path.join(root, CLAUDE_SETTINGS);
  const read = () => JSON.parse(readFileSync(settings(), "utf8")) as Record<string, any>;

  function seed(doc: unknown) {
    mkdirSync(path.dirname(settings()), { recursive: true });
    writeFileSync(settings(), JSON.stringify(doc, null, 2));
  }

  it("registers the hook in a file that did not exist", () => {
    const result = writeSessionStartHook(root, command);
    expect(result.created).toBe(true);
    expect(read().hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command });
  });

  it("leaves the developer's own hooks exactly where they were", () => {
    seed({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./their-own-thing" }] }] },
      permissions: { allow: ["Bash(ls)"] },
    });
    writeSessionStartHook(root, command);

    const doc = read();
    // Their setting, untouched.
    expect(doc.permissions).toEqual({ allow: ["Bash(ls)"] });
    const commands = doc.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toEqual(["./their-own-thing", command]);
  });

  // Idempotent by construction rather than by checking, the same way the MCP
  // entry is replaced rather than appended: reconnecting after the launcher
  // path changes repairs the entry instead of leaving two.
  it("does not accumulate a second entry when connect runs again", () => {
    writeSessionStartHook(root, command);
    writeSessionStartHook(root, command);
    const commands = read().hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toEqual([command]);
  });

  it("refuses a file it cannot parse rather than overwriting somebody's settings", () => {
    seed("this is not json" as unknown);
    writeFileSync(settings(), "{not json");
    expect(() => writeSessionStartHook(root, command)).toThrow(/cannot parse/);
    expect(readFileSync(settings(), "utf8")).toBe("{not json");
  });

  describe("disconnect", () => {
    it("removes ADP's hook and nothing beside it", () => {
      seed({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "./their-own-thing" }] }] },
        permissions: { allow: ["Bash(ls)"] },
      });
      writeSessionStartHook(root, command);
      expect(removeSessionStartHook(root, command).removed).toBe(true);

      const doc = read();
      expect(doc.permissions).toEqual({ allow: ["Bash(ls)"] });
      const commands = doc.hooks.SessionStart.flatMap((g: any) => g.hooks.map((h: any) => h.command));
      expect(commands).toEqual(["./their-own-thing"]);
    });

    // Deleting beats leaving `{}`: the difference between no orphaned config
    // and a tidy one.
    it("deletes a file that held nothing but ADP's hook", () => {
      writeSessionStartHook(root, command);
      expect(removeSessionStartHook(root, command).removed).toBe(true);
      expect(existsSync(settings())).toBe(false);
    });

    it("reports nothing removed when it was never connected here", () => {
      seed({ permissions: { allow: [] } });
      expect(removeSessionStartHook(root, command).removed).toBe(false);
      expect(read().permissions).toEqual({ allow: [] });
    });
  });
});
