import { useEffect, useState } from "react";
import { AndroidLogo, DeviceMobile, DeviceTablet } from "@phosphor-icons/react";
import { Banner, type NoticeAction } from "../ui/notice";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";

/**
 * The Android pane's strips and cards: the Apple pane's top strip (one
 * line, one action), the loading card, the one-card messages, and the live
 * line at the foot of the picture (plan §5 "Status strip").
 */

/** One error at the top of the pane, with the raw text behind `Details`. */
export function AndroidDeviceErrorStrip({
  sentence,
  detail,
  actions,
  onDismiss,
}: {
  sentence: string;
  detail?: string | null;
  actions?: NoticeAction[];
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const all: NoticeAction[] = [...(actions ?? [])];
  if (detail) {
    all.push({ label: "Details", variant: "link", expanded: open, onClick: () => setOpen((value) => !value) });
  }
  return (
    <div data-android-status-strip="error" style={{ display: "contents" }}>
      <Banner
        layout="inline"
        style={{ margin: "6px 8px", flexShrink: 0 }}
        model={{
          id: "android-device-status",
          tone: "error",
          title: sentence,
          actions: all,
          dismiss: onDismiss ? { onDismiss, title: "Dismiss this message", label: "Dismiss this message" } : undefined,
          extra: open && detail ? (
            <div
              style={{
                maxHeight: 96,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                fontSize: 11,
                lineHeight: 1.45,
                color: "var(--color-muted-fg)",
              }}
            >
              {detail}
            </div>
          ) : undefined,
        }}
      />
    </div>
  );
}

/** A fact about the device, not a failure: "Pixel is off." with one action. */
export function AndroidDeviceNoticeStrip({
  sentence,
  tone = "neutral",
  actions,
  onDismiss,
  busy,
}: {
  sentence: string;
  tone?: "neutral" | "warning";
  actions: NoticeAction[];
  onDismiss?: () => void;
  busy?: boolean;
}) {
  return (
    <div data-android-status-strip={tone === "warning" ? "warning" : "notice"} style={{ display: "contents" }}>
      <Banner
        layout="inline"
        style={{ margin: "6px 8px", flexShrink: 0 }}
        model={{
          id: "android-device-notice",
          tone,
          icon: <AndroidLogo size={13} />,
          title: sentence,
          actions: busy ? [] : actions,
          busy: busy ?? false,
          dismiss: onDismiss ? { onDismiss, title: "Dismiss this message", label: "Dismiss this message" } : undefined,
        }}
      />
    </div>
  );
}

/** One card in the middle of the pane: unsupported host, loading, a stopped device. */
export function AndroidPaneMessage({
  title,
  description,
  action,
}: {
  title: string;
  description: string | null;
  action?: { label: string; onClick: () => void; disabled?: boolean } | undefined;
}) {
  return (
    <div data-android-pane-message="" className="ade-tool-picker-static flex size-full items-center justify-center px-6 py-10">
      <div className="ade-tool-card flex w-full min-w-0 max-w-sm flex-col items-center gap-2 p-6 text-center">
        <AndroidLogo size={28} aria-hidden="true" className="text-muted-fg/60" />
        <p className="min-w-0 break-words font-sans text-sm font-medium leading-5 text-fg">{title}</p>
        {description ? <p className="min-w-0 break-words font-sans text-xs leading-5 text-muted-fg">{description}</p> : null}
        {action ? (
          <Button variant="outline" size="sm" disabled={action.disabled} onClick={action.onClick} className="mt-1 shrink-0">
            {action.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export type AndroidLoadingStage = "booting" | "streaming";

/** A wait shorter than this needs no stopwatch. */
const ELAPSED_AFTER_MS = 5_000;
/** The first boot of a new AVD measured ~54 s (plan §9); past this the card says why. */
const SLOW_AFTER_MS = 20_000;

function useElapsedMs(): number {
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return elapsedMs;
}

/** Between pressing a device and seeing it: the Apple loading card's two steps. */
export function AndroidDeviceLoadingCard({
  name,
  spec,
  tablet,
  stage,
}: {
  name: string;
  spec: string | null;
  tablet: boolean;
  stage: AndroidLoadingStage;
}) {
  const Glyph = tablet ? DeviceTablet : DeviceMobile;
  const elapsedMs = useElapsedMs();
  const elapsedSeconds = elapsedMs >= ELAPSED_AFTER_MS ? Math.floor(elapsedMs / 1_000) : null;
  const slow = stage === "booting" && elapsedMs >= SLOW_AFTER_MS;
  return (
    <div
      role="status"
      data-android-loading-card={stage}
      className="ade-tool-picker-static relative flex size-full items-center justify-center px-6 py-10"
    >
      <div className="ade-tool-card flex w-full min-w-0 max-w-sm flex-col items-center gap-3 p-6 text-center">
        <Glyph size={44} aria-hidden="true" className="shrink-0 text-fg/70" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="min-w-0 break-words font-sans text-sm font-medium text-fg">{`Booting ${name}…`}</p>
          {spec ? <p className="min-w-0 break-words font-sans text-xs text-muted-fg">{spec}</p> : null}
        </div>
        <div className="flex min-w-0 items-center gap-2 font-sans text-xs text-muted-fg">
          <span aria-hidden="true" className="h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-fg/35 border-t-accent" />
          <span className="min-w-0 break-words">{stage === "booting" ? "Booting device" : "Connecting video"}</span>
          {elapsedSeconds != null ? (
            <span data-android-loading-elapsed="" className="shrink-0 tabular-nums text-muted-fg">{elapsedSeconds}s</span>
          ) : null}
        </div>
        {slow ? (
          <p data-android-loading-slow="" className="min-w-0 break-words font-sans text-xs leading-5 text-muted-fg">
            The first boot of a new device can take about a minute.
          </p>
        ) : null}
        <div className="flex w-24 gap-1" aria-label={stage === "booting" ? "Step 1 of 2: boot device" : "Step 2 of 2: connect video"}>
          <span className="h-1 min-w-0 flex-1 rounded-full bg-fg/60" />
          <span className={cn("h-1 min-w-0 flex-1 rounded-full", stage === "streaming" ? "bg-fg/60" : "bg-muted")} />
        </div>
      </div>
    </div>
  );
}

/**
 * The foot of the picture: `● Live · 58 fps · lane checkout-flow · windows`.
 * The machine is named only when the emulator runs on another one.
 */
export function AndroidLiveLine({
  state,
  fps,
  laneName,
  machineName,
}: {
  state: "live" | "connecting" | "lost" | "off";
  fps: number | null;
  laneName: string | null;
  machineName: string | null;
}) {
  const label = state === "live" ? "Live" : state === "connecting" ? "Connecting" : state === "lost" ? "Video stopped" : "Off";
  const parts = [
    label,
    state === "live" && fps != null && fps > 0 ? `${Math.round(fps)} fps` : null,
    laneName ? `lane ${laneName}` : null,
    machineName ? `on ${machineName}` : null,
  ].filter((part): part is string => Boolean(part));
  return (
    <div
      data-android-live-line={state}
      className="pointer-events-none absolute bottom-2 left-3 z-10 flex min-w-0 max-w-[calc(100%-5rem)] items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 font-sans text-[11px] leading-4 text-muted-fg shadow-sm"
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          state === "live" ? "bg-success" : state === "lost" ? "bg-[var(--color-error)]" : "bg-muted-fg/60",
        )}
      />
      <span className="min-w-0 truncate">{parts.join(" · ")}</span>
    </div>
  );
}
