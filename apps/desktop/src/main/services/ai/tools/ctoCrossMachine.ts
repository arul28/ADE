/**
 * The CTO's reach onto the account's other machines.
 *
 * The CTO lives on one home machine, and its typed tools act on that machine's
 * services directly. This is the one seam through which a tool reaches a
 * different machine: the brain resolves the machine on the account, finds the
 * same repository there (matched by normalized git origin), and runs one ADE
 * action on that machine's brain. The TARGET's action policy decides whether
 * the call is allowed; this seam never widens it. The generic action tools
 * (`runMachineAction`, `listMachineActions`) also go through it for the home
 * machine, where the brain runs the call through its own action dispatcher
 * under the same CTO identity another machine would see.
 *
 * Only the brain wires it (`ade-cli/src/services/account/ctoCrossMachineBridge.ts`).
 * A host that leaves it unset answers "not reachable from this runtime", and a
 * typed tool call that names no machine never touches it.
 */

/** One machine on the account, as `listMachines` reports it. */
export type CtoMachineSummary = {
  /** The account machine key. Stable; pass it back as `machine`. */
  machineId: string;
  /** Absolute display name, e.g. "MacBook Pro". */
  name: string;
  /** The machine this CTO runs on (its home machine). */
  isThisMachine: boolean;
  online: boolean;
  /** "online" | "asleep" | "offline", from the account directory. */
  presence: string;
  platform: string | null;
  lastSeenAt: string | null;
  /**
   * Whether this project (same git origin) is registered on that machine.
   * Null when it could not be checked (offline, or the connection failed).
   */
  hasProject: boolean | null;
  /** The checkout on that machine, when found. */
  projectRoot: string | null;
  /** Present only when work counts were requested and could be read. */
  laneCount?: number | null;
  runningChatCount?: number | null;
  /** Why `hasProject` or the counts are missing, when they are. */
  note?: string | null;
};

export type CtoMachineListResult =
  | { state: "ok"; projectOrigin: string | null; machines: CtoMachineSummary[] }
  | { state: "signed_out" | "unavailable" | "disabled"; message: string; machines: CtoMachineSummary[] };

/** A resolved `machine` argument. */
export type CtoMachineTarget = {
  machineId: string;
  name: string;
  /** True when the query names the home machine: the call runs in this brain. */
  isThisMachine: boolean;
};

export type CtoRemoteActionCall = {
  domain: string;
  action: string;
  /** Object arguments, as `ade actions run <domain>.<action> --input-json` sends them. */
  args?: Record<string, unknown>;
  /** A single scalar argument, for actions that take one (`--scalar`). */
  arg?: string | number | boolean;
  /** Per-call ceiling. The bridge clamps it; connecting has its own budget. */
  timeoutMs?: number;
};

/** One action a machine will run for the CTO, as that machine reports it. */
export type CtoMachineActionInfo = {
  domain: string;
  action: string;
  description?: string;
  /** The input contract, when the machine publishes one. Only sent for a single-domain listing. */
  input?: unknown;
  example?: unknown;
};

/** One row of the roster the CTO's live-state block carries each turn. */
export type CtoMachineRosterEntry = {
  name: string;
  machineId: string;
  isThisMachine: boolean;
  online: boolean;
  /** Null until something has checked (listMachines, or any call to that machine). */
  hasProject: boolean | null;
};

/** What every cross-machine tool answers while the user has the toggle off. */
export const CTO_CROSS_MACHINE_DISABLED_MESSAGE =
  "Turned off in Settings › CTO (\"Let the CTO reach my other machines\"). Ask the user to turn it on there.";

/**
 * Is this action a read? Read-only calls run without asking; everything else
 * is treated as a change and goes through the CTO's confirmation card.
 *
 * The action registry carries no read/write flag, so this reads the verb. It is
 * deliberately narrow and fails closed: a verb it does not recognize counts as
 * a change. `getOrCreate…`-style names are excluded even though they start
 * with a read verb, and so is `simulate…`, which can write a proposal.
 */
export function isReadOnlyAdeActionName(action: string): boolean {
  const name = action.trim();
  if (!name || /OrCreate|AndMark|AndClear/.test(name)) return false;
  return /^(get|list|read|search|find|preview|inspect|describe|peek|count|is|has|can)(?=[A-Z0-9]|$)/.test(name);
}

