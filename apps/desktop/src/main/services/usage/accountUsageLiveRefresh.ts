/**
 * accountUsageLiveRefresh.ts
 *
 * The opportunistic half of account-wide usage: ask the machines that happen to
 * be reachable right now for a fresh rollup, so the page is not limited to
 * whatever each of them last published.
 *
 * Everything here is best effort by design. The durable rollups in
 * `usage_machine_rollups` are the floor the page renders from; this only raises
 * it. A machine that is asleep, off the tailnet, unpaired, or simply slow
 * produces a `failure` entry and nothing more — never a rejected promise that
 * would take the other machines' numbers down with it.
 *
 * Transport is the one that already exists: the account directory lists the
 * machines, the paired remote-connection pool carries the call, and the command
 * is `usage.getUsageRollup`, registered next to the long-standing
 * `usage.getAdeStats` in `syncRemoteCommandService`.
 */

import type {
  AdeAccountMachine,
  AdeAccountMachinesResult,
  AdeUsageRollup,
  AdeUsageRollupRow,
} from "../../../shared/types";
import { getErrorMessage } from "../shared/utils";
import { ROLLUP_RETAINED_DAYS } from "./accountUsageRollupStore";
import { localDayKey } from "./localDay";

export type AccountRollupFetchResult = {
  rollups: AdeUsageRollup[];
  failures: Array<{ machineKey: string; label: string; platform: string | null; message: string }>;
};

/**
 * Cap on machines contacted per refresh. A large fleet must not turn one page
 * open into a fan-out storm; the machines left out keep their published rollup,
 * which is exactly what the durable floor is for.
 */
const MAX_LIVE_MACHINES = 12;

function machineLabel(machine: AdeAccountMachine): string {
  return machine.customName?.trim() || machine.name?.trim() || machine.machineKey;
}

/** Shown for a peer whose ADE cannot answer `usage.getUsageRollup` at all. */
const TOO_OLD_MESSAGE = "This computer's ADE is too old to share usage";

/**
 * The message a genuinely unknown method produces.
 *
 * `runtimeRpcClient` flattens the JSON-RPC error into a plain `Error` with no
 * `.code`, so the text is all there is; `-32601` is deliberately *not* matched,
 * because ADE also throws `methodNotFound` for permission denials, and reading
 * one of those as "too old to share usage" is exactly the bug class this guard
 * exists to avoid.
 */
const UNKNOWN_METHOD_MESSAGE = /method not found:|unsupported remote command:/i;

/**
 * Denial phrasings that ADE dresses in a `methodNotFound` code.
 *
 * See `adeRpcServer.ts` — elevated-role and owner-scope refusals all use that
 * code. A scope denial is a real problem to surface, not a version mismatch to
 * explain away, so it must never reach `TOO_OLD_MESSAGE`.
 */
const AUTHORIZATION_DENIAL_MESSAGE = /requires elevated role|requires an authenticated owner scope|not authorized for this caller|not owned by this caller|requires .*(?:permission|scope)|permission denied|not permitted|access denied|unauthorized/i;

/**
 * Did the peer reject the call because it does not know the method?
 *
 * A brain that predates `usage.getUsageRollup` answers with JSON-RPC -32601.
 * Left in the generic catch that reads as "Couldn't reach this computer" on
 * every refresh, which sends the user looking at the network for a problem that
 * is a version mismatch.
 */
function isMethodNotFound(error: unknown): boolean {
  if (!error) return false;
  const message = getErrorMessage(error);
  if (AUTHORIZATION_DENIAL_MESSAGE.test(message)) return false;
  return UNKNOWN_METHOD_MESSAGE.test(message);
}

/**
 * Cap on rows accepted from a peer.
 *
 * The honest maximum is one row per retained day per provider × model in use;
 * 200 of those a day is already far past any real fleet. Beyond it the payload
 * is either broken or hostile, and it is heading for a CRR-replicated table.
 */
