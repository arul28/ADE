/**
 * `ade mcp` — this computer's ADE MCP, from the person's own terminal.
 *
 * Every subcommand is one `remoteMcp.call` on the machine brain (machine-wide,
 * so it works from any folder and never registers the current one). The brain
 * refuses it to agents; Settings → ADE MCP is the same service.
 */

export const REMOTE_MCP_HELP = `
  ADE MCP

  Lets AI apps you choose (claude.ai, ChatGPT, Cursor, Claude Code, VS Code,
  Grok, or anything that speaks remote MCP) run ade on this computer through
  ADE Relay. Off until you turn it on. Each app or token is read only or
  read & write (full access), and you can change or remove it any time.

    $ ade mcp status --text                  On or off, the server URL, and every connection
    $ ade mcp on | off                       Turn ADE MCP on or off for this computer
    $ ade mcp token create --label "Grok" [--read-only] --text
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

type RemoteMcpPlan = {
  kind: "execute";
  label: string;
  formatter: "remote-mcp";
  needsLiveRuntime: string;
  connectRole: "cto";
  steps: Array<{ key: string; method: string; params: Record<string, unknown> }>;
};

export class RemoteMcpUsageError extends Error {}

function positionals(args: readonly string[], valueFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token.startsWith("-")) {
      if (valueFlags.has(token)) index += 1;
      continue;
    }
    out.push(token);
  }
  return out;
}

function flagValue(args: readonly string[], names: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    for (const name of names) {
      if (token === name) return args[index + 1] ?? null;
      if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    }
  }
  return null;
}

const VALUE_FLAGS = new Set(["--label", "--name", "--scope", "--limit"]);

function call(label: string, action: string, args: Record<string, unknown> = {}): RemoteMcpPlan {
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

function parseScopeWord(value: string | null | undefined): "read" | "write" {
  const word = (value ?? "").trim().toLowerCase();
  if (word === "read" || word === "read-only" || word === "readonly") return "read";
  if (word === "write" || word === "full" || word === "read-write" || word === "rw") return "write";
  throw new RemoteMcpUsageError("Access must be read or write (full access).");
}

/** `args` are the words after `ade mcp`. */
export function buildRemoteMcpPlan(args: readonly string[]): RemoteMcpPlan | { kind: "help"; text: string } {
  const words = positionals(args, VALUE_FLAGS);
  const sub = words[0] ?? "status";
  switch (sub) {
    case "help":
      return { kind: "help", text: REMOTE_MCP_HELP };
    case "status":
    case "list":
      return call("mcp status", "getStatus");
    case "on":
    case "enable":
      return call("mcp on", "setEnabled", { enabled: true });
    case "off":
    case "disable":
      return call("mcp off", "setEnabled", { enabled: false });
    case "token": {
      if ((words[1] ?? "create") !== "create") {
        throw new RemoteMcpUsageError("Usage: ade mcp token create [--label <name>] [--read-only]");
      }
      const readOnly = args.includes("--read-only") || args.includes("--readonly");
      const scope = readOnly ? "read" : parseScopeWord(flagValue(args, ["--scope"]) ?? "write");
      const label = flagValue(args, ["--label", "--name"]) ?? words[2] ?? "Token";
      return call("mcp token create", "createToken", { label, scope });
    }
    case "scope": {
      const id = words[1];
      if (!id || !words[2]) throw new RemoteMcpUsageError("Usage: ade mcp scope <connection-id> read|write");
      return call("mcp scope", "updateConnection", { id, scope: parseScopeWord(words[2]) });
    }
    case "rename": {
      const id = words[1];
      const label = words.slice(2).join(" ");
      if (!id || !label) throw new RemoteMcpUsageError("Usage: ade mcp rename <connection-id> <name>");
      return call("mcp rename", "updateConnection", { id, label });
    }
    case "remove":
    case "revoke":
    case "disconnect": {
      const id = words[1];
      if (!id) throw new RemoteMcpUsageError("Usage: ade mcp remove <connection-id>");
      return call("mcp remove", "removeConnection", { id });
    }
    case "activity":
    case "log": {
      const limit = Number.parseInt(flagValue(args, ["--limit"]) ?? "50", 10);
      return call("mcp activity", "listActivity", { limit: Number.isFinite(limit) ? limit : 50 });
    }
    default:
      throw new RemoteMcpUsageError(`Unknown 'ade mcp' command '${sub}'. Run 'ade mcp help'.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
      result.serverUrl ? `Server URL: ${String(result.serverUrl)}` : "",
    ].filter((line) => line !== null).join("\n");
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
