import React from "react";
import { ArrowClockwise, ArrowSquareOut, ArrowsClockwise, WarningCircle } from "@phosphor-icons/react";
import type { AutoUpdatePhase, AutoUpdateSnapshot } from "../../../shared/types";
import { Dialog, type DialogAction } from "../ui/dialog";

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
    case "check": return "Checking for updates";
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

/** The feed request failed: nothing was downloaded or installed. */
export function isAutoUpdateCheckError(snapshot: AutoUpdateSnapshot): boolean {
  return snapshot.errorDetails?.phase === "check";
}

/** Short name for the failure, shared by the top-bar pill and this dialog's title. */
export function autoUpdateErrorTitle(snapshot: AutoUpdateSnapshot): string {
  if (isAutoUpdateDiskSpaceError(snapshot)) return "Not enough space to update";
  if (isAutoUpdateCheckError(snapshot)) return "ADE couldn't check for updates";
  return "ADE update failed";
}

function updateErrorExplanation(snapshot: AutoUpdateSnapshot): string {
  const kind = snapshot.errorDetails?.kind;
  const checking = isAutoUpdateCheckError(snapshot);
  if (kind === "network_stuck") {
    return "Your internet connection works, but ADE's connection to the update server is stuck. Restarting ADE clears it.";
  }
  if (kind === "network") {
    return checking
      ? "ADE can't reach the update server. Check your connection, then choose Check again."
      : "ADE lost its connection to the update server before the download finished.";
  }
  if (kind === "insufficient_space" || kind === "disk_full") {
    return "ADE does not have enough free space on the affected volume to safely download, stage, and replace the app.";
  }
  if (kind === "artifact_too_large") {
    return "This release is too large for the macOS updater to install safely, so ADE stopped before it could crash. Download the latest version from the ADE website instead.";
  }
  if (kind === "quota") return "The account or volume quota was reached while ADE was updating.";
  if (kind === "signature" || kind === "verification") return "ADE could not verify that the downloaded update is complete and trusted.";
  if (kind === "permission") return "ADE could not write to the update cache or replace the installed application.";
  if (kind === "installer") return "The updater could not complete the installer handoff or quit and relaunch ADE.";
  return checking
    ? "ADE didn't get an answer from the update server."
    : "ADE could not complete the update.";
}

function recoverySteps(snapshot: AutoUpdateSnapshot): string[] {
  const kind = snapshot.errorDetails?.kind;
  if (kind === "network_stuck") {
    return [
      "Choose Restart ADE. If agents are running, ADE asks before it quits.",
      "ADE reopens and checks for updates on its own.",
    ];
  }
  if (kind === "network") {
    return ["Check your internet connection, VPN, or proxy.", "Choose Check again."];
  }
  if (isAutoUpdateDiskSpaceError(snapshot)) {
    return ["Free space on the affected volume, including Trash if needed.", "Return here and choose Check again."];
  }
  if (kind === "permission") {
    return [
      "Make sure your account can write to the folder ADE is installed in and to its update cache.",
      "Choose Check again.",
    ];
  }
  if (kind === "signature" || kind === "verification") {
    return [
      "Choose Check again. ADE downloads a fresh copy of the update.",
      "If it fails again, install the latest version from the ADE website.",
    ];
  }
  if (kind === "artifact_too_large") {
    return ["Download the latest version from the ADE website and install it over this one."];
  }
  if (kind === "installer") {
    return [
      "Choose Check again to retry the install.",
      "If it fails again, quit ADE and install the latest version from the ADE website.",
    ];
  }
  return ["Choose Check again.", "If it keeps failing, restart ADE."];
}

function formatRetryTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

const DETAIL_LIST_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr",
  columnGap: 16,
  rowGap: 6,
  margin: 0,
  padding: 12,
  borderRadius: 10,
  border: "1px solid color-mix(in srgb, var(--color-border) 80%, transparent)",
  background: "color-mix(in srgb, var(--color-fg) 3%, transparent)",
  fontSize: 12,
};
const DETAIL_TERM_STYLE: React.CSSProperties = { color: "var(--color-muted-fg)" };
const DETAIL_VALUE_STYLE: React.CSSProperties = {
  margin: 0,
  textAlign: "right",
  color: "var(--color-fg)",
  overflowWrap: "anywhere",
};
const DETAIL_MONO_STYLE: React.CSSProperties = {
  ...DETAIL_VALUE_STYLE,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
};

