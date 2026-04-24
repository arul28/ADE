import React, { useMemo } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "./useReducedMotion";

export type AnimatedFieldProps = {
  variant: "orbit" | "drift" | "particles";
  accent?: string;
  opacity?: number;
  className?: string;
};

const DEFAULT_ACCENT = "var(--color-accent)";

export function AnimatedField({
  variant,
  accent = DEFAULT_ACCENT,
  opacity = 0.35,
  className,
}: AnimatedFieldProps): JSX.Element {
  const reduced = useReducedMotion();
  return (
    <svg
      className={className}
      viewBox="0 0 800 600"
      preserveAspectRatio="xMidYMid slice"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        opacity,
      }}
      aria-hidden="true"
    >
      {variant === "orbit" ? <OrbitVariant accent={accent} reduced={reduced} /> : null}
      {variant === "drift" ? <DriftVariant accent={accent} reduced={reduced} /> : null}
      {variant === "particles" ? <ParticlesVariant accent={accent} reduced={reduced} /> : null}
    </svg>
  );
}

type VariantProps = { accent: string; reduced: boolean };

function OrbitVariant({ accent, reduced }: VariantProps): JSX.Element {
  const rings = [
    { rx: 90, ry: 50, dur: 16 },
    { rx: 150, ry: 85, dur: 22 },
    { rx: 210, ry: 120, dur: 30 },
    { rx: 270, ry: 155, dur: 38 },
    { rx: 330, ry: 190, dur: 48 },
    { rx: 390, ry: 225, dur: 60 },
  ];
  return (
    <g transform="translate(400 300)">
      {rings.map((r, i) =>
        reduced ? (
          <ellipse
            key={i}
            rx={r.rx}
            ry={r.ry}
            fill="none"
            stroke={accent}
            strokeOpacity={0.3 - i * 0.03}
            strokeWidth={1}
          />
        ) : (
          <motion.g
            key={i}
            animate={{ rotate: i % 2 === 0 ? 360 : -360 }}
            transition={{ duration: r.dur, repeat: Infinity, ease: "linear" }}
          >
            <ellipse
              rx={r.rx}
              ry={r.ry}
              fill="none"
              stroke={accent}
              strokeOpacity={0.3 - i * 0.03}
              strokeWidth={1}
            />
          </motion.g>
        ),
      )}
    </g>
  );
}

function DriftVariant({ accent, reduced }: VariantProps): JSX.Element {
  const blobs = [
    { cx: 200, cy: 180, r: 180, id: "g0", dx: 30, dy: 20, dur: 12 },
    { cx: 600, cy: 200, r: 220, id: "g1", dx: -28, dy: 30, dur: 15 },
    { cx: 250, cy: 440, r: 200, id: "g2", dx: 26, dy: -22, dur: 18 },
    { cx: 620, cy: 460, r: 240, id: "g3", dx: -32, dy: -26, dur: 20 },
  ];
  return (
    <>
      <defs>
        {blobs.map((b) => (
          <radialGradient key={b.id} id={b.id}>
            <stop offset="0%" stopColor={accent} stopOpacity={0.9} />
            <stop offset="100%" stopColor={accent} stopOpacity={0} />
          </radialGradient>
        ))}
      </defs>
      {blobs.map((b, i) =>
        reduced ? (
          <circle key={i} cx={b.cx} cy={b.cy} r={b.r} fill={`url(#${b.id})`} />
        ) : (
          <motion.circle
            key={i}
            cx={b.cx}
            cy={b.cy}
            r={b.r}
            fill={`url(#${b.id})`}
            animate={{
              x: [0, b.dx, 0, -b.dx, 0],
              y: [0, b.dy, 0, -b.dy, 0],
            }}
            transition={{ duration: b.dur, repeat: Infinity, ease: "easeInOut" }}
          />
        ),
      )}
    </>
  );
}

function ParticlesVariant({ accent, reduced }: VariantProps): JSX.Element {
  const particles = useMemo(() => {
    // Deterministic pseudo-random sequence so HMR/SSR is stable.
    const list: { cx: number; cy: number; r: number; delay: number; dur: number; dx: number; dy: number }[] = [];
    let seed = 1;
    const rand = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    for (let i = 0; i < 40; i += 1) {
      list.push({
        cx: rand() * 800,
        cy: rand() * 600,
        r: 1 + rand() * 1.8,
        delay: rand() * 3,
        dur: 2 + rand() * 3,
        dx: (rand() - 0.5) * 20,
        dy: (rand() - 0.5) * 20,
      });
    }
    return list;
  }, []);
  return (
    <>
      {particles.map((p, i) =>
        reduced ? (
          <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={accent} fillOpacity={0.6} />
        ) : (
          <motion.circle
            key={i}
            cx={p.cx}
            cy={p.cy}
            r={p.r}
            fill={accent}
            animate={{
              opacity: [0.15, 0.9, 0.15],
              x: [0, p.dx, 0],
              y: [0, p.dy, 0],
            }}
            transition={{
              duration: p.dur,
              repeat: Infinity,
              ease: "easeInOut",
              delay: p.delay,
            }}
          />
        ),
      )}
    </>
  );
}
