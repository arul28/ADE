import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppControlEventPayload,
  AppControlRecordingStatus,
  OpenProjectBinding,
} from "../../../shared/types";
import type { MacDesktopPermissionKind, MacDesktopPermissions } from "../../../shared/types/macDesktop";
import { RECORDING_RECEIPT_MS, revealProofArtifactRow } from "../shared/recordingFormat";

/**
 * The App Control pane's recording: status, the Record/Stop toggle, the
 * receipt after a stop, and the Screen Recording grant a macOS start needs.
 *
 * The contract is Mac Desktop's (one recording per lane, chat owned, a caption
 * files it as proof), so the pane's chrome is Mac Desktop's too. The status is
 * read once and then followed by `recording-changed` events for this lane; the
 * elapsed clock ticks only while a recording runs.
 */

export type AppControlRecordingReceipt = {
  artifactId: string;
  durationMs: number | null;
  bytes: number | null;
  filePath: string | null;
};

/** The grants a refused start reported as off. Only Screen Recording matters to a recording. */
export function appControlRecordingMissingPermissions(
  permissions: MacDesktopPermissions | null | undefined,
): MacDesktopPermissionKind[] {
  return permissions?.screenRecording === "denied" ? ["screenRecording"] : [];
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // The service prefixes coded errors (`APP_CONTROL_…: message`) for the CLI's
  // hint table. The person reads the sentence.
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, "").replace(/^[A-Z_]{8,}:\s*/u, "");
}

