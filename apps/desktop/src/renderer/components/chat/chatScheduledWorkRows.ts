import type {
  ChatActivityBundleItem,
  ChatTranscriptGroupedEnvelope,
  WakeChainRenderEvent,
} from "./chatTranscriptRows";
import { groupedEnvelopeTurnId } from "./chatTranscriptTurnFolds";
import { mergeScheduledWorkEvent } from "../../../shared/chatScheduledWork";
import { isForeignTurnEnd, type TurnFold } from "../../../shared/chatTurnFold";

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
      const ownerItems = owner.rowIndex === rowIndex ? kept : itemsByRow.get(owner.rowIndex);
      const ownerItem = ownerItems?.[owner.itemIndex];
      if (!ownerItems || !ownerItem) continue;
      ownerItems[owner.itemIndex] = {
        ...ownerItem,
        timestamp: item.timestamp,
        event: mergeScheduledWorkEvent(ownerItem.event, item.event, item.timestamp),
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
  let windowTurnIds = new Set<string>();
  rows.forEach((row, index) => {
    const turnId = groupedEnvelopeTurnId(row);
    if (row.event.type !== "done") {
      if (turnId) windowTurnIds.add(turnId);
      if (row.event.type === "activity_bundle") pending.push(index);
      return;
    }
    // A subagent's `done` inside the parent turn does not end it.
    if (isForeignTurnEnd(turnId, windowTurnIds)) return;
    windowTurnIds = new Set();
    if (!pending.length) return;
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
  // A queued message keeps its place in the earlier turn when it is delivered,
  // so "a person started this turn" is read by turn id, not by row position.
  const promptedTurnIds = new Set<string>();
  for (const row of rows) {
    if (row.event.type === "user_message" && !row.event.metadata?.scheduledWake) {
      const turnId = groupedEnvelopeTurnId(row);
      if (turnId) promptedTurnIds.add(turnId);
    }
  }
  const segments: TurnSegment[] = [];
  let current: TurnSegment | null = null;
  let windowTurnIds = new Set<string>();
  for (const row of rows) {
    const turnId = groupedEnvelopeTurnId(row);
    const foreignEnd = row.event.type === "done" && isForeignTurnEnd(turnId, windowTurnIds);
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
    if (turnId && row.event.type !== "done") windowTurnIds.add(turnId);
    const event = row.event;
    if (event.type === "user_message" && !event.metadata?.scheduledWake) segment.prompted = true;
    if (event.type === "scheduled_wake_divider") segment.wakeDivider = true;
    if (
      (event.type === "activity_bundle" && event.items.some(isWakeItem))
      || (event.type === "done" && scheduledByTurnEndKey.get(row.key)?.some(isWakeItem))
    ) {
      segment.schedulesWake = true;
    }
    if (event.type === "done" && segment === current && !foreignEnd) {
      current.closed = true;
      current.doneKey = row.key;
      current = null;
      windowTurnIds = new Set();
    }
  }
  for (const segment of segments) {
    if (segment.turnId && promptedTurnIds.has(segment.turnId)) segment.prompted = true;
  }
  return segments;
}

/** Started by the agent's own wake-up: no person started it, and it follows a wake-up or opens with one. */
function isWakeTriggered(segment: TurnSegment, previous: TurnSegment | null): boolean {
  return !segment.prompted && (segment.wakeDivider || previous?.schedulesWake === true);
}

export type WakeTurns = {
  /**
   * Turns the agent started from its own wake-ups. Their work folds onto their
   * turn-end line instead of a `Worked for …` row: a check is one reply and
   * one line.
   */
  turnIds: ReadonlySet<string>;
  /**
   * Runs of those turns (a self-paced watch loop). Every check but the latest
   * folds into one chain; the latest stays in the thread. A turn a person
   * started ends the run.
   */
  chains: WakeChain[];
};

export function deriveWakeTurns(
  rows: readonly ChatTranscriptGroupedEnvelope[],
  scheduledByTurnEndKey: ReadonlyMap<string, readonly ChatActivityBundleItem[]> = EMPTY_TURN_END_ITEMS,
): WakeTurns {
  const segments = splitTurnSegments(rows, scheduledByTurnEndKey);
  const turnIds = new Set<string>();
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
    if (!isWakeTriggered(segment, previous)) {
      flush();
      return;
    }
    if (segment.turnId) turnIds.add(segment.turnId);
    if (!run.length) beforeRun = previous;
    run.push(segment);
  });
  flush();
  return { turnIds, chains };
}

/**
 * The fold each hidden row answers to, for jumps and reveals. A closed chain
 * hides whole turns, so it wins over the turn fold inside it until it opens.
 */
export function foldIdsByHiddenRowKey(
  turnFolds: readonly TurnFold[],
  chains: readonly WakeChain[],
  openIds: ReadonlySet<string>,
): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const fold of turnFolds) {
    for (const key of fold.hiddenKeys) byKey.set(key, fold.foldId);
  }
  for (const chain of chains) {
    if (openIds.has(chain.chainId)) continue;
    for (const key of chain.hiddenKeys) byKey.set(key, chain.chainId);
    for (const fold of turnFolds) {
      if (!chain.hiddenTurnIds.has(fold.turnId)) continue;
      byKey.set(fold.foldId, chain.chainId);
      for (const key of fold.hiddenKeys) byKey.set(key, chain.chainId);
    }
  }
  return byKey;
}

/**
 * `── New since 9:12 PM ──` above the first row that arrived while the reader
 * was away. Placed once, when the chat opens; it never moves as rows stream in.
 */
export function insertNewSinceDivider(
  rows: ChatTranscriptGroupedEnvelope[],
  unreadSince: { sinceMs: number; openedAtMs: number } | null,
): ChatTranscriptGroupedEnvelope[] {
  if (!unreadSince) return rows;
  const index = rows.findIndex((row) => {
    const at = Date.parse(row.timestamp);
    return Number.isFinite(at) && at > unreadSince.sinceMs;
  });
  // Nothing before it (a new chat) or nothing that arrived before this open.
  if (index <= 0) return rows;
  const firstAt = Date.parse(rows[index]!.timestamp);
  if (firstAt > unreadSince.openedAtMs) return rows;
  const divider: ChatTranscriptGroupedEnvelope = {
    key: "new-since-divider",
    timestamp: rows[index]!.timestamp,
    event: { type: "new_since_divider", sinceMs: unreadSince.sinceMs },
  };
  return [...rows.slice(0, index), divider, ...rows.slice(index)];
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
