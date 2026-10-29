import { randomUUID } from "node:crypto";
import { getErrorMessage } from "../../../../desktop/src/main/services/shared/utils";
import type { RemoteMcpMachine, RemoteMcpNotServingReason } from "../../../../desktop/src/shared/types/remoteMcp";
import {
  isRemoteMcpEnabledForAccount,
  readRemoteMcpMachineEntries,
  remoteMcpAdeVersion,
  type RemoteMcpMachineEntry,
  type RemoteMcpSettings,
} from "./remoteMcpAccount";
import {
  describeNetworkError,
  fetchThroughRelayWithRetry,
  isTimeoutError,
  REMOTE_MCP_CALL_ID_HEADER,
} from "./remoteMcpHttp";
import { findTypedTool } from "./remoteMcpTools";

/**
 * The account's computers as ADE MCP sees them, and sending a tool call on to
 * one of them.
 *
 * Who is on the account comes from the account settings entries
 * (`ade_mcp.machine.<key>`, written by each computer that runs this code) and
 * the account directory. Whether another computer serves is what it last
 * reported in its own entry; the directory's "offline" overrides that, and an
 * entry from an ADE that never reported is a guess shown as unknown.
 * A call for another computer goes to that computer's own per-machine address,
 * `<relay>/m/<endpointKey>/mcp`, with the app's own bearer token. The target
 * checks the token against its own copy of the account vault and runs the call
 * under its own policy: no brain trusts another brain, only the token.
 *
 * One hop: the forwarded request carries `x-ade-mcp-via`, and a request that
 * carries it is never forwarded again.
 */

export type RemoteMcpToolResult = {
  content: Array<{ type: string; text?: string } & Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} & Record<string, unknown>;

/** What the HTTP layer knows about the call that the protocol needs for routing. */
export type RemoteMcpCallContext = {
  /** The bearer token the app presented, forwarded as-is to another computer. */
  bearer: string | null;
  /** The computer that forwarded this call here, when one did. */
  via: string | null;
  /** The app's `mcp-protocol-version` header, passed on when forwarding. */
  protocolVersion: string | null;
  /** The app reached the account address (any computer may answer it). */
  accountMount: boolean;
};

type RemoteMcpMachineRef = { key: string; name: string };

export type RemoteMcpRosterMachine = RemoteMcpMachine & {
  endpointKey: string | null;
  version: string | null;
};

type RemoteMcpResolvedMachine =
  | { kind: "here"; machine: RemoteMcpMachineRef }
  | { kind: "remote"; machine: RemoteMcpRosterMachine }
  | { kind: "error"; message: string };

/** What the protocol needs to send calls to other computers. Injected so it stays testable. */
export type RemoteMcpMachineRouter = {
  thisMachine(): RemoteMcpMachineRef;
  roster(): Promise<RemoteMcpRosterMachine[]>;
  /** A machine name or key. */
  resolve(selector: string): Promise<RemoteMcpResolvedMachine>;
  /** Why a computer cannot take a call now, as a sentence; null when it can. */
  unavailableReason(machine: RemoteMcpRosterMachine): string | null;
  forward(
    machine: RemoteMcpRosterMachine,
    call: { name: string; arguments: Record<string, unknown> },
    context: RemoteMcpCallContext,
    timeoutMs: number,
  ): Promise<RemoteMcpToolResult>;
};

export type RemoteMcpDirectoryMachine = { machineKey: string; name: string | null; online: boolean };

/** How long a directory read is reused; Settings and machines_list both read it. */
const DIRECTORY_TTL_MS = 15_000;
const DIRECTORY_FAILURE_TTL_MS = 5_000;
const DIRECTORY_TIMEOUT_MS = 8_000;
/** The MCP protocol version this server answers with when a client names none it knows. */
export const REMOTE_MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";
export const REMOTE_MCP_VIA_HEADER = "x-ade-mcp-via";

/** A tool result that failed, with one sentence for the model. */
export function toolError(text: string): RemoteMcpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** A machine name for a header: plain ASCII, so any HTTP stack carries it. */
export function encodeViaHeader(name: string): string {
  return encodeURIComponent(name.slice(0, 120));
}

export function decodeViaHeader(value: string): string | null {
  if (!value) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // keep the raw value
  }
  const clean = decoded.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return clean || null;
}

/**
 * Why another computer can't take a call, as a sentence the model (and the
 * person) can act on: the answer when a call for it is refused before it is
 * sent, or the relay turns it away. Lists use the short NOT_SERVING_WORDS.
 */
