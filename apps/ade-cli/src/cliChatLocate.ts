import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../../desktop/src/main/services/state/durableFile";
import { resolveMachineAdeDir } from "./services/projects/machineLayout";
import { FREE_TEXT_VALUE_FLAGS } from "./cliMachineTargeting";
import {
  CLI_COMMAND_ALIASES,
  VALUE_CARRIER_FLAGS,
  asString,
  connectMachineRuntimeDaemon,
  firstPositional,
  firstStandalonePositional,
  isRecord,
  readValue,
  renderTable,
  type GlobalOptions,
  type JsonObject,
  type ParsedCli,
  type SocketJsonRpcClient,
} from "./cli";

/* ──────────────────────────────────────────────────────────────────────────
   WHERE A CHAT LIVES — a chat id given without `--machine`.

   A chat id is unique across the account, but a chat runs on one machine.
   When a chat command finds no such chat here, this machine's brain is asked
   whether it has the chat anywhere (`chats.locate`: booted scopes, then
   transcripts on disk). If not, every online machine on the account is asked
   the same, once, with a short timeout. Exactly one match: the command runs there, one hop, and the
   target applies its own rules to the caller. No match: the command runs
   here and fails as before, naming the machines that could not be asked.

   The command runs here first; only a "no such chat" here starts the lookup.
   A match is remembered (chatId → machine) so the next lookup asks only
   that machine. The lookup is read-only. Through ADE MCP the CLI does not
   look anywhere else: the MCP layer forwards the call itself, so the target
   checks the app's own token (remoteMcpProtocol.ts).
   ────────────────────────────────────────────────────────────────────────── */

/** Chat subcommands whose session id comes as the first positional or `--session`. */
const CHAT_ID_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "read", "transcript", "messages", "show", "status", "wait", "watch",
  "send", "message", "tell", "steer", "interrupt", "stop", "respond", "answer",
  "pending", "pending-inputs", "resume", "resume-now", "subagents", "list-subagents",
]);

/** How long one machine gets to answer "do you have it?". */
const LOCATE_TIMEOUT_MS = 5_000;
const CACHE_FILE = "chat-machines.json";
const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 24 * 60 * 60_000;

export type ChatLocationScope =
  | { kind: "project"; projectId: string; name: string | null; rootPath: string | null }
  | { kind: "personal" };

export type ChatLocation = {
  machineKey: string | null;
  machineName: string;
  isThisMachine: boolean;
  scope: ChatLocationScope;
};

export type ChatLocateReport = {
  sessionId: string;
  matches: ChatLocation[];
  /** Machines that are offline: not asked, never waited on. */
  offline: string[];
  /** Machines that were asked and did not answer (older ADE, timeout, error). */
  unreachable: Array<{ machine: string; error: string }>;
  /** Why other machines were not asked at all (signed out, no brain). */
  note: string | null;
};

/** The chat id a command names, when it is one that a lookup can route. */
export function chatIdForLookup(parsed: ParsedCli): string | null {
  const typed = parsed.command[0]?.toLowerCase() ?? "";
  if ((CLI_COMMAND_ALIASES[typed] ?? typed) !== "chat") return null;
  const options = parsed.options;
  if (options.machine || options.allMachines || options.headless) return null;
  // Through ADE MCP the MCP layer routes, with the app's own token.
  if (process.env.ADE_REMOTE_MCP_CONNECTION_ID?.trim()) return null;
  const args = parsed.command.slice(1);
  // Read the way `buildChatPlan` reads it, so both agree on the subcommand and the id.
  const sub = firstPositional(args)?.toLowerCase() ?? "";
  if (!CHAT_ID_SUBCOMMANDS.has(sub)) return null;
  const id = readValue(args, ["--session", "--session-id"]) ?? firstStandalonePositional(args);
  return id && /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : null;
}

type CacheEntry = { machineKey: string; machineName: string; at: number };

function cachePath(): string {
  return path.join(resolveMachineAdeDir(), "cache", CACHE_FILE);
}

function readCache(): Record<string, CacheEntry> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    return isRecord(value) ? (value as Record<string, CacheEntry>) : {};
  } catch {
    return {};
  }
}

