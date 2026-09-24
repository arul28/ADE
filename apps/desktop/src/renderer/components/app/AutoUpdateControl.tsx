import React, { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, ArrowsClockwise, CheckCircle, GithubLogo, WarningCircle } from "@phosphor-icons/react";
import type { AppInfo, AutoUpdateSnapshot } from "../../../shared/types";
import { cn } from "../ui/cn";
import { AutoUpdateErrorDialog, isAutoUpdateDiskSpaceError } from "./AutoUpdateErrorDialog";
import { EMPTY_AUTO_UPDATE_SNAPSHOT } from "./useAutoUpdateSnapshot";
import { captureUpdatePromptDecision } from "./captureUpdatePromptDecision";
import { confirmDialog } from "../ui/dialog/confirm";
import { Dialog } from "../ui/dialog";

const RUNTIME_SKEW_REFRESH_MS = 15_000;
const RUNTIME_SKEW_TITLE = "ADE has an update. Update ADE before continuing.";
type RuntimeVersionSkew = NonNullable<AppInfo["localRuntime"]>["versionSkew"];

function versionLabel(version: string | null): string {
  return version ? `v${version}` : "the latest update";
}

function progressLabel(progressPercent: number | null): string | null {
  if (progressPercent == null || !Number.isFinite(progressPercent)) return null;
  return `${Math.max(0, Math.min(100, Math.round(progressPercent)))}%`;
}

function activeRuntimeVersionSkew(value: RuntimeVersionSkew | null | undefined): RuntimeVersionSkew | null {
  if (!value || value.state === "none") return null;
  return value;
}

