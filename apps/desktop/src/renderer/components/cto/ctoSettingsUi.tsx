import React, { useCallback, useState } from "react";
import { CaretRight, Check, Copy } from "@phosphor-icons/react";

import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

/**
 * The CTO settings' visual vocabulary, borrowed wholesale from the main
 * Settings pages.
 *
 * Everything here is the same 42px accent tile, the same card and the same type
 * ramp Settings uses — two surfaces sitting side by side in one app must not
 * read as two products. `SettingsSectionShell` is imported directly rather than
 * copied, and what is not shareable (a card that is not a settings row, a block
 * of prompt text) is built here to match it.
 */

/** One accent per section, the way each Settings section has a brand colour. */
export const CTO_SECTION_COLORS = {
  identity: "#22D3EE",
  model: "#A78BFA",
  voice: "#F59E0B",
  memory: "#34D399",
  prompt: "#60A5FA",
  history: "#FB7185",
} as const;

export type CtoSectionKey = keyof typeof CTO_SECTION_COLORS;

/**
 * A card, matching `SettingsCard`'s treatment without its settings-row
 * assumptions (anchor, scope chip, control on the right).
 */
export function CtoCard({
  title,
  description,
  right,
  accent,
  padded = true,
  testId,
  children,
}: {
  title?: string;
  description?: React.ReactNode;
  right?: React.ReactNode;
  /** Tints the title dot; omitted, the card has no dot. */
  accent?: string;
  padded?: boolean;
  testId?: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      style={{
        background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 12,
        padding: padded ? 16 : 0,
        minWidth: 0,
      }}
    >
      {title || right ? (
        <header
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            marginBottom: children ? 12 : 0,
            padding: padded ? 0 : "14px 16px 0",
          }}
        >
          <div style={{ minWidth: 0 }}>
            {title ? (
              <h3
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  margin: 0,
                  fontFamily: SANS_FONT,
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  color: COLORS.textPrimary,
                }}
              >
                {accent ? (
                  <span
                    aria-hidden
                    style={{ width: 6, height: 6, borderRadius: 3, background: accent, flexShrink: 0 }}
                  />
                ) : null}
                {title}
              </h3>
            ) : null}
            {description ? (
              <p
                style={{
                  margin: "5px 0 0",
                  fontFamily: SANS_FONT,
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  color: COLORS.textMuted,
                }}
              >
                {description}
              </p>
            ) : null}
          </div>
          {right ? <div style={{ flexShrink: 0 }}>{right}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** The button shape used for every action on these panes. */
export const ctoButtonStyle = (variant: "primary" | "quiet" = "quiet"): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 28,
  padding: "0 10px",
  borderRadius: 8,
  fontFamily: SANS_FONT,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
  color: variant === "primary" ? "#0B0910" : COLORS.textSecondary,
  background: variant === "primary" ? COLORS.accent : COLORS.recessedBg,
  border: `1px solid ${variant === "primary" ? "transparent" : COLORS.outlineBorder}`,
  transition: "background 140ms ease, color 140ms ease",
});

/** Copy to clipboard, and say so for a moment. */
export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [value]);
  return (
    <button type="button" onClick={onCopy} style={ctoButtonStyle()} aria-label={label}>
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
      {copied ? "Copied" : label}
    </button>
  );
}

/**
 * A read-only block of text that cannot grow past a screenful.
 *
 * The memory and prompt panes both print whole files, and a file printed in
 * full is how a pane becomes a wall.
 */
export function TextBlock({
  text,
  collapsedHeight = 190,
  mono = true,
}: {
  text: string;
  collapsedHeight?: number;
  mono?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  // Roughly: taller than the cap, so there is something to expand into.
  const expandable = text.length > 600 || text.split("\n").length > 10;
  return (
    <div style={{ minWidth: 0 }}>
      <pre
        style={{
          margin: 0,
          maxHeight: expanded || !expandable ? undefined : collapsedHeight,
          overflow: expanded || !expandable ? "visible" : "hidden",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.borderMuted}`,
          borderRadius: 10,
          padding: 12,
          fontFamily: mono ? "var(--font-mono, ui-monospace, SFMono-Regular, monospace)" : SANS_FONT,
          fontSize: 11.5,
          lineHeight: 1.7,
          color: COLORS.textSecondary,
          maskImage:
            expanded || !expandable
              ? undefined
              : "linear-gradient(to bottom, #000 calc(100% - 40px), transparent 100%)",
        }}
      >
        {text}
      </pre>
      {expandable ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{ ...ctoButtonStyle(), marginTop: 8, height: 26 }}
          aria-expanded={expanded}
        >
          <CaretRight
            size={11}
            weight="bold"
            style={{ transform: expanded ? "rotate(-90deg)" : "rotate(90deg)", transition: "transform 140ms ease" }}
          />
          {expanded ? "Show less" : "Show all"}
        </button>
      ) : null}
    </div>
  );
}

/** A quiet key/value line, for facts that are read rather than set. */
export function FactRow({
  label,
  value,
  mono = false,
  title,
}: {
  label: string;
  value: React.ReactNode;
  /** A path or an id, which has to line up character by character. */
  mono?: boolean;
  /** The untruncated value, for the row whose value is ellipsised. */
  title?: string;
}) {
  return (
    <>
      <dt style={{ fontFamily: SANS_FONT, fontSize: 11.5, lineHeight: 1.6, color: COLORS.textMuted }}>
        {label}
      </dt>
      <dd
        title={title}
        style={{
          margin: 0,
          minWidth: 0,
          fontFamily: mono ? "var(--font-mono, ui-monospace, SFMono-Regular, monospace)" : SANS_FONT,
          fontSize: mono ? 11 : 11.5,
          lineHeight: 1.6,
          color: COLORS.textSecondary,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {value}
      </dd>
    </>
  );
}
