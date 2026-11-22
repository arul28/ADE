import type { CloudPhoneStart } from "../../../../../account-directory/src/cloud/contract";
import { CLOUD_PHONE_IDLE_MINUTES, CLOUD_PHONE_MAX_MINUTES, CLOUD_PHONE_MODELS, isCloudPhoneDevice } from "../../../shared/cloudPhone";

/*
 * One run of the ADE Cloud iPhone as a brain tracks it, and the lines its chat
 * reads when it starts and ends (`cloudPhoneService`'s notices).
 */

/**
 * The phone this brain took, kept past the held token (a stop or a failed
 * read drops that) until its end is told: the chat its start was told to,
 * when it became ready, and when this brain last called one of its tools.
 * `P` is the service's held phone (its token, to read why it ended).
 */
export type CloudPhoneRun<P> = {
  phoneId: string;
  account: string | null;
  /** The agent chat whose call started it; null when a person, a terminal, or a reuse did. */
  chatSessionId: string | null;
  readyAt: number | null;
  lastActivityAt: number | null;
  /** When this brain took it: a status read sent before then can't have seen it. */
  heldAt: number;
  /** The chat's start line, until told: kept past a failed readiness read, told once it reads ready. */
  startLine: string | null;
  phone: P;
};

export type CloudPhoneRunEnd = { why: string | null; at: number | null };

/** The chat a call came from: the RPC server's `approval` stamp, never the caller's own word. */
export function cloudPhoneCallerChat(args: unknown): string | null {
  const approval = args && typeof args === "object" ? (args as { approval?: unknown }).approval : null;
  const id = approval && typeof approval === "object" ? (approval as { chatSessionId?: unknown }).chatSessionId : null;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/** Why a phone ended, as a chat reads it. */
function endSentence(reason: string | null): string {
  if (reason === "idle") return `nothing used it for ${CLOUD_PHONE_IDLE_MINUTES} minutes`;
  if (reason === "time_limit") return `it reached its ${CLOUD_PHONE_MAX_MINUTES / 60}-hour limit`;
  if (reason === "spend_cap" || reason === "minutes_used") return "this period's minutes ran out";
  if (reason === "stopped") return "it was stopped";
  return reason ? `it ended (${reason})` : "it ended";
}

/** The chat's line for a phone its call started. */
export function cloudPhoneStartLine(start: CloudPhoneStart): string {
  const device = start.phone.device;
  const label = isCloudPhoneDevice(device) ? CLOUD_PHONE_MODELS[device].label : String(device);
  const minutes = start.minutes
    ? start.minutes.left > 0 ? ` ${start.minutes.left} of ${start.minutes.included} min left this period.` : " This period's plan minutes are used, so extra minutes apply."
    : "";
  return `ADE Cloud iPhone started (${label}).${minutes} It stops after ${CLOUD_PHONE_IDLE_MINUTES} min with no command or input.`;
}

/** The chat's line for the run's end; `stopped` is a stop this brain asked for. */
export function cloudPhoneEndLine(ended: { readyAt: number | null; lastActivityAt: number | null }, end: CloudPhoneRunEnd | "stopped", now = Date.now()): string {
  // No end time known: an idle stop came 5 minutes after the last call, not when this read noticed it.
  const idleEnd = end !== "stopped" && end.why === "idle" && ended.lastActivityAt ? ended.lastActivityAt + CLOUD_PHONE_IDLE_MINUTES * 60_000 : null;
  const at = end === "stopped" ? now : end.at ?? Math.min(now, idleEnd ?? now);
  const used = ended.readyAt ? ` Used ${Math.min(CLOUD_PHONE_MAX_MINUTES, Math.max(1, Math.ceil((at - ended.readyAt) / 60_000)))} min this run.` : "";
  return end === "stopped" ? `ADE Cloud iPhone stopped.${used}` : `ADE Cloud iPhone stopped: ${endSentence(end.why)}.${used}`;
}
