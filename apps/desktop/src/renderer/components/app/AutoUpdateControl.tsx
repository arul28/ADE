import React, { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowSquareOut, ArrowsClockwise, X } from "@phosphor-icons/react";
import type { AutoUpdateSnapshot } from "../../../shared/types";
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

function versionLabel(version: string | null): string {
  return version ? `v${version}` : "the latest update";
}

function progressLabel(progressPercent: number | null): string | null {
  if (progressPercent == null || !Number.isFinite(progressPercent)) return null;
  return `${Math.max(0, Math.min(100, Math.round(progressPercent)))}%`;
}

export function AutoUpdateControl() {
  const [snapshot, setSnapshot] = useState<AutoUpdateSnapshot>(EMPTY_UPDATE_SNAPSHOT);
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

  const handleRestartToInstall = useCallback(() => {
    const confirmed = window.confirm(
      `ADE will quit and reopen automatically to install ${versionLabel(snapshot.version)}.\n\nYou do not need to restart ADE yourself. Any unsaved work may be lost. Continue?`,
    );
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
              handleRestartToInstall();
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
          <Dialog.Content
            className={cn(
              "fixed left-1/2 top-1/2 z-[121] w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2",
              "border border-border bg-card p-5 shadow-2xl outline-none",
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <Dialog.Title className="font-mono text-[12px] font-semibold uppercase tracking-[1px] text-fg">
                  ADE updated
                </Dialog.Title>
                <Dialog.Description className="text-sm text-muted-fg">
                  {snapshot.recentlyInstalled
                    ? `ADE restarted on v${snapshot.recentlyInstalled.version}.`
                    : "ADE finished installing the latest version."}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center text-muted-fg transition-colors hover:text-fg"
                  aria-label="Close update details"
                >
                  <X size={14} weight="bold" />
                </button>
              </Dialog.Close>
            </div>

            <div className="mt-3 text-[13px] leading-6 text-muted-fg">
              The update is installed. You can reopen the release notes to see what changed in this build.
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={dismissInstalledNotice}
              >
                Close
              </Button>
              {releaseNotesUrl ? (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => {
                    void window.ade.app.openExternal(releaseNotesUrl);
                    dismissInstalledNotice();
                  }}
                >
                  <ArrowSquareOut size={12} weight="bold" />
                  Open release notes
                </Button>
              ) : null}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