const MAX_PEER_ROLLUP_ROWS = ROLLUP_RETAINED_DAYS * 200;

/**
 * Bounds on the identity half of a peer's source record.
 *
 * `roots` are 32-hex digests and there is one per provider transcript home, so
 * a couple of dozen is already generous, and `sourceId` matches an
 * 8..64-character marker. These are `JSON.stringify`d straight into a
 * CRR-replicated meta cell that rides a 256KB changeset batch budget, and
 * nothing downstream bounds them.
 */
const MAX_PEER_ROOTS = 32;
const MAX_PEER_ROOT_LENGTH = 128;
const MAX_PEER_ID_LENGTH = 128;

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value ? value.slice(0, maxLength) : null;
}

function finiteNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Clamp a peer token/call count exactly as `buildRollupRows` clamps the local
 * side.
 *
 * Finiteness alone is not enough. `foldRollupsIntoStats` adds these straight
 * into the account total, the daily chart point and the per-machine sort with
 * no clamp of its own (only `costUsd` is guarded), so a negative drives the
 * page's numbers *down* — and a fractional value survives into an
 * `integer not null` column via SQLite's type affinity. Honest input is already
 * a non-negative integer, so this changes nothing for it.
 */
function nonNegativeInt(value: number): number {
  return Math.max(0, Math.floor(value));
}

/**
 * Accept one peer row, or drop it.
 *
 * A row whose scalars are the wrong shape makes `db.run` throw inside
 * `publish`, which swallows it — so the machine's rollup is abandoned *after*
 * an unknown number of rows were written and *before* the delete-reconcile
 * runs, leaving stored history half-updated. Dropping the bad row instead
 * keeps the rest of the payload usable.
 */
function boundPeerRow(value: unknown): AdeUsageRollupRow | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  // Not just "a short string": the store's primary key and
  // `foldRollupsIntoStats`' range filter both read this as a `YYYY-MM-DD`
  // calendar day, and `localDayOrdinal` returns null for anything else — so a
  // free-text date is a row that stores fine and can never be counted or
  // pruned. `localDayKey` is the same validator the local build uses.
  const date = localDayKey(boundedString(record.date, MAX_PEER_ID_LENGTH) ?? "");
  const provider = boundedString(record.provider, MAX_PEER_ID_LENGTH);
  const model = boundedString(record.model, MAX_PEER_ID_LENGTH);
  if (!date || !provider || !model) return null;
  const inputTokens = finiteNumber(record.inputTokens);
  const outputTokens = finiteNumber(record.outputTokens);
  const cachedTokens = finiteNumber(record.cachedTokens);
  const totalTokens = finiteNumber(record.totalTokens);
  const costUsd = finiteNumber(record.costUsd);
  const calls = finiteNumber(record.calls);
  if (inputTokens === null
    || outputTokens === null
    || cachedTokens === null
    || totalTokens === null
    || costUsd === null
    || calls === null) return null;
  return {
    date,
    provider,
    model,
    inputTokens: nonNegativeInt(inputTokens),
    outputTokens: nonNegativeInt(outputTokens),
    cachedTokens: nonNegativeInt(cachedTokens),
    totalTokens: nonNegativeInt(totalTokens),
    costUsd: Math.max(0, costUsd),
    calls: nonNegativeInt(calls),
  };
}

function isUsageRollup(value: unknown): value is AdeUsageRollup {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.machineKey === "string"
    && typeof record.capturedAt === "string"
    && Array.isArray(record.rows)
    && !!record.source
    && typeof record.source === "object";
}

/**
 * Bound what a peer can put in the store.
 *
 * Nothing here rejects: a peer with an outsized payload should lose the excess,
 * not its whole contribution. Truncation is log-free — it is a property of the
 * payload, not an event worth waking anyone over.
 */
