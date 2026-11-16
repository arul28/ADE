import React, { useEffect, useId, useMemo, useRef } from "react";
import type { CtoAvatarEyes, CtoAvatarLook, CtoAvatarState } from "../../../../shared/types/cto";
import { cn } from "../../ui/cn";
import { CTO_AVATAR_SHAPE_SPECS, type CtoAvatarShapeSpec } from "./ctoAvatarShapes";
import { ctoAvatarEyeColor, resolveCtoAvatarLook } from "./ctoAvatarLook";
import "./ctoAvatar.css";

export { deriveCtoAvatarState, useCtoAvatarState, CTO_AVATAR_BLIP_MS } from "./ctoAvatarState";
export type { CtoAvatarStateInput } from "./ctoAvatarState";

/**
 * The CTO, drawn as a small living character.
 *
 * A body (one of seven silhouettes) with a face. The default eyes are two
 * text carets that blink like a terminal cursor, because the CTO lives in a
 * dev tool. The state shows twice: in the eyes (typing dots while it writes,
 * `^ ^` when a turn lands, `x x` when one fails, closed arcs asleep) and in
 * motion. Long-lived states (idle, waiting, asleep) move in steps, which the
 * renderer's step clock drives for almost nothing; short-lived ones (working,
 * thinking, the 1.4 s blips) glide on the compositor. Everything animates
 * transform and opacity on HTML layers, pauses off screen and in a hidden
 * window, and holds still at 24 px and under or with reduced motion.
 */

export type CtoAvatarProps = {
  /** Null or absent draws the default look. */
  look?: CtoAvatarLook | null;
  state: CtoAvatarState;
  /** Width and height in px. */
  size: number;
  /**
   * static: a picture (the state still shows in the eyes).
   * lazy (default): still at idle, moves in every other state.
   * live: also blinks and glances around at idle.
   */
  motion?: "static" | "lazy" | "live";
  className?: string;
  /** Accessible label. Without it the avatar is decoration (aria-hidden). */
  title?: string;
};

/** At this size and under, motion would only read as jitter. */
export const CTO_AVATAR_STILL_MAX_SIZE = 24;
/** Under this size the ground shadow is noise. */
const SHADOW_MIN_SIZE = 40;

type EyeSet = "base" | "dots" | "happy" | "error" | "sleep";
const EYE_SETS: readonly EyeSet[] = ["base", "dots", "happy", "error", "sleep"];

function eyeSetFor(state: CtoAvatarState): EyeSet {
  switch (state) {
    case "thinking": return "dots";
    case "happy": return "happy";
    case "error": return "error";
    case "asleep": return "sleep";
    default: return "base";
  }
}

/* ── Pause while unseen ──
 * One observer and one visibility listener for every avatar on the page. The
 * flag is written straight to the element, so pausing never re-renders. */

const watched = new Map<Element, { visible: boolean }>();
let sharedObserver: IntersectionObserver | null = null;
let listeningForVisibility = false;

function applyPause(element: Element, visible: boolean) {
  const paused = !visible || document.visibilityState === "hidden";
  element.setAttribute("data-paused", paused ? "true" : "false");
}

function onVisibilityChange() {
  for (const [element, entry] of watched) applyPause(element, entry.visible);
}

function watchVisibility(element: Element): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  sharedObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const record = watched.get(entry.target);
      if (!record) continue;
      record.visible = entry.isIntersecting;
      applyPause(entry.target, record.visible);
    }
  });
  watched.set(element, { visible: true });
  sharedObserver.observe(element);
  if (!listeningForVisibility) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    listeningForVisibility = true;
  }
  applyPause(element, true);
  return () => {
    sharedObserver?.unobserve(element);
    watched.delete(element);
    element.removeAttribute("data-paused");
  };
}

/* ── Faces ── */

type Face = CtoAvatarShapeSpec["eyes"] & { ink: string; body: string };

function BaseEyes({ kind, face }: { kind: CtoAvatarEyes; face: Face }) {
  const { x, y, gap, scale: s, ink, body } = face;
  const eyesX = [x - gap / 2, x + gap / 2];
  switch (kind) {
    case "round": {
      // A catchlight makes round eyes look at you rather than through you.
      const glint = ink === "#FFFFFF" ? body : "#FFFFFF";
      return (
        <>
          {eyesX.map((cx) => (
            <g key={cx}>
              <ellipse cx={cx} cy={y} rx={4.8 * s} ry={6 * s} fill={ink} />
              <circle cx={cx + 1.6 * s} cy={y - 2.1 * s} r={1.5 * s} fill={glint} opacity={0.9} />
            </g>
          ))}
        </>
      );
    }
    case "visor": {
      const width = gap + 13 * s;
      const height = 7.6 * s;
      return <rect x={x - width / 2} y={y - height / 2} width={width} height={height} rx={height / 2} fill={ink} />;
    }
    case "pixel": {
      const cell = 4.2 * s;
      const step = cell + 1.1 * s;
      return (
        <>
          {eyesX.flatMap((cx) => [0, 1].flatMap((row) => [0, 1].map((col) => (
            <rect
              key={`${cx}-${row}-${col}`}
              x={cx - step / 2 - cell / 2 + col * step}
              y={y - step / 2 - cell / 2 + row * step}
              width={cell}
              height={cell}
              rx={0.6 * s}
              fill={ink}
            />
          ))))}
        </>
      );
    }
    case "caret":
    default: {
      const width = 5.6 * s;
      const height = 16 * s;
      return (
        <>
          {eyesX.map((cx) => (
            <rect key={cx} x={cx - width / 2} y={y - height / 2} width={width} height={height} rx={width / 2} fill={ink} />
          ))}
        </>
      );
    }
  }
}

