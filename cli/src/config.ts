import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface AdpConfig {
  serverUrl: string;
  token: string;
}

// ADP_CONFIG_DIR lets tests (and anyone running two configs side by side)
// point somewhere other than the real ~/.adp — same escape hatch gh's own
// GH_CONFIG_DIR provides.
function configDir(): string {
  return process.env.ADP_CONFIG_DIR ?? path.join(homedir(), ".adp");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

export async function saveConfig(config: AdpConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  // 0o600: this file holds a bearer token in the clear, same sensitivity as
  // a git credential file.
  await writeFile(configPath(), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

export async function loadConfig(): Promise<AdpConfig> {
  // Env vars win over the config file — the same override shape `gh` itself
  // offers (GH_TOKEN/GH_HOST): useful in CI, and for pointing at a second
  // instance without touching the saved config.
  if (process.env.ADP_SERVER_URL && process.env.ADP_TOKEN) {
    return { serverUrl: process.env.ADP_SERVER_URL, token: process.env.ADP_TOKEN };
  }
  try {
    const raw = await readFile(configPath(), "utf8");
    return JSON.parse(raw) as AdpConfig;
  } catch {
    throw new Error(
      "not logged in — run `adp login --server <url> --token <token>`, or set ADP_SERVER_URL and ADP_TOKEN",
    );
  }
}
