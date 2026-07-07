import React from "react";
import { COLORS, SANS_FONT, cardStyle } from "./shellTokens";

/**
 * Full-viewport surface for the pre-app screens (welcome, pairing, machine +
 * project pickers). The ADE logo is pinned to the page's top-left; a soft accent
 * glow sits behind a centered glass card, matching ADE's onboarding feel.
 */
export function ScreenShell({
  title,
  subtitle,
  children,
  footer,
  width = 560,
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
      {/* Page logo, pinned top-left. */}
      <img
        src="/logo.png"
        alt="ADE"
        draggable={false}
        style={{ position: "fixed", top: 24, left: 28, height: 38, width: "auto", objectFit: "contain", pointerEvents: "none" }}
      />

      <div
        aria-hidden
        style={{
          position: "absolute",
          top: "42%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: "60vw",
          maxWidth: 720,
          height: "60vw",
          maxHeight: 720,
          borderRadius: "50%",
          background: "var(--color-accent)",
          opacity: 0.12,
          filter: "blur(140px)",
          pointerEvents: "none",
        }}
      />
      <div style={{ position: "relative", width: "100%", maxWidth: width, display: "grid", gap: 22 }}>
        <div style={{ display: "grid", gap: 8, justifyItems: "start" }}>
          <h1 style={{ margin: 0, color: COLORS.textPrimary, fontFamily: SANS_FONT, fontSize: 30, fontWeight: 700, letterSpacing: "-0.02em" }}>
            {title}
          </h1>
          {subtitle ? (
            <p style={{ margin: 0, color: COLORS.textSecondary, fontFamily: SANS_FONT, fontSize: 15, lineHeight: 1.6 }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {children ? <div style={cardStyle({ display: "grid", gap: 18, padding: 22 })}>{children}</div> : null}
        {footer ? <div style={{ justifySelf: "start" }}>{footer}</div> : null}
      </div>
    </div>
  );
}
