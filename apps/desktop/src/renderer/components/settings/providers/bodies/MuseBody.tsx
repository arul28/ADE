/**
 * Muse Code's left-rail actions: download ADE's pinned `muse`, then sign in.
 *
 * ADE never runs a user's own `muse`. It fetches one pinned build into the
 * machine's agent-tools cache, so "Install" here is a download button, not a
 * command to copy. Both the download and the sign-in go to the machine the
 * Settings page is showing (`useSettingsMachineScope().pin`): that machine's
 * cache and that machine's `~/.config/muse`.
 *
 * Sign-in runs the pinned `muse login` in an ADE terminal (the shared
 * `ProviderSignInModal`). An API key is the other path; it is saved through
 * the key panel below and handed to Muse as `META_API_KEY`, never on argv.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { DownloadSimple, SignIn } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import type { MuseBinaryStatus } from "../../../../../shared/museBinary";
import type { ProvidersViewContext } from "../types";

/** How often the download's progress is re-read while it runs. */
const DOWNLOAD_POLL_MS = 1_000;

function formatMegabytes(bytes: number | null): string | null {
  if (bytes == null) return null;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function downloadLine(status: MuseBinaryStatus): string {
  const received = formatMegabytes(status.receivedBytes);
  const total = formatMegabytes(status.totalBytes);
  if (received && total && status.totalBytes) {
    const percent = Math.min(100, Math.floor(((status.receivedBytes ?? 0) / status.totalBytes) * 100));
    return `Downloading Muse ${status.pinnedVersion ?? ""} — ${received} of ${total} (${percent}%)`;
  }
  return `Downloading Muse ${status.pinnedVersion ?? ""}…`;
}

function MuseDownload({ ctx }: { ctx: ProvidersViewContext }) {
  const { pin } = useSettingsMachineScope();
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [status, setStatus] = useState<MuseBinaryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshStatus = ctx.actions.refreshStatus;

  // Read where the download stands on this machine; one read per machine.
  useEffect(() => {
    let cancelled = false;
    const read = window.ade?.ai?.museBinaryStatus;
    if (!read) return undefined;
    void read(pinRef.current)
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pinKey]);

  // While a download runs, poll its progress; when it lands, refresh the page.
  const downloading = status?.state === "downloading";
  useEffect(() => {
    if (!downloading) return undefined;
    const read = window.ade?.ai?.museBinaryStatus;
    if (!read) return undefined;
    let stopped = false;
    const timer = window.setInterval(() => {
      void read(pinRef.current)
        .then((next) => {
          if (stopped) return;
          setStatus(next);
          if (next.state === "installed") void refreshStatus({ force: true, silent: true });
        })
        .catch(() => undefined);
    }, DOWNLOAD_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [downloading, pinKey, refreshStatus]);

  const start = useCallback(async () => {
    const ensure = window.ade?.ai?.ensureMuseBinary;
    if (!ensure) {
      setError("This ADE build cannot download Muse on that machine. Update ADE there and try again.");
      return;
    }
    setError(null);
    try {
      const next = await ensure(pinRef.current);
      setStatus(next);
      if (next.state === "installed") void refreshStatus({ force: true, silent: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [refreshStatus]);

  if (status?.state === "unsupported") {
    return (
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        ADE has no Muse build for this platform.
      </div>
    );
  }

  const failure = error ?? (status?.state === "failed" ? status.error : null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        {downloading && status
          ? downloadLine(status)
          : `ADE runs its own pinned Muse${status?.pinnedVersion ? ` ${status.pinnedVersion}` : ""} (about 350–470 MB). It does not use a copy you installed yourself.`}
      </div>
      {downloading ? null : (
        <button
          type="button"
          onClick={() => void start()}
          style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
        >
          <DownloadSimple size={13} /> {status?.state === "failed" ? "Retry download" : "Download Muse"}
        </button>
      )}
      {failure ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger }}>{failure}</div>
      ) : null}
    </div>
  );
}

export function MuseAuthActions({ ctx }: { ctx: ProvidersViewContext }) {
  const connection = ctx.status?.providerConnections?.muse ?? null;
  if (ctx.isInitialCheckInFlight) return null;
  if (!connection?.runtimeDetected) return <MuseDownload ctx={ctx} />;
  if (connection.authAvailable) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <button
        type="button"
        onClick={() => ctx.actions.openSignInTerminal("muse")}
        style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
      >
        <SignIn size={13} /> Sign in to Muse
      </button>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
        Opens <code>muse login</code> in a terminal for your Meta account. Or add a Meta API key below.
      </div>
    </div>
  );
}
