import { parseSessionInputOrigin, type SessionInputOrigin } from "../../../shared/sessionInputOrigin";

/**
 * The desktop that sent each session its last message, in this runtime.
 *
 * In memory on purpose: after a restart nobody can say which screen the user
 * is at, and the answer for "unknown" (show everywhere) is the safe one.
 * Bounded so a long-lived brain with thousands of chats keeps only the recent.
 */

const MAX_SESSIONS = 512;
const origins = new Map<string, SessionInputOrigin>();

/** Record the stamp a message carried. A message without one changes nothing. */
export function noteSessionInputOrigin(sessionId: string | null | undefined, value: unknown): void {
  const id = sessionId?.trim();
  const origin = parseSessionInputOrigin(value);
  if (!id || !origin) return;
  origins.delete(id);
  origins.set(id, origin);
  if (origins.size > MAX_SESSIONS) {
    const oldest = origins.keys().next().value;
    if (oldest) origins.delete(oldest);
  }
}

export function getSessionInputOrigin(sessionId: string | null | undefined): SessionInputOrigin | null {
  const id = sessionId?.trim();
  return id ? origins.get(id) ?? null : null;
}
