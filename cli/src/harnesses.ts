// What each harness needs written, and where it keeps it.
//
// **Everything `adp connect` writes lives inside the repository.** All three
// harnesses take project-scoped configuration — Claude Code's `.mcp.json`,
// Codex's `.codex/config.toml` (the `Project` layer of its config loader), and
// Gemini CLI's `.gemini/settings.json` — so nothing here reaches into `$HOME`.
// That is worth having for its own sake: disconnecting cannot leave an orphan
// somewhere a user will never look, two checkouts of two projects cannot fight
// over one file, and a connect that went wrong is undone by `git status`.
//
// **ADP owns one key and never the file.** These files belong to their harness
// and to whoever else has edited them, so connect merges into the `adp` entry
// and disconnect removes that entry alone. A file ADP created from nothing is
// remembered as such, so disconnect can delete it rather than leave `{}`
// behind — which is the difference between "leaves no orphaned config" and
// "leaves an empty one".
//
// The formats were taken from each project's own source rather than from
// memory: Codex's `McpServerTransportConfig::Stdio` (`command`, `args`, `env`)
// and Gemini's documented `mcpServers` entry are the same three fields Claude
// Code's `.mcp.json` uses, which is why one spec type covers all three.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** A stdio MCP server, in the shape all three harnesses spell the same way. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface Harness {
  /** The value `adp connect <harness>` takes, and what the token records as its harness. */
  name: string;
  /** Repo-relative path to the file ADP edits. */
  configPath: string;
  format: "json" | "toml";
  /** How the recorder attaches to this harness — see `commands/connect.ts`. */
  recording: "hook" | "wrap";
  /** Named in the report, because an adopter's next question is where their trajectory comes from. */
  stream: string;
  /**
   * Where this harness writes its session transcripts, for the harnesses that
   * offer no hook (#237).
   *
   * `wrap` used to be the answer there — a different command the developer types
   * instead of their normal one, which is capture the developer performs rather
   * than ambient capture, and which fails silently the first time they forget.
   * Watching this directory needs nothing from them at all.
   *
   * A function rather than a string because it reads the environment, and
   * because the honest default for a harness whose layout is not verified here
   * is `null` — a watch pointed at a guess would report success and record
   * nothing.
   */
  sessionsDir?: () => string | null;
}

/** The key ADP owns inside whatever else is in the file. */
export const SERVER_KEY = "adp";

export const HARNESSES: Harness[] = [
  {
    name: "claude-code",
    configPath: ".mcp.json",
    format: "json",
    // The only one that can start the recorder by itself: a SessionStart hook
    // is handed the transcript path, which is exactly what `tail` needs.
    recording: "hook",
    stream: "the session transcript, followed by `adp-recorder tail`, started by a hook connect writes",
  },
  {
    name: "codex",
    configPath: path.join(".codex", "config.toml"),
    format: "toml",
    recording: "wrap",
    stream: "its session transcripts, followed by `adp-recorder watch`",
    // `CODEX_HOME` is Codex's own override for where it keeps everything;
    // `~/.codex` is its default. Named in connect's output rather than assumed
    // silently, so a layout this is wrong about is visible on the line that
    // wires it instead of being a watch that never fires.
    sessionsDir: () =>
      path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "sessions"),
  },
  {
    name: "gemini-cli",
    configPath: path.join(".gemini", "settings.json"),
    format: "json",
    recording: "wrap",
    // Said plainly rather than implied: #150 ships two readers, and this is
    // not one of them. Everything that rides on git and the commit trailer
    // works; the trajectory does not.
    stream: "no reader ships for it — commit-level provenance only, see README",
  },
];

export function findHarness(name: string): Harness | null {
  return HARNESSES.find((h) => h.name === name) ?? null;
}

export function harnessNames(): string[] {
  return HARNESSES.map((h) => h.name);
}

export interface WriteResult {
  /** Absolute path written. */
  file: string;
  /** True when the file did not exist and ADP created it — so disconnect may delete it. */
  created: boolean;
}