function StrokeEyes({ set, face }: { set: "happy" | "error" | "sleep"; face: Face }) {
  const { x, y, gap, scale: s, ink } = face;
  const eyesX = [x - gap / 2, x + gap / 2];
  const d = eyesX.map((cx) => {
    if (set === "happy") return `M ${cx - 5 * s} ${y + 2.6 * s} L ${cx} ${y - 3 * s} L ${cx + 5 * s} ${y + 2.6 * s}`;
    if (set === "error") {
      const r = 4 * s;
      return `M ${cx - r} ${y - r} L ${cx + r} ${y + r} M ${cx + r} ${y - r} L ${cx - r} ${y + r}`;
    }
    return `M ${cx - 5 * s} ${y - 0.5 * s} Q ${cx} ${y + 4.5 * s} ${cx + 5 * s} ${y - 0.5 * s}`;
  }).join(" ");
  return (
    <path
      d={d}
      fill="none"
      stroke={ink}
      strokeWidth={(set === "sleep" ? 3 : 3.6) * s}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
}

/** Typing dots as HTML, so each one ripples on its own compositor layer. */
function TypingDots({ face }: { face: Face }) {
  const r = 3.3 * face.scale;
  const spread = 9.5 * face.scale;
  return (
    <>
      {[-spread, 0, spread].map((dx) => (
        <span
          key={dx}
          className="cto-av-dot"
          style={{ left: `${face.x + dx - r}%`, top: `${face.y - r}%`, width: `${r * 2}%`, height: `${r * 2}%` }}
        />
      ))}
    </>
  );
}

function EyeLayer({ set, kind, face, on }: { set: EyeSet; kind: CtoAvatarEyes; face: Face; on: boolean }) {
  return (
    <div className="cto-av-eyes" data-set={set} data-on={on ? "true" : "false"}>
      {set === "dots" ? (
        <TypingDots face={face} />
      ) : set === "base" ? (
        <div className="cto-av-blink">
          <svg viewBox="0 0 100 100" aria-hidden focusable="false">
            <BaseEyes kind={kind} face={face} />
          </svg>
        </div>
      ) : (
        <svg viewBox="0 0 100 100" aria-hidden focusable="false">
          <StrokeEyes set={set} face={face} />
        </svg>
      )}
    </div>
  );
}

export function CtoAvatar({ look, state, size, motion = "lazy", className, title }: CtoAvatarProps) {
  const resolved = useMemo(
    () => resolveCtoAvatarLook(look),
    // The look is a small value object; callers often rebuild it each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [look?.shape, look?.color, look?.eyes, look?.energy],
  );
  const spec = CTO_AVATAR_SHAPE_SPECS[resolved.shape];
  const ink = ctoAvatarEyeColor(resolved.color);
  const face: Face = { ...spec.eyes, ink, body: resolved.color };
  const animated = motion !== "static" && size > CTO_AVATAR_STILL_MAX_SIZE;
  const activeSet = eyeSetFor(state);
  const clipId = `cto-av-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = rootRef.current;
    if (!animated || !element) return undefined;
    return watchVisibility(element);
  }, [animated]);

  // A still avatar draws only the face it shows; a moving one keeps every
  // face mounted so a state change crossfades instead of popping.
  const sets = animated ? EYE_SETS : [activeSet];

  return (
    <div
      ref={rootRef}
      className={cn("cto-av", className)}
      data-state={state}
      data-eyes={resolved.eyes}
      data-energy={resolved.energy}
      data-anim={animated ? "on" : "off"}
      data-life={motion === "live" ? "on" : "off"}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
      style={{
        width: size,
        height: size,
        ["--cto-av-body" as string]: resolved.color,
        ["--cto-av-ink" as string]: ink,
        ["--cto-av-eye-y" as string]: `${spec.eyes.y}%`,
      }}
    >
      {size >= SHADOW_MIN_SIZE ? <div className="cto-av-shadow" /> : null}
      <div className="cto-av-body">
        {animated ? (
          <div className="cto-av-ring">
            <svg viewBox="0 0 100 100" aria-hidden focusable="false"><path d={spec.path} /></svg>
          </div>
        ) : null}
        <svg className="cto-av-shape" viewBox="0 0 100 100" aria-hidden focusable="false">
          <defs>
            <clipPath id={clipId}><path d={spec.path} /></clipPath>
          </defs>
          {spec.extras ? (
            <>
              <path d={spec.extras} fill={resolved.color} />
              <path d={spec.extras} fill="#000" opacity={0.2} />
            </>
          ) : null}
          <path d={spec.path} fill={resolved.color} />
          <g clipPath={`url(#${clipId})`}>
            <ellipse cx={62} cy={102} rx={54} ry={30} fill="#000" opacity={0.13} />
            <ellipse cx={34} cy={25} rx={19} ry={10} fill="#FFF" opacity={0.2} transform="rotate(-26 34 25)" />
          </g>
        </svg>
        <div className="cto-av-gaze">
          {sets.map((set) => (
            <EyeLayer key={set} set={set} kind={resolved.eyes} face={face} on={set === activeSet} />
          ))}
        </div>
        {animated ? <div className="cto-av-orbit"><span /></div> : null}
      </div>
      {animated ? <span className="cto-av-z" style={{ fontSize: Math.round(size * 0.2) }}>z</span> : null}
    </div>
  );
}
