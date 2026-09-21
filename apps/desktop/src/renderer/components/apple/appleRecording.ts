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
  /** Proof-pinned recordings. These have no delete action anywhere. */
  pinnedCount: number;
};

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

/** Proof-marked recordings are undeletable — by an agent and by this UI. */
export function canDeleteRecording(recording: SimRecording): boolean {
  return !recording.proof;
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

/** "agent · auto", "manual", "manual · pinned" — the caption beside the red dot. */
export function describeRecording(recording: SimRecording): string {
  const parts: string[] = [];
  if (recording.chatSessionId) parts.push("agent");
  parts.push(recording.mode);
  if (recording.proof) parts.push("pinned");
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
  /** `proof-bundle`'s UI half: pin the active or latest recording. */
  pinProof: (caption?: string | null) => void;
};

export function useAppleRecordings({
  laneId,
  chatSessionId,
  enabled,
  runtimePinRef,
  onError,
}: UseAppleRecordingsArgs): AppleRecordings {
  const [recordings, setRecordings] = useState<SimRecording[]>([]);
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
    void run(() => window.ade.iosSimulator.recordStop(
      // `keep` and `discard` are the service's own two words, and a stop that
      // names neither is ambiguous rather than defaulted.
      { laneId, chatSessionId, keep: !options.discard, discard: Boolean(options.discard) },
      runtimePinRef.current,
    ));
  }, [chatSessionId, laneId, run, runtimePinRef]);

  const remove = useCallback((id: string) => {
    void run(() => window.ade.iosSimulator.recordDelete(
      { laneId, chatSessionId, id },
      runtimePinRef.current,
    ));
  }, [chatSessionId, laneId, run, runtimePinRef]);

  const pinProof = useCallback((caption?: string | null) => {
    void run(() => window.ade.iosSimulator.captureProofBundle(
      { laneId, chatSessionId, caption: caption ?? null },
      runtimePinRef.current,
    ));
  }, [chatSessionId, laneId, run, runtimePinRef]);

  const active = useMemo(
    () => recordings.find((recording) => isRecordingActive(recording)) ?? null,
    [recordings],
  );
  const summary = useMemo(() => summarizeRecordings(recordings), [recordings]);

  return { recordings, active, summary, busy, refresh, start, stop, remove, pinProof };
}
