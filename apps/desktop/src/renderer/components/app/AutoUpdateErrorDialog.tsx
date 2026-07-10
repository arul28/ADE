import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowSquareOut, ArrowsClockwise, WarningCircle, X } from "@phosphor-icons/react";
import type { AutoUpdatePhase, AutoUpdateSnapshot } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

function versionLabel(version: string | null): string {
  return version ? `v${version}` : "the latest update";
}

function formatBytes(bytes: number | null): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "Not available";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function phaseLabel(phase: AutoUpdatePhase | null | undefined): string {
  switch (phase) {
    case "download": return "Download";
    case "staging": return "Staging";
    case "verification": return "Verification";
    case "install": return "Install";
    default: return "Update";
  }
}

export function isAutoUpdateDiskSpaceError(snapshot: AutoUpdateSnapshot): boolean {
  const kind = snapshot.errorDetails?.kind;
  return kind === "insufficient_space" || kind === "disk_full" || kind === "quota";
}

function updateErrorExplanation(snapshot: AutoUpdateSnapshot): string {
  const kind = snapshot.errorDetails?.kind;
  if (kind === "insufficient_space" || kind === "disk_full") {
    return "ADE does not have enough free space on the affected volume to safely download, stage, and replace the app.";
  }
  if (kind === "quota") return "The account or volume quota was reached while ADE was updating.";
  if (kind === "network") return "ADE could not reach or finish downloading the update from the release server.";
  if (kind === "signature" || kind === "verification") return "ADE could not verify that the downloaded update is complete and trusted.";
  if (kind === "permission") return "ADE could not write to the update cache or replace the installed application.";
  if (kind === "installer") return "The updater could not complete the installer handoff or quit and relaunch ADE.";
  return snapshot.errorDetails?.message ?? snapshot.error ?? "ADE could not complete the update.";
}

type AutoUpdateErrorDialogProps = {
  snapshot: AutoUpdateSnapshot;
  open: boolean;
  retrying: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
};

export function AutoUpdateErrorDialog({
  snapshot,
  open,
  retrying,
  onOpenChange,
  onRetry,
}: AutoUpdateErrorDialogProps) {
  const isDiskSpaceError = isAutoUpdateDiskSpaceError(snapshot);
  const releaseNotesUrl = snapshot.releaseNotesUrl;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[120] bg-black/55 backdrop-blur-sm" />
        <div className="pointer-events-none fixed inset-0 z-[121] grid place-items-center p-4">
          <Dialog.Content
            className={cn(
              "pointer-events-auto relative w-[min(92vw,460px)] overflow-hidden rounded-xl",
              "border border-amber-200/20 bg-[color:var(--ade-shell-surface,#121019)] text-fg shadow-2xl shadow-black/55 outline-none",
            )}
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-amber-300/70 to-transparent" />
            <div className="p-5 sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 gap-3">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-amber-300/25 bg-amber-400/10 text-amber-200">
                    <WarningCircle size={20} weight="fill" aria-hidden="true" />
                  </div>
                  <div>
                    <Dialog.Title className="text-sm font-semibold text-fg">
                      {isDiskSpaceError ? "Not enough space to update" : "ADE update failed"}
                    </Dialog.Title>
                    <Dialog.Description className="mt-1 text-xs leading-5 text-muted-fg">
                      {updateErrorExplanation(snapshot)}
                    </Dialog.Description>
                  </div>
                </div>
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-fg transition-colors hover:bg-white/[0.06] hover:text-fg"
                    aria-label="Close update error details"
                  >
                    <X size={14} weight="bold" />
                  </button>
                </Dialog.Close>
              </div>

              <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-white/[0.08] bg-black/15 p-3 text-xs">
                <dt className="text-muted-fg">Version</dt>
                <dd className="text-right text-fg">
                  {snapshot.currentVersion ? `v${snapshot.currentVersion}` : "Current"} → {versionLabel(snapshot.version)}
                </dd>
                <dt className="text-muted-fg">Failed during</dt>
                <dd className="text-right text-fg">{phaseLabel(snapshot.errorDetails?.phase)}</dd>
                {snapshot.errorDetails?.message ? (
                  <>
                    <dt className="text-muted-fg">Failure</dt>
                    <dd className="text-right text-fg">{snapshot.errorDetails.message}</dd>
                  </>
                ) : null}
                {snapshot.errorDetails?.availableBytes != null ? (
                  <>
                    <dt className="text-muted-fg">Available</dt>
                    <dd className="text-right text-fg">{formatBytes(snapshot.errorDetails.availableBytes)}</dd>
                  </>
                ) : null}
                {snapshot.errorDetails?.requiredBytes != null ? (
                  <>
                    <dt className="text-muted-fg">Estimated needed</dt>
                    <dd className="text-right text-fg">{formatBytes(snapshot.errorDetails.requiredBytes)}</dd>
                  </>
                ) : null}
                {snapshot.errorDetails?.volumePath ? (
                  <>
                    <dt className="text-muted-fg">Affected path</dt>
                    <dd className="break-all text-right font-mono text-[10px] text-fg">{snapshot.errorDetails.volumePath}</dd>
                  </>
                ) : null}
              </dl>

              <div className="mt-4 text-xs leading-5 text-muted-fg">
                <p className="font-medium text-fg">What to do</p>
                <ol className="mt-1 list-decimal space-y-1 pl-4">
                  {isDiskSpaceError ? (
                    <>
                      <li>Free space on the affected volume, including Trash if needed.</li>
                      <li>Return here and choose Check again.</li>
                    </>
                  ) : (
                    <>
                      <li>Resolve the connection, permission, or installer problem described above.</li>
                      <li>Choose Check again to retry the update.</li>
                    </>
                  )}
                </ol>
                {snapshot.errorDetails?.preservesDownload ? (
                  <p className="mt-2 text-emerald-200/90">The downloaded update was kept, so ADE can reuse it when safe.</p>
                ) : snapshot.version ? (
                  <p className="mt-2">ADE must download the update again to avoid reusing an incomplete or unverified file.</p>
                ) : null}
              </div>

              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-end">
                {releaseNotesUrl ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => void window.ade.app.openExternal(releaseNotesUrl)}
                  >
                    <ArrowSquareOut size={12} weight="bold" />
                    Changelog
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="primary"
                  className="w-full sm:w-auto"
                  onClick={onRetry}
                  disabled={retrying}
                >
                  <ArrowsClockwise size={12} weight="bold" className={cn(retrying && "animate-spin")} />
                  {retrying ? "Checking…" : "Check again"}
                </Button>
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
