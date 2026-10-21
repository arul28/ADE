/**
 * Receipt notices as the transcript draws them: one quiet line with a semantic
 * icon, the detail behind a click, and adjacent receipts in one turn on a
 * single line with a `+N` count.
 *
 * A "receipt" is a notice with nothing to act on: the chat entered plan mode,
 * queued a message, recalled a memory, compacted, changed an output style.
 * Those used to be drawn as the same frosted card as a failure, which gave a
 * four-word status the visual weight of an answer. Failures and sign-in keep
 * their cards (`renderEvent` decides), warnings keep their amber line.
 *
 * Kept apart from `chatTranscriptRows.ts`, which runs the fold; this file takes
 * only (erased) types back from it, so there is no runtime cycle.
 */
import { isHostSleepNoticeEvent } from "../../../shared/hostSleepNotice";
import type { AgentChatEvent } from "../../../shared/types";
import type { ChatTranscriptRenderEnvelope } from "./chatTranscriptRows";

export type SystemNoticeEvent = Extract<AgentChatEvent, { type: "system_notice" }>;

/** One receipt drawn on another receipt's line. */
export type QuietNoticeSibling = {
  key: string;
  event: SystemNoticeEvent;
};

/**
 * The kinds that are receipts. `auth`, `rate_limit`, `warning`, `error`,
 * `thread_error` and `provider_health` are never quiet: each has its own
 * treatment (sign-in card, usage row, amber line, failure card) and someone has
 * to act on it.
 */
const QUIET_NOTICE_KINDS: ReadonlySet<string> = new Set([
  "info",
  "config",
  "hook",
  "file_persist",
]);

/**
 * Statuses whose renderer is a dedicated row (divider, spawn pill, sleep chip,
 * reset-credit card, voice card), so they must never join a receipt line.
 */
const SPECIAL_NOTICE_STATUSES: ReadonlySet<string> = new Set([
  "model_switched",
  "reset_credit_available",
  "voice_session",
  "subagent_spawned",
  "spawn_takeover",
  "spawn_parent_gone",
  "spawn_completed",
  "spawn_completion_delivery_failed",
]);

/**
 * True when `renderEvent` draws this notice as a quiet line — and therefore
 * when `foldQuietNoticeLines` may put it on a shared line. Both decisions read
 * this one predicate so a folded row can never be a card.
 */
export function isQuietNoticeEvent(
  event: ChatTranscriptRenderEnvelope["event"],
): boolean {
  if (event.type !== "system_notice") return false;
  if (!QUIET_NOTICE_KINDS.has(event.noticeKind)) return false;
  // Warnings get the amber one-liner; errors must keep their card.
  if (event.severity === "warning" || event.severity === "error") return false;
  if (event.status && SPECIAL_NOTICE_STATUSES.has(event.status)) return false;
  if (isHostSleepNoticeEvent(event)) return false;
  if (event.detail && typeof event.detail === "object") {
    // Both carry actions (retry, recover) and stay cards.
    if (event.detail.kind === "continuity_recovery" || event.detail.kind === "disk_pressure") return false;
  }
  return true;
}

/**
 * Puts neighbouring receipts from the same turn on one line. The first notice
 * keeps the line (and its key), the rest ride along as siblings the row draws
 * under a `+N` count.
 *
 * Adjacency-only, like `foldSpawnCompletionLines`: the incremental and full
 * collapses see the same stream, and a divider, a tool card or a user message
 * still ends a run. Returns `rows` itself when nothing folded, so an unchanged
 * transcript keeps its identity.
 */
export function foldQuietNoticeLines(
  rows: ChatTranscriptRenderEnvelope[],
): ChatTranscriptRenderEnvelope[] {
  let line: { source: ChatTranscriptRenderEnvelope; event: SystemNoticeEvent; siblings: QuietNoticeSibling[] } | null = null;
  const folded: ChatTranscriptRenderEnvelope[] = [];

  const push = () => {
    if (!line) return;
    folded.push(line.siblings.length === 0 ? line.source : {
      ...line.source,
      quietNoticeSiblings: line.siblings,
    });
    line = null;
  };

  for (const row of rows) {
    if (row.event.type !== "system_notice" || !isQuietNoticeEvent(row.event)) {
      push();
      folded.push(row);
      continue;
    }
    const event = row.event;
    if (line && (line.event.turnId ?? null) === (event.turnId ?? null)) {
      line.siblings.push({ key: row.key, event });
      continue;
    }
    push();
    line = { source: row, event, siblings: [] };
  }
  push();
  return folded.length === rows.length ? rows : folded;
}
