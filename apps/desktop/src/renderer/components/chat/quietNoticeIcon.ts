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

export function quietNoticeIcon(event: SystemNoticeEvent): Icon {
  const detail = event.detail && typeof event.detail === "object" ? event.detail : null;
  if (detail?.permissionModeTransition) return Compass;

  switch (event.status) {
    case "memory_recall":
      return Brain;
    case "classifier_context":
      return Funnel;
    case "goal_reached":
    case "goal_blocked":
      return Target;
    case "cross_machine_handoff_state":
    case "cross_machine_handoff_arrived":
    case "cross_machine_handoff_complete":
    case "cross_machine_handoff_ended":
    case "cross_machine_handoff_returned":
    case "model_refusal_fallback":
      return ArrowsLeftRight;
    case "waiting":
      return Hourglass;
    case "completed":
      return CheckCircle;
    default:
      break;
  }

  if (event.noticeKind === "file_persist") return FloppyDisk;
  if (event.noticeKind === "config") return Wrench;
  if (event.noticeKind === "hook") return Note;

  const message = event.message;
  if (/plan mode/i.test(message)) return Compass;
  if (/\bqueued\b|steer|delivering your/i.test(message)) return Tray;
  if (/question dismissed|duplicate check-in/i.test(message)) return Question;
  if (/reconnected|original thread|ai thread/i.test(message)) return Plugs;
  if (/compact/i.test(message)) return ArrowsIn;
  if (/memor/i.test(message)) return Brain;
  if (/goal/i.test(message)) return Target;
  if (/output style|permission mode/i.test(message)) return SlidersHorizontal;
  if (/downloading|install/i.test(message)) return DownloadSimple;
  if (/denied|permission/i.test(message)) return ShieldCheck;
  if (/warmup|restart|reconnect/i.test(message)) return ArrowCounterClockwise;
  if (/app-server|unsandboxed|shell/i.test(message)) return Terminal;
  if (/mcp|config|setting|header/i.test(message)) return Wrench;
  if (/handoff|another machine|moved/i.test(message)) return ArrowsLeftRight;
  return Note;
}
