import React from "react";

import { COLORS, RADII, SANS_FONT, outlineButton, primaryButton } from "../lanes/laneDesignTokens";
import { useAppStore, useRootAppStore } from "../../state/appStore";
import {
  previewPluginTheme,
  revertPluginThemePreview,
  sanitizePluginThemeTokens,
  type PluginThemeTokens,
} from "../../lib/pluginTheme";
import { RailSection } from "./marketplaceUi";

/**
 * Trying a theme on.
 *
 * A theme cannot be judged from a swatch strip — the question is what a full
 * screen of ADE looks like — so preview here is STICKY: pressing Preview paints
 * the whole app and leaves it painted while you go and look at Work, PRs, a
 * transcript. It ends two ways and only two ways: Escape puts the old palette
 * back, or Apply everywhere makes it the real one.
 *
 * That is a deliberate departure from the hover-preview in Appearance, which is
 * momentary and correct there — Appearance is a settings row you are already
 * looking at. Here the whole point is to leave the page.
 *
 * The floating pill is not decoration. A sticky preview with no persistent
 * marker is a mode you can forget you are in; the pill is what stops "why do my
 * colours look wrong" being a bug report.
 */

export function PluginThemePreview({
  pluginId,
  displayName,
  tokens,
  installed,
}: {
  pluginId: string;
  displayName: string;
  tokens: PluginThemeTokens;
  /** Applying is only meaningful for a theme that is installed and on. */
  installed: boolean;
}) {
  const baseTheme = useAppStore((state) => state.theme);
  const appliedThemeId = useRootAppStore((state) => state.pluginThemeId);
  const setPluginThemeId = useRootAppStore((state) => state.setPluginThemeId);
  const [previewing, setPreviewing] = React.useState(false);

  const sanitized = React.useMemo(() => sanitizePluginThemeTokens(tokens), [tokens]);
  const swatches = React.useMemo(() => {
    const set = sanitized.tokens[baseTheme === "light" ? "light" : "dark"] ?? {};
    return Object.entries(set).slice(0, 6);
  }, [baseTheme, sanitized.tokens]);

  const isApplied = appliedThemeId === pluginId;

  const stopPreview = React.useCallback(() => {
    revertPluginThemePreview();
    setPreviewing(false);
  }, []);

  // Escape ends the preview from anywhere in the app, which is the whole point
  // of a sticky preview — you are not expected to be on this page when you
  // decide against it. Capture phase so a focused input cannot swallow it.
  React.useEffect(() => {
    if (!previewing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      stopPreview();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [previewing, stopPreview]);

  // Leaving the page ends the preview. A theme that outlived the page that
  // started it would be indistinguishable from an applied theme, with no
  // control anywhere to undo it.
  React.useEffect(() => () => {
    revertPluginThemePreview();
  }, []);

  const startPreview = () => {
    previewPluginTheme({ pluginId, displayName, tokens: sanitized.tokens });
    setPreviewing(true);
  };

  const apply = () => {
    setPluginThemeId(pluginId);
    setPreviewing(false);
  };

  return (
    <RailSection title="Colours">
      <div style={{ display: "flex", gap: 4 }} aria-hidden>
        {swatches.map(([name, value]) => (
          <span
            key={name}
            title={name}
            style={{
              width: 24,
              height: 24,
              borderRadius: RADII.sm,
              background: value,
              border: `1px solid ${COLORS.borderMuted}`,
            }}
          />
        ))}
      </div>

      {sanitized.rejected.length > 0 ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim, lineHeight: 1.5 }}>
          {sanitized.rejected.length} of this theme’s values aren’t ADE palette colours and are ignored.
        </span>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={previewing ? stopPreview : startPreview}
          data-tour="plugin:marketplace.theme-preview"
          style={outlineButton({ height: 27, fontSize: 11.5 })}
        >
          {previewing ? "Stop preview" : "Preview"}
        </button>
        {installed && !isApplied ? (
          <button
            type="button"
            onClick={apply}
            data-tour="plugin:marketplace.theme-apply"
            style={primaryButton({ height: 27, fontSize: 11.5 })}
          >
            Apply everywhere
          </button>
        ) : null}
        {isApplied ? (
          <button
            type="button"
            onClick={() => setPluginThemeId(null)}
            style={outlineButton({ height: 27, fontSize: 11.5 })}
          >
            Use ADE’s own colours
          </button>
        ) : null}
      </div>

      {!installed ? (
        <span style={{ fontFamily: SANS_FONT, fontSize: 10.5, color: COLORS.textDim, lineHeight: 1.5 }}>
          Preview works before installing. Install the theme to keep it.
        </span>
      ) : null}

      {previewing ? (
        <PreviewPill
          displayName={displayName}
          canApply={installed && !isApplied}
          onApply={apply}
          onRevert={stopPreview}
        />
      ) : null}
    </RailSection>
  );
}

/**
 * The persistent marker for a running preview. Fixed to the viewport rather
 * than the rail so it survives scrolling away and navigating to another tab —
 * the two things a sticky preview is for.
 */
function PreviewPill({
  displayName,
  canApply,
  onApply,
  onRevert,
}: {
  displayName: string;
  canApply: boolean;
  onApply: () => void;
  onRevert: () => void;
}) {
  return (
    <div
      role="status"
      data-tour="plugin:marketplace.theme-pill"
      style={{
        position: "fixed",
        left: "50%",
        bottom: 20,
        transform: "translateX(-50%)",
        zIndex: 60,
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "7px 8px 7px 14px",
        background: "var(--color-card)",
        border: `1px solid ${COLORS.border}`,
        borderRadius: 999,
        boxShadow: "var(--shadow-panel)",
      }}
    >
      <span style={{ fontFamily: SANS_FONT, fontSize: 11.5, color: COLORS.textSecondary, whiteSpace: "nowrap" }}>
        Previewing {displayName} — Esc to revert
      </span>
      {canApply ? (
        <button type="button" onClick={onApply} style={primaryButton({ height: 24, padding: "0 10px", fontSize: 11 })}>
          Apply everywhere
        </button>
      ) : null}
      <button
        type="button"
        onClick={onRevert}
        style={{ ...outlineButton({ height: 24, padding: "0 10px", fontSize: 11 }), background: "transparent" }}
      >
        Revert
      </button>
    </div>
  );
}
