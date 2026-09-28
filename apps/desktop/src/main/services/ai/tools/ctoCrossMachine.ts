/**
 * The CTO's reach onto the account's other machines.
 *
 * The CTO lives on one home machine, and its tools act on that machine's
 * services directly. This is the one seam through which a tool reaches a
 * different machine: the brain resolves the machine on the account, finds the
 * same repository there (matched by normalized git origin), and runs one ADE
 * action on that machine's brain. The TARGET's action policy decides whether
 * the call is allowed; this seam never widens it.
 *
 * Only the brain wires it (`ade-cli/src/services/account/ctoCrossMachineBridge.ts`).
 * A host that leaves it unset answers "not reachable from this runtime", and a
 * tool call that names no machine never touches it.
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
  | { state: "signed_out" | "unavailable"; message: string; machines: CtoMachineSummary[] };

/** A resolved `machine` argument. */
export type CtoMachineTarget = {
  machineId: string;
  name: string;
  /** True when the query names the home machine: the tool runs locally. */
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

/**
 * Is this action a read? Read-only calls run without asking; everything else
 * is treated as a change and goes through the CTO's confirmation card.
 *
 * The action registry carries no read/write flag, so this reads the verb. It is
 * deliberately narrow and fails closed: a verb it does not recognize counts as
 * a change. `getOrCreate…`-style names are excluded even though they start
 * with a read verb.
 */
export function isReadOnlyAdeActionName(action: string): boolean {
  const name = action.trim();
  if (!name || /OrCreate|AndMark|AndClear/.test(name)) return false;
  return /^(get|list|read|search|find|preview|inspect|describe|peek|count|is|has|can|simulate)(?=[A-Z0-9]|$)/.test(name);
}

export type CtoCrossMachineDeps = {
  listMachines: (options?: { includeWork?: boolean }) => Promise<CtoMachineListResult>;
  /**
   * Resolves an id or a name (case-insensitive). Throws a message the model can
   * act on when nothing matches, when the query is ambiguous, or when the
   * account cannot be read.
   */
  resolveMachine: (query: string) => Promise<CtoMachineTarget>;
  /**
   * Runs one ADE action on a machine, in this project's checkout there. The
   * home machine runs it in-process under the same allowlist and user-only
   * rules; any other machine runs it over the bridge. Throws when the machine
   * is offline, unreachable, lacks the repository, refuses the call under its
   * own policy (message kept verbatim), or returns an oversized result.
   */
  runAction: (target: CtoMachineTarget, call: CtoRemoteActionCall) => Promise<unknown>;
  /**
   * The actions a machine will run for the CTO, under THAT machine's policy.
   * For the home machine, this machine's registry answers.
   */
  listActions: (
    target: CtoMachineTarget,
    domain?: string | null,
  ) => Promise<{ count: number; actions: CtoMachineActionInfo[] }>;
  /**
   * The cached roster, synchronously, for the per-turn live-state block. Never
   * waits on the network: a stale or empty cache starts a refresh in the
   * background and answers with what it has (null before the first read).
   */
  peekRoster: () => CtoMachineRosterEntry[] | null;
};