function boundPeerRollup(rollup: AdeUsageRollup, fetchedAtIso: string): AdeUsageRollup {
  const rawRows = Array.isArray(rollup.rows) ? rollup.rows : [];
  const rows: AdeUsageRollupRow[] = [];
  for (const raw of rawRows) {
    if (rows.length >= MAX_PEER_ROLLUP_ROWS) break;
    const row = boundPeerRow(raw);
    if (row) rows.push(row);
  }
  // Rebuilt field by field rather than spread: a peer may send fields this
  // version no longer reads, and a spread would carry them into the store.
  const source = (rollup.source ?? {}) as Partial<AdeUsageRollup["source"]>;
  const roots = Array.isArray(source.roots)
    ? source.roots
      .filter((root): root is string => typeof root === "string" && !!root)
      .slice(0, MAX_PEER_ROOTS)
      .map((root) => root.slice(0, MAX_PEER_ROOT_LENGTH))
    : [];
  // `label`, `platform` and `capturedAt` land in the same CRR meta row as
  // `sourceId`/`roots` and ride the same changeset budget, so they get the
  // same cap. `capturedAt` additionally reaches `Date.parse` and
  // is rendered as `lastReportedAt`, so a value that does not parse is replaced
  // with the time this refresh actually heard from the machine — which is the
  // honest answer — rather than shown as-is.
  const capturedAt = boundedString(rollup.capturedAt, MAX_PEER_ID_LENGTH);
  const capturedAtMs = capturedAt ? Date.parse(capturedAt) : Number.NaN;
  return {
    // Every field listed explicitly, and the peer object never spread: a peer
    // controls this payload, and a spread carries anything it invented straight
    // into the CRR-replicated store. `version` is pinned rather than echoed for
    // the same reason — this is the shape this version wrote.
    version: 1,
    // Bounded even though the caller overwrites it from the directory: this
    // function's own return value must be safe to store on its own terms.
    machineKey: boundedString(rollup.machineKey, MAX_PEER_ID_LENGTH) ?? "",
    // Non-strings read as null so the caller's directory-supplied fallback
    // takes over. Note this is also why the caller must not touch
    // `rollup.label` directly: `.trim()` on a numeric label throws, and the
    // catch around it reports the machine as unreachable — pointing the user at
    // the network for a payload-shape problem.
    label: boundedString(rollup.label, MAX_PEER_ID_LENGTH) ?? "",
    platform: boundedString(rollup.platform, MAX_PEER_ID_LENGTH),
    capturedAt: Number.isFinite(capturedAtMs) ? (capturedAt as string) : fetchedAtIso,
    rows,
    source: {
      sourceId: boundedString(source.sourceId, MAX_PEER_ID_LENGTH),
      roots,
    },
  };
}

/**
 * Race a per-machine call against the refresh deadline.
 *
 * Without this the whole refresh waits for the slowest peer at the connection
 * pool's default timeout, and the caller's in-flight key stays held that whole
 * time — suppressing every later refresh. The abort does not cancel the
 * underlying RPC (the pool owns that, via `timeoutMs`); it bounds how long this
 * refresh is willing to wait for it.
 */
function withDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (!signal.aborted && typeof signal.addEventListener !== "function") return work;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Timed out"));
      return;
    }
    const onAbort = (): void => reject(new Error("Timed out"));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      signal.removeEventListener?.("abort", onAbort);
    });
  });
}

