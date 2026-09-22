import { Desktop, DeviceMobile, Eye, Power, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

/**
 * The one shape every blocked state on the Apple stage wears: an icon, one
 * short label, at most one detail line, and at most one action.
 *
 * The union lost the capture-specific members when window capture did. There is
 * no Simulator.app window to hide, minimize, or ask Screen Recording for — the
 * helper reads the framebuffer — so `screen-recording-permission`,
 * `automation-denied`, `no-window`, `hidden` and `minimized` describe nothing
 * that can happen any more. What replaced them are the states an Apple column
 * actually reaches: a lane with no device, a device that is powered off, a
 * viewer that is not visible, a Mac with nothing installed, and a runtime that
 * is not a Mac at all.
 */

export type IosSimBlockerAction =
  | "reconnect"
  | "resume"
  | "boot"
  | "create-device"
  | "attach-device"
  | "open-xcode"
  | "bind-mac"
  | "relaunch";

export type IosSimBlockerKind =
  | "no-device"
  | "no-simulators-installed"
  | "not-a-mac"
  | "powered-off"
  | "not-visible"
  | "not-running"
  | "no-frames"
  | "error"
  | "starting";

export type IosSimBlocker = {
  kind: IosSimBlockerKind;
  tone: "permission" | "warn" | "info";
  label: string;
  detail: string | null;
  action: IosSimBlockerAction | null;
  actionLabel: string | null;
  /**
   * A second action, for the two states that genuinely have two next steps —
   * Create / Attach, and Open Xcode / copy the install command. Everything else
   * keeps the one-action rule, which is what stops this overlay becoming a
   * settings page.
   */
  secondaryAction?: IosSimBlockerAction | null;
  secondaryActionLabel?: string | null;
  spinner: boolean;
};

export type IosSimLiveStatus = "starting" | "active" | "stalled" | "paused" | "error";

export type ResolveIosSimBlockerInput = {
  /** True when this machine can host a simulator at all. */
  supported: boolean;
  /** The machine this lane runs on, named in the "macOS only" state. */
  machineName: string | null;
  /** True once a status read has proved the Mac has no installed simulator. */
  noSimulatorsInstalled: boolean;
  /** The lane owns no device yet. */
  hasDevice: boolean;
  /** The lane's device exists but is shut down. */
  poweredOff: boolean;
  /** The column is mounted but its surface is not visible. */
  notVisible: boolean;
  liveStatus: IosSimLiveStatus | null;
  liveError: string | null;
};

/**
 * Most specific cause wins. Device facts outrank stream facts, because a lane
 * with no device has no stream to stall and saying "No frames" there is a lie
 * with a Reconnect button on it.
 */
export function resolveIosSimBlocker(input: ResolveIosSimBlockerInput): IosSimBlocker | null {
  if (!input.supported) {
    return {
      kind: "not-a-mac",
      tone: "warn",
      label: "macOS only",
      detail: input.machineName
        ? `Simulators run on a Mac. This lane runs on ${input.machineName}.`
        : "Simulators run on a Mac.",
      action: "bind-mac",
      actionLabel: "Bind to a Mac",
      spinner: false,
    };
  }
  if (input.noSimulatorsInstalled) {
    return {
      kind: "no-simulators-installed",
      tone: "warn",
      label: "No simulators installed",
      detail: "ADE only uses simulators you already have.",
      action: "open-xcode",
      actionLabel: "Open Xcode",
      spinner: false,
    };
  }
  if (!input.hasDevice) {
    return {
      kind: "no-device",
      tone: "info",
      label: "No device yet",
      detail: "This lane has no simulator.",
      action: "create-device",
      actionLabel: "Create a device",
      secondaryAction: "attach-device",
      secondaryActionLabel: "Attach…",
      spinner: false,
    };
  }
  if (input.poweredOff) {
    return {
      kind: "powered-off",
      tone: "info",
      label: "Device powered off",
      detail: null,
      action: "boot",
      actionLabel: "Boot",
      spinner: false,
    };
  }
  if (input.notVisible) {
    return {
      kind: "not-visible",
      tone: "info",
      label: "Paused — not visible",
      detail: null,
      action: "resume",
      actionLabel: "Resume",
      spinner: false,
    };
  }
  if (input.liveStatus === "error") {
    return {
      kind: "error",
      tone: "warn",
      label: "Stream stopped",
      detail: input.liveError,
      action: "reconnect",
      actionLabel: "Reconnect",
      spinner: false,
    };
  }
  if (input.liveStatus === "stalled") {
    return {
      kind: "no-frames",
      tone: "warn",
      label: "No frames",
      detail: "Nothing for 3s.",
      action: "reconnect",
      actionLabel: "Reconnect",
      spinner: false,
    };
  }
  if (input.liveStatus === "starting") {
    return {
      kind: "starting",
      tone: "info",
      label: "Starting stream",
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
  if (blocker.kind === "not-a-mac") return <Desktop size={18} className={className} />;
  if (blocker.kind === "powered-off") return <Power size={18} className={className} />;
  if (blocker.kind === "not-visible") return <Eye size={18} className={className} />;
  if (
    blocker.kind === "no-device"
    || blocker.kind === "no-simulators-installed"
    || blocker.kind === "not-running"
  ) {
    return <DeviceMobile size={18} className={className} />;
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
        className="pointer-events-auto flex max-w-[320px] items-center gap-2.5 rounded-md border border-white/[0.10] bg-black/78 px-3 py-2.5 shadow-xl backdrop-blur"
        data-ios-blocker={blocker.kind}
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
        {blocker.secondaryAction && blocker.secondaryActionLabel ? (
          <button
            type="button"
            className={cn(
              "inline-flex h-7 shrink-0 items-center rounded-md border px-2 font-sans text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
              TONE_BUTTON_CLASS.info,
            )}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              if (blocker.secondaryAction) onAction(blocker.secondaryAction);
            }}
          >
            {blocker.secondaryActionLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
