import React from "react";
import { COLORS, SANS_FONT, cardStyle } from "./shellTokens";

/**
 * Full-viewport centered surface for the pre-app screens (welcome, pairing,
 * machine + project pickers). Premium-minimal: a single soft accent glow behind
 * a glass card, matching ADE's onboarding/startup feel.
 */
export function ScreenShell({
  title,
  subtitle,
  children,
  footer,
  width = 460,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--color-bg)",
        overflow: "auto",
      }}
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: "40%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "48vw",
          maxWidth: 520,
          height: "48vw",
          maxHeight: 520,
          borderRadius: "50%",
          background: "var(--color-accent)",
          opacity: 0.12,
          filter: "blur(120px)",
          pointerEvents: "none",
        }}
      />
      <div style={{ position: "relative", width: "100%", maxWidth: width, display: "grid", gap: 18 }}>
        <div style={{ display: "grid", gap: 6, justifyItems: "start" }}>
          <Wordmark />
          <h1 style={{ margin: 0, color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em" }}>
            {title}
          </h1>
          {subtitle ? (
            <p style={{ margin: 0, color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 14, lineHeight: 1.55 }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {children ? <div style={cardStyle({ display: "grid", gap: 16 })}>{children}</div> : null}
        {footer ? <div style={{ justifySelf: "start" }}>{footer}</div> : null}
      </div>
    </div>
  );
}

function Wordmark() {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        color: COLORS.textPrimary,
        fontFamily: SANS_FONT,
        fontSize: 13,
        fontWeight: 700,
        letterSpacing: "0.14em",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: "var(--color-accent)",
          boxShadow: "0 0 12px color-mix(in srgb, var(--color-accent) 60%, transparent)",
        }}
      />
      ADE
    </div>
  );
}
