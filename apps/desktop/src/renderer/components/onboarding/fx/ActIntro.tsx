import React, { useCallback, useEffect, useRef } from "react";
import { AnimatedField } from "./AnimatedField";
import { StaggeredText } from "./StaggeredText";
import { useReducedMotion } from "./useReducedMotion";

export type ActIntroProps = {
  title: string;
  subtitle?: string;
  variant: "orbit" | "drift" | "particles";
  durationMs?: number;
  onComplete?: () => void;
  onSkip?: () => void;
};

export function ActIntro({
  title,
  subtitle,
  variant,
  durationMs = 3000,
  onComplete,
  onSkip,
}: ActIntroProps): JSX.Element {
  const reduced = useReducedMotion();
  const onCompleteRef = useRef(onComplete);
  const onSkipRef = useRef(onSkip);
  onCompleteRef.current = onComplete;
  onSkipRef.current = onSkip;

  // Auto-advance (or instant complete under reduced motion).
  useEffect(() => {
    if (reduced) {
      onCompleteRef.current?.();
      return;
    }
    const id = window.setTimeout(() => {
      onCompleteRef.current?.();
    }, durationMs);
    return () => window.clearTimeout(id);
  }, [durationMs, reduced]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onSkipRef.current?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleClick = useCallback(() => {
    onSkipRef.current?.();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={handleClick}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "rgba(0, 0, 0, 0.85)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px",
        overflow: "hidden",
        fontFamily: "var(--font-sans)",
        cursor: "pointer",
      }}
    >
      <AnimatedField variant={variant} />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          textAlign: "center",
          maxWidth: "880px",
          pointerEvents: "none",
        }}
      >
        <StaggeredText
          text={title}
          mode="word"
          as="h1"
          style={{
            fontSize: "60px",
            lineHeight: 1.05,
            fontWeight: 600,
            letterSpacing: "-0.02em",
            color: "var(--color-fg)",
            margin: 0,
          }}
        />
        {subtitle ? (
          <p
            style={{
              marginTop: "20px",
              fontSize: "18px",
              lineHeight: 1.5,
              color: "var(--color-muted-fg)",
            }}
          >
            {subtitle}
          </p>
        ) : null}
      </div>
      <div
        style={{
          position: "absolute",
          bottom: "32px",
          left: 0,
          right: 0,
          textAlign: "center",
          fontSize: "12px",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--color-muted-fg)",
          pointerEvents: "none",
          zIndex: 1,
        }}
      >
        Press Esc or click to continue
      </div>
    </div>
  );
}
