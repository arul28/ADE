/**
 * The glyph on a quiet receipt line. Shape carries the meaning, so the line
 * needs no `INFO` chip: a plan transition gets a compass, a queued message a
 * tray, a reconnect a plug, a memory a brain.
 *
 * `status` and structured `detail` are the durable signals and are read first.
 * The message patterns exist only for older transcripts (and for producers that
 * never set a status); they are a fallback, and an unmatched receipt draws the
 * neutral note rather than nothing.
 */
import {
  ArrowsIn,
  ArrowsLeftRight,
  ArrowCounterClockwise,
  Bell,
  Brain,
  CheckCircle,
  Compass,
  DownloadSimple,
  FloppyDisk,
  Funnel,
  Hourglass,
  Note,
  Plugs,
  Question,
  ShieldCheck,
  SlidersHorizontal,
  Target,
  Terminal,
  Tray,
  Wrench,
  type Icon,
} from "@phosphor-icons/react";
import type { SystemNoticeEvent } from "./quietNoticeLines";

/**
 * Keyed by a string off the wire, so a `Map` (not an object literal): a status
 * such as `constructor` must miss, not resolve to `Object.prototype`.
 */
const ICON_BY_STATUS: ReadonlyMap<string, Icon> = new Map([
  ["memory_recall", Brain],
  ["classifier_context", Funnel],
  ["user_notified", Bell],
  ["goal_reached", Target],
  ["goal_blocked", Target],
  ["cross_machine_handoff_state", ArrowsLeftRight],
  ["cross_machine_handoff_arrived", ArrowsLeftRight],
  ["cross_machine_handoff_complete", ArrowsLeftRight],
  ["cross_machine_handoff_ended", ArrowsLeftRight],
  ["cross_machine_handoff_returned", ArrowsLeftRight],
  ["model_refusal_fallback", ArrowsLeftRight],
  ["waiting", Hourglass],
  ["completed", CheckCircle],
]);

/** Kinds whose glyph is fixed, before any message pattern is consulted. */
const ICON_BY_KIND: ReadonlyMap<string, Icon> = new Map([
  ["file_persist", FloppyDisk],
  ["config", Wrench],
  ["hook", Note],
]);

/**
 * Fallback vocabulary for transcripts that predate a `status`. Ordered: the
 * first match wins, so the specific families sit above the general ones.
 */
const ICON_BY_MESSAGE: ReadonlyArray<readonly [RegExp, Icon]> = [
  [/plan mode/i, Compass],
  [/\bqueued\b|steer|delivering your/i, Tray],
  [/question dismissed|duplicate check-in/i, Question],
  [/reconnected|original thread|ai thread/i, Plugs],
  [/compact/i, ArrowsIn],
  [/memor/i, Brain],
  [/goal/i, Target],
  [/output style|permission mode/i, SlidersHorizontal],
  [/downloading|install/i, DownloadSimple],
  [/denied|permission/i, ShieldCheck],
  [/warmup|restart|reconnect/i, ArrowCounterClockwise],
  [/app-server|unsandboxed|shell/i, Terminal],
  [/mcp|config|setting|header/i, Wrench],
  [/handoff|another machine|moved/i, ArrowsLeftRight],
];

export function quietNoticeIcon(event: SystemNoticeEvent): Icon {
  const detail = event.detail && typeof event.detail === "object" ? event.detail : null;
  if (detail?.permissionModeTransition) return Compass;

  const byStatus = event.status ? ICON_BY_STATUS.get(event.status) : undefined;
  if (byStatus) return byStatus;

  const byKind = ICON_BY_KIND.get(event.noticeKind);
  if (byKind) return byKind;

  for (const [pattern, icon] of ICON_BY_MESSAGE) {
    if (pattern.test(event.message)) return icon;
  }
  return Note;
}
