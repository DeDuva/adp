import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUILTIN_READERS,
  builtinHarnesses,
  createBuiltinReader,
  DEFAULT_HARNESS,
  loadReaderModule,
  resolveReader,
} from "./index.js";

/** A reader module written the way a third party would write one. */
function writeReaderModule(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "adp-reader-"));
  const file = path.join(dir, "reader.mjs");
  writeFileSync(file, body);
  return file;
}

describe("the reader registry", () => {
  it("ships two harnesses, and the default is one of them", () => {
    // #150's shape, not an arbitrary count: one reader is an implementation
    // detail of the recorder, and two is the point at which the interface has
    // to be real.
    expect(builtinHarnesses()).toEqual(["claude-code", "codex"]);
    expect(builtinHarnesses()).toContain(DEFAULT_HARNESS);
  });

  it("says which stream each harness has to be able to produce", () => {
    // The first question an adopter asks is whether their harness is covered,
    // and the honest answer is about a stream rather than a product name.
    for (const reader of BUILTIN_READERS) expect(reader.stream.length).toBeGreaterThan(0);
  });

  it("hands out a fresh reader each time", () => {
    // Readers hold correlation state. One shared instance across two sessions
    // would pair a tool call from one with a result from the other.
    expect(createBuiltinReader("codex")).not.toBe(createBuiltinReader("codex"));
    expect(createBuiltinReader("nothing-by-that-name")).toBeNull();
  });

  it("refuses an unknown harness instead of defaulting to one", async () => {
    // The failure this prevents is the expensive kind: recording a codex
    // stream through the claude-code parser succeeds, produces a trajectory of
    // `custom` events, looks like a recording, and is worthless — and the
    // person who typed the wrong name finds out days later, from the record
    // they were relying on.
    await expect(resolveReader({ harness: "aider" })).rejects.toThrow(/no reader for harness 'aider'/);
    // And it names the way out, which is what #145 established a refusal owes
    // the person reading it.
    await expect(resolveReader({ harness: "aider" })).rejects.toThrow(/--reader/);
  });

  it("loads a reader nobody here wrote, from a path", async () => {
    // The claim #150 makes: a third-party reader can be written against the
    // documented interface without patching this package.
    const file = writeReaderModule(`
      export function createReader() {
        return {
          read: (line) => (line.trim() ? [{ kind: "message", type: "assistant", payload: { text: line } }] : []),
          end: () => [],
        };
      }
    `);
    const reader = await resolveReader({ harness: "some-other-harness", module: file });
    expect(reader.read("hello")).toEqual([{ kind: "message", type: "assistant", payload: { text: "hello" } }]);
    expect(reader.end()).toEqual([]);
  });

  it("accepts a default export as the factory", async () => {
    const file = writeReaderModule(`export default () => ({ read: () => [], end: () => [] });`);
    await expect(loadReaderModule(file)).resolves.toMatchObject({});
  });

  it("fails at startup, not at end of session, when the module is wrong", async () => {
    // Every one of these is a startup error with a message. A reader
    // validated later — or not at all — fails as a session that recorded
    // nothing, which is the outcome the recorder exists to prevent.
    await expect(loadReaderModule("./no-such-module.mjs")).rejects.toThrow(/cannot load reader module/);

    const noFactory = writeReaderModule(`export const somethingElse = 1;`);
    await expect(loadReaderModule(noFactory)).rejects.toThrow(/exports no 'createReader' function/);

    const notAReader = writeReaderModule(`export function createReader() { return { read: 1 }; }`);
    await expect(loadReaderModule(notAReader)).rejects.toThrow(/needs read\(\) and end\(\)/);
  });
});
