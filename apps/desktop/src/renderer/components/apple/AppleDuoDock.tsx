import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { DeviceMobile } from "@phosphor-icons/react";
import { APPLE_DEVICE_POSE_TARGETS, type AppleDeviceOrientation } from "../../../shared/types/iosSimulator";
import { appleOrientationIconDegrees, appleOrientationLabel } from "./appleDeviceState";
import { appleDuoPanelOrientation, appleOrientationFamily, type AppleDuoScreen } from "../../../shared/appleOrientation";
import { cn } from "../ui/cn";

/**
 * The iPhone Duo's own controls, docked under the device.
 *
 * A foldable is driven by two things at once, the hinge and how the phone is
 * held, and both decide what the screen shows; on the Duo they are used as
 * often as a tap, so they live in a band of their own under the device rather
 * than in the rail's menus. Two groups, read left to right:
 *
 * - **Hinge** (3D): a continuous slider that previews on drag and folds on
 *   release, with soft detents at Closed, Laptop and Open. **Screen** (flat,
 *   where there is no body to fold): Cover folds the phone shut, Inner
 *   unfolds it flat.
 * - **Orientation**: the four ways to hold the phone, each drawn as the
 *   SCREEN it gives, not the phone: the inner panel is mounted a quarter
 *   turn, so holding the phone upright runs it wide, and a phone-shaped icon
 *   there read backwards. The pressed one is how the simulator says the phone
 *   is held; the app on screen decides whether its picture follows.
 *
 * Every device without a hinge keeps the rail's orientation menu instead.
 */

const DETENTS = [
  { angle: APPLE_DEVICE_POSE_TARGETS.closed.angle, label: "Closed" },
  { angle: APPLE_DEVICE_POSE_TARGETS.laptop.angle, label: "Laptop" },
  { angle: APPLE_DEVICE_POSE_TARGETS.open.angle, label: "Open" },
] as const;
const DETENT_RANGE = 4;

/** Left to right, each a quarter turn of the phone clockwise from the one before. */
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
  /** `onDetent`: the release landed on Closed, Laptop or Open. */
  onCommit: (angle: number, onDetent: boolean) => void;
}) {
  const [value, setValue] = useState(Math.round(angle));
  const [dragging, setDragging] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  useEffect(() => {
    if (!dragging) setValue(Math.round(angle));
  }, [angle, dragging]);
  const releaseRef = useRef<(() => void) | null>(null);
  const commit = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
    setDragging(false);
    const angle = valueRef.current;
    onCommitRef.current(angle, DETENTS.some((detent) => detent.angle === angle));
  }, []);
  // The slider holds its own value only while the pointer is down. The
  // release is heard on the window, so one the input never sees (off the
  // window, a lost pointer) still ends the drag: a held value kept the slider
  // on Closed while the phone was open.
  const startDrag = () => {
    setDragging(true);
    if (releaseRef.current) return;
    const events = ["pointerup", "pointercancel", "blur"] as const;
    for (const name of events) window.addEventListener(name, commit);
    releaseRef.current = () => {
      for (const name of events) window.removeEventListener(name, commit);
    };
  };
  useEffect(() => () => releaseRef.current?.(), []);
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
          onPointerDown={startDrag}
          onChange={(event) => {
            const raw = Number(event.currentTarget.value);
            const next = dragging ? snapToDetent(raw) : raw;
            valueRef.current = next;
            setValue(next);
            onPreview(next);
          }}
          onKeyUp={(event) => {
            if (event.key.startsWith("Arrow") || ["Home", "End", "PageUp", "PageDown"].includes(event.key)) commit();
          }}
        />
        <div aria-hidden="true" className="kit-eyebrow pointer-events-none mt-0.5 hidden justify-between !text-[9px] !tracking-[0.08em] @[520px]:flex">
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
  onCommitAngle: (angle: number, onDetent: boolean) => void;
  onScreen: (screen: AppleDuoScreen) => void;
  onTurn: (orientation: AppleDeviceOrientation) => void;
}) {
  const where = screen ? `${screen} screen` : "screen";
  // Each hold, with the screen it gives; ordered by that screen, so the row
  // always starts at an upright tall screen.
  const turns = TURNS
    .map((orientation) => ({ orientation, panel: appleDuoPanelOrientation(orientation, screen === "inner") }))
    .sort((a, b) => TURNS.indexOf(a.panel) - TURNS.indexOf(b.panel));
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
      className="relative shrink-0 border-t border-[color:var(--kit-rule)] bg-[color:var(--kit-card-bg)] pr-14"
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
        <Group label="Orientation">
          <div className="kit-seg">
            {turns.map(({ orientation, panel }) => {
              const shape = appleOrientationFamily(panel) === "landscape" ? "Wide" : "Tall";
              const turnedOver = panel === "portrait-upside-down" || panel === "landscape-right";
              const label = `${shape} ${where}${turnedOver ? ", turned over" : ""} · phone held ${appleOrientationLabel(orientation).toLowerCase()}`;
              return (
                <button
                  key={orientation}
                  type="button"
                  aria-pressed={held === orientation}
                  aria-label={label}
                  title={label}
                  disabled={turnPending}
                  onClick={() => onTurn(orientation)}
                  className={cn("!px-1.5 disabled:opacity-50", turnPending && "cursor-progress")}
                >
                  <DeviceMobile
                    size={14}
                    style={{ transform: `rotate(${appleOrientationIconDegrees(panel)}deg)` }}
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
