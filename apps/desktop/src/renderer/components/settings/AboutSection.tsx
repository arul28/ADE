import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise, WarningCircle } from "@phosphor-icons/react";
import type { AppInfo, AutoUpdateSnapshot, LatestReleaseInfo } from "../../../shared/types";
import { useAutoUpdateSnapshot } from "../app/useAutoUpdateSnapshot";
import { isWindowsPlatform, requestWindowsBetaNotice } from "../../lib/windowsBetaNotice";
import { canRestartAde, restartAde } from "../app/restartAde";
import { requestDownloadedUpdateInstall } from "../app/autoUpdateInstallAction";
import { AutoUpdatesControls } from "./AutoUpdatesSection";
import { ModernRow, ModernRows, ModernSection } from "./primitives";

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

/** The status dot beside the runtime version: colour only for status. */
function runtimeServiceHealthTone(state: RuntimeServiceHealthState): "ok" | "warn" | "crit" | undefined {
  switch (state) {
    case "running": return "ok";
    case "installed": return "warn";
    case "error": return "crit";
    case "unsupported": return "warn";
    default: return undefined;
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

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
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

export function resolveAboutVersionState(
  appVersion: string,
  snapshot: Pick<AutoUpdateSnapshot, "status" | "version" | "parked">,
): {
  runningVersion: string;
  installedVersion: string;
  downloadedVersion: string | null;
  restartPending: boolean;
} {
  const hasDownloadedUpdate = snapshot.status === "ready" || Boolean(snapshot.parked);
  const downloadedVersion = hasDownloadedUpdate && snapshot.version
    ? snapshot.version
    : null;
  return {
    runningVersion: appVersion,
    // electron-updater's ready state is only a cached download. Until the
    // native installer succeeds, the app bundle on disk remains appVersion.
    installedVersion: appVersion,
    downloadedVersion,
    restartPending: downloadedVersion != null && downloadedVersion !== appVersion,
  };
}

export function AboutSection() {
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
      <div className="ade-modern-sections">
        <ModernSection group="About" title="About ADE" hint="Versions on this computer.">
          <div className="ade-modern-stats">
            <div className="ade-modern-stat" id="about-app" data-settings-anchor="about-app">
              <span className="kit-eyebrow">ADE</span>
              <span className="ade-modern-stat-sub">Loading app info…</span>
            </div>
          </div>
        </ModernSection>
      </div>
    );
  }

  const isDev = !info.isPackaged;
  const updateAvailable = Boolean(latest?.updateAvailable) && !isDev;
  const releasedAgo = formatReleasedAgo(latest?.publishedAt ?? null);
  const runtimeSkew = !info.localRuntime?.versionSkew || info.localRuntime.versionSkew.state === "none"
    ? null
    : info.localRuntime.versionSkew;

  const {
    runningVersion,
    installedVersion,
    downloadedVersion,
    restartPending,
  } = resolveAboutVersionState(info.appVersion, updateSnapshot);
  const latestVersion = updateSnapshot.latestKnownVersion ?? latest?.version ?? info.appVersion;
  const latestReleasedAgo = releasedAgo && latest != null && latestVersion === latest.version ? releasedAgo : null;
  // A failed check while an update is downloaded keeps the snapshot `ready`,
  // so without this the stale Latest would read as current. An `error`
  // snapshot has its own surface in the top bar.
  const checkFailure = !isDev && updateSnapshot.status !== "error" ? updateSnapshot.checkFailure ?? null : null;
  const checkStuck = checkFailure?.kind === "network_stuck";
  // With an update downloaded, one note covers both facts: installing it is
  // a restart, and a restart also clears a stuck connection.
  const checkFailedWithDownload = checkFailure != null && restartPending && updateSnapshot.status === "ready";
  const lastCheckedAt = updateSnapshot.lastCheckedAt ?? null;
  let latestSub: React.ReactNode;
  if (checkFailure) {
    latestSub = <span style={{ color: "var(--kit-warn)" }}>Check failed at {formatClockTime(checkFailure.at)}</span>;
  } else if (latestReleasedAgo) {
    latestSub = latestReleasedAgo.replace(/^released/, "Released");
  } else if (lastCheckedAt != null && !isDev) {
    latestSub = `Checked at ${formatClockTime(lastCheckedAt)}`;
  } else {
    latestSub = "Newest release ADE knows about";
  }

  let pill: React.ReactNode = null;
  if (isDev) {
    pill = <span className="kit-tag">DEV BUILD</span>;
  } else if (restartPending) {
    pill = <span className="kit-tag" data-tone="warn">Restart to update</span>;
  } else if (latest && updateAvailable) {
    pill = <span className="kit-tag" data-tone="warn">Update available</span>;
  } else if (latest) {
    pill = <span className="kit-tag" data-tone="ok">Up to date</span>;
  }

  const runtime = info.localRuntime;
  const runtimePath = runtime ? runtime.serviceHealth.path ?? runtime.serviceInstall.path : null;
  const runtimeMeta = runtime
    ? [
        runtime.pid != null ? `pid ${runtime.pid}` : null,
        runtime.syncPort != null ? `port ${runtime.syncPort}` : null,
      ].filter(Boolean).join(" · ")
    : "";

  return (
    <div className="ade-modern-sections">
      <ModernSection
        group="About"
        title="About ADE"
        hint="Versions on this computer."
        actions={(updateAvailable && latest?.htmlUrl) || !isDev ? (
          <>
            {updateAvailable && latest?.htmlUrl ? (
              <button type="button" className="ade-modern-btn" data-variant="ghost" onClick={openReleaseNotes}>
                View release notes
              </button>
            ) : null}
            {!isDev ? (
              <button type="button" className="ade-modern-btn" disabled={checking} onClick={checkForUpdates}>
                <ArrowsClockwise size={13} weight="bold" className={checking ? "animate-spin" : undefined} />
                {checking ? "Checking..." : "Check for updates"}
              </button>
            ) : null}
          </>
        ) : undefined}
      >
        <div className="ade-modern-stats">
          <div className="ade-modern-stat" id="about-app" data-settings-anchor="about-app">
            <span className="kit-eyebrow">ADE</span>
            <span className="ade-modern-stat-value">
              <span className="kit-stat kit-num">{runningVersion}</span>
              {pill}
            </span>
            <span className="ade-modern-stat-sub">
              {restartPending ? (
                <span style={{ color: "var(--kit-warn)" }}>Restart pending · </span>
              ) : null}
              {downloadedVersion ? (
                <>Installed <span className="kit-num">{installedVersion}</span> · Downloaded <span className="kit-num">{downloadedVersion}</span></>
              ) : (
                <>Installed <span className="kit-num">{installedVersion}</span></>
              )}
            </span>
          </div>

          <div className="ade-modern-stat">
            <span className="kit-eyebrow">Latest</span>
            <span className="ade-modern-stat-value">
              <span className="kit-stat kit-num">{latestVersion}</span>
            </span>
            <span className="ade-modern-stat-sub">{latestSub}</span>
          </div>

          {runtime ? (
            <div className="ade-modern-stat" id="about-runtime-service" data-settings-anchor="about-runtime-service">
              <span className="kit-eyebrow">Runtime service</span>
              <span className="ade-modern-stat-value">
                <span className="kit-stat kit-num">{runtime.versionSkew.runtimeVersion ?? info.appVersion}</span>
                <span className="kit-dot" data-state={runtimeServiceHealthTone(runtime.serviceHealth.state)} aria-hidden />
              </span>
              <span className="ade-modern-stat-sub">
                {runtimeServiceHealthLabel(runtime.serviceHealth.state)} · {runtimeServiceLabel(runtime.serviceInstall.state)}
                {runtime.connectionState === "connected" ? " · Connected" : ` · Status: ${runtime.connectionState}.`}
                {runtime.runtimeMode === "isolated" ? " · Fallback mode" : ""}
              </span>
            </div>
          ) : null}
        </div>

        {checkFailure ? (
          <div className="ade-modern-note" data-tone="warn">
            <WarningCircle size={14} weight="fill" />
            <div className="ade-modern-note-body">
              <strong style={{ fontWeight: 600, color: "var(--color-fg)" }}>ADE couldn't check for newer versions</strong>
              <span>
                {checkFailedWithDownload
                  ? checkStuck
                    ? `ADE's connection to the update server is stuck. Restarting to install ${downloadedVersion} clears it.`
                    : `Latest may be out of date. ${downloadedVersion} installs when ADE restarts.`
                  : checkStuck
                    ? "ADE's connection to the update server is stuck. Restarting ADE clears it."
                    : "Latest may be out of date. ADE tries again every 30 minutes."}
              </span>
            </div>
            {checkFailedWithDownload ? (
              <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => void requestDownloadedUpdateInstall(updateSnapshot)}>
                Restart to update
              </button>
            ) : checkStuck && canRestartAde() ? (
              <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => void restartAde()}>
                Restart ADE
              </button>
            ) : (
              <button type="button" className="ade-modern-btn" data-size="sm" disabled={checking} onClick={checkForUpdates}>
                Check again
              </button>
            )}
          </div>
        ) : null}

        {restartPending && !checkFailedWithDownload ? (
          <div className="ade-modern-note" data-tone="warn">
            <WarningCircle size={14} weight="fill" />
            <span>Will update when the app restarts</span>
          </div>
        ) : null}

        {runtimeSkew && !restartPending ? (
          <div className="ade-modern-note" data-tone="warn">
            <WarningCircle size={14} weight="fill" />
            <div className="ade-modern-note-body">
              <span>
                <strong style={{ fontWeight: 600 }}>{runtimeVersionSkewLabel(runtimeSkew.state)}.</strong>{" "}
                {runtimeVersionSkewMessage(runtimeSkew)}
              </span>
              {(runtimeSkew.appVersion || runtimeSkew.runtimeVersion) ? (
                <span className="ade-modern-path">
                  Desktop {runtimeSkew.appVersion ?? "unknown"} · Brain {runtimeSkew.runtimeVersion ?? "unknown"}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ADE is GA on macOS and Linux; only the Windows port is in beta. This is
            the re-open surface for the start-up notice — the header build chip only
            exists on alpha/beta packages, so a Windows Stable install needs it. */}
        {isWindowsPlatform() ? (
          <ModernRows>
            <ModernRow
              title="ADE on Windows is in beta"
              hint="What to expect, known gaps, and how to report a bug."
              control={(
                <button type="button" className="ade-modern-btn" onClick={requestWindowsBetaNotice}>
                  Open notice
                </button>
              )}
            />
          </ModernRows>
        ) : null}

        {runtime && (runtimeMeta || runtimePath || runtime.serviceInstall.exitCode != null || runtime.serviceHealth.checkedAt) ? (
          <div className="ade-modern-path" style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", padding: "0 2px" }}>
            {runtimeMeta ? <span>{runtimeMeta}</span> : null}
            {runtimePath ? <span>{runtimePath}</span> : null}
            {runtime.serviceInstall.exitCode != null ? <span>exit {runtime.serviceInstall.exitCode}</span> : null}
            {runtime.serviceHealth.checkedAt ? (
              <span>checked {formatRuntimeTimestamp(runtime.serviceHealth.checkedAt)}</span>
            ) : null}
            {formatRuntimeTimestamp(runtime.serviceInstall.updatedAt) ? (
              <span>updated {formatRuntimeTimestamp(runtime.serviceInstall.updatedAt)}</span>
            ) : null}
          </div>
        ) : null}
      </ModernSection>

      <ModernSection group="Updates" title="Updates" hint="Choose whether ADE installs downloaded updates automatically.">
        <AutoUpdatesControls />
      </ModernSection>
    </div>
  );
}
