import React, { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowSquareOut, ArrowsClockwise, CheckCircle, GithubLogo, WarningCircle, X } from "@phosphor-icons/react";
import type { AppInfo, AutoUpdateSnapshot } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

const EMPTY_UPDATE_SNAPSHOT: AutoUpdateSnapshot = {
  status: "idle",
  version: null,
  progressPercent: null,
  bytesPerSecond: null,
  transferredBytes: null,
  totalBytes: null,
  releaseNotesUrl: null,
  error: null,
  recentlyInstalled: null,
};

const RUNTIME_SKEW_REFRESH_MS = 15_000;
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

function runtimeSkewTitle(skew: RuntimeVersionSkew): string {
  if (skew.message?.trim()) return skew.message;
  if (skew.state === "runtime_newer") {
    const runtime = skew.runtimeVersion ? ` v${skew.runtimeVersion}` : "";
    const app = skew.appVersion ? ` v${skew.appVersion}` : "";
    return `The ADE brain${runtime} is newer than this desktop app${app}. Update ADE desktop before using this machine brain.`;
  }
  return "The ADE desktop app and ADE brain are out of sync.";
}

export function AutoUpdateControl() {
  const [snapshot, setSnapshot] = useState<AutoUpdateSnapshot>(EMPTY_UPDATE_SNAPSHOT);
  const [runtimeSkew, setRuntimeSkew] = useState<RuntimeVersionSkew | null>(null);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
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
    const lines = [
      `ADE will quit and reopen automatically to install ${versionLabel(snapshot.version)}.`,
      "",
    ];
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
    const confirmed = window.confirm(lines.join("\n"));
    if (!confirmed) return;
    setInstallRequested(true);
    void window.ade.updateQuitAndInstall()
      .then((started) => {
        if (!started) setInstallRequested(false);
      })
      .catch(() => {
        setInstallRequested(false);
        // The main process logs updater failures.
      });
  }, [snapshot.version]);

  const handleSkewUpdateCheck = useCallback(() => {
    setSnapshot((current) => current.status === "idle"
      ? { ...current, status: "checking", error: null }
      : current);
    void window.ade.updateCheckForUpdates()
      .catch(() => {
        setSnapshot((current) => current.status === "checking"
          ? { ...current, status: "idle" }
          : current);
      });
  }, []);

  const effectiveStatus = installRequested && snapshot.status === "ready"
    ? "installing"
    : snapshot.status;
  const isReadyOrInstalling = effectiveStatus === "ready" || effectiveStatus === "installing";
  const shouldShowIndicator =
    effectiveStatus === "checking"
    || effectiveStatus === "downloading"
    || isReadyOrInstalling;
  const downloadProgress = progressLabel(snapshot.progressPercent);
  const releaseNotesUrl = snapshot.recentlyInstalled?.releaseNotesUrl ?? null;
  const githubReleaseUrl = snapshot.recentlyInstalled?.githubReleaseUrl ?? null;
  const installedVersion = snapshot.recentlyInstalled?.version ?? null;
  const runtimeRequiresDesktopUpdate = runtimeSkew?.state === "runtime_newer";
  const showRuntimeSkewIndicator = runtimeRequiresDesktopUpdate && !shouldShowIndicator;

  function indicatorTitle(): string {
    switch (effectiveStatus) {
      case "checking":
        return "Checking for updates";
      case "downloading":
        return `Downloading ${versionLabel(snapshot.version)}${downloadProgress ? ` (${downloadProgress})` : ""}`;
      case "installing":
        return "ADE is preparing to quit and reopen automatically";
      default:
        return `Install ${versionLabel(snapshot.version)}. ADE will quit and reopen automatically.`;
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
          title={`${runtimeSkewTitle(runtimeSkew)} Check for ADE desktop updates.`}
        >
          <WarningCircle size={12} weight="fill" />
          <span>Update required</span>
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
            <span>Install update {snapshot.version ? `v${snapshot.version}` : ""}</span>
          ) : null}
          {effectiveStatus === "installing" ? (
            <span>ADE will quit and reopen</span>
          ) : null}
        </button>
      ) : null}

      <Dialog.Root
        open={releaseNotesOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            dismissInstalledNotice();
          } else {
            setReleaseNotesOpen(true);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/55 backdrop-blur-sm" />
          {/* Full-viewport flex layer centers the card. Positioning the card
              this way (instead of fixed + translate) keeps it centered even if
              an ancestor establishes a containing block for fixed descendants.
              The layer is click-through so a click outside the card lands on the
              overlay and dismisses via onOpenChange. */}
          <div className="pointer-events-none fixed inset-0 z-[121] grid place-items-center p-4">
            <Dialog.Content
              className={cn(
                "ade-update-installed-card pointer-events-auto relative w-[min(92vw,420px)]",
                "overflow-hidden rounded-xl border border-white/[0.12] bg-[color:var(--ade-shell-surface,#121019)] text-fg shadow-2xl shadow-black/55 outline-none",
              )}
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-300/60 to-transparent" />
              <div className="p-5 sm:p-6">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-emerald-300/25 bg-emerald-400/10 text-emerald-200 shadow-[0_0_24px_rgba(16,185,129,0.18)]">
                      <CheckCircle size={20} weight="fill" aria-hidden="true" />
                    </div>
                    <Dialog.Title className="min-w-0 truncate text-sm font-semibold text-fg">
                      {installedVersion ? `Updated to v${installedVersion}` : "ADE updated"}
                    </Dialog.Title>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-fg transition-colors hover:bg-white/[0.06] hover:text-fg"
                      aria-label="Close update details"
                    >
                      <X size={14} weight="bold" />
                    </button>
                  </Dialog.Close>
                </div>

                <Dialog.Description className="sr-only">
                  ADE finished installing {installedVersion ? `v${installedVersion}` : "the latest update"}.
                </Dialog.Description>

                <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                  {releaseNotesUrl ? (
                    <Button
                      type="button"
                      variant="primary"
                      className="w-full sm:w-auto"
                      onClick={() => openInstalledLink(releaseNotesUrl)}
                    >
                      <ArrowSquareOut size={12} weight="bold" />
                      Changelog
                    </Button>
                  ) : null}
                  {githubReleaseUrl ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full sm:w-auto"
                      onClick={() => openInstalledLink(githubReleaseUrl)}
                    >
                      <GithubLogo size={12} weight="bold" />
                      View on GitHub
                    </Button>
                  ) : null}
                </div>
              </div>
            </Dialog.Content>
          </div>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