export function AutoUpdateControl() {
  const [snapshot, setSnapshot] = useState<AutoUpdateSnapshot>(EMPTY_AUTO_UPDATE_SNAPSHOT);
  const [runtimeSkew, setRuntimeSkew] = useState<RuntimeVersionSkew | null>(null);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [updateErrorOpen, setUpdateErrorOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [installRequested, setInstallRequested] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void window.ade.updateGetState()
      .then((nextSnapshot) => {
        if (cancelled) return;
        setSnapshot(nextSnapshot);
        setReleaseNotesOpen(Boolean(nextSnapshot.recentlyInstalled));
      })
      .catch(() => {
        // Best effort only.
      });

    const unsubscribe = window.ade.onUpdateEvent((nextSnapshot) => {
      if (cancelled) return;
      setSnapshot(nextSnapshot);
      if (nextSnapshot.status !== "error") {
        setUpdateErrorOpen(false);
        setRetrying(false);
      }
      if (nextSnapshot.status !== "ready") {
        setInstallRequested(false);
      }
      if (nextSnapshot.recentlyInstalled) {
        setReleaseNotesOpen(true);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const refresh = () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      void window.ade.app.getInfo()
        .then((info) => {
          if (cancelled) return;
          setRuntimeSkew(activeRuntimeVersionSkew(info.localRuntime?.versionSkew));
        })
        .catch(() => {
          if (!cancelled) setRuntimeSkew(null);
        })
        .finally(() => {
          inFlight = false;
        });
    };

    refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, RUNTIME_SKEW_REFRESH_MS);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const dismissInstalledNotice = useCallback(() => {
    setReleaseNotesOpen(false);
    setSnapshot((current) => ({
      ...current,
      recentlyInstalled: null,
    }));
    void window.ade.updateDismissInstalledNotice().catch(() => {
      // Ignore renderer-side dismissal failures.
    });
  }, []);

  const openInstalledLink = useCallback((url: string) => {
    void window.ade.app.openExternal(url);
    dismissInstalledNotice();
  }, [dismissInstalledNotice]);

  const handleRestartToInstall = useCallback(async () => {
    // Best-effort probe of live connections (paired phones) so the user knows
    // what drops while ADE and its brain service restart on the new version.
    const impact = await window.ade.updateGetInstallImpact().catch(() => null);
    const phones = impact?.connectedPhones ?? [];
    const title = `ADE will quit and reopen automatically to install ${versionLabel(snapshot.version)}.`;
    const lines: string[] = [];
    if (phones.length === 1) {
      lines.push(
        `${phones[0].deviceName} is connected through ADE phone sync. It will disconnect during the update and reconnect automatically once ADE is back.`,
      );
    } else if (phones.length > 1) {
      lines.push(
        `Connected phones (${phones.map((phone) => phone.deviceName).join(", ")}) will disconnect during the update and reconnect automatically once ADE is back.`,
      );
    }
    lines.push(
      "Open ADE Code terminals and running agent sessions on this machine will disconnect while the ADE service restarts — you can reopen them right after the update.",
      "",
      "You do not need to restart ADE yourself. Any unsaved work may be lost. Continue?",
    );
    const confirmed = await confirmDialog({ title, message: lines.join("\n"), confirmLabel: "Continue" });
    if (!confirmed) {
      captureUpdatePromptDecision(snapshot, "deferred");
      return;
    }
    captureUpdatePromptDecision(snapshot, "accepted");
    setInstallRequested(true);
    void window.ade.updateQuitAndInstall()
      .then((started) => {
        if (!started) setInstallRequested(false);
      })
      .catch(() => {
        setInstallRequested(false);
        // The main process logs updater failures.
      });
  }, [snapshot.currentVersion, snapshot.version]);

  const handleSkewUpdateCheck = useCallback(() => {
    setSnapshot((current) => current.status === "idle"
      ? { ...current, status: "checking", error: null, errorDetails: null }
      : current);
    void window.ade.updateCheckForUpdates()
      .catch(() => {
        setSnapshot((current) => current.status === "checking"
          ? { ...current, status: "idle" }
          : current);
      });
  }, []);

  const handleRetryUpdate = useCallback(() => {
    setRetrying(true);
    void window.ade.updateCheckForUpdates()
      .catch(() => undefined)
      .finally(() => {
        setRetrying(false);
      });
  }, []);

  const effectiveStatus = installRequested && snapshot.status === "ready"
    ? "installing"
    : snapshot.status;
  const isReadyOrInstalling = effectiveStatus === "ready" || effectiveStatus === "installing";
  const showUpdateError = effectiveStatus === "error";
  const shouldShowIndicator =
    effectiveStatus === "checking"
    || effectiveStatus === "downloading"
    || isReadyOrInstalling;
  const downloadProgress = progressLabel(snapshot.progressPercent);
  const releaseNotesUrl = snapshot.recentlyInstalled?.releaseNotesUrl ?? null;
  const githubReleaseUrl = snapshot.recentlyInstalled?.githubReleaseUrl ?? null;
  const installedVersion = snapshot.recentlyInstalled?.version ?? null;
  const runtimeRequiresDesktopUpdate = runtimeSkew?.state === "runtime_newer";
  const showRuntimeSkewIndicator = runtimeRequiresDesktopUpdate && !shouldShowIndicator && !showUpdateError;

  // A previous attempt quit but came back on the old version. Saying so beats
  // re-offering the identical button as if nothing had happened.
  const retryAfterFailedInstall = Boolean(
    snapshot.lastInstallFailed
    && snapshot.version
    && snapshot.lastInstallFailed.targetVersion === snapshot.version,
  );
  // A second consecutive failure stops trusting the archive and clears the
  // cache, so only the first retry can promise the bytes are still local.
  const downloadStillLocal = (snapshot.lastInstallFailed?.attempt ?? 0) < 2;

  function indicatorTitle(): string {
    switch (effectiveStatus) {
      case "checking":
        return "Checking for updates";
      case "downloading":
        return `Downloading ${versionLabel(snapshot.version)}${downloadProgress ? ` (${downloadProgress})` : ""}`;
      case "installing":
        return "ADE is preparing to quit and reopen automatically";
      default:
        return retryAfterFailedInstall
          ? `The last attempt to install ${versionLabel(snapshot.version)} quit without finishing. `
            + (downloadStillLocal
              ? "Try again — the download is already on this machine."
              : "Try again — ADE will download it again first.")
          : `Install ${versionLabel(snapshot.version)}. ADE will quit and reopen automatically.`;
    }
  }

  return (
    <>
      {showRuntimeSkewIndicator && runtimeSkew ? (
        <button
          type="button"
          className={cn(
            "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
            "border border-amber-300/45 bg-amber-400/15 text-[11px] font-medium text-amber-100",
            "shadow-[0_0_18px_rgba(245,158,11,0.18)] transition-colors duration-150 hover:bg-amber-400/22",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onClick={handleSkewUpdateCheck}
          title={`${RUNTIME_SKEW_TITLE} Check for ADE updates.`}
        >
          <WarningCircle size={12} weight="fill" />
          <span>Update required</span>
        </button>
      ) : null}

      {showUpdateError ? (
        <button
          type="button"
          className={cn(
            "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
            "border border-amber-300/55 bg-amber-400/15 text-[11px] font-medium text-amber-100",
            "shadow-[0_0_18px_rgba(245,158,11,0.2)] transition-colors duration-150 hover:bg-amber-400/24",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          onClick={() => setUpdateErrorOpen(true)}
          aria-haspopup="dialog"
          title="Open update failure details and recovery steps"
        >
          <WarningCircle size={12} weight="fill" aria-hidden="true" />
          <span>{isAutoUpdateDiskSpaceError(snapshot) ? "Not enough space to update" : "Update failed"}</span>
        </button>
      ) : null}

      {shouldShowIndicator ? (
        <button
          type="button"
          className={cn(
            "ade-shell-control shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1",
            "text-[11px] font-medium transition-colors duration-150",
            isReadyOrInstalling
              ? "animate-pulse border border-fuchsia-200/70 bg-fuchsia-500/30 text-white shadow-[0_0_20px_rgba(217,70,239,0.38)] hover:bg-fuchsia-400/40 [animation-duration:2.8s]"
              : "border border-border/60 bg-card/90 text-muted-fg",
            effectiveStatus !== "ready" && "cursor-default",
          )}
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          disabled={effectiveStatus !== "ready"}
          onClick={() => {
            if (effectiveStatus === "ready") {
              void handleRestartToInstall();
            }
          }}
          title={indicatorTitle()}
        >
          <ArrowsClockwise
            size={12}
            weight="bold"
            className={cn(effectiveStatus !== "ready" && "animate-spin")}
          />
          {effectiveStatus === "checking" ? "Checking for updates" : null}
          {effectiveStatus === "downloading" ? (
            <>
              <span>Downloading {snapshot.version ? `v${snapshot.version}` : "update"}</span>
              {downloadProgress ? <span className="text-[10px] text-muted-fg opacity-80">{downloadProgress}</span> : null}
            </>
          ) : null}
          {effectiveStatus === "ready" ? (
            <span>
              {retryAfterFailedInstall ? "Retry install" : "Install update"}
              {snapshot.version ? ` v${snapshot.version}` : ""}
            </span>
          ) : null}
          {effectiveStatus === "installing" ? (
            <span>ADE will quit and reopen</span>
          ) : null}
        </button>
      ) : null}
      <AutoUpdateErrorDialog
        snapshot={snapshot}
        open={updateErrorOpen}
        retrying={retrying}
        onOpenChange={setUpdateErrorOpen}
        onRetry={handleRetryUpdate}
      />

      <Dialog
        open={releaseNotesOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            dismissInstalledNotice();
          } else {
            setReleaseNotesOpen(true);
          }
        }}
        title={installedVersion ? `Updated to v${installedVersion}` : "ADE updated"}
        tone="success"
        icon={<CheckCircle size={16} weight="fill" />}
        size="sm"
        actions={[
          ...(releaseNotesUrl
            ? [
                {
                  label: "Changelog",
                  icon: <ArrowSquareOut size={12} weight="bold" />,
                  onClick: () => openInstalledLink(releaseNotesUrl),
                },
              ]
            : []),
          ...(githubReleaseUrl
            ? [
                {
                  label: "View on GitHub",
                  icon: <GithubLogo size={12} weight="bold" />,
                  onClick: () => openInstalledLink(githubReleaseUrl),
                },
              ]
            : []),
        ]}
      />
    </>
  );
}
