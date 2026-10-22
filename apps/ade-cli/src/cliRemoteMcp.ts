/**
 * `ade mcp` — this computer's ADE MCP, from the person's own terminal.
 *
 * Every subcommand is one `remoteMcp.call` on the machine brain (machine-wide,
 * so it works from any folder and never registers the current one). The brain
 * refuses it to agents; Settings → ADE MCP is the same service.
 */

import type { RemoteMcpAction, RemoteMcpScope } from "../../desktop/src/shared/types/remoteMcp";
import { CliUsageError, isRecord, readFlag, readValue, type CliPlan } from "./cli";

export const REMOTE_MCP_HELP = `
  ADE MCP

  Lets AI apps you choose (claude.ai, ChatGPT, Cursor, Claude Code, VS Code,
  Grok, or anything that speaks remote MCP) run ade on this computer through
  ADE Relay. Off until you turn it on. Each app or token is read only or
  read & write (full access), and you can change or remove it any time.

    $ ade mcp status --text                  On or off, the server URL, and every connection
    $ ade mcp on | off                       Turn ADE MCP on or off for this computer
    $ ade mcp token create --label "Grok" --read-only --text
    $ ade mcp token create --label "Grok" --full-access --text
    $ ade mcp token create --label "Grok" --scope read|write --text
                                             A token for apps that send a header (shown once)
    $ ade mcp scope <connection-id> read|write
                                             Change what a connection may do
    $ ade mcp remove <connection-id>         Disconnect an app or revoke a token
    $ ade mcp activity [--limit 50] --text   What connected apps ran here, newest first

  Two ways to connect an app:
    Sign in   Add the server URL from 'ade mcp status' as a custom connector.
              The app opens ADE sign-in: sign in to your ADE account, pick
              the access, and allow it.
    Token     Run 'ade mcp token create', then send the token in the app's
              MCP settings as "Authorization: Bearer <token>".
`;

function call(label: string, action: RemoteMcpAction, args: Record<string, unknown> = {}): CliPlan {
  return {
    kind: "execute",
    label,
    formatter: "remote-mcp",
    needsLiveRuntime: "ADE MCP",
    // Like `ade logout`: the person's terminal asserts the operator role. The
    // brain clamps it to its ceiling and refuses any chat-bound agent.
    connectRole: "cto",
    steps: [{ key: "result", method: "remoteMcp.call", params: { action, args } }],
  };
}

function parseScopeWord(value: string | null | undefined): RemoteMcpScope {
  const word = (value ?? "").trim().toLowerCase();
  if (word === "read" || word === "read-only" || word === "readonly") return "read";
  if (word === "write" || word === "full" || word === "read-write" || word === "rw") return "write";
  throw new CliUsageError("Access must be read or write (full access).");
}

/** `args` are the words after `ade mcp`. */
export function buildRemoteMcpPlan(input: readonly string[]): CliPlan {
  // The readers consume what they match, so the flags come out first and the
  // words left are the positionals.
  const args = [...input];
  const label = readValue(args, ["--label", "--name"]);
  const scopeFlag = readValue(args, ["--scope"]);
  const limitFlag = readValue(args, ["--limit"]);
  const readOnly = readFlag(args, ["--read-only", "--readonly"]);
  const fullAccess = readFlag(args, ["--full-access"]);
  const words = args.filter((word) => !word.startsWith("-"));
  const sub = words[0] ?? "status";
  switch (sub) {
    case "help":
      return { kind: "help", text: REMOTE_MCP_HELP };
    case "status":
      return call("mcp status", "getStatus");
    case "on":
      return call("mcp on", "setEnabled", { enabled: true });
    case "off":
      return call("mcp off", "setEnabled", { enabled: false });
    case "token": {
      if ((words[1] ?? "create") !== "create") {
        throw new CliUsageError(
          "Usage: ade mcp token create [--label <name>] (--read-only | --full-access | --scope read|write)",
        );
      }
      const accessOptions = Number(readOnly) + Number(fullAccess) + Number(scopeFlag !== null);
      if (accessOptions === 0) {
        throw new CliUsageError("Pick the access: --read-only or --full-access.");
      }
      if (accessOptions > 1) {
        throw new CliUsageError("Choose one access option: --read-only, --full-access, or --scope.");
      }
      const scope = readOnly ? "read" : fullAccess ? "write" : parseScopeWord(scopeFlag);
      return call("mcp token create", "createToken", { label: label ?? words[2] ?? "Token", scope });
    }
    case "scope": {
      const id = words[1];
      if (!id || !words[2]) throw new CliUsageError("Usage: ade mcp scope <connection-id> read|write");
      return call("mcp scope", "updateConnection", { id, scope: parseScopeWord(words[2]) });
    }
    case "remove": {
      const id = words[1];
      if (!id) throw new CliUsageError("Usage: ade mcp remove <connection-id>");
      return call("mcp remove", "removeConnection", { id });
    }
    case "activity": {
      const limit = Number.parseInt(limitFlag ?? "50", 10);
      return call("mcp activity", "listActivity", { limit: Number.isFinite(limit) ? limit : 50 });
    }
    default:
      throw new CliUsageError(`Unknown 'ade mcp' command '${sub}'. Run 'ade mcp help'.`);
  }
}

