import React, { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import Lottie from "lottie-react";
import { useReducedMotion } from "./useReducedMotion";

export type TourIllustrationProps = {
  illustration:
    | { kind: "lottie"; src: string; loop?: boolean }
    | { kind: "svg"; src: string };
  height?: number;
};

export function TourIllustration({ illustration, height = 120 }: TourIllustrationProps): JSX.Element {
  const reduced = useReducedMotion();
  const initial = reduced ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 };
  const animate = { opacity: 1, y: 0 };
  const transition = reduced ? { duration: 0 } : { duration: 0.4, ease: "easeOut" as const };

  return (
    <motion.div
      initial={initial}
      animate={animate}
      transition={transition}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height,
        width: "100%",
      }}
    >
      {illustration.kind === "lottie" ? (
        <LottieInlineLoader src={illustration.src} loop={illustration.loop ?? true} height={height} />
      ) : (
        <img
          src={illustration.src}
          alt=""
          style={{ height, width: "auto", display: "block" }}
        />
      )}
    </motion.div>
  );
}

type LottieInlineLoaderProps = { src: string; loop: boolean; height: number };

function LottieInlineLoader({ src, loop, height }: LottieInlineLoaderProps): JSX.Element {
  const [data, setData] = useState<unknown | null>(null);
  const [error, setError] = useState<boolean>(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    setData(null);
    setError(false);
    let cancelled = false;
    fetch(src)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        if (cancelled) return;
        setData(json);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (data != null) {
    return (
      <Lottie
        animationData={data as object}
        loop={loop}
        style={{ height, width: "auto" }}
      />
    );
  }
  return (
    <div
      style={{
        height,
        width: height * 1.6,
        borderRadius: 8,
        background: "var(--color-surface-muted, rgba(255,255,255,0.04))",
        border: "1px solid var(--color-separator, rgba(255,255,255,0.08))",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-muted-fg)",
        fontSize: 12,
        fontFamily: "var(--font-sans)",
      }}
    >
      {error ? "Illustration unavailable" : "Loading..."}
    </div>
  );
}
