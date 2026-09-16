import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CtoIdentity, CtoSystemPromptPreview, CtoSystemPromptPreviewSection } from "../../../shared/types";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";
import { CopyButton, ctoButtonStyle } from "./ctoSettingsUi";

/**
 * Everything the CTO is sent, shown as the document it is.
 *
 * It used to be a disclosure, inside a card, inside a pane — and once opened,
 * five more cards each with an uppercase label like "IMMUTABLE ADE DOCTRINE".
 * Four frames around text nobody could read. This is the text, full width,
 * with a contents list when there is enough of it to get lost in.
 */

const MONO = "var(--font-mono, ui-monospace, SFMono-Regular, monospace)";

/** The backend's ids, in words a person would use for them. */
const SECTION_TITLES: Record<CtoSystemPromptPreviewSection["id"], string> = {
  doctrine: "Doctrine",
  continuity: "Project state",
  memory: "Memory",
  knowledge: "Knowledge",
  capabilities: "Rules",
};

function sectionTitle(section: CtoSystemPromptPreviewSection): string {
  return SECTION_TITLES[section.id] ?? section.title;
}

export function CtoPromptPreview({
  identityOverride,
  accent = "#60A5FA",
}: {
  identityOverride?: Partial<CtoIdentity>;
  accent?: string;
} = {}) {
  const [preview, setPreview] = useState<CtoSystemPromptPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const firstSectionId = preview?.sections[0]?.id ?? null;
  const current = active ?? firstSectionId;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const overrideKey = useMemo(() => JSON.stringify(identityOverride ?? {}), [identityOverride]);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.ade?.cto;
    if (!bridge?.previewSystemPrompt) {
      setLoading(false);
      setError("The CTO isn't available. Reopen ADE to reconnect.");
      return () => { cancelled = true; };
    }
    setLoading(true);
    setError(null);
    void bridge.previewSystemPrompt({ identityOverride })
      .then((result) => { if (!cancelled) setPreview(result); })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Couldn't read the prompt.");
        setPreview(null);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- overrideKey serializes identityOverride
  }, [overrideKey]);

  const sections = preview?.sections ?? [];
  const showToc = sections.length > 3;

  const jumpTo = useCallback((id: string) => {
    setActive(id);
    bodyRef.current
      ?.querySelector(`[data-prompt-section="${id}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  if (loading) {
    return <p style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>Reading the prompt…</p>;
  }
  if (error) {
    return (
      <p role="alert" style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.danger }}>{error}</p>
    );
  }

  return (
    <div data-testid="cto-prompt-preview" style={{ minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          paddingBottom: 12,
          marginBottom: 16,
          borderBottom: `1px solid ${COLORS.borderMuted}`,
        }}
      >
        <span style={{ fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textMuted }}>
          {(preview?.tokenEstimate ?? 0).toLocaleString()} tokens, {sections.length} sections
        </span>
        <CopyButton value={preview?.prompt ?? ""} label="Copy prompt" />
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: showToc ? "minmax(0, 132px) minmax(0, 1fr)" : "minmax(0, 1fr)",
          gap: 20,
          alignItems: "start",
        }}
      >
        {showToc ? (
          <nav
            aria-label="Prompt sections"
            style={{
              position: "sticky",
              top: 0,
              display: "grid",
              gap: 2,
              paddingRight: 12,
              borderRight: `1px solid ${COLORS.borderMuted}`,
            }}
          >
            {sections.map((section) => {
              const selected = current === section.id;
              return (
                <button
                  key={section.id}
                  type="button"
                  onClick={() => jumpTo(section.id)}
                  style={{
                    ...ctoButtonStyle(),
                    justifyContent: "flex-start",
                    height: 26,
                    minWidth: 0,
                    background: selected ? `color-mix(in srgb, ${accent} 14%, transparent)` : "transparent",
                    border: "1px solid transparent",
                    color: selected ? COLORS.textPrimary : COLORS.textMuted,
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {sectionTitle(section)}
                  </span>
                </button>
              );
            })}
          </nav>
        ) : null}

        <div ref={bodyRef} style={{ display: "grid", gap: 20, minWidth: 0 }}>
          {sections.map((section) => (
            <section key={section.id} data-prompt-section={section.id} style={{ minWidth: 0, scrollMarginTop: 8 }}>
              <h3
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  margin: "0 0 8px",
                  fontFamily: SANS_FONT,
                  fontSize: 12.5,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  color: COLORS.textPrimary,
                }}
              >
                <span aria-hidden style={{ width: 6, height: 6, borderRadius: 3, background: accent }} />
                {sectionTitle(section)}
              </h3>
              <pre
                style={{
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: MONO,
                  fontSize: 11.5,
                  lineHeight: 1.75,
                  color: COLORS.textSecondary,
                }}
              >
                {section.content}
              </pre>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
