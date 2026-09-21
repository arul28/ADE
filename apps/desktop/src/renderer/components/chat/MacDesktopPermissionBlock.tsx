import type { ReactNode } from "react";
import { ArrowSquareOut, ArrowsClockwise, Cursor, HandPalm, Monitor, Sparkle } from "@phosphor-icons/react";

import type {
  MacDesktopPermissionKind,
  MacDesktopSigningState,
} from "../../../shared/types/macDesktop";
import { WORK_TOOL_PRIMARY_BUTTON } from "../terminals/workToolChrome";
import { cn } from "../ui/cn";

/**
 * The card macOS's missing grant gets, instead of white text on a black pane.
 *
 * Screen Recording is what makes the picture; Accessibility is what makes the
 * mouse and keyboard do anything. Both fail the same way from the outside,
 * silently, so this card names the grant, names the app macOS lists, and puts
 * the two things that change the state first: opening the exact row in System
 * Settings, and asking again after the switch is on. "Ask macOS" is the third
 * way, the system's own prompt, only on the Mac that hosts the display.
 *
 * Nothing here decides policy: the panel draws it when the host reported a
 * denied grant, and `hostIsLocal` decides whether a settings button can mean
 * anything on this machine.
 */

const SECONDARY_BUTTON = cn(
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] px-3",
  "border border-white/[0.10] bg-white/[0.04]",
  "font-sans text-[12px] font-medium text-fg/85 transition-colors duration-[120ms] ease-out",
  "hover:bg-white/[0.08] hover:text-fg focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
  "disabled:pointer-events-none disabled:opacity-40",
);

const PERMISSION_COPY: Record<MacDesktopPermissionKind, {
  label: string;
  title: string;
  why: string;
  icon: typeof Monitor;
}> = {
  screenRecording: {
    label: "Screen Recording",
    title: "Let ADE see this screen",
    why: "macOS only shows a display to apps with Screen Recording turned on.",
    icon: Monitor,
  },
  accessibility: {
    label: "Accessibility",
    title: "Let ADE use the mouse and keyboard here",
    why: "macOS only lets apps with Accessibility turned on click, type, and move windows.",
    icon: Cursor,
  },
};

export type MacDesktopPermissionBlockProps = {
  kind: MacDesktopPermissionKind;
  /** `status.responsibleAppName`: the app macOS lists in its own UI. */
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
  /**
   * Drawn over a live picture (Accessibility missing while the screen already
   * streams) rather than as the pane's whole content. Tighter, and no tall
   * centring.
   */
  compact?: boolean;
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
  compact = false,
}: MacDesktopPermissionBlockProps) {
  const copy = PERMISSION_COPY[kind];
  const Icon = copy.icon;
  const where = machineName ?? "the lane's Mac";
  return (
    <div
      data-testid="mac-desktop-permission-block"
      className={cn(
        "flex min-h-0 w-full flex-col items-center",
        compact ? "justify-start py-3" : "h-full justify-center px-4 py-6",
      )}
    >
      <div
        className={cn(
          "flex w-full max-w-[440px] flex-col gap-4 rounded-[14px] border border-white/[0.08] bg-white/[0.03] p-5",
          "shadow-[0_12px_40px_-24px_rgba(0,0,0,0.8)]",
        )}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-400/15 text-amber-300">
            <Icon size={20} weight="duotone" />
          </span>
          <div className="min-w-0">
            <p className="font-sans text-[14px] font-semibold text-fg">{copy.title}</p>
            <p className="mt-0.5 text-[12px] leading-[1.45] text-muted-fg">
              {copy.why}
              {" "}
              {hostIsLocal
                ? `Turn on ${appName} under ${copy.label}.`
                : `Turn it on for ${appName} on ${where}.`}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hostIsLocal ? (
            <button
              type="button"
              className={WORK_TOOL_PRIMARY_BUTTON}
              data-testid="mac-desktop-open-settings"
              onClick={onOpenSettings}
              disabled={checking}
            >
              <ArrowSquareOut size={14} />
              {`Open ${copy.label} settings`}
            </button>
          ) : null}
          <button
            type="button"
            className={hostIsLocal ? SECONDARY_BUTTON : WORK_TOOL_PRIMARY_BUTTON}
            data-testid="mac-desktop-check-again"
            onClick={onCheckAgain}
            disabled={checking}
          >
            <ArrowsClockwise size={14} className={checking ? "animate-spin" : undefined} />
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
              <Sparkle size={14} />
              Ask macOS
            </button>
          ) : null}
        </div>

        {hostIsLocal ? (
          <ol className="grid gap-1.5 text-[12px] text-fg/75">
            <Step n={1}>{`Find ${appName} in the list and turn it on.`}</Step>
            <Step n={2}>If macOS asks to quit and reopen, press Later.</Step>
            <Step n={3}>Press Check again. The screen updates by itself within a few seconds.</Step>
          </ol>
        ) : (
          <p className="text-[12px] leading-[1.45] text-fg/75">
            {`Grant it on ${where}: System Settings › Privacy & Security › ${copy.label}, then press Check again.`}
          </p>
        )}

        {signing === "adhoc" ? (
          <div
            data-testid="mac-desktop-adhoc-note"
            className="flex items-start gap-2 rounded-[10px] border border-amber-400/25 bg-amber-400/[0.08] px-3 py-2 text-[11.5px] leading-[1.45] text-amber-200"
          >
            <HandPalm size={14} className="mt-0.5 shrink-0" />
            <span>
              {`This build is not signed with a certificate, so macOS forgets this grant on every rebuild. Remove ${appName} from the list, add it again, then press Check again.`}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className="mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-white/[0.08] font-mono text-[10.5px] text-fg/70">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}
