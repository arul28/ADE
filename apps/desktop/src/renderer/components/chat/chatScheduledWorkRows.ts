import type {
  ChatActivityBundleItem,
  ChatTranscriptGroupedEnvelope,
  WakeChainRenderEvent,
} from "./chatTranscriptRows";
import { groupedEnvelopeTurnId } from "./chatTranscriptTurnFolds";

type ScheduledWorkEvent = ChatActivityBundleItem["event"];

const PENDING_STATUSES: ReadonlySet<string> = new Set(["scheduled", "paused", "running"]);

/**
 * A one-shot cancelled at or after its fire time was delivered, not dropped:
 * older brains reconciled a fired wake-up against the provider's inventory and
 * wrote `cancelled`. Read those as fired so old transcripts tell the truth.
 */
const LATE_CANCEL_TOLERANCE_MS = 30_000;

function definedFields(event: ScheduledWorkEvent): Partial<ScheduledWorkEvent> {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined),
  ) as Partial<ScheduledWorkEvent>;
}

function patchScheduledWork(
  previous: ScheduledWorkEvent,
  next: ScheduledWorkEvent,
  nextTimestamp: string,
): ScheduledWorkEvent {
  const patched = { ...previous, ...definedFields(next) } as ScheduledWorkEvent;
  if (
    (patched.kind === "wakeup" || patched.kind === "loop")
    && next.status === "cancelled"
    && previous.nextRunAt
  ) {
    const dueAt = Date.parse(previous.nextRunAt);
    const cancelledAt = Date.parse(nextTimestamp);
    if (Number.isFinite(dueAt) && Number.isFinite(cancelledAt) && cancelledAt >= dueAt - LATE_CANCEL_TOLERANCE_MS) {
      patched.status = "completed";
      patched.firedAt = patched.firedAt ?? previous.nextRunAt;
    }
  }
  return patched;
}

function itemsChanged(left: readonly ChatActivityBundleItem[], right: readonly ChatActivityBundleItem[]): boolean {
  if (left.length !== right.length) return true;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return true;
  }
  return false;
}

/**
 * One row per schedule across the whole transcript. A schedule's later updates
 * (the provider's inventory snapshot, the fire, the cancel) patch the row where
 * the schedule was created instead of adding a row in a later turn. Bundles left
 * with no items drop out. Untouched rows keep their identity.
 */
export function foldScheduledWorkRows(
  rows: ChatTranscriptGroupedEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  const ownerById = new Map<string, { rowIndex: number; itemIndex: number }>();
  const itemsByRow = new Map<number, ChatActivityBundleItem[]>();
  let changed = false;
  rows.forEach((row, rowIndex) => {
    if (row.event.type !== "activity_bundle") return;
    const kept: ChatActivityBundleItem[] = [];
    for (const item of row.event.items) {
      const id = item.event.id;
      const owner = ownerById.get(id);
      if (!owner) {
        ownerById.set(id, { rowIndex, itemIndex: kept.length });
        kept.push(item);
        continue;
      }
      const ownerItems = owner.rowIndex === rowIndex ? kept : itemsByRow.get(owner.rowIndex)!;
      const ownerItem = ownerItems[owner.itemIndex]!;
      ownerItems[owner.itemIndex] = {
        ...ownerItem,
        timestamp: item.timestamp,
        event: patchScheduledWork(ownerItem.event, item.event, item.timestamp),
      };
      changed = true;
    }
    itemsByRow.set(rowIndex, kept);
  });
  if (!changed) return rows;
  const out: ChatTranscriptGroupedEnvelope[] = [];
  rows.forEach((row, rowIndex) => {
    const items = itemsByRow.get(rowIndex);
    if (!items || row.event.type !== "activity_bundle") {
      out.push(row);
      return;
    }
    if (!items.length) return;
    out.push(itemsChanged(row.event.items, items) ? { ...row, event: { ...row.event, items } } : row);
  });
  return out;
}

export type ScheduledWorkAtTurnEnd = {
  rows: ChatTranscriptGroupedEnvelope[];
  /** Schedule items moved onto each ended turn's `done` row, by its row key. */
  byTurnEndKey: ReadonlyMap<string, readonly ChatActivityBundleItem[]>;
};

const EMPTY_TURN_END_ITEMS: ReadonlyMap<string, readonly ChatActivityBundleItem[]> = new Map();

/**
 * A turn that ended shows its wake-ups, crons, and loops on its turn-end line
 * instead of as rows of their own. Bundles in a turn still running stay rows
 * until its `done` arrives. Run after {@link foldScheduledWorkRows}, so each
 * schedule already sits in the turn that created it.
 */
