import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { SimRecording } from "../../../main/services/ios/recording/simRecordingService";

/**
 * The column's half of the recording contract.
 *
 * The service owns the rules that actually matter — auto-record on an agent's
 * first injected input, the ten-minute cap, `proof` pinning, and the refusal to
 * delete a pinned file. This module owns the numbers on screen and the four
 * calls the toolbar makes, so the column never has to hold a recording clock of
 * its own.
 */

export type AppleRecordingSummary = {
  count: number;
  totalBytes: number;
  /** Recordings filed into the proof drawer. Since round 3 that is all of them. */
  pinnedCount: number;
};

/** How long the "Saved to proof" receipt stays on screen. */
export const APPLE_RECORDING_RECEIPT_MS = 6_000;

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
 * How long a recording has been running, or ran.
 *
 * A recording still in flight has no `durationMs`, so the elapsed time has to
 * be measured against the wall clock the caller passes. Passing `now` rather
 * than reading it here is what lets one 1Hz tick in the column drive every row.
 */
export function recordingElapsedMs(recording: SimRecording, now: number): number {
  if (typeof recording.durationMs === "number") return recording.durationMs;
  const startedAt = Date.parse(recording.startedAt);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, now - startedAt);
}

export function isRecordingActive(recording: SimRecording): boolean {
  return recording.endedAt == null;
}

/**
 * The user may delete any finished recording.
 *
 * Round 2 hid delete for anything marked proof. Round 3 files EVERY stopped
 * recording as proof, so that rule would have left a drawer full of rows with
 * no way to get rid of any of them. The protection it was written for — an
 * agent quietly deleting its own evidence — still holds in the service, which
 * refuses unless the caller passes `allowProof`, and only this UI does.
 */
export function canDeleteRecording(recording: SimRecording): boolean {
  return !isRecordingActive(recording);
}

export function summarizeRecordings(recordings: readonly SimRecording[]): AppleRecordingSummary {
  let totalBytes = 0;
  let pinnedCount = 0;
  for (const recording of recordings) {
    if (typeof recording.bytes === "number" && recording.bytes > 0) totalBytes += recording.bytes;
    if (recording.proof) pinnedCount += 1;
  }
  return { count: recordings.length, totalBytes, pinnedCount };
}

/** "agent · auto", "manual", "manual · proof" — the caption beside the red dot. */
export function describeRecording(recording: SimRecording): string {
  const parts: string[] = [];
  if (recording.chatSessionId) parts.push("agent");
  parts.push(recording.mode);
  if (recording.proof) parts.push("proof");
  return parts.join(" · ");
}

/** Newest first, with any in-flight recording ahead of every finished one. */
export function sortRecordings(recordings: readonly SimRecording[]): SimRecording[] {
  return [...recordings].sort((left, right) => {
    const leftActive = isRecordingActive(left) ? 1 : 0;
    const rightActive = isRecordingActive(right) ? 1 : 0;
    if (leftActive !== rightActive) return rightActive - leftActive;
    return Date.parse(right.startedAt) - Date.parse(left.startedAt);
  });
}

export type UseAppleRecordingsArgs = {
  laneId: string | null;
  chatSessionId: string | null;
  /** False keeps the list unread. The drawer's Recording section is opt-in. */
  enabled: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onError: (message: string | null) => void;
};

export type AppleRecordings = {
  recordings: SimRecording[];
  /** The one in flight, if any. Auto and manual are the same object here. */
  active: SimRecording | null;
  summary: AppleRecordingSummary;
  busy: boolean;
  refresh: () => void;
  start: (options?: { label?: string | null }) => void;
  stop: (options?: { discard?: boolean }) => void;
  remove: (id: string) => void;
  /**
   * The recording that just stopped, for the receipt under the viewport.
   *
   * Round 2 wrote three MP4s during one live test and put nothing on screen
   * about any of them; this is the half of A3 that makes a recording visible
   * the moment it exists, and it clears itself after six seconds.
   */
  lastSaved: SimRecording | null;
  dismissLastSaved: () => void;
  /** Opens a finished recording — the receipt's Open. */
  openProof: (recording: SimRecording) => void;
  /** The drawer's "Open in proof", which knows the artifact and not the file. */
  openProofArtifact: (artifactId: string) => void;
  /** Reveals the file in Finder. The drawer's ⋯ menu. */
  reveal: (recording: SimRecording) => void;
};

