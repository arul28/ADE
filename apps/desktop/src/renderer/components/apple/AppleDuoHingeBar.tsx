import { useEffect, useState } from "react";

/**
 * The iPhone Duo's hinge, under the device: the control you reach for most
 * on a foldable, so it lives on the stage rather than in a menu.
 *
 * Dragging previews the angle (the 3D body follows at once) and folds the
 * simulator when you let go; the simulator sweeps there itself. Soft detents
 * at Closed, Laptop and Open: a drag that lands within a few degrees settles
 * on the pose, as a real hinge clicks into place. Arrow keys stay exact.
 */
const DETENTS = [
  { angle: 0, label: "Closed" },
  { angle: 90, label: "Laptop" },
  { angle: 180, label: "Open" },
] as const;
const DETENT_RANGE = 4;

function snapToDetent(angle: number): number {
  return DETENTS.find((detent) => Math.abs(detent.angle - angle) <= DETENT_RANGE)?.angle ?? angle;
}

export function AppleDuoHingeBar({
  angle,
  reported,
  onPreview,
  onCommit,
}: {
  angle: number;
  /** What the simulator itself reports, beside ADE's own angle. */
  reported: { angle: number | null; panel: "cover" | "inner" | null } | null;
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
  const simulator = reported
    ? [reported.angle !== null ? `${Math.round(reported.angle)}°` : null, reported.panel].filter(Boolean).join(" · ")
    : "";
  return (
    <div
      data-apple-duo-hinge=""
      className="pointer-events-auto flex w-[min(420px,calc(100%-96px))] items-center gap-3 rounded-full border border-white/10 bg-black/45 px-4 py-2 shadow-lg backdrop-blur-md"
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <span className="shrink-0 font-sans text-[11px] font-medium text-white/70">Hinge</span>
      <div className="relative min-w-0 flex-1">
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
          onKeyUp={(event) => {
            if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") commit();
          }}
        />
        <div aria-hidden="true" className="pointer-events-none mt-0.5 flex justify-between font-sans text-[9px] uppercase tracking-[0.06em] text-white/40">
          {DETENTS.map((detent) => (
            <span key={detent.angle} className={value === detent.angle ? "text-white/80" : undefined}>{detent.label}</span>
          ))}
        </div>
      </div>
      <span className="w-10 shrink-0 text-right font-sans text-[12px] tabular-nums text-white/90">{`${value}°`}</span>
      {simulator ? (
        <span title="What the simulator reports" className="hidden shrink-0 font-sans text-[10px] tabular-nums text-white/45 sm:inline">
          {`sim ${simulator}`}
        </span>
      ) : null}
    </div>
  );
}
