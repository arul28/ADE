import React, { useCallback, useEffect, useRef, useState } from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import type { SettingScope } from "../settingsManifest";
import { ScopeChip } from "./ScopeChip";

/**
 * One setting, one card. The card owns its anchor id, so a Cmd-K result or a
 * deeplink of the form `?tab=<tab>#<anchor>` lands exactly here.
 */
export function SettingsCard({
  anchor,
  title,
  description,
  control,
  scope,
  showScopeChip = false,
  remoteMachineName,
  children,
  /** Renders the control below the description instead of to its right. */
  stacked = false,
  disabled = false,
}: {
  anchor: string;
  title: string;
  description?: React.ReactNode;
  control?: React.ReactNode;
  scope?: SettingScope;
  showScopeChip?: boolean;
  remoteMachineName?: string | null;
  children?: React.ReactNode;
  stacked?: boolean;
  disabled?: boolean;
}) {
  return (
    <section
      id={anchor}
      data-settings-anchor={anchor}
      style={{
        scrollMarginTop: 16,
        padding: 16,
        background: "color-mix(in srgb, var(--color-card) 90%, var(--color-bg) 10%)",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: 12,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: stacked ? "flex-start" : "center",
          justifyContent: "space-between",
          gap: 16,
          flexDirection: stacked ? "column" : "row",
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
            {scope && showScopeChip ? (
              <ScopeChip scope={scope} remoteMachineName={remoteMachineName} />
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
        {control ? <div style={{ flexShrink: 0 }}>{control}</div> : null}
      </div>
      {children ? <div style={{ marginTop: 14 }}>{children}</div> : null}
    </section>
  );
}

/** A titled band of related cards within a tab. */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    // `data-settings-group` lets the settings page hide a heading whose cards
    // were all filtered out by search, instead of leaving it stranded.
    <div data-settings-group={title} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <h2
          style={{
            margin: 0,
            fontFamily: SANS_FONT,
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: COLORS.textMuted,
          }}
        >
          {title}
        </h2>
        {description ? (
          <p style={{ margin: "4px 0 0", fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}>
            {description}
          </p>
        ) : null}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{children}</div>
    </div>
  );
}

/**
 * Replaces the Save buttons. Settings persist on change; this is the receipt.
 * Call `flash()` after a successful write — it shows "Saved" briefly, then
 * fades. Errors stay until the next successful save, since a silently failed
 * write is the one case where instant-save is worse than a Save button.
 */
export function useSavedFlash(holdMs = 1600) {
  const [state, setState] = useState<{ kind: "idle" | "saved" | "error"; message?: string }>({ kind: "idle" });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // `flash` and `fail` must be stable: callers put them in effect dependency
  // arrays, and a fresh identity each render turns that effect into an
  // infinite load/render loop.
  const flash = useCallback(() => {
    clearTimer();
    setState({ kind: "saved" });
    timerRef.current = setTimeout(() => setState({ kind: "idle" }), holdMs);
  }, [clearTimer, holdMs]);

  const fail = useCallback((message: string) => {
    clearTimer();
    setState({ kind: "error", message });
  }, [clearTimer]);

  return { state, flash, fail };
}

export function SavedFlash({ state }: { state: { kind: "idle" | "saved" | "error"; message?: string } }) {
  if (state.kind === "idle") return null;
  const isError = state.kind === "error";
  return (
    <span
      role="status"
      style={{
        fontFamily: SANS_FONT,
        fontSize: 11,
        color: isError ? COLORS.danger : COLORS.success,
        opacity: 0.9,
      }}
    >
      {isError ? (state.message ?? "Couldn't save") : "Saved"}
    </span>
  );
}
