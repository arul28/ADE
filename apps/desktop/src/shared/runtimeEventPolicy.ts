import {
  REMOTE_RUNTIME_EVENT_CATEGORIES,
  type RemoteRuntimeEventCategory,
} from "./types/remoteRuntime";

/* ─────────────────────── the cto_voice visibility rule ─────────────────────── */

/**
 * The one runtime event category that is not readable by whoever can read the
 * rest.
 *
 * A voice call's state carries its running transcript, so listening to one is
 * the same disclosure as reading the CTO thread — and the `cto_voice` ACTION
 * domain is already fail-closed to the cto role. Without the same gate on the
 * event buffer an agent that cannot start or drive a call could still sit and
 * drain one out of it.
 *
 * The rule has two halves and they are not the same half twice: a stream asked
 * for BY NAME is refused, so the caller learns it was denied rather than
 * quietly receiving nothing; an UNCATEGORISED stream is filtered, so every
 * other category still arrives and the cursor still advances past what was
 * withheld (refusing it would stall an innocent poller).
 *
 * A POLICY module rather than a line in the type file: this is behaviour, not
 * shape, and every helper here takes the caller's role flag so a call site
 * cannot express half the rule. The first version left the `!callerIsCto`
 * half to the callers, and all four of them hand-wrote it — which is exactly
 * the drift the module exists to prevent.
 */
export const VOICE_RUNTIME_EVENT_CATEGORY: RemoteRuntimeEventCategory = "cto_voice";

// The tuple is imported, not re-listed: a category renamed there must not
// leave this file pointing at a string nothing publishes any more.
if (!(REMOTE_RUNTIME_EVENT_CATEGORIES as readonly string[]).includes(VOICE_RUNTIME_EVENT_CATEGORY)) {
  throw new Error("VOICE_RUNTIME_EVENT_CATEGORY is not a runtime event category.");
}

/** True when this event must be withheld from this caller. */
export function hidesVoiceEvent(event: { category: string }, callerIsCto: boolean): boolean {
  return !callerIsCto && event.category === VOICE_RUNTIME_EVENT_CATEGORY;
}

/** True when a caller who is not the CTO named the voice category outright. */
export function refusesVoiceCategory(
  category: string | null | undefined,
  callerIsCto: boolean,
): boolean {
  return category === VOICE_RUNTIME_EVENT_CATEGORY && !callerIsCto;
}

/**
 * The refusal text, so the two servers cannot drift into two different answers
 * for the same denial. The caller supplies the method name and wraps this in
 * whatever error type its transport speaks.
 */
export function voiceCategoryRefusalMessage(method: string): string {
  return `${method} category ${VOICE_RUNTIME_EVENT_CATEGORY} requires the cto role.`;
}

/** The filtering half: strip voice state out of an uncategorised batch. */
export function withoutVoiceEvents<T extends { category: string }>(
  events: readonly T[],
  callerIsCto: boolean,
): T[] {
  if (callerIsCto) return [...events];
  return events.filter((event) => !hidesVoiceEvent(event, callerIsCto));
}
