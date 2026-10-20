/**
 * `-c mcp_servers.<name>.enabled=false` for every server in the config.toml
 * files a Codex with this env reads in `cwd` (its `CODEX_HOME` and the
 * project's `.codex/config.toml`), for a Codex run that needs none of the
 * user's servers (a background utility, a fork, a voice call).
 *
 * `-c mcp_servers={}` does not do this: Codex merges an override table into
 * config.toml, so an empty one changes nothing and every server still starts
 * (measured on Codex 0.162: `codex exec` and `app-server` threads both
 * started `npx @playwright/mcp`). Servers a Codex plugin adds are not in the
 * files and still start.
 */

import os from "node:os";
import path from "node:path";

import { codexConfiguredMcpServerNames } from "../../../shared/callerMcpServers";
import { readText } from "./mcpProviderConfigScan";

export function codexDisableConfiguredMcpArgs(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
  cwd?: string | null,
): string[] {
  const codexHome = env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  const files = [path.join(codexHome, "config.toml"), ...(cwd?.trim() ? [path.join(cwd.trim(), ".codex", "config.toml")] : [])];
  const names = new Set<string>();
  for (const file of files) {
    const text = readText(file);
    if (text != null) for (const name of codexConfiguredMcpServerNames(text)) names.add(name);
  }
  // A bare key where TOML allows one; otherwise a basic-string key. These are
  // argv entries handed straight to Codex's own executable, not a shell line.
  return [...names].flatMap((name) => [
    "-c",
    `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}.enabled=false`,
  ]);
}
