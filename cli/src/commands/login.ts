import { parseFlags } from "../args.js";
import { saveConfig } from "../config.js";

export async function login(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (!flags.server || !flags.token) {
    throw new Error("usage: adp login --server <url> --token <token>");
  }
  const serverUrl = flags.server.replace(/\/+$/, "");
  await saveConfig({ serverUrl, token: flags.token });
  console.log(`logged in to ${serverUrl}`);
}