/**
 * Put ADP's MCP server into the harness's config, leaving everything else
 * exactly as it was.
 *
 * Idempotent by construction rather than by checking: the entry is *replaced*,
 * not appended, so running connect again after a harness upgrade repairs the
 * entry instead of adding a second one.
 */
export function writeMcpServer(root: string, harness: Harness, spec: McpServerSpec): WriteResult {
  const file = path.join(root, harness.configPath);
  const created = !existsSync(file);
  mkdirSync(path.dirname(file), { recursive: true });
  const before = created ? "" : readFileSync(file, "utf8");
  writeFileSync(
    file,
    harness.format === "json" ? mergeJsonServer(before, spec) : mergeTomlServer(before, spec),
  );
  return { file, created };
}

/** Take ADP's entry back out, and the file too if ADP is all that was ever in it. */
export function removeMcpServer(root: string, harness: Harness): { file: string; removed: boolean } {
  const file = path.join(root, harness.configPath);
  if (!existsSync(file)) return { file, removed: false };
  const before = readFileSync(file, "utf8");
  const after = harness.format === "json" ? removeJsonServer(before) : removeTomlServer(before);
  if (after === null) {
    // Nothing but ADP's own entry was in it. Deleting beats leaving `{}`,
    // which is the difference between no orphaned config and a tidy one.
    rmSync(file, { force: true });
    return { file, removed: true };
  }
  if (after === before) return { file, removed: false };
  writeFileSync(file, after);
  return { file, removed: true };
}

