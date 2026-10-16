import type { AcpChatProvider } from "../../../shared/types/chat";
import type { AcpSpawnPlan } from "../chat/acpHost/acpHostTypes";
import { spawnAsync } from "../shared/utils";
import { shouldUseWindowsCmdWrapper } from "../shared/processExecution";

/** Background checks must not start MCP servers or their OAuth browser flows. */
export async function prepareAcpProbeSpawnPlan(
  provider: AcpChatProvider,
  plan: AcpSpawnPlan,
): Promise<AcpSpawnPlan> {
  if (provider !== "copilot") return plan;
  // This command lists user, workspace, plugin and built-in definitions without
  // connecting to them. An empty session/new mcpServers array only adds no
  // servers: it does not suppress Copilot's on-disk configuration.
  const result = await spawnAsync(plan.command, ["mcp", "list", "--json"], {
    cwd: plan.cwd,
    env: plan.env,
    timeout: 5_000,
    maxOutputBytes: 256 * 1024,
  });
  if (result.status !== 0) {
    throw new Error("Could not inspect Copilot MCP configuration safely; background session check skipped.");
  }
  let servers: unknown;
  try {
    // Some shells prepend a BOM or surrounding whitespace; strip only those
    // leading bytes so a clean catalog is not rejected as unreadable.
    const trimmedStdout = result.stdout.replace(/^\uFEFF/, "").trim();
    servers = (JSON.parse(trimmedStdout) as { mcpServers?: unknown })?.mcpServers;
  } catch {
    // Do not log the output: definitions can contain credentials in headers.
  }
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("Copilot returned an unreadable MCP catalog; background session check skipped.");
  }
  const names = Object.keys(servers);
  // cmd.exe expands %VAR% even inside quotes. Refuse a shim launch that
  // could disable a different name and accidentally start the real server.
  if (shouldUseWindowsCmdWrapper(plan.command) && names.some((name) => /[%\r\n]/.test(name))) {
    throw new Error("Copilot MCP server names cannot be safely passed through this Windows shim; background session check skipped.");
  }
  return {
    ...plan,
    args: [
      ...plan.args,
      "--disable-builtin-mcps",
      ...names.flatMap((name) => ["--disable-mcp-server", name]),
    ],
  };
}
