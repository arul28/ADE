/**
 * The pieces both sign-in sheets show while a CLI's own login runs: the
 * account sheet (Claude Code, Codex) and the agent CLI sheet (Grok, Devin,
 * Muse, Copilot, Droid, Kimi). Each sheet owns its own flow and words; these
 * only draw them.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowSquareOut, CaretRight, Check, Copy } from "@phosphor-icons/react";
import { COLORS, MONO_FONT, SANS_FONT, outlineButton } from "../../lanes/laneDesignTokens";
import { ProviderLogo } from "../../shared/ProviderLogos";

/** The sign-in link's host ("claude.ai"), or null when there is no usable link. */
export function linkHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The card in the middle of a running sign-in: the provider's logo, what to
 * do now, the device code to check, and the sign-in link to open or copy.
 * Pass a null `deviceCode` or `url` to hide it (once the CLI is verifying).
 */
export function SignInProgressCard({
  logoFamily,
  headline,
  detail,
  deviceCode,
  url,
}: {
  logoFamily: string;
  headline: React.ReactNode;
  detail: React.ReactNode;
  deviceCode: string | null;
  url: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const copyLink = useCallback(() => {
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(() => {
      if (!aliveRef.current) return;
      setCopied(true);
      window.setTimeout(() => {
        if (aliveRef.current) setCopied(false);
      }, 1_500);
    }).catch(() => undefined);
  }, [url]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        padding: "22px 20px 18px",
        borderRadius: 12,
        border: `1px solid ${COLORS.borderMuted}`,
        background: COLORS.recessedBg,
        textAlign: "center",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 44,
          height: 44,
          borderRadius: 12,
          background: COLORS.cardBg,
          border: `1px solid ${COLORS.outlineBorder}`,
        }}
      >
        <ProviderLogo family={logoFamily} size={22} />
      </span>
      <span style={{ fontSize: 14, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>{headline}</span>
      <span style={{ maxWidth: 400, fontSize: 12, lineHeight: 1.5, fontFamily: SANS_FONT, color: COLORS.textMuted }}>{detail}</span>
      {deviceCode ? (
        <span
          aria-label="One-time sign-in code"
          style={{
            padding: "6px 14px",
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: "0.08em",
            fontFamily: MONO_FONT,
            color: COLORS.textPrimary,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.outlineBorder}`,
            borderRadius: 8,
            userSelect: "all",
          }}
        >
          {deviceCode}
        </span>
      ) : null}
      {url ? (
        <span style={{ display: "inline-flex", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            onClick={() => void window.ade?.app?.openExternal?.(url)}
            style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}
          >
            <ArrowSquareOut size={13} /> Open sign-in page
          </button>
          <button type="button" onClick={copyLink} style={outlineButton({ height: 28, padding: "0 12px", fontSize: 12 })}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy link"}
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** The CLI's own words, for when the friendly view is not enough. Closed by default. */
export function OutputDisclosure({ output, open, onToggle }: { output: string; open: boolean; onToggle: () => void }) {
  if (!output.trim()) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          alignSelf: "flex-start",
          padding: 0,
          border: "none",
          background: "transparent",
          fontSize: 11,
          fontFamily: SANS_FONT,
          color: COLORS.textDim,
          cursor: "pointer",
        }}
      >
        <CaretRight size={10} style={{ transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms ease" }} />
        Sign-in output
      </button>
      {open ? (
        <pre
          style={{
            margin: 0,
            maxHeight: 140,
            overflow: "auto",
            padding: "8px 10px",
            borderRadius: 8,
            border: `1px solid ${COLORS.borderMuted}`,
            background: COLORS.recessedBg,
            fontSize: 11,
            lineHeight: 1.5,
            fontFamily: MONO_FONT,
            color: COLORS.textSecondary,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {output.trim()}
        </pre>
      ) : null}
    </div>
  );
}