export function useAppleRecordings({
  laneId,
  chatSessionId,
  enabled,
  runtimePinRef,
  onError,
}: UseAppleRecordingsArgs): AppleRecordings {
  const [recordings, setRecordings] = useState<SimRecording[]>([]);
  const [lastSaved, setLastSaved] = useState<SimRecording | null>(null);
  // Read by `openProofArtifact`, which is handed an id and has to find the
  // file behind it without the list becoming one of its dependencies.
  const recordingsRef = useRef<SimRecording[]>([]);
  const [busy, setBusy] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), []);

  useEffect(() => {
    if (!enabled || !laneId) {
      setRecordings([]);
      return;
    }
    let cancelled = false;
    void window.ade.iosSimulator
      .recordList({ laneId, chatSessionId }, runtimePinRef.current)
      .then((next) => {
        if (!cancelled) setRecordings(sortRecordings(next));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        onErrorRef.current(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [chatSessionId, enabled, laneId, refreshNonce, runtimePinRef]);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      onErrorRef.current(null);
    } catch (error: unknown) {
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
      setRefreshNonce((nonce) => nonce + 1);
    }
  }, []);

  const start = useCallback((options: { label?: string | null } = {}) => {
    void run(() => window.ade.iosSimulator.recordStart(
      { laneId, chatSessionId, label: options.label ?? null },
      runtimePinRef.current,
    ));
  }, [chatSessionId, laneId, run, runtimePinRef]);

  const stop = useCallback((options: { discard?: boolean } = {}) => {
    void run(async () => {
      const saved = await window.ade.iosSimulator.recordStop(
        // `keep` and `discard` are the service's own two words, and a stop that
        // names neither is ambiguous rather than defaulted.
        { laneId, chatSessionId, keep: !options.discard, discard: Boolean(options.discard) },
        runtimePinRef.current,
      );
      setLastSaved(saved ?? null);
      return saved;
    });
  }, [chatSessionId, laneId, run, runtimePinRef]);

  const dismissLastSaved = useCallback(() => setLastSaved(null), []);

  // The receipt is a receipt, not a notification centre: it says the file
  // exists, names it, and goes away. The drawer keeps the list.
  useEffect(() => {
    if (!lastSaved) return undefined;
    const timer = window.setTimeout(() => setLastSaved(null), APPLE_RECORDING_RECEIPT_MS);
    return () => window.clearTimeout(timer);
  }, [lastSaved]);

  const remove = useCallback((id: string) => {
    setLastSaved((current) => (current?.id === id ? null : current));
    void run(() => window.ade.iosSimulator.recordDelete(
      // The person pressed Delete. See `canDeleteRecording`.
      { laneId, chatSessionId, id, allowProof: true },
      runtimePinRef.current,
    ));
  }, [chatSessionId, laneId, run, runtimePinRef]);

  /**
   * Show the proof row for an artifact, if the proof panel is on screen.
   *
   * Returns false when it is not, which is the caller's cue to fall back to
   * the file. There is no "select this artifact" API to call — the panel
   * renders one row per artifact and labels it — so this scrolls to the row
   * rather than inventing a store two features would then have to keep in
   * sync.
   */
  const revealProofRow = useCallback((artifactId: string): boolean => {
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
  }, []);

  const openFile = useCallback((recordingPath: string) => {
    void window.ade.app.openPath(recordingPath).catch((error: unknown) => {
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    });
  }, []);

  const openProof = useCallback((recording: SimRecording) => {
    const artifactId = recording.proofArtifactId;
    if (artifactId && revealProofRow(artifactId)) return;
    openFile(recording.path);
  }, [openFile, revealProofRow]);

  const openProofArtifact = useCallback((artifactId: string) => {
    if (revealProofRow(artifactId)) return;
    const match = recordingsRef.current.find((entry) => entry.proofArtifactId === artifactId);
    if (match) openFile(match.path);
  }, [openFile, revealProofRow]);

  const reveal = useCallback((recording: SimRecording) => {
    void window.ade.app.revealPath(recording.path).catch((error: unknown) => {
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    });
  }, []);

  recordingsRef.current = recordings;

  const active = useMemo(
    () => recordings.find((recording) => isRecordingActive(recording)) ?? null,
    [recordings],
  );
  const summary = useMemo(() => summarizeRecordings(recordings), [recordings]);

  return {
    recordings,
    active,
    summary,
    busy,
    refresh,
    start,
    stop,
    remove,
    lastSaved,
    dismissLastSaved,
    openProof,
    openProofArtifact,
    reveal,
  };
}