export function moveScheduledWorkToTurnEnds(
  rows: ChatTranscriptGroupedEnvelope[],
): ScheduledWorkAtTurnEnd {
  if (!rows.some((row) => row.event.type === "activity_bundle")) {
    return { rows, byTurnEndKey: EMPTY_TURN_END_ITEMS };
  }
  const byTurnEndKey = new Map<string, ChatActivityBundleItem[]>();
  const moved = new Set<number>();
  let pending: number[] = [];
  rows.forEach((row, index) => {
    if (row.event.type === "activity_bundle") {
      pending.push(index);
      return;
    }
    if (row.event.type !== "done" || !pending.length) return;
    const items: ChatActivityBundleItem[] = [];
    for (const bundleIndex of pending) {
      const bundle = rows[bundleIndex]!.event;
      if (bundle.type !== "activity_bundle") continue;
      items.push(...bundle.items);
      moved.add(bundleIndex);
    }
    byTurnEndKey.set(row.key, items);
    pending = [];
  });
  if (!moved.size) return { rows, byTurnEndKey: EMPTY_TURN_END_ITEMS };
  return { rows: rows.filter((_, index) => !moved.has(index)), byTurnEndKey };
}

type TurnSegment = {
  turnId: string | null;
  keys: string[];
  firstTimestamp: string;
  lastTimestamp: string;
  /** A person (not a scheduled wake) started this turn. */
  prompted: boolean;
  /** The turn scheduled a one-shot wake-up or loop tick. */
  schedulesWake: boolean;
  /** The turn opened with a delivered-wake header. */
  wakeDivider: boolean;
  closed: boolean;
  /** Row key of the turn's `done` row, once it ended. */
  doneKey: string | null;
};

export type WakeChain = {
  chainId: string;
  /** Row keys (before turn folds) of the earlier checks the chain row stands for. */
  hiddenKeys: ReadonlySet<string>;
  hiddenTurnIds: ReadonlySet<string>;
  /**
   * The turn-end line just above the folded checks (the turn that scheduled
   * the first of them). The chain draws as a chip there; null when that turn
   * has no turn-end line, and the chain draws as a row of its own.
   */
  anchorTurnEndKey: string | null;
  checkCount: number;
  firstAt: string;
  lastAt: string;
};

function newSegment(timestamp: string): TurnSegment {
  return {
    turnId: null,
    keys: [],
    firstTimestamp: timestamp,
    lastTimestamp: timestamp,
    prompted: false,
    schedulesWake: false,
    wakeDivider: false,
    closed: false,
    doneKey: null,
  };
}

function isWakeItem(item: ChatActivityBundleItem): boolean {
  return item.event.kind === "wakeup" || item.event.kind === "loop";
}

function splitTurnSegments(
  rows: readonly ChatTranscriptGroupedEnvelope[],
  scheduledByTurnEndKey: ReadonlyMap<string, readonly ChatActivityBundleItem[]>,
): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let current: TurnSegment | null = null;
  for (const row of rows) {
    const turnId = groupedEnvelopeTurnId(row);
    const last = segments[segments.length - 1];
    let segment: TurnSegment;
    if (!current && last?.closed && turnId && last.turnId === turnId) {
      // A trailing row of a turn that already ended (turn details, a late
      // update) stays with that turn.
      segment = last;
    } else {
      if (!current) {
        current = newSegment(row.timestamp);
        segments.push(current);
      }
      segment = current;
    }
    segment.keys.push(row.key);
    segment.lastTimestamp = row.timestamp;
    if (turnId && !segment.turnId) segment.turnId = turnId;
    const event = row.event;
    if (event.type === "user_message" && !event.metadata?.scheduledWake) segment.prompted = true;
    if (event.type === "scheduled_wake_divider") segment.wakeDivider = true;
    if (
      (event.type === "activity_bundle" && event.items.some(isWakeItem))
      || (event.type === "done" && scheduledByTurnEndKey.get(row.key)?.some(isWakeItem))
    ) {
      segment.schedulesWake = true;
    }
    if (event.type === "done" && segment === current) {
      current.closed = true;
      current.doneKey = row.key;
      current = null;
    }
  }
  return segments;
}

/**
 * Runs of turns the agent started for itself from its own wake-ups (a self-paced
 * watch loop). Every check but the latest folds into one chain row; the latest
 * check stays in the thread. A turn a person started ends the run.
 */
