import { useEffect, useState, type ReactNode } from "react";
import { DeviceMobile } from "@phosphor-icons/react";
import { APPLE_DEVICE_POSE_TARGETS, type AppleDeviceOrientation } from "../../../shared/types/iosSimulator";
import { appleOrientationIconDegrees, appleOrientationLabel } from "./appleDeviceState";
import { cn } from "../ui/cn";

/**
 * The iPhone Duo's own controls, docked under the device.
 *
 * A foldable is driven by two things at once, the hinge and how the phone is
 * held, and both decide what the screen shows; on the Duo they are used as
 * often as a tap, so they live in a band of their own beside the rail rather
 * than in its menus. Two groups, read left to right:
 *
 * - **Hinge** (3D): a continuous slider that previews on drag and folds on
 *   release, with soft detents at Closed, Laptop and Open. **Screen** (flat,
 *   where there is no body to fold): Cover folds the phone shut, Inner
 *   unfolds it flat.
 * - **Turn**: the four ways to hold the phone. The pressed one is how the
 *   simulator says it is held; the app on screen decides whether its picture
 *   follows.
 *
 * Every device without a hinge keeps the rail's orientation menu instead.
 */

export type AppleDuoScreen = "cover" | "inner";

const DETENTS = [
  { angle: APPLE_DEVICE_POSE_TARGETS.closed.angle, label: "Closed" },
  { angle: APPLE_DEVICE_POSE_TARGETS.laptop.angle, label: "Laptop" },
  { angle: APPLE_DEVICE_POSE_TARGETS.open.angle, label: "Open" },
] as const;
const DETENT_RANGE = 4;

/** Left to right, each icon a quarter turn clockwise from the one before. */
const TURNS: readonly AppleDeviceOrientation[] = ["portrait", "landscape-left", "portrait-upside-down", "landscape-right"];

function snapToDetent(angle: number): number {
  return DETENTS.find((detent) => Math.abs(detent.angle - angle) <= DETENT_RANGE)?.angle ?? angle;
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 items-center gap-2.5">
      <span aria-hidden="true" className="kit-eyebrow shrink-0">{label}</span>
      {children}
    </div>
  );
}

function HingeSlider({ angle, onPreview, onCommit }: {
  angle: number;
  onPreview: (angle: number) => void;
  onCommit: (angle: number) => void;
}) {
  const [value, setValue] = useState(Math.round(angle));
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setValue(Math.round(angle));
  }, [angle, dragging]);
  const commit = () => {
    setDragging(false);
    onCommit(value);
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div className="relative w-[clamp(120px,28cqw,260px)] min-w-0">
        <input
          type="range"
          min={0}
          max={180}
          step={1}
          value={value}
          aria-label="Hinge angle"
          aria-valuetext={`${value} degrees`}
          className="block w-full accent-accent"
          onPointerDown={() => setDragging(true)}
          onChange={(event) => {
            const raw = Number(event.currentTarget.value);
            const next = dragging ? snapToDetent(raw) : raw;
            setValue(next);
            onPreview(next);
          }}
          onPointerUp={commit}
          // A cancelled drag (the window lost the pointer) still lets go.
          onPointerCancel={commit}
          onKeyUp={(event) => {
            if (event.key.startsWith("Arrow") || ["Home", "End", "PageUp", "PageDown"].includes(event.key)) commit();
          }}
        />
        <div aria-hidden="true" className="pointer-events-none mt-0.5 hidden justify-between font-sans text-[9px] uppercase tracking-[0.06em] text-[var(--kit-text-3)] @[520px]:flex">
          {DETENTS.map((detent) => (
            <span key={detent.angle} className={value === detent.angle ? "text-fg" : undefined}>{detent.label}</span>
          ))}
        </div>
      </div>
      <span className="kit-num w-9 shrink-0 text-right text-[12px] text-fg">{`${value}°`}</span>
    </div>
  );
}

export function AppleDuoDock({
  mode,
  angle,
  screen,
  held,
  turnPending,
  reported,
  onPreviewAngle,
  onCommitAngle,
  onScreen,
  onTurn,
}: {
  mode: "flat" | "3d";
  /** ADE's hinge angle (the drawn body's). */
  angle: number;
  /** The live panel, as the simulator reports it. */
  screen: AppleDuoScreen | null;
  /** How the simulator says the phone is held; null when it has not said or lies flat. */
  held: AppleDeviceOrientation | null;
  turnPending: boolean;
  /** What the simulator reports, for the quiet readout on the right. */
  reported: { angle: number | null; wide: boolean | null } | null;
  onPreviewAngle: (angle: number) => void;
  onCommitAngle: (angle: number) => void;
  onScreen: (screen: AppleDuoScreen) => void;
  onTurn: (orientation: AppleDeviceOrientation) => void;
}) {
  const readout = reported
    ? [
      reported.angle !== null ? `${Math.round(reported.angle)}°` : null,
      screen ? `${screen} screen` : null,
      reported.wide === null ? null : reported.wide ? "wide" : "tall",
    ].filter(Boolean).join(" · ")
    : "";
  return (
    <div
      data-apple-duo-dock=""
      className="relative shrink-0 border-t border-[color:var(--kit-rule)] bg-[color:var(--kit-card-bg)] pr-14 backdrop-blur-md"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <div className="flex min-h-12 flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 py-2">
        {mode === "3d" ? (
          <Group label="Hinge">
            <HingeSlider angle={angle} onPreview={onPreviewAngle} onCommit={onCommitAngle} />
          </Group>
        ) : (
          <Group label="Screen">
            <div className="kit-seg" data-case="sentence">
              <button type="button" aria-pressed={screen === "cover"} title="Fold the phone shut and show the cover screen" onClick={() => onScreen("cover")}>
                Cover
              </button>
              <button type="button" aria-pressed={screen === "inner"} title="Unfold the phone flat and show the inner screen" onClick={() => onScreen("inner")}>
                Inner
              </button>
            </div>
          </Group>
        )}
        <span aria-hidden="true" className="hidden h-5 w-px bg-[color:var(--kit-rule)] @[520px]:block" />
        <Group label="Turn">
          <div className="kit-seg">
            {TURNS.map((orientation) => {
              const label = appleOrientationLabel(orientation);
              return (
                <button
                  key={orientation}
                  type="button"
                  aria-pressed={held === orientation}
                  aria-label={`Hold ${label.toLowerCase()}`}
                  title={`Hold ${label.toLowerCase()}`}
                  disabled={turnPending}
                  onClick={() => onTurn(orientation)}
                  className={cn("!px-1.5 disabled:opacity-50", turnPending && "cursor-progress")}
                >
                  <DeviceMobile
                    size={14}
                    style={{ transform: `rotate(${appleOrientationIconDegrees(orientation)}deg)` }}
                  />
                </button>
              );
            })}
          </div>
        </Group>
        {readout ? (
          <span title="What the simulator reports" className="kit-num hidden shrink-0 text-[10.5px] text-[var(--kit-text-3)] @[720px]:inline">
            {readout}
          </span>
        ) : null}
      </div>
    </div>
  );
}