export function createAccountRollupFetcher({
  listMachines,
  resolveTargetIdForMachineKey,
  isTargetConnected,
  callMachineMethod,
  localMachineKey,
  logger,
}: {
  listMachines: () => Promise<AdeAccountMachinesResult>;
  resolveTargetIdForMachineKey: (machineKey: string) => string | null;
  /**
   * Whether a target is *already* connected.
   *
   * A usage refresh is opportunistic; the durable rollups are the floor and
   * this only raises it. Calling a disconnected target routes through the
   * remote connection service's implicit-reconnect path and schedules that
   * machine's bounded backoff. This page refreshes on every usage update and
   * every scope/preset change, so an optional refresh should not compete with
   * an interactive reconnect. So: only read a target that is already online.
   */
  isTargetConnected?: (targetId: string) => boolean;
  callMachineMethod: <T>(
    targetId: string,
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<T>;
  localMachineKey: () => string;
  /** Narrow structurally so a lazy per-call delegate satisfies it. */
  logger?: { debug?: (message: string, meta?: Record<string, unknown>) => void; warn?: (message: string, meta?: Record<string, unknown>) => void };
}) {
  return async ({ timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal }): Promise<AccountRollupFetchResult> => {
    const result: AccountRollupFetchResult = { rollups: [], failures: [] };
    if (signal.aborted) return result;
    let listed: AdeAccountMachinesResult;
    try {
      // The directory call is on the same deadline as the per-machine fetches.
      // Unwrapped it could outlive the whole refresh — and the caller's
      // in-flight key is held for exactly as long as this promise, so a slow
      // directory suppressed every later refresh while returning nothing.
      listed = await withDeadline(listMachines(), signal);
    } catch (error) {
      logger?.warn?.("usage.account.list_machines_failed", { error: getErrorMessage(error) });
      return result;
    }
    if (listed.state !== "ok") return result;

    const selfKey = localMachineKey();
    // Only machines the directory calls online and that already have a paired
    // target. Pairing on demand would put an interactive trust decision behind
    // a page render, which is not a trade the Usage page gets to make.
    // The cap is applied *after* the reachability filters, not before. Applied
    // first, a handful of unpaired or disconnected machines at the head of the
    // directory listing consumed the entire budget and every machine this
    // refresh could actually have reached was starved out of it.
    const candidates: Array<{ machine: AdeAccountMachine; targetId: string }> = [];
    for (const machine of listed.machines) {
      if (candidates.length >= MAX_LIVE_MACHINES) break;
      if (machine.machineKey === selfKey || !machine.online) continue;
      const targetId = resolveTargetIdForMachineKey(machine.machineKey);
      if (!targetId) continue;
      // Not connected right now: leave it to its durable rollup rather than
      // scheduling a reconnect for an optional page refresh.
      if (isTargetConnected && !isTargetConnected(targetId)) continue;
      candidates.push({ machine, targetId });
    }

    await Promise.all(candidates.map(async ({ machine, targetId }) => {
      const label = machineLabel(machine);
      try {
        if (signal.aborted) throw new Error("Timed out");
        const rollup = await withDeadline(
          callMachineMethod<unknown>(targetId, "usage.getUsageRollup", {}, { timeoutMs }),
          signal,
        );
        if (rollup === null || rollup === undefined) {
          // The peer answered honestly that it has nothing authoritative yet —
          // its first ledger scan is still running. Recording a failure keeps
          // its stored history intact and retries on the next refresh.
          result.failures.push({
            machineKey: machine.machineKey,
            label,
            platform: machine.platform,
            message: "This computer is still reading its usage history",
          });
          return;
        }
        if (!isUsageRollup(rollup)) {
          result.failures.push({
            machineKey: machine.machineKey,
            label,
            platform: machine.platform,
            message: TOO_OLD_MESSAGE,
          });
          return;
        }
        // Trust the directory's identity over the payload's: a machine may not
        // know its own account key, and letting a peer name itself would let it
        // overwrite another machine's rollup.
        const bounded = boundPeerRollup(rollup, new Date().toISOString());
        result.rollups.push({
          ...bounded,
          machineKey: machine.machineKey,
          label: bounded.label.trim() || label,
          platform: bounded.platform ?? machine.platform,
        });
      } catch (error) {
        result.failures.push({
          machineKey: machine.machineKey,
          label,
          platform: machine.platform,
          message: isMethodNotFound(error) ? TOO_OLD_MESSAGE : "Couldn't reach this computer",
        });
        logger?.debug?.("usage.account.machine_refresh_failed", {
          machineKey: machine.machineKey,
          error: getErrorMessage(error),
        });
      }
    }));

    return result;
  };
}
