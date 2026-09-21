import { WarningCircle } from "@phosphor-icons/react";

import type {
  MacDesktopPermissionKind,
  MacDesktopSigningState,
} from "../../../shared/types/macDesktop";
import { WORK_TOOL_PRIMARY_BUTTON } from "../terminals/workToolChrome";
import { cn } from "../ui/cn";

/**
 * The first screen when macOS has not granted a permission yet.
 *
 * The one-line empty state was the bug: it said a grant was missing and offered
 * one "Try again" that re-read a cached "denied" and changed nothing. This is
 * the same information with the three things the user can actually do (open the
 * pane, let macOS prompt, or re-probe after granting in System Settings) and
 * the one note that explains why a grant keeps disappearing.
 *
 * Nothing here decides policy: the panel only draws it when the host reported a
 * denied grant, and `hostIsLocal` decides whether a System Settings button can
 * mean anything on this machine.
 */

/** The second-tier control: visible, but not the filled primary. */
const SECONDARY_BUTTON = cn(
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-3",
  "font-sans text-[12px] font-medium text-fg/80 transition-colors duration-[120ms] ease-out",
  "hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
  "disabled:pointer-events-none disabled:opacity-40",
);

const PERMISSION_LABEL: Record<MacDesktopPermissionKind, string> = {
  screenRecording: "Screen Recording",
  accessibility: "Accessibility",
};

export type MacDesktopPermissionBlockProps = {
  kind: MacDesktopPermissionKind;
  /** `status.responsibleAppName`: the app macOS accuses in its own UI. */
  appName: string;
  signing: MacDesktopSigningState;
  hostIsLocal: boolean;
  /** The lane's machine, named in the remote instructions. */
  machineName: string | null;
  /** A "Check again" or "Ask macOS" call is in flight. */
  checking: boolean;
  onOpenSettings: () => void;
  onCheckAgain: () => void;
  /** Absent on a remote lane host, where there is nothing to prompt locally. */
  onAskMacos: (() => void) | null;
};

export function MacDesktopPermissionBlock({
  kind,
  appName,
  signing,
  hostIsLocal,
  machineName,
  checking,
  onOpenSettings,
  onCheckAgain,
  onAskMacos,
}: MacDesktopPermissionBlockProps) {
  const label = PERMISSION_LABEL[kind];
  return (
    <div
      data-testid="mac-desktop-permission-block"
      className="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-5 text-center"
    >
      <p className="flex items-center gap-2 font-sans text-[14px] font-medium text-fg/85">
        <WarningCircle size={14} className="shrink-0 text-amber-300" />
        {`${label} is off for ADE`}
      </p>
      <p className="max-w-[340px] text-[12px] text-muted-fg">
        {`macOS asks the app that owns the helper: ${appName}.`}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {hostIsLocal ? (
          <button
            type="button"
            className={WORK_TOOL_PRIMARY_BUTTON}
            data-testid="mac-desktop-open-settings"
            onClick={onOpenSettings}
            disabled={checking}
          >
            {`Open ${label} settings`}
          </button>
        ) : null}
        <button
          type="button"
          className={hostIsLocal ? SECONDARY_BUTTON : WORK_TOOL_PRIMARY_BUTTON}
          data-testid="mac-desktop-check-again"
          onClick={onCheckAgain}
          disabled={checking}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
        {hostIsLocal && onAskMacos ? (
          <button
            type="button"
            className={SECONDARY_BUTTON}
            data-testid="mac-desktop-ask-macos"
            onClick={onAskMacos}
            disabled={checking}
          >
            Ask macOS
          </button>
        ) : null}
      </div>
      {hostIsLocal ? (
        <ol className="list-decimal space-y-0.5 pl-5 text-left text-[12px] text-muted-fg">
          <li>{`Turn on ${appName}.`}</li>
          <li>If macOS asks to quit and reopen, press Later.</li>
          <li>Press Check again.</li>
        </ol>
      ) : (
        <p className="max-w-[340px] text-[12px] text-muted-fg">
          {`Grant it on ${machineName ?? "the lane's Mac"}: System Settings › Privacy & Security › ${label}, then press Check again.`}
        </p>
      )}
      {signing === "adhoc" ? (
        <p data-testid="mac-desktop-adhoc-note" className="max-w-[340px] text-[11.5px] text-amber-300">
          {`This build is not signed with a certificate. macOS forgets this grant on every rebuild. Remove ${appName} from the list and add it again, then press Check again.`}
        </p>
      ) : null}
    </div>
  );
}