function writeCache(update: (entries: Record<string, CacheEntry>) => void): void {
  const entries = readCache();
  update(entries);
  const now = Date.now();
  const kept = Object.entries(entries)
    .filter(([, entry]) => isRecord(entry) && typeof entry.at === "number" && now - entry.at < CACHE_TTL_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, CACHE_MAX_ENTRIES);
  try {
    fs.mkdirSync(path.dirname(cachePath()), { recursive: true, mode: 0o700 });
    writeFileAtomic(cachePath(), JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
  } catch {
    // A cache that can't be written only costs the next lookup a fan-out.
  }
}

function readScope(value: unknown): ChatLocationScope | null {
  if (!isRecord(value) || value.found !== true || !isRecord(value.scope)) return null;
  const scope = value.scope;
  if (scope.kind === "personal") return { kind: "personal" };
  const projectId = asString(scope.projectId);
  if (scope.kind !== "project" || !projectId) return null;
  return { kind: "project", projectId, name: asString(scope.name), rootPath: asString(scope.rootPath) };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function askMachine(client: SocketJsonRpcClient, machineKey: string, name: string, sessionId: string) {
  const answer = await withTimeout(client.request("machines.call", {
    machine: machineKey,
    scope: { kind: "machine" },
    request: { method: "chats.locate", params: { sessionId } },
    timeoutMs: LOCATE_TIMEOUT_MS,
  }), LOCATE_TIMEOUT_MS + 1_000, name);
  return readScope(isRecord(answer) && "result" in answer ? answer.result : answer);
}

/**
 * Where `sessionId` lives: this machine first, then the remembered machine,
 * then every other online machine at once. With `includeThisMachine: false`
 * this machine is not asked (the caller already knows it is not here).
 */
export async function locateChatOnAccount(
  options: GlobalOptions,
  sessionId: string,
  settings: { includeThisMachine?: boolean } = {},
): Promise<ChatLocateReport> {
  const report: ChatLocateReport = { sessionId, matches: [], offline: [], unreachable: [], note: null };
  let client: SocketJsonRpcClient;
  try {
    client = await connectMachineRuntimeDaemon(options, options.socketPath?.trim() || null, { allowSpawn: false });
  } catch (error) {
    report.note = `Couldn't reach this machine's ADE brain, so no other machine was asked (${errorText(error)}).`;
    return report;
  }
  try {
    if (settings.includeThisMachine !== false) {
      const here = readScope(await client.request("chats.locate", { sessionId }).catch(() => null));
      if (here) {
        report.matches.push({ machineKey: null, machineName: "this machine", isThisMachine: true, scope: here });
        return report;
      }
    }
    const roster = await client.request("machines.list", {}).catch((error: unknown) => ({ state: "unavailable", message: errorText(error) }));
    if (!isRecord(roster) || roster.state !== "ok") {
      report.note = asString(isRecord(roster) ? roster.message : null) ?? "Other machines are unavailable.";
      return report;
    }
    const others = (Array.isArray(roster.machines) ? roster.machines.filter(isRecord) : [])
      .filter((machine) => machine.isThisMachine !== true)
      .map((machine) => ({
        key: asString(machine.machineKey),
        name: asString(machine.name) ?? asString(machine.machineKey) ?? "machine",
        online: machine.online === true,
      }))
      .filter((machine): machine is { key: string; name: string; online: boolean } => machine.key !== null);
    for (const machine of others) if (!machine.online) report.offline.push(machine.name);
    const online = others.filter((machine) => machine.online);

    // The remembered machine first: one question instead of all of them.
    const cached = readCache()[sessionId];
    const remembered = cached ? online.find((machine) => machine.key === cached.machineKey) : undefined;
    let asked: string | null = null;
    if (remembered) {
      let scope: ChatLocationScope | null = null;
      try {
        scope = await askMachine(client, remembered.key, remembered.name, sessionId);
      } catch (error) {
        // No answer is not "not there": say so, and do not wait on it twice.
        report.unreachable.push({ machine: remembered.name, error: errorText(error) });
        asked = remembered.key;
      }
      if (scope) {
        report.matches.push({ machineKey: remembered.key, machineName: remembered.name, isThisMachine: false, scope });
        writeCache((entries) => { entries[sessionId] = { machineKey: remembered.key, machineName: remembered.name, at: Date.now() }; });
        return report;
      }
      // It answered, and the chat is no longer there.
      if (!asked) writeCache((entries) => { delete entries[sessionId]; });
    }

    const answers = await Promise.all(online.filter((machine) => machine.key !== asked).map(async (machine) => {
      try {
        return { machine, scope: await askMachine(client, machine.key, machine.name, sessionId), error: null };
      } catch (error) {
        return { machine, scope: null, error: errorText(error) };
      }
    }));
    for (const answer of answers) {
      if (answer.scope) {
        report.matches.push({ machineKey: answer.machine.key, machineName: answer.machine.name, isThisMachine: false, scope: answer.scope });
      } else if (answer.error) {
        report.unreachable.push({ machine: answer.machine.name, error: answer.error });
      }
    }
    const only = report.matches.length === 1 ? report.matches[0]! : null;
    if (only?.machineKey) {
      const key = only.machineKey;
      writeCache((entries) => { entries[sessionId] = { machineKey: key, machineName: only.machineName, at: Date.now() }; });
    }
    return report;
  } finally {
    client.close();
  }
}

/** What the lookup could not cover, for a "not found" message. */
export function describeUnasked(report: ChatLocateReport): string | null {
  const parts: string[] = [];
  if (report.note) parts.push(report.note);
  if (report.offline.length) parts.push(`offline, not asked: ${report.offline.join(", ")}`);
  if (report.unreachable.length) {
    parts.push(`no answer from: ${report.unreachable.map((entry) => `${entry.machine} (${entry.error})`).join(", ")}`);
  }
  return parts.length ? parts.join("; ") : null;
}

/**
 * Where `--personal` stands as a flag in `command` (never as the value of
 * `--text` and the like), and where flags end (`--` or the end).
 */
function personalFlagPositions(command: readonly string[]): { at: number[]; end: number } {
  const at: number[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const token = command[index]!;
    if (token === "--") return { at, end: index };
    if (token === "--personal") at.push(index);
    else if (!token.includes("=") && (FREE_TEXT_VALUE_FLAGS.has(token) || VALUE_CARRIER_FLAGS.has(token))) index += 1;
  }
  return { at, end: command.length };
}

/** The parsed command, sent to where the chat is: its machine, its project, personal or not. */
export function routedToLocation(parsed: ParsedCli, location: ChatLocation): ParsedCli {
  const personal = location.scope.kind === "personal";
  const { at, end } = personalFlagPositions(parsed.command);
  const command = personal && !at.length
    ? [...parsed.command.slice(0, end), "--personal", ...parsed.command.slice(end)]
    : !personal && at.length ? parsed.command.filter((_, index) => !at.includes(index)) : parsed.command;
  return {
    command,
    options: {
      ...parsed.options,
      machine: location.machineKey,
      machineProject: location.scope.kind === "project" ? location.scope.projectId : null,
    },
  };
}

/** The `ade chat read` that reaches the chat where it is: its machine, and its project or personal scope. */
function readCommandFor(sessionId: string, location: ChatLocation): string {
  const words = ["ade", "chat", "read", sessionId];
  if (!location.isThisMachine) words.push("--machine", JSON.stringify(location.machineName));
  if (location.scope.kind === "personal") words.push("--personal");
  else if (!location.isThisMachine) words.push("--project", location.scope.projectId);
  else if (location.scope.rootPath) words.push("--project-root", JSON.stringify(location.scope.rootPath));
  return words.join(" ");
}

/** `ade chat locate <session>`: where a chat lives on the account. */
export function chatLocateValue(report: ChatLocateReport): JsonObject {
  const only = report.matches.length === 1 ? report.matches[0]! : null;
  return {
    sessionId: report.sessionId,
    found: report.matches.length > 0,
    machine: only ? { key: only.machineKey, name: only.machineName, isThisMachine: only.isThisMachine } : null,
    project: only?.scope.kind === "project" ? { projectId: only.scope.projectId, name: only.scope.name } : null,
    personal: only?.scope.kind === "personal",
    matches: report.matches.map((match) => ({
      machine: match.machineName,
      key: match.machineKey,
      scope: match.scope as unknown as JsonObject,
    })),
    offline: report.offline,
    unreachable: report.unreachable,
    note: report.note,
    read: only ? readCommandFor(report.sessionId, only) : null,
  };
}

export function formatChatLocate(value: unknown): string {
  const record = isRecord(value) ? value : {};
  const matches = Array.isArray(record.matches) ? record.matches.filter(isRecord) : [];
  const unasked = [
    asString(record.note),
    Array.isArray(record.offline) && record.offline.length ? `offline, not asked: ${record.offline.join(", ")}` : null,
    Array.isArray(record.unreachable) && record.unreachable.length
      ? `no answer from: ${record.unreachable.filter(isRecord).map((entry) => entry.machine).join(", ")}`
      : null,
  ].filter(Boolean).join("\n");
  if (!matches.length) {
    return `Chat ${String(record.sessionId ?? "")} was not found on any machine that answered.${unasked ? `\n${unasked}` : ""}\n`;
  }
  const table = renderTable(
    ["machine", "project", "next"],
    matches.map((match) => {
      const scope = isRecord(match.scope) ? match.scope : {};
      return [match.machine, scope.kind === "personal" ? "(personal)" : scope.name ?? scope.projectId ?? "", record.read ?? ""];
    }),
    "ADE chat location",
    { fullColumns: ["next"] },
  );
  return `${table}\n${matches.length > 1 ? "\nThis id is on more than one machine; pass --machine <name>.\n" : ""}${unasked ? `${unasked}\n` : ""}`;
}