function DetailRow({ term, mono, children }: { term: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <>
      <dt style={DETAIL_TERM_STYLE}>{term}</dt>
      <dd style={mono ? DETAIL_MONO_STYLE : DETAIL_VALUE_STYLE}>{children}</dd>
    </>
  );
}

type AutoUpdateErrorDialogProps = {
  snapshot: AutoUpdateSnapshot;
  open: boolean;
  retrying: boolean;
  onOpenChange: (open: boolean) => void;
  onRetry: () => void;
  /** When the last Check again from this dialog finished, if it ended in this error. */
  lastRetryAt?: number | null;
};

export function AutoUpdateErrorDialog({
  snapshot,
  open,
  retrying,
  onOpenChange,
  onRetry,
  lastRetryAt = null,
}: AutoUpdateErrorDialogProps) {
  const details = snapshot.errorDetails;
  const releaseNotesUrl = snapshot.releaseNotesUrl;
  const stuck = details?.kind === "network_stuck";
  const technicalDetail = details?.message ?? snapshot.error;
  const title = autoUpdateErrorTitle(snapshot);

  const checkAgain: DialogAction = {
    label: retrying ? "Checking…" : "Check again",
    icon: <ArrowsClockwise size={12} weight="bold" />,
    busy: retrying,
    onClick: onRetry,
  };
  const actions: DialogAction[] = stuck
    ? [
        { ...checkAgain, variant: "secondary" },
        {
          label: "Restart ADE",
          icon: <ArrowClockwise size={12} weight="bold" />,
          variant: "solid",
          autoFocus: true,
          onClick: () => void window.ade.updateRelaunchApp?.().catch(() => false),
        },
      ]
    : [
        ...(releaseNotesUrl
          ? [{
              label: "Changelog",
              icon: <ArrowSquareOut size={12} weight="bold" />,
              variant: "secondary" as const,
              onClick: () => void window.ade.app.openExternal(releaseNotesUrl),
            }]
          : []),
        { ...checkAgain, variant: "solid" },
      ];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={updateErrorExplanation(snapshot)}
      tone="warning"
      icon={<WarningCircle size={16} weight="fill" />}
      size="sm"
      width={460}
      actions={actions}
    >
      <dl style={DETAIL_LIST_STYLE}>
        {snapshot.version ? (
          <DetailRow term="Version">
            {snapshot.currentVersion ? `v${snapshot.currentVersion}` : "Current"} → v{snapshot.version}
          </DetailRow>
        ) : null}
        <DetailRow term="Failed during">{phaseLabel(details?.phase)}</DetailRow>
        {details?.availableBytes != null ? (
          <DetailRow term="Available">{formatBytes(details.availableBytes)}</DetailRow>
        ) : null}
        {details?.requiredBytes != null ? (
          <DetailRow term="Estimated needed">{formatBytes(details.requiredBytes)}</DetailRow>
        ) : null}
        {details?.volumePath ? (
          <DetailRow term="Affected path" mono>{details.volumePath}</DetailRow>
        ) : null}
        {technicalDetail ? (
          <DetailRow term="Technical detail" mono>{technicalDetail}</DetailRow>
        ) : null}
      </dl>

      <div style={{ marginTop: 14 }}>
        <p style={{ margin: 0, fontWeight: 600, color: "var(--color-fg)" }}>What to do</p>
        <ol style={{ margin: "4px 0 0", paddingLeft: 18, display: "grid", gap: 3 }}>
          {recoverySteps(snapshot).map((step) => <li key={step}>{step}</li>)}
        </ol>
        {details?.preservesDownload ? (
          <p style={{ margin: "8px 0 0", color: "var(--color-success)" }}>
            The downloaded update was kept, so ADE can reuse it when safe.
          </p>
        ) : snapshot.version && !isAutoUpdateCheckError(snapshot) ? (
          <p style={{ margin: "8px 0 0" }}>
            ADE must download the update again to avoid reusing an incomplete or unverified file.
          </p>
        ) : null}
        {lastRetryAt != null && !retrying ? (
          <p role="status" style={{ margin: "8px 0 0", color: "var(--color-warning)" }}>
            Checked again at {formatRetryTime(lastRetryAt)}. It still didn't work.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