export function notServingSentence(name: string, reason: RemoteMcpNotServingReason): string {
  switch (reason) {
    case "off_for_account":
      return "ADE MCP is off for this ADE account. The person can turn it on in Settings → ADE MCP.";
    case "left_out":
      return `${name} is left out of ADE MCP. The person can include it in Settings → ADE MCP.`;
    case "signed_out":
      return `${name} is signed out of its ADE account, so it can't take ADE MCP calls. Sign in to ADE on it.`;
    case "relay_disconnected":
      return `${name} isn't connected to ADE Relay right now, so calls can't reach it. Check its internet connection, or try again in a minute.`;
    case "account_vault_unreachable":
      return `${name} can't sync its ADE account vault, so it hasn't received this account's ADE MCP key. Open ADE on ${name} and check Settings → ADE MCP.`;
    case "waiting_for_account_secret":
      return `${name} hasn't received this account's ADE MCP key yet. Try again in a minute.`;
    case "older_ade":
      return `ADE on ${name} is older and can't take account calls yet. Update ADE there.`;
    case "offline":
      return `${name} is offline right now. Try again when it is awake.`;
  }
}

/**
 * Short words for why a computer does not serve: the one table for lists
 * (machines_list, `ade mcp status`).
 */
export const NOT_SERVING_WORDS: Readonly<Record<RemoteMcpNotServingReason, string>> = {
  off_for_account: "off for the account",
  left_out: "left out",
  signed_out: "not serving: signed out of ADE",
  relay_disconnected: "not serving: not connected to ADE Relay",
  account_vault_unreachable: "not serving: its account vault can't sync, so it has no ADE MCP key",
  waiting_for_account_secret: "not serving yet: waiting for the account's ADE MCP key",
  older_ade: "not joined yet: update ADE on it",
  offline: "offline",
};

type RosterState = Pick<RemoteMcpMachine, "isThisMachine" | "serving" | "notServingReason" | "reportedAt">;

/**
 * False when `serving` is a guess: another computer counted as serving because
 * its ADE never reported (or its last report no longer holds). The roster
 * leaves `reportedAt` null exactly then, so every reader of a roster row,
 * including Settings and `ade mcp status` through getStatus, can tell.
 */
export function servingStateKnown(machine: Pick<RosterState, "isThisMachine" | "serving" | "reportedAt">): boolean {
  return machine.isThisMachine || !machine.serving || machine.reportedAt !== null;
}

/** Short words for a computer's state, for lists. */
export function rosterStateWords(machine: RosterState): string {
  if (machine.serving) return servingStateKnown(machine) ? "serving" : "serving unknown (its ADE doesn't report it; update ADE there)";
  return machine.notServingReason ? NOT_SERVING_WORDS[machine.notServingReason] : "not serving";
}

/**
 * Another computer's state from its entry and the directory. Rules that hold
 * now (account off, left out, older ADE, offline) win over what it last
 * reported; a report that one of them since stopped holding is stale until
 * the computer reports again, so it counts as unknown.
 */
function otherMachineState(input: {
  accountOn: boolean;
  supported: boolean;
  included: boolean;
  online: boolean | null;
  entry: RemoteMcpMachineEntry | null;
}): { serving: boolean; reason: RemoteMcpNotServingReason | null; known: boolean } {
  if (!input.accountOn) return { serving: false, reason: "off_for_account", known: true };
  if (!input.supported) return { serving: false, reason: "older_ade", known: true };
  if (!input.included) return { serving: false, reason: "left_out", known: true };
  if (input.online === false) return { serving: false, reason: "offline", known: true };
  const reported = input.entry?.reported ?? null;
  const stale = reported?.reason === "off_for_account" || reported?.reason === "left_out" || reported?.reason === "offline";
  if (!reported || stale) return { serving: true, reason: null, known: false };
  return { serving: reported.serving, reason: reported.serving ? null : reported.reason, known: true };
}

