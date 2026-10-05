import { parseSessionInputOrigin, type SessionInputOrigin } from "../../../shared/sessionInputOrigin";

/**
 * The desktop that sent each session its last message, in this runtime.
 *
 * In memory on purpose: after a restart nobody can say which screen the user
 * is at, and the answer for "unknown" (show everywhere) is the safe one.
 * Bounded so a long-lived brain with thousands of chats keeps only the recent.
 */

const MAX_SESSIONS = 512;
/**
 * How long a sender is trusted for requests nobody acknowledges (automatic
 * float offers, Apple drawer reveals). Those cannot fall back when the desktop
 * is gone, so after a quiet spell they go to every desktop instead.
 */
export const RECENT_INPUT_ORIGIN_MS = 10 * 60_000;
const origins = new Map<string, { origin: SessionInputOrigin; at: number }>();

/**
 * Record the stamp a message carried. A message without one (the phone, the
 * CLI, another agent) makes the sender unknown again, so requests go to every
 * desktop rather than to a laptop whose lid may be closed.
 */
export function noteSessionInputOrigin(sessionId: string | null | undefined, value: unknown): void {
  const id = sessionId?.trim();
  if (!id) return;
  origins.delete(id);
  const origin = parseSessionInputOrigin(value);
  if (!origin) return;
  origins.set(id, { origin, at: Date.now() });
  if (origins.size > MAX_SESSIONS) {
    const oldest = origins.keys().next().value;
    if (oldest) origins.delete(oldest);
  }
}

/** The last sender; with `maxAgeMs`, only when that message is that recent. */
export function getSessionInputOrigin(
  sessionId: string | null | undefined,
  options: { maxAgeMs?: number } = {},
): SessionInputOrigin | null {
  const id = sessionId?.trim();
  const entry = id ? origins.get(id) : undefined;
  if (!entry) return null;
  if (options.maxAgeMs != null && Date.now() - entry.at > options.maxAgeMs) return null;
  return entry.origin;
}
