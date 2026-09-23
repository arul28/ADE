/**
 * Devin cloud transcript mirroring.
 *
 * Devin's surface is simpler than Cursor's: `GET .../sessions/{id}/messages`
 * returns a flat, chronological list of `{ event_id, source, message }` rows —
 * no runs, no attach lease, no per-run conversation payloads. The mirror
 * dedupes on `event_id` — mirrored events carry it in `messageId`, so
 * rehydrating after a restart does not double-print history. Text
 * fingerprints apply only to the local-send echo: the `user_message` this
 * host emits when the composer sends over REST arrives again in the next
 * poll with its own event id.
 */

import type { DevinCloudMessage } from "../../../shared/types/config";

/** How often a watched cloud chat re-reads the session's remote title. */
export const DEVIN_CLOUD_REMOTE_NAME_READ_TTL_MS = 60_000;

/** Empty transcript reads of a terminal session before ADE stops asking. */
export const DEVIN_CLOUD_EMPTY_TERMINAL_READ_LIMIT = 3;

/**
 * Event-driven name reads a still-unnamed cloud chat may make on top of the
 * TTL rule — Devin titles a session shortly after its first output lands.
 */
export const DEVIN_CLOUD_PLACEHOLDER_NAME_READ_LIMIT = 3;

/** Bounded retries covering "session exists, transcript not materialized yet". */
export const DEVIN_CLOUD_MESSAGES_RETRY_ATTEMPTS = 4;
export const DEVIN_CLOUD_MESSAGES_RETRY_MS = 2_000;

/**
 * Fingerprint matching `transcriptCloudFingerprints`' vocabulary so hydrated
 * events and freshly polled rows dedupe against each other.
 */
export function devinCloudMessageFingerprint(
  message: Pick<DevinCloudMessage, "source" | "message">,
): string | null {
  const text = message.message.trim();
  if (!text) return null;
  return message.source === "user" ? `user:${text}` : `text:${text}`;
}

/**
 * Prefix stamped into `messageId` on mirrored events so the remote event id
 * survives in the persisted transcript and dedupes across restarts.
 */
export const DEVIN_CLOUD_REMOTE_MESSAGE_ID_PREFIX = "devin:";

/**
 * Consumes one local-send echo: returns the matched local fingerprint (one
 * occurrence removed) when `candidate` matches a fingerprint the transcript
 * carries for a user message this host emitted, else null. Call only for
 * remote `source: "user"` rows — agent output dedupes on event id, never
 * text, so repeated identical Devin messages still print. The return is the
 * LOCAL key, not the remote candidate — a remote row whose text differs by
 * appended delivery lines is still the same send, but persisting the remote
 * text would fail to retire the local echo on rebuild.
 */
export function consumeDevinEchoFingerprint(
  echoes: Map<string, number>,
  candidate: string,
): string | null {
  const claim = (key: string): string => {
    const remaining = (echoes.get(key) ?? 0) - 1;
    if (remaining <= 0) echoes.delete(key);
    else echoes.set(key, remaining);
    return key;
  };
  if (echoes.has(candidate)) return claim(candidate);
  // A local send's remote copy can only differ by lines ADE appended itself —
  // `Image URL:` hints and v1 `ATTACHMENT:` delivery lines. Strip exactly
  // those and compare again: any other divergence means the remote row is a
  // distinct message, not this host's echo.
  const [kind, ...rest] = candidate.split(":");
  const value = rest.join(":");
  if (!value) return null;
  const stripped = value
    .split("\n")
    .filter((line) => !/^(?:Image URL: |ATTACHMENT:)/.test(line.trimStart()))
    .join("\n")
    .trim();
  if (stripped !== value.trim() && echoes.has(`${kind}:${stripped}`)) {
    return claim(`${kind}:${stripped}`);
  }
  return null;
}

/** Terminal Devin statuses — a session that will not produce further output. */
export function isDevinCloudSessionLive(
  status: string | null | undefined,
): boolean {
  const lower = status?.toLowerCase() ?? "";
  return (
    lower === "new"
    || lower === "claimed"
    || lower === "running"
    || lower === "resuming"
  );
}