export function createRemoteMcpMachineRouter(deps: {
  settings: RemoteMcpSettings;
  /** This computer: its relay machine key (null before it has a relay identity) and name. */
  thisMachine: () => { key: string | null; name: string };
  /** Why this computer does not answer right now; null when it serves. */
  notServingReasonHere: () => RemoteMcpNotServingReason | null;
  relayUrl: () => string | null;
  /** The account directory; null when it cannot be read. */
  listAccountMachines: () => Promise<RemoteMcpDirectoryMachine[] | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: { warn?: (event: string, data?: Record<string, unknown>) => void };
}): RemoteMcpMachineRouter {
  const now = deps.now ?? Date.now;
  let directory: { at: number; ttl: number; machines: RemoteMcpDirectoryMachine[] | null } | null = null;
  let directoryInFlight: Promise<RemoteMcpDirectoryMachine[] | null> | null = null;

  const readDirectory = async (): Promise<RemoteMcpDirectoryMachine[] | null> => {
    if (directory && now() - directory.at < directory.ttl) return directory.machines;
    directoryInFlight ??= (async () => {
      let machines: RemoteMcpDirectoryMachine[] | null = null;
      try {
        machines = await Promise.race([
          deps.listAccountMachines(),
          new Promise<null>((resolve) => {
            const timer = setTimeout(() => resolve(null), DIRECTORY_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } catch (error) {
        deps.logger?.warn?.("remote_mcp.directory_read_failed", { error: getErrorMessage(error) });
        machines = null;
      }
      directory = { at: now(), ttl: machines ? DIRECTORY_TTL_MS : DIRECTORY_FAILURE_TTL_MS, machines };
      return machines;
    })().finally(() => {
      directoryInFlight = null;
    });
    return await directoryInFlight;
  };

  const thisMachine = (): RemoteMcpMachineRef => {
    const self = deps.thisMachine();
    return { key: self.key ?? "", name: self.name };
  };

  const roster = async (): Promise<RemoteMcpRosterMachine[]> => {
    const self = deps.thisMachine();
    const entries = readRemoteMcpMachineEntries(deps.settings);
    const accountOn = isRemoteMcpEnabledForAccount(deps.settings);
    const listed = await readDirectory();
    const byKey = new Map<string, RemoteMcpRosterMachine>();
    const add = (machineKey: string, directoryRow: RemoteMcpDirectoryMachine | null) => {
      const entry = entries.get(machineKey) ?? null;
      const isThisMachine = machineKey === self.key;
      const name = isThisMachine
        ? self.name
        : directoryRow?.name?.trim() || entry?.name || `Computer ${machineKey.slice(0, 6)}`;
      const supported = isThisMachine || Boolean(entry?.endpointKey);
      const included = entry?.included ?? true;
      const online = isThisMachine ? true : directoryRow ? directoryRow.online : listed ? false : null;
      const hereReason = isThisMachine ? deps.notServingReasonHere() : null;
      const state = isThisMachine
        ? { serving: hereReason === null, reason: hereReason, known: true }
        : otherMachineState({ accountOn, supported, included, online, entry });
      byKey.set(machineKey, {
        machineKey,
        name,
        included,
        supported,
        online,
        isThisMachine,
        endpointKey: entry?.endpointKey || null,
        version: entry?.version || null,
        serving: state.serving,
        notServingReason: state.serving ? null : state.reason,
        // This computer's state is live; another's is as of its last report,
        // and null when its state is a guess (servingStateKnown).
        reportedAt: isThisMachine ? new Date(now()).toISOString() : state.known ? entry?.reported?.at ?? null : null,
      });
    };
    for (const row of listed ?? []) add(row.machineKey, row);
    for (const machineKey of entries.keys()) if (!byKey.has(machineKey)) add(machineKey, null);
    if (self.key && !byKey.has(self.key)) add(self.key, null);
    return [...byKey.values()].sort((left, right) =>
      Number(right.isThisMachine) - Number(left.isThisMachine) || left.name.localeCompare(right.name));
  };

  const resolve = async (selector: string): Promise<RemoteMcpResolvedMachine> => {
    const wanted = selector.trim();
    const self = thisMachine();
    if (!wanted) return { kind: "here", machine: self };
    const lower = wanted.toLowerCase();
    if (wanted === self.key || lower === self.name.toLowerCase()) return { kind: "here", machine: self };
    const machines = await roster();
    const byKey = machines.filter((machine) => machine.machineKey === lower);
    const matches = byKey.length ? byKey : machines.filter((machine) => machine.name.toLowerCase() === lower);
    const names = machines.map((machine) => machine.name).join(", ") || "none";
    if (matches.length > 1) {
      return { kind: "error", message: `More than one computer is called "${wanted}". Pass its key from machines_list instead.` };
    }
    const match = matches[0];
    if (!match) return { kind: "error", message: `No computer "${wanted}" on this ADE account. Computers: ${names}.` };
    if (match.isThisMachine) return { kind: "here", machine: self };
    return { kind: "remote", machine: match };
  };

  const unavailableReason = (machine: RemoteMcpRosterMachine): string | null => {
    if (!machine.supported || !machine.endpointKey) return notServingSentence(machine.name, "older_ade");
    if (machine.serving) return null;
    return notServingSentence(machine.name, machine.notServingReason ?? "relay_disconnected");
  };

  const forward: RemoteMcpMachineRouter["forward"] = async (machine, call, context, timeoutMs) => {
    const relay = deps.relayUrl()?.replace(/\/+$/, "");
    if (!relay) return toolError(`This computer has no relay address yet, so it can't reach ${machine.name}.`);
    if (!context.bearer) return toolError(`This call has no token to send on to ${machine.name}.`);
    if (!machine.endpointKey) return toolError(unavailableReason(machine) ?? `${machine.name} can't take calls.`);
    // A read-only typed tool may be sent twice; anything else is tried again
    // only when the first try never left this computer.
    const typed = findTypedTool(call.name);
    const retryAfterSend = typed !== null && !typed.write;
    let response: Response;
    let body: string;
    try {
      response = await fetchThroughRelayWithRetry(deps.fetchImpl ?? fetch, `${relay}/m/${machine.endpointKey}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${context.bearer}`,
          "content-type": "application/json",
          accept: "application/json",
          "mcp-protocol-version": context.protocolVersion || REMOTE_MCP_DEFAULT_PROTOCOL_VERSION,
          // Cloudflare's bot check refuses some default library agents (error 1010).
          "user-agent": `ADE/${remoteMcpAdeVersion()} (ADE MCP forward)`,
          [REMOTE_MCP_VIA_HEADER]: encodeViaHeader(thisMachine().name),
          // The same id on a retry, so a target that knows it runs the call once.
          [REMOTE_MCP_CALL_ID_HEADER]: randomUUID(),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: call }),
      }, timeoutMs, { retryAfterSend });
      body = await response.text();
    } catch (error) {
      if (isTimeoutError(error)) {
        return toolError(`${machine.name} didn't answer within ${Math.round(timeoutMs / 1000)}s. It may still be running the call.`);
      }
      deps.logger?.warn?.("remote_mcp.forward_failed", { machine: machine.machineKey, error: getErrorMessage(error) });
      return toolError(describeNetworkError(error, machine.name));
    }
    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(body) as unknown;
      parsed = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    } catch {
      parsed = null;
    }
    const relayError = typeof parsed?.error === "string" ? parsed.error : "";
    switch (response.status) {
      case 200:
        break;
      case 401:
        return toolError(
          `ADE on ${machine.name} didn't accept this connection. If ${machine.name} runs an older ADE, update ADE there; `
          + "if it was just set up, try again in a minute.",
        );
      case 404:
        // The relay says the target told it to stop serving: name the reason it reported, when it did.
        return toolError(relayError === "ade_mcp_off"
          ? machine.notServingReason
            ? notServingSentence(machine.name, machine.notServingReason)
            : `${machine.name} isn't answering ADE MCP right now: it may have just turned off, been left out, or not received this account's key yet. machines_list shows why.`
          : notServingSentence(machine.name, "older_ade"));
      case 429:
        return toolError(`${machine.name} is busy with other ADE MCP calls. Wait a moment, then retry.`);
      case 503:
        return toolError(notServingSentence(machine.name, "offline"));
      default:
        return toolError(`${machine.name} answered ${response.status}${relayError ? ` (${relayError})` : ""}.`);
    }
    const rpcError = parsed?.error && typeof parsed.error === "object" ? parsed.error as { message?: unknown } : null;
    if (rpcError) {
      return toolError(`ADE on ${machine.name} refused the call: ${typeof rpcError.message === "string" ? rpcError.message : "unknown error"}.`);
    }
    const result = parsed?.result;
    if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) {
      return toolError(`ADE on ${machine.name} sent an answer this computer can't read.`);
    }
    return result as RemoteMcpToolResult;
  };

  return { thisMachine, roster, resolve, unavailableReason, forward };
}

/** Marks a result with the computer it came from: a first text line and `structuredContent.machine`. */
export function withMachineLabel(result: RemoteMcpToolResult, machine: RemoteMcpMachineRef): RemoteMcpToolResult {
  const line = `[machine: ${machine.name}]`;
  const content = Array.isArray(result.content) ? [...result.content] : [];
  const firstText = content.findIndex((item) => item?.type === "text" && typeof item.text === "string");
  if (firstText >= 0) {
    const item = content[firstText]!;
    content[firstText] = { ...item, text: `${line}\n${item.text}` };
  } else {
    content.unshift({ type: "text", text: line });
  }
  const machineRef = { key: machine.key, name: machine.name };
  return {
    ...result,
    content,
    ...(result.structuredContent && typeof result.structuredContent === "object"
      ? { structuredContent: { ...result.structuredContent, machine: machineRef } }
      : {}),
  };
}
