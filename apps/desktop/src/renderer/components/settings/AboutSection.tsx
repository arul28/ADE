import { useCallback, useEffect, useState } from "react";
import { ArrowCircleUp, ArrowsClockwise, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { AppInfo, AutoUpdateSnapshot, LatestReleaseInfo } from "../../../shared/types";
import { COLORS, MONO_FONT, SANS_FONT, cardStyle, inlineBadge, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  width: 84,
  flexShrink: 0,
};

const valueStyle: React.CSSProperties = {
  fontSize: 12,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
};

type RuntimeServiceInstallState = NonNullable<AppInfo["localRuntime"]>["serviceInstall"]["state"];
type RuntimeServiceHealthState = NonNullable<AppInfo["localRuntime"]>["serviceHealth"]["state"];
type RuntimeVersionSkew = NonNullable<AppInfo["localRuntime"]>["versionSkew"];

function runtimeServiceLabel(state: RuntimeServiceInstallState): string {
  switch (state) {
    case "installed": return "Installed";
    case "installing": return "Installing";
    case "failed": return "Needs attention";
    case "skipped": return "Skipped";
    default: return "Not checked";
  }
}

function runtimeServiceColor(state: RuntimeServiceInstallState): string {
  switch (state) {
    case "installed": return COLORS.success;
    case "installing": return COLORS.accent;
    case "failed": return COLORS.danger;
    case "skipped": return COLORS.warning;
    default: return COLORS.textMuted;
  }
}

function runtimeServiceHealthLabel(state: RuntimeServiceHealthState): string {
  switch (state) {
    case "running": return "Running";
    case "installed": return "Installed";
    case "not_installed": return "Not installed";
    case "error": return "Status error";
    case "unsupported": return "Unsupported";
    default: return "Unknown";
  }
}

function runtimeServiceHealthColor(state: RuntimeServiceHealthState): string {
  switch (state) {
    case "running": return COLORS.success;
    case "installed": return COLORS.warning;
    case "not_installed": return COLORS.textMuted;
    case "error": return COLORS.danger;
    case "unsupported": return COLORS.warning;
    default: return COLORS.textMuted;
  }
}

function runtimeVersionSkewLabel(state: RuntimeVersionSkew["state"]): string {
  switch (state) {
    case "runtime_newer": return "Desktop update required";
    case "runtime_older": return "Runtime update required";
    case "build_mismatch": return "Build mismatch";
    case "role_mismatch": return "Role mismatch";
    case "unknown": return "Version mismatch";
    default: return "In sync";
  }
}

function runtimeVersionSkewMessage(skew: RuntimeVersionSkew): string {
  if (skew.message?.trim()) return skew.message;
  if (skew.state === "runtime_newer") {
    return "The ADE brain on this machine is newer than the desktop app. Update ADE desktop before using this machine brain.";
  }
  if (skew.state === "runtime_older") {
    return "The ADE brain on this machine is older than the desktop app. Update the ADE brain service and reconnect.";
  }
  return "The ADE desktop app and ADE brain service are out of sync.";
}

function formatRuntimeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function formatReleasedAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return null;
  const diffMs = Date.now() - ts;
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const days = Math.floor(diffMs / dayMs);
  if (days <= 0) {
    const hours = Math.floor(diffMs / hourMs);
    if (hours <= 0) return "released just now";
    return `released ${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  if (days < 30) return `released ${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `released ${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `released ${years} year${years === 1 ? "" : "s"} ago`;
}

export function AboutSection({ embedded = false }: { embedded?: boolean } = {}) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [latest, setLatest] = useState<LatestReleaseInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const updateSnapshot = useAutoUpdateSnapshot();

  const refreshLatest = useCallback(async () => {
    try {
      setLatest(await window.ade.app.getLatestRelease());
    } catch {
      setLatest(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.ade.app
      .getInfo()
      .then((value) => {
        if (!cancelled) setInfo(value);
      })
      .catch(() => {});
    void refreshLatest();
    return () => {
      cancelled = true;
    };
  }, [refreshLatest]);

  useEffect(() => {
    const unsubscribe = window.ade.onUpdateEvent((snapshot: AutoUpdateSnapshot) => {
      setChecking(snapshot.status === "checking");
      if (snapshot.status !== "checking") void refreshLatest();
    });
    return unsubscribe;
  }, [refreshLatest]);

  const checkForUpdates = useCallback(() => {
    setChecking(true);
    void window.ade.updateCheckForUpdates()
      .then(() => refreshLatest())
      .catch(() => {})
      .finally(() => setChecking(false));
  }, [refreshLatest]);

  const openReleaseNotes = useCallback(() => {
    if (latest?.htmlUrl) void window.ade.app.openExternal(latest.htmlUrl);
  }, [latest]);

  if (!info) {
    return (
      <div style={embedded ? undefined : cardStyle()}>
        <div style={{ fontSize: embedded ? 13 : 15, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
          {embedded ? "App" : "ADE"}
        </div>
        <div style={{ marginTop: 10, fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
          Loading app info...
        </div>
      </div>
    );
  }

  const isDev = !info.isPackaged;
  const updateAvailable = Boolean(latest?.updateAvailable) && !isDev;
  const releasedAgo = formatReleasedAgo(latest?.publishedAt ?? null);
  const runtimeSkew = !info.localRuntime?.versionSkew || info.localRuntime.versionSkew.state === "none"
    ? null
    : info.localRuntime.versionSkew;

  // Truthful version split: "Running" is the version of the process the user is
  // actually using (getInfo); "Installed" is what is staged on disk and will run
  // after a restart; "Latest" is what the update feed advertises. When a
  // consented install parked or a download is ready, the running process lags
  // what is staged — that is the state the incident hid behind an "up to date".
  const hasStagedUpdate = updateSnapshot.status === "ready" || Boolean(updateSnapshot.parked);
  const runningVersion = info.appVersion;
  const installedVersion = hasStagedUpdate && updateSnapshot.version
    ? updateSnapshot.version
    : info.appVersion;
  const latestVersion = updateSnapshot.latestKnownVersion ?? latest?.version ?? info.appVersion;
  const restartPending = hasStagedUpdate && installedVersion !== runningVersion;

  let pill: React.ReactNode = null;
  if (isDev) {
    pill = <span style={inlineBadge(COLORS.textMuted)}>DEV BUILD</span>;
  } else if (restartPending) {
    pill = (
      <span style={{ ...inlineBadge(COLORS.warning), gap: 5 }}>
        <WarningCircle size={13} weight="fill" />
        Restart to update
      </span>
    );
  } else if (latest && updateAvailable) {
    pill = (
      <span style={{ ...inlineBadge(COLORS.warning), gap: 5 }}>
        <ArrowCircleUp size={13} weight="fill" />
        Update available
      </span>
    );
  } else if (latest) {
    pill = (
      <span style={{ ...inlineBadge(COLORS.success), gap: 5 }}>
        <CheckCircle size={13} weight="fill" />
        Up to date
      </span>
    );
  }

  const content = (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ fontSize: embedded ? 13 : 15, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
          {embedded ? "App" : "ADE"}
        </div>
        {pill}
      </div>

      <div style={{ display: "grid", gap: 10, marginTop: embedded ? 14 : 18 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={labelStyle}>Running</span>
          <span style={valueStyle}>{runningVersion}</span>
          {restartPending ? (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.warning }}>
              <WarningCircle size={12} weight="fill" />
              restart pending
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={labelStyle}>Installed</span>
          <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={valueStyle}>{installedVersion}</span>
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
              · Latest <span style={{ ...valueStyle, fontSize: 11 }}>{latestVersion}</span>
              {releasedAgo && latestVersion === (latest?.version ?? latestVersion) ? ` · ${releasedAgo}` : ""}
            </span>
          </span>
        </div>
      </div>

      {(updateAvailable || !isDev) ? (
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: embedded ? 14 : 18, flexWrap: "wrap" }}>
          {updateAvailable && latest?.htmlUrl ? (
            <button type="button" style={outlineButton()} onClick={openReleaseNotes}>
              View release notes
            </button>
          ) : null}
          {!isDev ? (
            <button type="button" style={primaryButton()} disabled={checking} onClick={checkForUpdates}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <ArrowsClockwise size={13} weight="bold" />
                {checking ? "Checking..." : "Check for updates"}
              </span>
            </button>
          ) : null}
        </div>
      ) : null}

      {info.localRuntime ? (
        <div style={{ marginTop: embedded ? 14 : 18, paddingTop: embedded ? 14 : 18, borderTop: `1px solid ${COLORS.border}`, display: "grid", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>
                {embedded ? "Background service" : "ADE runtime service"}
              </div>
              <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span style={labelStyle}>Running</span>
                <span style={valueStyle}>
                  {info.localRuntime.versionSkew.runtimeVersion ?? info.appVersion}
                </span>
                {info.localRuntime.pid != null || info.localRuntime.syncPort != null ? (
                  <span style={{ ...valueStyle, color: COLORS.textMuted }}>
                    {[
                      info.localRuntime.pid != null ? `· pid ${info.localRuntime.pid}` : null,
                      info.localRuntime.syncPort != null ? `· port ${info.localRuntime.syncPort}` : null,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  </span>
                ) : null}
                <span
                  aria-hidden
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: runtimeServiceHealthColor(info.localRuntime.serviceHealth.state),
                  }}
                />
              </div>
              <div style={{ marginTop: 5, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
                {info.localRuntime.connectionState === "connected"
                  ? "Connected and ready."
                  : `Status: ${info.localRuntime.connectionState}.`}
                {info.localRuntime.runtimeMode === "isolated" ? " Running in fallback mode." : ""}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              <span style={inlineBadge(runtimeServiceColor(info.localRuntime.serviceInstall.state))}>
                {runtimeServiceLabel(info.localRuntime.serviceInstall.state)}
              </span>
              <span style={inlineBadge(runtimeServiceHealthColor(info.localRuntime.serviceHealth.state))}>
                {runtimeServiceHealthLabel(info.localRuntime.serviceHealth.state)}
              </span>
              {runtimeSkew ? (
                <span style={inlineBadge(COLORS.warning)}>
                  {runtimeVersionSkewLabel(runtimeSkew.state)}
                </span>
              ) : null}
            </div>
          </div>
          {restartPending ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "9px 10px",
                borderRadius: 8,
                border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
                background: "color-mix(in srgb, var(--color-warning) 10%, transparent)",
                color: COLORS.warning,
                fontFamily: SANS_FONT,
                fontSize: 11,
                lineHeight: 1.45,
              }}
            >
              <WarningCircle size={15} weight="fill" style={{ flexShrink: 0 }} />
              <span>Will update when the app restarts</span>
            </div>
          ) : null}
          {runtimeSkew && !restartPending ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                padding: "9px 10px",
                borderRadius: 8,
                border: "1px solid color-mix(in srgb, var(--color-warning) 30%, transparent)",
                background: "color-mix(in srgb, var(--color-warning) 10%, transparent)",
                color: COLORS.warning,
                fontFamily: SANS_FONT,
                fontSize: 11,
                lineHeight: 1.45,
              }}
            >
              <WarningCircle size={15} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
                <span>{runtimeVersionSkewMessage(runtimeSkew)}</span>
                {(runtimeSkew.appVersion || runtimeSkew.runtimeVersion) ? (
                  <span style={{ fontFamily: MONO_FONT, color: COLORS.textMuted, overflowWrap: "anywhere" }}>
                    Desktop {runtimeSkew.appVersion ?? "unknown"} · Brain {runtimeSkew.runtimeVersion ?? "unknown"}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
          {!embedded && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim }}>
              {info.localRuntime.serviceHealth.path ?? info.localRuntime.serviceInstall.path ? (
                <span>Path: {info.localRuntime.serviceHealth.path ?? info.localRuntime.serviceInstall.path}</span>
              ) : null}
              {info.localRuntime.serviceInstall.exitCode != null ? (
                <span>Exit code: {info.localRuntime.serviceInstall.exitCode}</span>
              ) : null}
              {info.localRuntime.serviceHealth.checkedAt ? (
                <span>Service checked: {formatRuntimeTimestamp(info.localRuntime.serviceHealth.checkedAt)}</span>
              ) : null}
              {formatRuntimeTimestamp(info.localRuntime.serviceInstall.updatedAt) ? (
                <span>Updated: {formatRuntimeTimestamp(info.localRuntime.serviceInstall.updatedAt)}</span>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </>
  );

  if (embedded) return content;

  return (
    <div
      style={cardStyle(
        updateAvailable
          ? { borderColor: "color-mix(in srgb, var(--color-warning) 40%, transparent)" }
          : undefined,
      )}
    >
      {content}
    </div>
  );
}
