import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { watchDir } from "./watch.js";

// #237 — noticing a session without the harness telling anyone.
//
// `wrap` is a different command the developer has to remember to type instead
// of their normal one, and it fails silently the first time they forget:
// sessions simply do not appear, which looks identical to nothing having
// happened. Watching the directory the harness writes into needs nothing from
// them at all.
describe("watchDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "adp-watch-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(rel: string, mtime?: number) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "{}\n");
    if (mtime !== undefined) utimesSync(full, mtime / 1000, mtime / 1000);
    return full;
  }

  it("reports a transcript that appears after the watch started", () => {
    const seen: string[] = [];
    const w = watchDir(dir, (f) => seen.push(f));
    const file = write("rollout-1.jsonl");
    w.poll();
    w.stop();
    expect(seen).toEqual([file]);
  });

  // The important default. A directory of past sessions is history, and a
  // watcher that ingested all of it on every start would re-record the
  // developer's entire back catalogue every time they reconnected.
  it("treats what was already there as history", () => {
    write("old.jsonl");
    const seen: string[] = [];
    const w = watchDir(dir, (f) => seen.push(f));
    w.poll();
    w.stop();
    expect(seen).toEqual([]);
  });

  it("records the back catalogue when explicitly asked", () => {
    const old = write("old.jsonl");
    const seen: string[] = [];
    const w = watchDir(dir, (f) => seen.push(f), { backfill: true });
    w.poll();
    w.stop();
    expect(seen).toEqual([old]);
  });

  it("never reports the same transcript twice", () => {
    const seen: string[] = [];
    const w = watchDir(dir, (f) => seen.push(f));
    write("a.jsonl");
    w.poll();
    w.poll();
    w.stop();
    expect(seen).toHaveLength(1);
  });

  // Codex nests its sessions under dated directories, so a flat listing would
  // find nothing at all.
  it("looks into subdirectories", () => {
    const seen: string[] = [];
    const w = watchDir(dir, (f) => seen.push(f));
    const nested = write(path.join("2026", "09", "rollout-2.jsonl"));
    w.poll();
    w.stop();
    expect(seen).toEqual([nested]);
  });

  // A burst that appears between two polls is recorded in the order it was
  // written, not in whatever order the filesystem happens to list.
  it("reports a burst in the order the files were written", () => {
    const seen: string[] = [];
    const w = watchDir(dir, (f) => seen.push(f));
    const later = write("z-later.jsonl", Date.now());
    const earlier = write("a-earlier.jsonl", Date.now() - 60_000);
    w.poll();
    w.stop();
    expect(seen).toEqual([earlier, later]);
  });

  // The ordinary state before the harness has ever run. A watch that threw here
  // would be one that has to be started after the first session, which is the
  // session it exists to catch.
  it("survives being started before the directory exists", () => {
    const missing = path.join(dir, "not-yet");
    const seen: string[] = [];
    const w = watchDir(missing, (f) => seen.push(f));
    w.poll();
    mkdirSync(missing);
    writeFileSync(path.join(missing, "first.jsonl"), "{}\n");
    w.poll();
    w.stop();
    expect(seen).toHaveLength(1);
  });

  it("ignores files that are not transcripts", () => {
    const seen: string[] = [];
    const w = watchDir(dir, (f) => seen.push(f));
    write("notes.txt");
    write("real.jsonl");
    w.poll();
    w.stop();
    expect(seen).toHaveLength(1);
  });
});
