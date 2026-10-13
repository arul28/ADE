/**
 * "Chat X finished its turn" notices as the transcript draws them. A parent
 * that spawned chats gets one `spawn_completed` notice per child TURN; drawn
 * as they arrive they stack up, repeat whenever another row splits them, and
 * keep showing finishes that a newer one has already replaced. Here each
 * child keeps only its newest notice (carrying how many turns it stands for),
 * and notices left next to each other share one line.
 *
 * Kept apart from `chatTranscriptRows.ts`, which runs these folds; this file
 * takes only (erased) types back from it, so there is no runtime cycle.
 */
import { readSpawnCompletedNotice, type SpawnCompletedNotice } from "../../../shared/types/chat";
import type { ChatTranscriptGroupedEnvelope, ChatTranscriptRenderEnvelope } from "./chatTranscriptRows";

/** One child's finished-turn notice drawn on another child's line. */
export type SpawnCompletionSibling = {
  key: string;
  notice: SpawnCompletedNotice;
  repeatCount: number;
};

/**
 * The child a `spawn_completed` notice reports on, or `null` for anything
 * else — including a notice whose detail lost its `spawnCompletion` (an old or
 * truncated transcript). An unidentified completion folds into nothing, so it
 * keeps its own row rather than silently absorbing a different child's.
 *
 * Takes a row's event, not `AgentChatEvent`: the folds compare an incoming
 * event against one already stored on a row, and a row holds the render (or,
 * once grouped, the grouped) union.
 */
export function readSpawnCompletionChildId(event: ChatTranscriptGroupedEnvelope["event"]): string | null {
  return spawnCompletionNoticeOf(event)?.childSessionId ?? null;
}

/**
 * One parse per notice event, so a sibling's `notice` keeps its identity
 * across streaming deltas and the line cache below can compare it with `===`.
 */
const noticeByEvent = new WeakMap<object, SpawnCompletedNotice | null>();

/** The notice an event reports, or null; see `readSpawnCompletedNotice`. */
export function spawnCompletionNoticeOf(event: ChatTranscriptGroupedEnvelope["event"]): SpawnCompletedNotice | null {
  if (event.type !== "system_notice") return null;
  let notice = noticeByEvent.get(event);
  if (notice === undefined) {
    notice = readSpawnCompletedNotice(event);
    noticeByEvent.set(event, notice);
  }
  return notice;
}

/**
 * A completion line as drawn, cached on its source row so an unchanged line
 * keeps its identity across streaming deltas (and `React.memo` holds).
 */
const lineCache = new WeakMap<
  ChatTranscriptRenderEnvelope,
  { repeatCount: number; siblings: SpawnCompletionSibling[]; row: ChatTranscriptRenderEnvelope }
>();

function sameSiblings(left: readonly SpawnCompletionSibling[], right: readonly SpawnCompletionSibling[]): boolean {
  return left.length === right.length && left.every((sibling, index) => {
    const other = right[index];
    return sibling.key === other.key && sibling.notice === other.notice && sibling.repeatCount === other.repeatCount;
  });
}

function completionLine(
  source: ChatTranscriptRenderEnvelope,
  repeatCount: number,
  siblings: SpawnCompletionSibling[],
): ChatTranscriptRenderEnvelope {
  if (repeatCount === (source.repeatCount ?? 1) && siblings.length === 0) return source;
  const cached = lineCache.get(source);
  if (cached && cached.repeatCount === repeatCount && sameSiblings(cached.siblings, siblings)) return cached.row;
  const row: ChatTranscriptRenderEnvelope = {
    ...source,
    repeatCount,
    ...(siblings.length ? { spawnCompletionSiblings: siblings } : {}),
  };
  lineCache.set(source, { repeatCount, siblings, row });
  return row;
}

/**
 * Drops each child's older notices (an older one is out of date the moment a
 * newer one lands, wherever it sits) and puts neighbouring notices on one
 * line. Returns `rows` itself when there is nothing to fold.
 */
export function foldSpawnCompletionLines(
  rows: ChatTranscriptRenderEnvelope[],
): ChatTranscriptRenderEnvelope[] {
  // Newest first: the first row seen per child is the one that stays.
  const turnsByChild = new Map<string, number>();
  const staleRows = new Set<ChatTranscriptRenderEnvelope>();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const childId = readSpawnCompletionChildId(row.event);
    if (!childId) continue;
    const seen = turnsByChild.get(childId);
    if (seen !== undefined) staleRows.add(row);
    turnsByChild.set(childId, (seen ?? 0) + (row.repeatCount ?? 1));
  }
  if (turnsByChild.size === 0) return rows;

  const folded: ChatTranscriptRenderEnvelope[] = [];
  let line: { source: ChatTranscriptRenderEnvelope; repeatCount: number; siblings: SpawnCompletionSibling[] } | null = null;
  // Nothing else is pushed while a line is open, so it lands in its place.
  const closeLine = () => {
    if (!line) return;
    folded.push(completionLine(line.source, line.repeatCount, line.siblings));
    line = null;
  };
  for (const row of rows) {
    if (staleRows.has(row)) continue;
    const notice = spawnCompletionNoticeOf(row.event);
    const childId = notice?.childSessionId;
    if (!notice || !childId) {
      closeLine();
      folded.push(row);
      continue;
    }
    const repeatCount = turnsByChild.get(childId) ?? 1;
    if (line) {
      line.siblings.push({ key: row.key, notice, repeatCount });
      continue;
    }
    line = { source: row, repeatCount, siblings: [] };
  }
  closeLine();
  return folded;
}

/**
 * The row that shows `childId`'s finished turns: its line's leader, or a line
 * it shares. A notice anchor needs this because the notice it names may have
 * folded into a newer one further down the thread.
 */
export function findSpawnCompletionLine(
  rows: readonly ChatTranscriptGroupedEnvelope[],
  childId: string,
): ChatTranscriptGroupedEnvelope | undefined {
  return rows.find((row) => (
    readSpawnCompletionChildId(row.event) === childId
    || (row.spawnCompletionSiblings ?? []).some((sibling) => sibling.notice.childSessionId === childId)
  ));
}