function mergeJsonServer(before: string, spec: McpServerSpec): string {
  let doc: Record<string, unknown> = {};
  if (before.trim()) {
    try {
      doc = JSON.parse(before) as Record<string, unknown>;
    } catch {
      // Refused rather than overwritten. A file this cannot parse is a file
      // somebody wrote, and replacing it with ADP's one key is a worse outcome
      // than saying so.
      throw new Error(`cannot parse ${JSON.stringify(before.slice(0, 40))}… as JSON — fix or move it, then retry`);
    }
  }
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  doc.mcpServers = { ...servers, [SERVER_KEY]: spec };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** Null when the document held nothing but ADP's entry, so the caller can delete the file. */
function removeJsonServer(before: string): string | null {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(before) as Record<string, unknown>;
  } catch {
    return before;
  }
  const servers = (doc.mcpServers ?? {}) as Record<string, unknown>;
  if (!(SERVER_KEY in servers)) return before;
  delete servers[SERVER_KEY];
  if (Object.keys(servers).length === 0) delete doc.mcpServers;
  if (Object.keys(doc).length === 0) return null;
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The one TOML table ADP owns, written and removed as a block of lines.
 *
 * Not a TOML parser, and deliberately not: `cli/` has no dependencies, and
 * everything needed here is "replace the `[mcp_servers.adp]` table". The limit
 * of that is real and worth knowing — a `mcp_servers` written as an inline
 * table (`mcp_servers = { adp = … }`) is a form this will not find, and connect
 * would then add a second, conflicting definition. Codex's own `codex mcp add`
 * writes the table form, so that is the shape this meets in practice.
 */
function mergeTomlServer(before: string, spec: McpServerSpec): string {
  const body = removeTomlServer(before) ?? "";
  const head = body.trimEnd();
  const table = [
    `[mcp_servers.${SERVER_KEY}]`,
    `command = ${tomlString(spec.command)}`,
    `args = [${spec.args.map(tomlString).join(", ")}]`,
    "",
    `[mcp_servers.${SERVER_KEY}.env]`,
    ...Object.entries(spec.env).map(([k, v]) => `${k} = ${tomlString(v)}`),
  ].join("\n");
  return head ? `${head}\n\n${table}\n` : `${table}\n`;
}

function removeTomlServer(before: string): string | null {
  const lines = before.split("\n");
  const kept: string[] = [];
  let skipping = false;
  let found = false;
  for (const line of lines) {
    const isTableHeader = /^\s*\[/.test(line);
    if (isTableHeader) {
      // Both the table and its `.env` sub-table belong to ADP; anything else
      // ends the block, including a table that merely starts with the same
      // prefix in another namespace.
      skipping = new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_KEY}(\\.[A-Za-z0-9_-]+)*\\]`).test(line);
      if (skipping) found = true;
    }
    if (!skipping) kept.push(line);
  }
  if (!found) return before;
  const body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return body === "" ? null : `${body}\n`;
}

/** TOML basic string: the four escapes a path or a URL can actually contain. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

// ---------------------------------------------------------------------------
// The Claude Code hook (#237)
// ---------------------------------------------------------------------------
//
// `connect` used to write the launcher and then *tell* the developer to add it
// as a `SessionStart` hook in `.claude/settings.json` themselves — the last
// step of a command whose promise is one command and then the harness records
// itself. It failed silently when skipped: sessions simply do not appear, which
// looks identical to nothing having happened.
//
// The earlier reasoning for not writing it was that `.claude/settings.json` is
// a file the developer may already have, shared with their own hooks, and that
// merging JSON somebody else owns is how connect comes to own it. That argument
// is right about the risk and wrong about the conclusion: it is the same risk
// `.mcp.json` already carries, and the answer there is the discipline this file
// opens with — **ADP owns one entry and never the file.** The entry is
// recognised by the command it runs, which is the launcher connect wrote, so
// disconnect removes exactly what connect added and nothing beside it.

export const CLAUDE_SETTINGS = path.join(".claude", "settings.json");

interface HookEntry {
  type?: string;
  command?: string;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
}

export function writeSessionStartHook(root: string, command: string): WriteResult {
  const file = path.join(root, CLAUDE_SETTINGS);
  const created = !existsSync(file);
  mkdirSync(path.dirname(file), { recursive: true });

  let doc: Record<string, unknown> = {};
  if (!created) {
    const before = readFileSync(file, "utf8");
    if (before.trim()) {
      try {
        doc = JSON.parse(before) as Record<string, unknown>;
      } catch {
        // Refused rather than overwritten, exactly as the MCP merge refuses:
        // a file this cannot parse is a file somebody wrote.
        throw new Error(`cannot parse ${CLAUDE_SETTINGS} as JSON — fix or move it, then retry`);
      }
    }
  }

  const hooks = (doc.hooks ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as HookGroup[]) : [];
  // Replaced rather than appended, so reconnecting after the launcher path
  // changes repairs the entry instead of leaving two — the same reason the MCP
  // entry is replaced.
  const others = groups
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => h.command !== command) }))
    .filter((group) => (group.hooks ?? []).length > 0);
  hooks.SessionStart = [...others, { hooks: [{ type: "command", command }] }];
  doc.hooks = hooks;

  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { file, created };
}

export function removeSessionStartHook(root: string, command: string): { file: string; removed: boolean } {
  const file = path.join(root, CLAUDE_SETTINGS);
  if (!existsSync(file)) return { file, removed: false };
  const before = readFileSync(file, "utf8");
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(before) as Record<string, unknown>;
  } catch {
    return { file, removed: false };
  }

  const hooks = (doc.hooks ?? {}) as Record<string, unknown>;
  const groups = Array.isArray(hooks.SessionStart) ? (hooks.SessionStart as HookGroup[]) : [];
  const kept = groups
    .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((h) => h.command !== command) }))
    .filter((group) => (group.hooks ?? []).length > 0);
  if (kept.length === groups.length && groups.every((g, i) => (g.hooks ?? []).length === (kept[i]?.hooks ?? []).length)) {
    return { file, removed: false };
  }

  if (kept.length === 0) delete hooks.SessionStart;
  else hooks.SessionStart = kept;
  if (Object.keys(hooks).length === 0) delete doc.hooks;

  if (Object.keys(doc).length === 0) {
    // Nothing but ADP's own hook was ever in it — deleting beats leaving `{}`,
    // the same judgement removeMcpServer makes.
    rmSync(file, { force: true });
    return { file, removed: true };
  }
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { file, removed: true };
}
