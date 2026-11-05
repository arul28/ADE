import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A foldable's hinge as a slider: it previews on drag (the 3D body folds
 * under the pointer) and folds the device on release, with soft detents at
 * the named angles. The Apple Duo dock and the Android fold dock use it.
 */

export type HingeDetent = { angle: number; label: string };

const DETENT_RANGE = 4;

function snapToDetent(detents: readonly HingeDetent[], angle: number): number {
  return detents.find((detent) => Math.abs(detent.angle - angle) <= DETENT_RANGE)?.angle ?? angle;
}

export function HingeSlider({ angle, detents, onPreview, onCommit }: {
  angle: number;
  /** The named angles a drag snaps to (within 4°), labelled under the track. */
  detents: readonly HingeDetent[];
  onPreview: (angle: number) => void;
  /** `onDetent`: the release landed on one of the detents. */
  onCommit: (angle: number, onDetent: boolean) => void;
}) {
  const [value, setValue] = useState(Math.round(angle));
  const [dragging, setDragging] = useState(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  const detentsRef = useRef(detents);
  detentsRef.current = detents;
  useEffect(() => {
    if (!dragging) setValue(Math.round(angle));
  }, [angle, dragging]);
  const releaseRef = useRef<(() => void) | null>(null);
  const commit = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
    setDragging(false);
    const angle = valueRef.current;
    onCommitRef.current(angle, detentsRef.current.some((detent) => detent.angle === angle));
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
            const next = dragging ? snapToDetent(detents, raw) : raw;
            valueRef.current = next;
            setValue(next);
            onPreview(next);
          }}
          onKeyUp={(event) => {
            if (event.key.startsWith("Arrow") || ["Home", "End", "PageUp", "PageDown"].includes(event.key)) commit();
          }}
        />
        <div aria-hidden="true" className="kit-eyebrow pointer-events-none mt-0.5 hidden justify-between !text-[9px] !tracking-[0.08em] @[520px]:flex">
          {detents.map((detent) => (
            <span key={detent.angle} className={value === detent.angle ? "text-fg" : undefined}>{detent.label}</span>
          ))}
        </div>
      </div>
      <span className="kit-num w-9 shrink-0 text-right text-[12px] text-fg">{`${value}°`}</span>
    </div>
  );
}