/**
 * The most the generic action tools hand back to the model. The transport has
 * its own, much larger cap; this one keeps a single answer from filling the
 * CTO's context.
 */
export const CTO_MACHINE_RESULT_MAX_BYTES = 64 * 1024;
const NARROW_THE_REQUEST = "Narrow the request (filters, limits, a smaller range).";

function jsonByteLength(value: unknown): { json: string; bytes: number } | null {
  try {
    const json = JSON.stringify(value ?? null) ?? "null";
    return { json, bytes: Buffer.byteLength(json, "utf8") };
  } catch {
    return null;
  }
}

/**
 * `value` as the model should see it: whole when it fits, otherwise the head
 * of its JSON with `truncated: true` and how to ask for less.
 */
export function clampMachineResultForModel(
  value: unknown,
  maxBytes = CTO_MACHINE_RESULT_MAX_BYTES,
): { result: unknown; truncated?: true; bytes?: number; note?: string } {
  const measured = jsonByteLength(value);
  if (!measured) {
    return { result: null, truncated: true, note: `The result could not be serialized. ${NARROW_THE_REQUEST}` };
  }
  if (measured.bytes <= maxBytes) return { result: value ?? null };
  let head = measured.json.slice(0, maxBytes);
  while (Buffer.byteLength(head, "utf8") > maxBytes) head = head.slice(0, -1024);
  return {
    result: head,
    truncated: true,
    bytes: measured.bytes,
    note: `The result was ${measured.bytes} bytes; this is the first ${maxBytes} bytes of its JSON. ${NARROW_THE_REQUEST}`,
  };
}

/** An action listing cut to the model budget, whole rows only. */
export function clampActionListForModel(
  actions: CtoMachineActionInfo[],
  maxBytes = CTO_MACHINE_RESULT_MAX_BYTES,
): { actions: CtoMachineActionInfo[]; truncated: boolean } {
  let bytes = 2;
  const kept: CtoMachineActionInfo[] = [];
  for (const row of actions) {
    const size = (jsonByteLength(row)?.bytes ?? Number.POSITIVE_INFINITY) + 1;
    if (bytes + size > maxBytes) return { actions: kept, truncated: true };
    bytes += size;
    kept.push(row);
  }
  return { actions: kept, truncated: false };
}

/**
 * While the user has the switch off (Settings › CTO), everything that would
 * list or reach another machine answers `CTO_CROSS_MACHINE_DISABLED_MESSAGE`
 * and connects to nothing. The home machine stays reachable.
 */
export type CtoCrossMachineDeps = {
  /** The home machine as a target. Synchronous; reads no network. */
  homeMachine: () => CtoMachineTarget;
  listMachines: (options?: { includeWork?: boolean }) => Promise<CtoMachineListResult>;
  /**
   * Resolves an id or a name (case-insensitive). Throws a message the model can
   * act on when nothing matches, when the query is ambiguous, when the account
   * cannot be read, or when the toggle is off.
   */
  resolveMachine: (query: string) => Promise<CtoMachineTarget>;
  /**
   * Runs one ADE action on a machine, in this project's checkout there, under
   * the CTO's caller identity. The home machine runs it through this brain's
   * own action dispatcher; any other machine runs it over the bridge. Both
   * apply the same policy. Throws when the machine is offline, unreachable,
   * lacks the repository, refuses the call (message kept verbatim), or returns
   * an oversized result.
   */
  runAction: (target: CtoMachineTarget, call: CtoRemoteActionCall) => Promise<unknown>;
  /** The actions a machine will run for the CTO, under THAT machine's policy. */
  listActions: (
    target: CtoMachineTarget,
    domain?: string | null,
  ) => Promise<{ count: number; actions: CtoMachineActionInfo[] }>;
  /**
   * The cached roster, synchronously, for the per-turn live-state block. Never
   * waits on the network. Null while signed out, while the toggle is off, and
   * before any cross-machine tool has run in this brain.
   */
  peekRoster: () => CtoMachineRosterEntry[] | null;
};
