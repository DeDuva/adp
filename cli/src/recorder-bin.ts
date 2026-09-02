import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the recorder is, and where this CLI was installed from.
//
// Extracted from `commands/connect.ts` by #242, because `bakeoff --launch` runs
// the harnesses through the same recorder connect wires in — and two answers to
// "where is the recorder" is one answer too many the first time a build layout
// moves.

/** The checkout this CLI was installed from — where the MCP server and the recorder live. */
export function installRoot(): string {
  return path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}

/** The built recorder, or null when there is none — which is a degraded path, not an error. */
export function recorderBin(root: string): string | null {
  const built = path.join(root, "recorder", "dist", "main.js");
  return existsSync(built) ? built : null;
}