export function useAppControlRecording({
  laneId,
  chatSessionId,
  runtimePin,
  enabled,
}: {
  laneId: string | null;
  chatSessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** A session exists; with none there is nothing to record. */
  enabled: boolean;
}) {
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  /** The lane on screen now: an answer for a lane the pane has left is dropped. */
  const laneIdRef = useRef(laneId);
  laneIdRef.current = laneId;
  const pinKey = runtimePin?.key ?? null;
  const [recording, setRecording] = useState<AppControlRecordingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AppControlRecordingReceipt | null>(null);
  const [proofBusy, setProofBusy] = useState(false);
  /** A refused start's grants, until a Check again finds them on. */
  const [permissions, setPermissions] = useState<MacDesktopPermissions | null>(null);
  const [checkingPermissions, setCheckingPermissions] = useState(false);
  const [permissionCheck, setPermissionCheck] = useState<
    { at: number; stillMissing: MacDesktopPermissionKind[] } | { at: number; error: string } | null
  >(null);

  // A lane change starts fresh.
  useEffect(() => {
    setRecording(null);
    setError(null);
    setNotice(null);
    setReceipt(null);
    setPermissions(null);
    setPermissionCheck(null);
  }, [laneId]);

  useEffect(() => {
    if (!receipt) return undefined;
    const timer = window.setTimeout(() => setReceipt(null), RECORDING_RECEIPT_MS);
    return () => window.clearTimeout(timer);
  }, [receipt]);

  // One read, then events. Never a poll.
  useEffect(() => {
    const api = window.ade?.appControl;
    if (!laneId || !api) return undefined;
    let cancelled = false;
    if (enabled && typeof api.getRecordingStatus === "function") {
      void api.getRecordingStatus({ laneId }, pinRef.current)
        .then((status) => {
          if (cancelled || !status) return;
          setRecording(status);
          // A start refused for a grant earlier (by an agent, say) still says so.
          if (appControlRecordingMissingPermissions(status.permissions).length > 0) setPermissions(status.permissions ?? null);
        })
        .catch(() => {});
    }
    const unsubscribe = api.onEvent?.((event: AppControlEventPayload) => {
      if (event.type !== "recording-changed" || event.laneId !== laneId) return;
      setRecording(event.status);
      if (event.status.permissions) setPermissions(event.status.permissions);
    }, pinRef.current);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [enabled, laneId, pinKey]);

  const running = Boolean(recording?.running);
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const elapsedMs = running
    ? Math.max(0, nowTick - (Date.parse(recording?.startedAt ?? "") || nowTick))
    : 0;

  const start = useCallback(async (caption: string | null) => {
    const api = window.ade?.appControl;
    if (!laneId || !api?.startRecording) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.startRecording({
        laneId,
        chatSessionId,
        caption: caption?.trim() || null,
      }, pinRef.current);
      if (laneIdRef.current !== laneId) return;
      setRecording(next);
      const missing = appControlRecordingMissingPermissions(next.permissions);
      setPermissions(missing.length > 0 ? next.permissions ?? null : null);
      // A missing grant is the permission card's to say, with its fix.
      if (!next.running && next.lastError && missing.length === 0) setError(errorText(next.lastError));
    } catch (cause) {
      if (laneIdRef.current !== laneId) return;
      const withPermissions = cause as { permissions?: MacDesktopPermissions | null };
      const missing = appControlRecordingMissingPermissions(withPermissions?.permissions);
      if (missing.length > 0) setPermissions(withPermissions.permissions ?? null);
      else setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, [chatSessionId, laneId]);

  const stop = useCallback(async () => {
    const api = window.ade?.appControl;
    if (!laneId || !api?.stopRecording) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.stopRecording({ laneId, chatSessionId }, pinRef.current);
      if (laneIdRef.current !== laneId) return;
      setRecording(next);
      if (next.proofArtifactId) {
        setReceipt({
          artifactId: next.proofArtifactId,
          durationMs: next.durationMs ?? 0,
          bytes: next.bytes ?? null,
          filePath: next.filePath,
        });
      } else if (next.caption && next.proofArtifactId === null) {
        setError("The recording was saved, but it could not be filed as proof.");
      } else if (next.lastError) {
        setError(errorText(next.lastError));
      }
    } catch (cause) {
      if (laneIdRef.current !== laneId) return;
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }, [chatSessionId, laneId]);

  /** Proof: one still of the app, filed as proof. Same receipt as a recording, with no running time. */
  const captureProof = useCallback(async (caption: string | null) => {
    const api = window.ade?.appControl;
    if (!laneId || !api?.captureProof) return;
    setProofBusy(true);
    setError(null);
    try {
      const filed = await api.captureProof({
        laneId,
        chatSessionId,
        caption: caption?.trim() || null,
      }, pinRef.current);
      if (laneIdRef.current !== laneId) return;
      setReceipt({ artifactId: filed.artifactId, durationMs: null, bytes: null, filePath: filed.filePath });
    } catch (cause) {
      if (laneIdRef.current !== laneId) return;
      setError(errorText(cause));
    } finally {
      setProofBusy(false);
    }
  }, [chatSessionId, laneId]);

  const hostIsLocal = runtimePin?.kind !== "remote";
  const openReceipt = useCallback((entry: AppControlRecordingReceipt) => {
    if (revealProofArtifactRow(entry.artifactId)) return;
    if (hostIsLocal && entry.filePath && window.ade?.app?.openPath) {
      void window.ade.app.openPath(entry.filePath).catch((cause: unknown) => setError(errorText(cause)));
      return;
    }
    setNotice("It is in this chat's proof drawer.");
  }, [hostIsLocal]);

  /**
   * Re-read the grants without restarting the desktop helper: a restart would
   * close any Mac Desktop display the lane has open. Never starts a recording.
   */
  const checkPermissionsAgain = useCallback(async () => {
    const recheck = window.ade?.macDesktop?.recheckPermissions;
    setCheckingPermissions(true);
    try {
      if (typeof recheck !== "function") throw new Error("Could not check on this machine.");
      const next = await recheck({ restartDriver: false }, pinRef.current);
      const stillMissing = appControlRecordingMissingPermissions(next);
      setPermissionCheck({ at: Date.now(), stillMissing });
      setPermissions(stillMissing.length > 0 ? next : null);
      if (stillMissing.length === 0) setError(null);
    } catch (cause) {
      setPermissionCheck({ at: Date.now(), error: errorText(cause) });
    } finally {
      setCheckingPermissions(false);
    }
  }, []);

  const openSettings = useCallback((kind: MacDesktopPermissionKind) => {
    const open = window.ade?.app?.openSystemSettingsPane;
    const failed = () => setError("Could not open System Settings on this Mac. Open Privacy & Security yourself.");
    if (typeof open !== "function") {
      failed();
      return;
    }
    void open(kind === "screenRecording" ? "macos-screen-recording" : "macos-accessibility")
      .then((result) => {
        if (!result?.opened) failed();
      }, failed);
  }, []);

  return {
    recording,
    running,
    elapsedMs,
    busy,
    error,
    clearError: () => setError(null),
    notice,
    clearNotice: () => setNotice(null),
    receipt,
    clearReceipt: () => setReceipt(null),
    openReceipt,
    start,
    stop,
    captureProof,
    proofBusy,
    permissions,
    missingPermissions: appControlRecordingMissingPermissions(permissions),
    checkingPermissions,
    permissionCheck,
    checkPermissionsAgain,
    openSettings,
    hostIsLocal,
  };
}

export type AppControlRecordingController = ReturnType<typeof useAppControlRecording>;
