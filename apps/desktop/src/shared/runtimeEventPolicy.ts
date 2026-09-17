import type { RemoteRuntimeEventCategory } from "./types/remoteRuntime";

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
 * cannot express half the rule — a call site that hand-writes the
 * `!callerIsCto` half is exactly the drift this module exists to prevent.
 *
 * `satisfies` rather than a runtime check: the category type is derived from
 * `REMOTE_RUNTIME_EVENT_CATEGORIES`, so renaming the category there fails the
 * typecheck here rather than throwing at module load.
 */
export const VOICE_RUNTIME_EVENT_CATEGORY = "cto_voice" satisfies RemoteRuntimeEventCategory;

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

/**
 * The filtering half: strip voice state out of an uncategorised batch.
 *
 * The CTO's own batch is returned as the SAME array, not a copy — this sits on
 * the hot drain path of every event poll, and copying a thousand-event batch
 * for the one caller who is allowed all of it buys nothing.
 */
export function withoutVoiceEvents<T extends { category: string }>(
  events: readonly T[],
  callerIsCto: boolean,
): readonly T[] {
  if (callerIsCto) return events;
  return events.filter((event) => !hidesVoiceEvent(event, callerIsCto));
}
