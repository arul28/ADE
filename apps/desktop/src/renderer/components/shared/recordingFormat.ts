/**
 * The numbers and the one lookup behind a screen tool's recording chrome.
 *
 * Shared by the Apple device pane and the Mac Desktop pane, so a recording
 * reads the same in both: the same clock, the same size, the same receipt
 * timeout, and the same way of finding the proof row it was filed as.
 */

/** How long the "Saved to proof" receipt stays on screen. */
export const RECORDING_RECEIPT_MS = 6_000;

/** `mm:ss`, or `h:mm:ss` past an hour. Monospaced-friendly and never negative. */
export function formatRecordingElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRecordingBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // A whole number reads as one: "3 MB", not "3.0 MB".
  const rounded = Math.round(value * 10) / 10;
  const text = unit === 0 || Number.isInteger(rounded) ? String(Math.round(rounded)) : rounded.toFixed(1);
  return `${text} ${units[unit]}`;
}

/**
 * Show the proof row for an artifact, if the proof panel is on screen.
 *
 * Returns false when it is not, which is the caller's cue to fall back to
 * the file. There is no "select this artifact" API to call — the panel
 * renders one row per artifact and labels it — so this scrolls to the row
 * rather than inventing a store two features would then have to keep in
 * sync.
 */
export function revealProofArtifactRow(artifactId: string): boolean {
  let row: HTMLElement | null = null;
  try {
    // `CSS.escape` is not everywhere (jsdom has no `CSS` at all), and a
    // selector that throws inside a click handler takes the whole row down
    // rather than falling through to the file — which is the one thing this
    // function exists to allow.
    const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(artifactId)
      : artifactId.replace(/["\\]/gu, "\\$&");
    row = document.querySelector<HTMLElement>(`[data-chat-proof-artifact="${escaped}"]`);
  } catch {
    return false;
  }
  if (!row) return false;
  row.scrollIntoView({ block: "center", behavior: "smooth" });
  row.focus?.();
  return true;
}
