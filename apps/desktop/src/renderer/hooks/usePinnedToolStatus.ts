/**
 * ADE's pinned copy of one provider's tool on one machine, for a Settings row
 * or a chat card.
 *
 * ADE never runs a CLI the user installed: each provider runs a pinned,
 * checksum-verified build ADE downloads into the tools cache of the machine
 * that runs it. So "is it installed" is really "has that machine downloaded
 * it", and the answer lives on that machine — the caller passes the pin of the
 * machine that owns the chat, lane or Settings page (`useChatRuntimeScope().pin`,
 * `useSettingsMachineScope().pin`; null = the tab's own machine).
 *
 * One read when the surface mounts (per machine), a 1 s poll only while a
 * download runs, nothing otherwise. A host that predates the action leaves
 * `status` null, and the surface keeps its connection-status sentence.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OpenProjectBinding } from "../../shared/types";
import type { PinnedProviderToolStatus } from "../../shared/types/config";
import { usePolling } from "./usePolling";

/** How often a running download's progress is re-read. */
const DOWNLOAD_POLL_MS = 1_000;

export type PinnedToolStatusHandle = {
  status: PinnedProviderToolStatus | null;
  /** The Download/Retry call itself failed (not the download). */
  error: string | null;
  /** A Download/Retry call is in flight. */
  starting: boolean;
  download: () => Promise<void>;
};

export function usePinnedToolStatus(
  provider: string | null,
  pin: OpenProjectBinding | null,
  options: {
    /** Runs once when a download this surface watched lands. */
    onReady?: () => void;
    /** Off: no read, no poll (e.g. while the parent is still checking). */
    enabled?: boolean;
  } = {},
): PinnedToolStatusHandle {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const onReadyRef = useRef(options.onReady);
  onReadyRef.current = options.onReady;
  const enabled = options.enabled !== false && Boolean(provider);
  const [status, setStatus] = useState<PinnedProviderToolStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const watchedDownloadRef = useRef(false);

  const apply = useCallback((next: PinnedProviderToolStatus | null | undefined) => {
    if (!next) return;
    setStatus(next);
    if (next.downloading || next.state === "downloading") {
      watchedDownloadRef.current = true;
      return;
    }
    if (watchedDownloadRef.current) {
      watchedDownloadRef.current = false;
      if (next.state === "ready") onReadyRef.current?.();
    }
  }, []);

  // One read per provider and machine.
  useEffect(() => {
    setStatus(null);
    setError(null);
    watchedDownloadRef.current = false;
    const read = window.ade?.ai?.pinnedToolStatus;
    if (!enabled || !provider || !read) return undefined;
    let cancelled = false;
    void read({ provider }, pinRef.current)
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apply, enabled, pinKey, provider]);

  const downloading = status?.downloading === true || status?.state === "downloading";
  usePolling(async () => {
    const read = window.ade?.ai?.pinnedToolStatus;
    if (!read || !provider) return;
    apply(await read({ provider }, pinRef.current).catch(() => null));
  }, DOWNLOAD_POLL_MS, enabled && downloading);

  const download = useCallback(async () => {
    if (!provider) return;
    const start = window.ade?.ai?.pinnedToolDownload;
    if (!start) {
      setError("This ADE build cannot download agents on that machine. Update ADE there and try again.");
      return;
    }
    setStarting(true);
    setError(null);
    try {
      const next = await start({ provider }, pinRef.current);
      // A start that finds the copy already there is a landing too.
      if (next && next.state === "ready" && !next.downloading) watchedDownloadRef.current = true;
      apply(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }, [apply, provider]);

  return { status, error, starting, download };
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function megabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

export type PinnedToolLine = {
  tone: "ready" | "busy" | "error" | "muted";
  text: string;
  /** The button the line offers, if any. */
  action: "download" | "retry" | null;
};

/**
 * The one line a surface shows for a provider's pinned tool: Ready (pinned
 * vX), Downloading <Tool> for <machine>… (with progress when the download
 * reports it), Couldn't download <Tool>: <reason> (Retry), or <Tool> is not
 * available on this machine. `runtimeReady` is the connection status's own
 * verdict: a source checkout or a developer override runs a copy the tools
 * cache does not know about, and that still counts as ready.
 */
export function pinnedToolLine(
  status: PinnedProviderToolStatus,
  options: { runtimeReady?: boolean; machineName?: string | null } = {},
): PinnedToolLine {
  const where = options.machineName?.trim() ? options.machineName.trim() : "this machine";
  const label = status.label;
  if (status.state === "ready" || options.runtimeReady) {
    // ADE moved past its pin because the vendor refused it; say so loudly.
    if (status.notice) return { tone: "error", text: status.notice, action: null };
    const running = status.runningVersion ?? status.version;
    const ready = running ? `Ready (pinned v${running})` : "Ready";
    const upgrading = status.downloading && status.version && status.version !== running
      ? `. Downloading v${status.version}…`
      : "";
    return { tone: "ready", text: `${ready}${upgrading}`, action: null };
  }
  switch (status.state) {
    case "downloading": {
      const progress = status.totalBytes && status.receivedBytes != null
        ? ` ${megabytes(status.receivedBytes)} of ${megabytes(status.totalBytes)} (${Math.min(100, Math.floor((status.receivedBytes / status.totalBytes) * 100))}%)`
        : "";
      return { tone: "busy", text: `Downloading ${label} for ${where}…${progress}`, action: null };
    }
    case "failed":
      return {
        tone: "error",
        text: `Couldn't download ${label}: ${status.failureReason ?? status.errorKind ?? "unknown error"}.`,
        action: "retry",
      };
    case "unavailable":
      return {
        tone: "muted",
        text: status.message ?? `${capitalized(label)} is not available on ${where}.`,
        action: null,
      };
    case "missing":
      return status.fetchAllowed
        ? { tone: "muted", text: `ADE downloads ${label} for ${where} the first time it is used.`, action: "download" }
        : { tone: "muted", text: status.message ?? `ADE has not downloaded ${label} for ${where}.`, action: null };
  }
}
