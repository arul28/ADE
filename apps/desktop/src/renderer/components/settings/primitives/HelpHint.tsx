import React, { useId, useState } from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

/**
 * A "?" beside a title, with one short sentence behind it.
 *
 * Settings pages kept explaining themselves in a paragraph under the heading.
 * Two sentences of prose at the top of a page is the first thing the eye lands
 * on and the last thing anyone reads twice — and once a page has one, every
 * page grows one. The explanation still exists; it just waits to be asked for.
 *
 * Hover and focus both open it, so it is reachable without a mouse, and it
 * closes on Escape.
 */
export function HelpHint({ text, label = "What is this?" }: { text: string; label?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 15,
          height: 15,
          padding: 0,
          borderRadius: "50%",
          border: `1px solid ${COLORS.outlineBorder}`,
          background: "transparent",
          color: open ? COLORS.textPrimary : COLORS.textDim,
          fontFamily: SANS_FONT,
          fontSize: 9.5,
          fontWeight: 700,
          lineHeight: 1,
          cursor: "help",
        }}
      >
        ?
      </button>
      {open ? (
        <span
          id={id}
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: -4,
            zIndex: 40,
            width: 248,
            padding: "7px 9px",
            borderRadius: 8,
            border: `1px solid ${COLORS.outlineBorder}`,
            background: "var(--color-surface-raised, var(--color-card))",
            boxShadow: "0 8px 24px rgba(0,0,0,0.32)",
            fontFamily: SANS_FONT,
            fontSize: 11,
            lineHeight: 1.5,
            color: COLORS.textSecondary,
          }}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}