export function deriveWakeChains(
  rows: readonly ChatTranscriptGroupedEnvelope[],
  scheduledByTurnEndKey: ReadonlyMap<string, readonly ChatActivityBundleItem[]> = EMPTY_TURN_END_ITEMS,
): WakeChain[] {
  const segments = splitTurnSegments(rows, scheduledByTurnEndKey);
  const chains: WakeChain[] = [];
  let run: TurnSegment[] = [];
  let beforeRun: TurnSegment | null = null;
  const flush = () => {
    const hidden = run.slice(0, -1);
    const anchor = beforeRun;
    run = [];
    if (!hidden.length) return;
    const first = hidden[0]!;
    const hiddenKeys = new Set<string>();
    const hiddenTurnIds = new Set<string>();
    for (const segment of hidden) {
      for (const key of segment.keys) hiddenKeys.add(key);
      if (segment.turnId) hiddenTurnIds.add(segment.turnId);
    }
    chains.push({
      chainId: `wake-chain:${first.turnId ?? first.keys[0]}`,
      hiddenKeys,
      hiddenTurnIds,
      anchorTurnEndKey: anchor?.doneKey ?? null,
      checkCount: hidden.length,
      firstAt: first.firstTimestamp,
      lastAt: hidden[hidden.length - 1]!.lastTimestamp,
    });
  };
  segments.forEach((segment, index) => {
    const previous = index > 0 ? segments[index - 1]! : null;
    const wakeTriggered = !segment.prompted
      && (segment.wakeDivider || previous?.schedulesWake === true);
    if (wakeTriggered) {
      if (!run.length) beforeRun = previous;
      run.push(segment);
    } else {
      flush();
    }
  });
  flush();
  return chains;
}

/**
 * Turns the agent started from its own wake-ups. Their work folds onto their
 * turn-end line instead of a `Worked for …` row: a check is one reply and one
 * line.
 */
export function deriveWakeTurnIds(
  rows: readonly ChatTranscriptGroupedEnvelope[],
  scheduledByTurnEndKey: ReadonlyMap<string, readonly ChatActivityBundleItem[]> = EMPTY_TURN_END_ITEMS,
): Set<string> {
  const segments = splitTurnSegments(rows, scheduledByTurnEndKey);
  const ids = new Set<string>();
  segments.forEach((segment, index) => {
    const previous = index > 0 ? segments[index - 1]! : null;
    if (segment.turnId && !segment.prompted && (segment.wakeDivider || previous?.schedulesWake === true)) {
      ids.add(segment.turnId);
    }
  });
  return ids;
}

export function sameWakeChains(left: readonly WakeChain[], right: readonly WakeChain[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((chain, index) => {
    const other = right[index]!;
    return chain.chainId === other.chainId
      && chain.checkCount === other.checkCount
      && chain.firstAt === other.firstAt
      && chain.lastAt === other.lastAt
      && chain.anchorTurnEndKey === other.anchorTurnEndKey
      && chain.hiddenKeys.size === other.hiddenKeys.size
      && [...chain.hiddenKeys].every((key) => other.hiddenKeys.has(key));
  });
}

function wakeChainRow(
  chain: WakeChain,
  previous: ReadonlyMap<string, ChatTranscriptGroupedEnvelope> | undefined,
): ChatTranscriptGroupedEnvelope {
  const reused = previous?.get(chain.chainId);
  if (
    reused?.event.type === "wake_chain"
    && reused.event.checkCount === chain.checkCount
    && reused.event.firstAt === chain.firstAt
    && reused.event.lastAt === chain.lastAt
  ) {
    return reused;
  }
  const event: WakeChainRenderEvent = {
    type: "wake_chain",
    chainId: chain.chainId,
    checkCount: chain.checkCount,
    firstAt: chain.firstAt,
    lastAt: chain.lastAt,
  };
  return { key: chain.chainId, timestamp: chain.firstAt, event };
}

/**
 * The timeline with every wake chain applied, on rows the turn fold already
 * produced. The chain row takes the place of its first check; a closed chain
 * drops the checks it stands for, an open one shows them under it.
 */
export function applyWakeChains(
  rows: ChatTranscriptGroupedEnvelope[],
  chains: readonly WakeChain[],
  openIds: ReadonlySet<string>,
  previousChainRows?: ReadonlyMap<string, ChatTranscriptGroupedEnvelope>,
): ChatTranscriptGroupedEnvelope[] {
  if (!chains.length) return rows;
  const chainByKey = new Map<string, WakeChain>();
  const chainByTurnId = new Map<string, WakeChain>();
  for (const chain of chains) {
    for (const key of chain.hiddenKeys) chainByKey.set(key, chain);
    for (const turnId of chain.hiddenTurnIds) chainByTurnId.set(turnId, chain);
  }
  const rowKeys = new Set(rows.map((row) => row.key));
  // A chain anchored on a drawn turn-end line is a chip there, not a row.
  const placed = new Set<string>(
    chains
      .filter((chain) => chain.anchorTurnEndKey && rowKeys.has(chain.anchorTurnEndKey))
      .map((chain) => chain.chainId),
  );
  const out: ChatTranscriptGroupedEnvelope[] = [];
  for (const row of rows) {
    const chain = chainByKey.get(row.key)
      ?? (row.event.type === "turn_fold" ? chainByTurnId.get(row.event.turnId) : undefined);
    if (!chain) {
      out.push(row);
      continue;
    }
    if (!placed.has(chain.chainId)) {
      placed.add(chain.chainId);
      out.push(wakeChainRow(chain, previousChainRows));
    }
    if (openIds.has(chain.chainId)) out.push(row);
  }
  return out;
}
