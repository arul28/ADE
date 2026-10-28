import type { RemoteMcpMachine } from "../../../../desktop/src/shared/types/remoteMcp";
import {
  isRemoteMcpEnabledForAccount,
  readRemoteMcpMachineEntries,
  remoteMcpAdeVersion,
  type RemoteMcpSettings,
} from "./remoteMcpAccount";

/**
 * The account's computers as ADE MCP sees them, and sending a tool call on to
 * one of them.
 *
 * Who is on the account and whether they can serve comes from the account
 * settings entries (`ade_mcp.machine.<key>`, written by each computer that
 * runs this code); whether they are online comes from the account directory.
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

export type RemoteMcpMachineRef = { key: string; name: string };

export type RemoteMcpRosterMachine = RemoteMcpMachine & {
  endpointKey: string | null;
  version: string | null;
  /** Included, running this code, online (or unknown), and ADE MCP on for the account. */
  serving: boolean;
};

export type RemoteMcpResolvedMachine =
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
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
export const REMOTE_MCP_VIA_HEADER = "x-ade-mcp-via";

function errorText(text: string): RemoteMcpToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

export function createRemoteMcpMachineRouter(deps: {
  settings: RemoteMcpSettings;
  /** This computer: its relay machine key (null before it has a relay identity) and name. */
  thisMachine: () => { key: string | null; name: string };
  /** Whether this computer answers ADE MCP right now. */
  servingHere: () => boolean;
  relayUrl: () => string | null;
  /** The account directory; null when it cannot be read. */
  listAccountMachines: () => Promise<RemoteMcpDirectoryMachine[] | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
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
      } catch {
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
      byKey.set(machineKey, {
        machineKey,
        name,
        included,
        supported,
        online,
        isThisMachine,
        endpointKey: entry?.endpointKey || null,
        version: entry?.version || null,
        serving: isThisMachine
          ? deps.servingHere()
          : accountOn && included && supported && online !== false,
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
    if (!machine.supported || !machine.endpointKey) {
      return `ADE on ${machine.name} is older and can't take account calls yet. Update ADE there.`;
    }
    if (!machine.included) return `${machine.name} is left out of ADE MCP. The person can include it in Settings → ADE MCP.`;
    if (machine.online === false) return `${machine.name} is offline right now. Try again when it is awake.`;
    return null;
  };

  const forward: RemoteMcpMachineRouter["forward"] = async (machine, call, context, timeoutMs) => {
    const relay = deps.relayUrl()?.replace(/\/+$/, "");
    if (!relay) return errorText(`This computer has no relay address yet, so it can't reach ${machine.name}.`);
    if (!context.bearer) return errorText(`This call has no token to send on to ${machine.name}.`);
    if (!machine.endpointKey) return errorText(unavailableReason(machine) ?? `${machine.name} can't take calls.`);
    const fetchImpl = deps.fetchImpl ?? fetch;
    let response: Response;
    let body: string;
    try {
      response = await fetchImpl(`${relay}/m/${machine.endpointKey}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${context.bearer}`,
          "content-type": "application/json",
          accept: "application/json",
          "mcp-protocol-version": context.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          // Cloudflare's bot check refuses some default library agents (error 1010).
          "user-agent": `ADE/${remoteMcpAdeVersion()} (ADE MCP forward)`,
          [REMOTE_MCP_VIA_HEADER]: encodeViaHeader(thisMachine().name),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: call }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await response.text();
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return errorText(`${machine.name} didn't answer within ${Math.round(timeoutMs / 1000)}s. It may still be running the call.`);
      }
      return errorText(`Couldn't reach ${machine.name}: ${errorMessage(error)}.`);
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
        return errorText(
          `ADE on ${machine.name} didn't accept this connection. If ${machine.name} runs an older ADE, update ADE there; `
          + "if it was just set up, try again in a minute.",
        );
      case 404:
        return errorText(relayError === "ade_mcp_off"
          ? `ADE MCP is off on ${machine.name}, or it is left out of ADE MCP. The person can change that in Settings → ADE MCP.`
          : `ADE on ${machine.name} is older and can't take account calls yet. Update ADE there.`);
      case 429:
        return errorText(`${machine.name} is busy with other ADE MCP calls. Wait a moment, then retry.`);
      case 503:
        return errorText(`${machine.name} is offline right now. Try again when it is awake.`);
      default:
        return errorText(`${machine.name} answered ${response.status}${relayError ? ` (${relayError})` : ""}.`);
    }
    const rpcError = parsed?.error && typeof parsed.error === "object" ? parsed.error as { message?: unknown } : null;
    if (rpcError) {
      return errorText(`ADE on ${machine.name} refused the call: ${typeof rpcError.message === "string" ? rpcError.message : "unknown error"}.`);
    }
    const result = parsed?.result;
    if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) {
      return errorText(`ADE on ${machine.name} sent an answer this computer can't read.`);
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
