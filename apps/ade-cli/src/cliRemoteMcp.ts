/**
 * `ade mcp` — the ADE account's ADE MCP server, from the person's own terminal.
 *
 * Every subcommand is one `remoteMcp.call` on this computer's brain
 * (machine-wide, so it works from any folder and never registers the current
 * one). On/off, the computers and the connections are account-wide; the
 * activity is this computer's. The brain refuses it to agents; Settings →
 * ADE MCP is the same service.
 */

import {
  isRemoteMcpNotServingReason,
  type RemoteMcpAction,
  type RemoteMcpScope,
} from "../../desktop/src/shared/types/remoteMcp";
import { CliUsageError, isRecord, readFlag, readValue, type CliPlan } from "./cli";
import { rosterStateWords } from "./services/remoteMcp/remoteMcpForward";

export const REMOTE_MCP_HELP = `
  ADE MCP

  Lets AI apps you choose (claude.ai, ChatGPT, Cursor, Claude Code, VS Code,
  Grok, or anything that speaks remote MCP) run ade on the computers of your
  ADE account through ADE Relay: one server URL for the account, and an app
  can name the computer each call runs on. Off until you turn it on. Each app
  or token is read only or read & write (full access), and you can change or
  remove it any time.

    $ ade mcp status --text                  On or off, the server URL, the computers and every connection
    $ ade mcp on | off                       Turn ADE MCP on or off for your ADE account
    $ ade mcp machine exclude "Mac mini"     Leave a computer out (include brings it back)
    $ ade mcp machine include "Mac mini"
    $ ade mcp token create --label "Grok" --read-only --text
    $ ade mcp token create --label "Grok" --full-access --text
    $ ade mcp token create --label "Grok" --scope read|write --text
                                             A token for apps that send a header (shown once)
    $ ade mcp scope <connection-id> read|write
                                             Change what a connection may do
    $ ade mcp remove <connection-id>         Disconnect an app or revoke a token
    $ ade mcp activity [--limit 50] --text   What connected apps ran on this computer, newest first

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
    case "machine":
    case "machines":
    case "computer": {
      const verb = words[1];
      // Names may have spaces: the words after the verb are the name.
      const name = words.slice(2).join(" ").trim();
      if ((verb !== "include" && verb !== "exclude") || !name) {
        throw new CliUsageError("Usage: ade mcp machine include|exclude <name or machine key>");
      }
      return call(`mcp machine ${verb}`, "setMachineIncluded", { machine: name, included: verb === "include" });
    }
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

function machineLine(machine: Record<string, unknown>): string {
  const isThisMachine = machine.isThisMachine === true;
  const name = `${String(machine.name)}${isThisMachine ? " (this computer)" : ""}`;
  const online = machine.online === true ? "online" : machine.online === false ? "offline" : "online unknown";
  const row = {
    isThisMachine,
    serving: machine.serving === true,
    reportedAt: typeof machine.reportedAt === "string" ? machine.reportedAt : null,
    notServingReason: machine.supported !== true
      ? "older_ade" as const
      : isRemoteMcpNotServingReason(machine.notServingReason) ? machine.notServingReason : null,
  };
  const reported = !isThisMachine && row.reportedAt ? `  (as of ${row.reportedAt})` : "";
  return `  ${name}  ${online}  ${rosterStateWords(row)}${reported}`;
}

function vaultLine(vault: Record<string, unknown>): string {
  const synced = typeof vault.lastSyncedAt === "string" ? `last synced ${vault.lastSyncedAt}` : "never synced";
  const pending = typeof vault.pendingChanges === "number" && vault.pendingChanges > 0 ? `, ${vault.pendingChanges} waiting to upload` : "";
  const state = vault.state === "ok" ? "ok" : vault.state === "failing" ? "FAILING" : "unavailable";
  const message = typeof vault.message === "string" && vault.message ? `\n  ${vault.message}` : "";
  return `Account vault on this computer: ${state} (${synced}${pending})${message}`;
}

function connectionLine(connection: Record<string, unknown>): string {
  const kind = connection.kind === "token" ? "token" : "app";
  const host = typeof connection.redirectHost === "string" && connection.redirectHost ? ` (${connection.redirectHost})` : "";
  const app = typeof connection.app === "string" ? ` [${connection.app}]` : "";
  const used = typeof connection.lastUsedAt === "string" ? `last used ${connection.lastUsedAt}` : "never used";
  const hint = typeof connection.tokenHint === "string" && connection.tokenHint ? ` …${connection.tokenHint}` : "";
  const only = isRecord(connection.onlyMachine) ? `  ${String(connection.onlyMachine.name)} only` : "";
  return `  ${String(connection.id)}  ${String(connection.label)}${host}${app}  ${kind}${hint}  ${scopeLabel(connection.scope)}${only}  ${used}`;
}

/** `--text` output for every `ade mcp` result. */
export function formatRemoteMcpResult(value: unknown): string {
  const result = isRecord(value) && "result" in value ? value.result : value;
  if (Array.isArray(result)) {
    if (result.length === 0) return "No ADE MCP activity yet.";
    return result.filter(isRecord).map((entry) => {
      const exit = entry.exitCode === null || entry.exitCode === undefined ? "" : ` exit ${String(entry.exitCode)}`;
      const detail = typeof entry.detail === "string" ? ` — ${entry.detail}` : "";
      const route = typeof entry.forwardedTo === "string"
        ? `  → ${entry.forwardedTo}`
        : typeof entry.via === "string" ? `  via ${entry.via}` : "";
      const what = typeof entry.tool === "string" && !entry.command ? entry.tool : `ade ${String(entry.command)}`;
      return `${String(entry.at)}  ${String(entry.label)}  ${String(entry.outcome)}${exit}  ${what}${route}${detail}`;
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
    if (result.signedIn === false) {
      return "ADE MCP needs an ADE account. Sign in on this computer (ade login), then run 'ade mcp on'.";
    }
    const accountOn = result.enabled === true;
    const thisServing = result.thisMachineServing === true;
    const lines = [
      `ADE MCP for your ADE account: ${accountOn ? "ON" : "off"}`,
      `Server URL: ${result.serverUrl ? String(result.serverUrl) : accountOn ? "not on this computer yet (no relay address, or the account's ADE MCP key hasn't arrived: see below)" : "made when you turn it on"}`,
      `This computer (${String(result.machineName)}): ${thisServing ? "serving" : "not serving"}, relay ${result.relayConnected === true ? "connected" : "not connected"}`,
      ...(isRecord(result.vault) ? [vaultLine(result.vault)] : []),
    ];
    const machines = Array.isArray(result.machines) ? result.machines.filter(isRecord) : [];
    if (machines.length) {
      lines.push(`Computers (${machines.length}):`);
      for (const machine of machines) lines.push(machineLine(machine));
    }
    const connections = result.connections.filter(isRecord);
    lines.push(connections.length ? `Connections (${connections.length}):` : "No connections yet. Add the server URL to an app, or run 'ade mcp token create'.");
    for (const connection of connections) lines.push(connectionLine(connection));
    return lines.join("\n");
  }
  if (typeof result.id === "string") return `Updated:\n${connectionLine(result)}`;
  return JSON.stringify(result, null, 2);
}
