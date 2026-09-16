import React from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { settingsScopeForAnchor, type SettingScope } from "../settingsManifest";
import { ScopeChip } from "./ScopeChip";

/**
 * The chrome every settings surface shares: the anchored `<section>`, the
 * title, the scope chip read off the manifest, and the description beneath.
 *
 * All three page templates — the card, the manager, the dashboard — had a
 * verbatim copy of it. Three copies of "the chip comes from the manifest" is
 * three chances for one of them to start hand-passing a scope again, which is
 * the exact bug the manifest exists to close. This is internal to `primitives`:
 * a section file picks one of the three templates, never the shell.
 */
export function SettingsPageShell({
  anchor,
  title,
  description,
  scope,
  showScopeChip,
  remoteMachineName,
  sectionAttrs,
  sectionStyle,
  headerAlign = "center",
  headerStacked = false,
  headerWrap = false,
  aside,
  bodyStyle,
  children,
}: {
  anchor: string;
  title: string;
  description?: React.ReactNode;
  /**
   * Overrides the manifest. Only for an anchor that is deliberately not a
   * manifest entry; a registered setting must never disagree with the registry.
   */
  scope?: SettingScope;
  /** Forces the chip off. Undefined means "show it whenever a scope is known". */
  showScopeChip?: boolean;
  remoteMachineName?: string | null;
  /** Extra data-* attributes for the `<section>`, e.g. `data-settings-manager`. */
  sectionAttrs?: Record<string, string>;
  /** Merged over the shared section styling. */
  sectionStyle?: React.CSSProperties;
  headerAlign?: "center" | "flex-start";
  /** Stacks the aside below the title block instead of beside it. */
  headerStacked?: boolean;
  headerWrap?: boolean;
  /** Rendered opposite the title — a control, a toolbar. Callers wrap it. */
  aside?: React.ReactNode;
  /** Applied to the wrapper around `children`; omitted when there are none. */
  bodyStyle?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  // The manifest is the source; an explicit `scope` is only for anchors that
  // are not registered settings at all.
  const resolvedScope = scope ?? settingsScopeForAnchor(anchor);
  return (
    <section
      id={anchor}
      data-settings-anchor={anchor}
      {...sectionAttrs}
      style={{
        scrollMarginTop: 16,
        padding: 16,
        background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 12,
        ...sectionStyle,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: headerStacked ? "flex-start" : headerAlign,
          justifyContent: "space-between",
          gap: 16,
          flexDirection: headerStacked ? "column" : "row",
          flexWrap: headerWrap ? "wrap" : "nowrap",
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <h3
              style={{
                margin: 0,
                fontFamily: SANS_FONT,
                fontSize: 13,
                fontWeight: 600,
                color: COLORS.textPrimary,
                letterSpacing: "-0.01em",
              }}
            >
              {title}
            </h3>
            {resolvedScope && showScopeChip !== false ? (
              <ScopeChip scope={resolvedScope} remoteMachineName={remoteMachineName} />
            ) : null}
          </div>
          {description ? (
            <p
              style={{
                margin: "4px 0 0",
                fontFamily: SANS_FONT,
                fontSize: 11,
                lineHeight: 1.55,
                color: COLORS.textMuted,
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
        {aside ?? null}
      </div>
      {children ? <div style={bodyStyle}>{children}</div> : null}
    </section>
  );
}
