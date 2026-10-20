/**
 * `-c mcp_servers.<name>.enabled=false` for every server in the config.toml a
 * Codex with this env reads, for a Codex run that needs none of the user's
 * servers (a background utility, a fork, a voice call).
 *
 * `-c mcp_servers={}` does not do this: Codex merges an override table into
 * config.toml, so an empty one changes nothing and every server still starts
 * (measured on Codex 0.162: `codex exec` and `app-server` threads both
 * started `npx @playwright/mcp`). Servers a Codex plugin adds are not in the
 * file and still start.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codexConfiguredMcpServerNames } from "../../../shared/callerMcpServers";

export function codexDisableConfiguredMcpArgs(env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined): string[] {
  const codexHome = env?.CODEX_HOME?.trim() || process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
  let configText: string;
  try {
    configText = fs.readFileSync(path.join(codexHome, "config.toml"), "utf8");
  } catch {
    return [];
  }
  // A name that would need TOML quoting is left to start: a quoted key is
  // exactly what a Windows cmd wrapper can mangle.
  return codexConfiguredMcpServerNames(configText)
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
    .flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
}
