import React, { useEffect, useState } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "./useReducedMotion";

export type SpotlightProps = {
  rect: DOMRect | null;
  padding?: number;
  radius?: number;
  accent?: string;
  dim?: number;
};

function useViewport(): { w: number; h: number } {
  const [vp, setVp] = useState(() => ({
    w: typeof window !== "undefined" ? window.innerWidth : 0,
    h: typeof window !== "undefined" ? window.innerHeight : 0,
  }));
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return vp;
}

export function Spotlight({
  rect,
  padding = 6,
  radius = 8,
  accent = "var(--color-accent)",
  dim = 0.55,
}: SpotlightProps): JSX.Element | null {
  const reduced = useReducedMotion();
  const { w, h } = useViewport();
  if (!rect || w === 0 || h === 0) {
    if (!rect) {
      return (
        <div
          aria-hidden="true"
          style={{
            position: "fixed",
            inset: 0,
            background: `rgba(0,0,0,${dim})`,
            pointerEvents: "none",
            zIndex: 9998,
          }}
        />
      );
    }
  }

  const x = Math.max(0, rect.left - padding);
  const y = Math.max(0, rect.top - padding);
  const cw = Math.min(w - x, rect.width + padding * 2);
  const ch = Math.min(h - y, rect.height + padding * 2);

  const maskId = "ade-fx-spotlight-mask";

  return (
    <>
      <svg
        width={w}
        height={h}
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 9998,
        }}
        aria-hidden="true"
      >
        <defs>
          <mask id={maskId}>
            <rect width={w} height={h} fill="white" />
            <rect x={x} y={y} width={cw} height={ch} rx={radius} ry={radius} fill="black" />
          </mask>
        </defs>
        <rect width={w} height={h} fill={`rgba(0,0,0,${dim})`} mask={`url(#${maskId})`} />
      </svg>
      {/* Chromatic edge glow. */}
      <svg
        width={w}
        height={h}
        style={{
          position: "fixed",
          inset: 0,
          pointerEvents: "none",
          zIndex: 9998,
          filter: "blur(4px)",
        }}
        aria-hidden="true"
      >
        {reduced ? (
          <rect
            x={x}
            y={y}
            width={cw}
            height={ch}
            rx={radius}
            ry={radius}
            fill="none"
            stroke={accent}
            strokeOpacity={0.9}
            strokeWidth={2}
          />
        ) : (
          <motion.rect
            x={x}
            y={y}
            width={cw}
            height={ch}
            rx={radius}
            ry={radius}
            fill="none"
            stroke={accent}
            strokeOpacity={0.9}
            strokeWidth={2}
            initial={{ scale: 1 }}
            animate={{ scale: [1, 1.03, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            style={{ transformOrigin: `${x + cw / 2}px ${y + ch / 2}px`, transformBox: "fill-box" as const }}
          />
        )}
      </svg>
    </>
  );
}
