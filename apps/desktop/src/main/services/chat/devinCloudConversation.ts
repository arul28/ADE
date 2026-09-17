/**
 * Devin cloud transcript mirroring.
 *
 * Devin's surface is simpler than Cursor's: `GET .../sessions/{id}/messages`
 * returns a flat, chronological list of `{ event_id, source, message }` rows —
 * no runs, no attach lease, no per-run conversation payloads. The mirror
 * dedupes on the same `user:`/`text:` fingerprints
 * `transcriptCloudFingerprints` produces for emitted events, so rehydrating a
 * chat after a restart does not double-print history.
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
