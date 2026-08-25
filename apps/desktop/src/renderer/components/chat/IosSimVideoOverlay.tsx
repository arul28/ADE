import { Desktop, DeviceMobile, Lock, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { IosSimulatorWindowState } from "../../../shared/types";

export type IosSimBlockerAction =
  | "open-screen-recording"
  | "open-automation"
  | "reveal"
  | "relaunch"
  | "restart";

export type IosSimBlocker = {
  kind:
    | "screen-recording-permission"
    | "automation-denied"
    | "not-running"
    | "no-window"
    | "hidden"
    | "minimized"
    | "no-frames"
    | "error"
    | "starting";
  tone: "permission" | "warn" | "info";
  label: string;
  detail: string | null;
  action: IosSimBlockerAction | null;
  actionLabel: string | null;
  spinner: boolean;
};

export type IosSimLiveStatus = "starting" | "reconnecting" | "active" | "error";

export type ResolveIosSimBlockerInput = {
  windowState: IosSimulatorWindowState | null;
  liveStatus: IosSimLiveStatus | null;
  liveError: string | null;
  /** Stream claims active but no new frame arrived inside the watchdog window. */
  frameStalled: boolean;
  degradationReason?: string | null;
  /** Why the last Reveal was refused, if it was. */
  revealError?: string | null;
};

/**
 * The video area owns every blocked state. Order matters: the most specific
 * cause wins, so a denied permission is never reported as a generic stall.
 */
export function resolveIosSimBlocker(input: ResolveIosSimBlockerInput): IosSimBlocker | null {
  const { windowState, liveStatus, liveError, frameStalled, revealError } = input;
  const issue = windowState?.issue ?? null;
  const message = windowState?.message?.trim() || null;

  // Every window issue already carries the host's own one-line reason. Use it
  // verbatim rather than restating it here: two copies of the same sentence
  // drift, and the host's is the one that knows what actually happened.
  if (issue === "screen-recording-permission") {
    return {
      kind: "screen-recording-permission",
      tone: "permission",
      label: "Screen recording",
      detail: message,
      action: "open-screen-recording",
      actionLabel: "Open settings",
      spinner: false,
    };
  }
  if (issue === "automation-denied") {
    return {
      kind: "automation-denied",
      tone: "permission",
      label: "Automation",
      detail: message,
      action: "open-automation",
      actionLabel: "Open settings",
      spinner: false,
    };
  }
  if (issue === "not-running") {
    return {
      kind: "not-running",
      tone: "warn",
      label: "Simulator not running",
      detail: message,
      action: "relaunch",
      actionLabel: "Relaunch",
      spinner: false,
    };
  }
  if (issue === "no-window") {
    return {
      kind: "no-window",
      tone: "warn",
      label: "No simulator window",
      detail: message,
      action: "relaunch",
      actionLabel: "Relaunch",
      spinner: false,
    };
  }
  if (issue === "minimized" || issue === "hidden") {
    return {
      kind: issue,
      tone: "warn",
      label: issue === "minimized" ? "Simulator minimized" : "Simulator hidden",
      // A refused Reveal must say why; silence here reads as "nothing happened".
      // Until one is refused, the host's own line explains the state.
      detail: revealError ?? message,
      action: "reveal",
      actionLabel: "Reveal",
      spinner: false,
    };
  }
  if (liveStatus === "error") {
    return {
      kind: "error",
      tone: "warn",
      label: "Live view stopped",
      detail: liveError ?? input.degradationReason ?? null,
      action: "restart",
      actionLabel: "Restart",
      spinner: false,
    };
  }
  if (frameStalled) {
    return {
      kind: "no-frames",
      tone: "warn",
      label: "No frames",
      detail: null,
      action: "restart",
      actionLabel: "Restart view",
      spinner: false,
    };
  }
  if (liveStatus === "starting" || liveStatus === "reconnecting") {
    return {
      kind: "starting",
      tone: "info",
      label: liveStatus === "starting" ? "Starting live view" : "Reconnecting",
      detail: null,
      action: null,
      actionLabel: null,
      spinner: true,
    };
  }
  return null;
}

const TONE_ICON_CLASS: Record<IosSimBlocker["tone"], string> = {
  permission: "text-violet-200/85",
  warn: "text-amber-200/85",
  info: "text-cyan-100/85",
};

const TONE_BUTTON_CLASS: Record<IosSimBlocker["tone"], string> = {
  permission: "border-violet-300/28 bg-violet-400/15 text-violet-50/92 hover:bg-violet-400/24",
  warn: "border-amber-300/28 bg-amber-400/15 text-amber-50/92 hover:bg-amber-400/24",
  info: "border-white/[0.10] bg-white/[0.05] text-fg/85 hover:bg-white/[0.09]",
};

function BlockerIcon({ blocker }: { blocker: IosSimBlocker }) {
  const className = cn("shrink-0", TONE_ICON_CLASS[blocker.tone]);
  if (blocker.spinner) return <SpinnerGap size={18} className={cn(className, "animate-spin")} />;
  if (blocker.tone === "permission") return <Lock size={18} weight="fill" className={className} />;
  if (blocker.kind === "not-running" || blocker.kind === "no-window") {
    return <DeviceMobile size={18} className={className} />;
  }
  if (blocker.kind === "hidden" || blocker.kind === "minimized") {
    return <Desktop size={18} className={className} />;
  }
  return <WarningCircle size={18} weight="fill" className={className} />;
}

type IosSimVideoOverlayProps = {
  blocker: IosSimBlocker;
  busy?: boolean;
  onAction: (action: IosSimBlockerAction) => void;
};

/** Centered, self-contained: icon, short label, at most one action. */
export function IosSimVideoOverlay({ blocker, busy = false, onAction }: IosSimVideoOverlayProps) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 px-4">
      <div
        className="pointer-events-auto flex max-w-[300px] items-center gap-2.5 rounded-md border border-white/[0.10] bg-black/78 px-3 py-2.5 shadow-xl backdrop-blur"
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <BlockerIcon blocker={blocker} />
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[11px] font-medium text-fg/90">{blocker.label}</div>
          {blocker.detail ? (
            <div className="mt-0.5 line-clamp-2 font-sans text-[10px] leading-4 text-muted-fg/62">{blocker.detail}</div>
          ) : null}
        </div>
        {blocker.action && blocker.actionLabel ? (
          <button
            type="button"
            className={cn(
              "inline-flex h-7 shrink-0 items-center rounded-md border px-2 font-sans text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
              TONE_BUTTON_CLASS[blocker.tone],
            )}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              if (blocker.action) onAction(blocker.action);
            }}
          >
            {blocker.actionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
