import type { ComponentProps } from "react";
import { AndroidLogo, DeviceMobile } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { DeviceLoadingCard } from "../device/DeviceLoadingCard";
import { DeviceNoticeStrip } from "../device/DeviceStatusStrip";

/**
 * The Android pane's strips and cards: the shared top strip (one line, one
 * action) and loading card, the one-card messages, and the live line at the
 * foot of the picture (plan §5 "Status strip").
 */

/** A fact about the device, not a failure: "Pixel is off." with one action. */
export function AndroidDeviceNoticeStrip(props: Omit<ComponentProps<typeof DeviceNoticeStrip>, "tool" | "icon" | "busy">) {
  return <DeviceNoticeStrip tool="android" icon={<AndroidLogo size={13} />} {...props} />;
}

/** One card in the middle of the pane: unsupported host, loading, a stopped device. */
export function AndroidPaneMessage({
  title,
  description,
}: {
  title: string;
  description: string | null;
}) {
  return (
    <div data-android-pane-message="" className="ade-tool-picker-static flex size-full items-center justify-center px-6 py-10">
      <div className="ade-tool-card flex w-full min-w-0 max-w-sm flex-col items-center gap-2 p-6 text-center">
        <AndroidLogo size={28} aria-hidden="true" className="text-muted-fg/60" />
        <p className="min-w-0 break-words font-sans text-sm font-medium leading-5 text-fg">{title}</p>
        {description ? <p className="min-w-0 break-words font-sans text-xs leading-5 text-muted-fg">{description}</p> : null}
      </div>
    </div>
  );
}

type AndroidLoadingStage = "booting" | "streaming";

/** The first boot of a new AVD measured ~54 s (plan §9); past this the card says why. */
const SLOW_AFTER_MS = 20_000;

/** Between pressing a device and seeing it: the shared loading card's two steps. */
export function AndroidDeviceLoadingCard({
  name,
  spec,
  stage,
}: {
  name: string;
  spec: string | null;
  stage: AndroidLoadingStage;
}) {
  return (
    <DeviceLoadingCard
      tool="android"
      glyph={DeviceMobile}
      name={name}
      subtitle={spec}
      step={stage}
      dataState={stage}
      slowAfterMs={stage === "booting" ? SLOW_AFTER_MS : null}
      slowSentence="The first boot of a new device can take about a minute."
    />
  );
}

/**
 * The foot of the picture: `● Live · 58 fps · lane checkout-flow · windows`
 * (`idle` in place of the fps while the screen does not change).
 * The machine is named only when the emulator runs on another one.
 *
 * `reconnecting` is an open stream whose frames stopped arriving while the
 * link looks at fault: the picture is the last frame, not the device now. Its
 * dot is neutral, because nothing has failed yet.
 */
export function AndroidLiveLine({
  state,
  fps,
  laneName,
  machineName,
}: {
  state: "live" | "reconnecting" | "lost";
  fps: number | null;
  laneName: string | null;
  machineName: string | null;
}) {
  const label = state === "live" ? "Live" : state === "reconnecting" ? "Reconnecting…" : "Video stopped";
  const parts = [
    label,
    // scrcpy sends a frame only when the screen changes, so a still screen
    // reads 0 fps: say "idle" rather than drop the value.
    state === "live" && fps != null ? (fps > 0 ? `${Math.round(fps)} fps` : "idle") : null,
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
          state === "live" ? "bg-success" : state === "reconnecting" ? "bg-muted-fg/50" : "bg-[var(--color-error)]",
        )}
      />
      <span className="min-w-0 truncate">{parts.join(" · ")}</span>
    </div>
  );
}