function scopeLabel(value: unknown): string {
  return value === "read" ? "read only" : "read & write";
}

function connectionLine(connection: Record<string, unknown>): string {
  const kind = connection.kind === "token" ? "token" : "app";
  const host = typeof connection.redirectHost === "string" && connection.redirectHost ? ` (${connection.redirectHost})` : "";
  const used = typeof connection.lastUsedAt === "string" ? `last used ${connection.lastUsedAt}` : "never used";
  const hint = typeof connection.tokenHint === "string" && connection.tokenHint ? ` …${connection.tokenHint}` : "";
  return `  ${String(connection.id)}  ${String(connection.label)}${host}  ${kind}${hint}  ${scopeLabel(connection.scope)}  ${used}`;
}

/** `--text` output for every `ade mcp` result. */
export function formatRemoteMcpResult(value: unknown): string {
  const result = isRecord(value) && "result" in value ? value.result : value;
  if (Array.isArray(result)) {
    if (result.length === 0) return "No ADE MCP activity yet.";
    return result.filter(isRecord).map((entry) => {
      const exit = entry.exitCode === null || entry.exitCode === undefined ? "" : ` exit ${String(entry.exitCode)}`;
      const detail = typeof entry.detail === "string" ? ` — ${entry.detail}` : "";
      return `${String(entry.at)}  ${String(entry.label)}  ${String(entry.outcome)}${exit}  ade ${String(entry.command)}${detail}`;
    }).join("\n");
  }
  if (!isRecord(result)) return String(result ?? "");
  if (typeof result.token === "string") {
    const connection = isRecord(result.connection) ? result.connection : {};
    return [
      `Token for ${String(connection.label ?? "Token")} (${scopeLabel(connection.scope)}), id ${String(connection.id ?? "")}:`,
      "",
      `  ${result.token}`,
      "",
      "This is the only time it is shown. Send it as: Authorization: Bearer <token>",
      ...(result.serverUrl ? [`Server URL: ${String(result.serverUrl)}`] : []),
    ].join("\n");
  }
  if (typeof result.removed === "boolean") {
    return result.removed ? "Disconnected. Its token stops working now." : "No connection with that id.";
  }
  if (Array.isArray(result.connections)) {
    const lines = [
      `ADE MCP on ${String(result.machineName)}: ${result.enabled === true ? "ON" : "off"}`,
      `Server URL: ${result.serverUrl ? String(result.serverUrl) : "not available yet (this computer has no relay address)"}`,
      `Relay: ${result.relayConnected === true ? "connected" : "not connected"}`,
    ];
    const connections = result.connections.filter(isRecord);
    lines.push(connections.length ? `Connections (${connections.length}):` : "No connections yet. Add the server URL to an app, or run 'ade mcp token create'.");
    for (const connection of connections) lines.push(connectionLine(connection));
    return lines.join("\n");
  }
  if (typeof result.id === "string") return `Updated:\n${connectionLine(result)}`;
  return JSON.stringify(result, null, 2);
}
