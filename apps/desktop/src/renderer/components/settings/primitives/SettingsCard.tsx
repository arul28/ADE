import React, { useCallback, useEffect, useRef, useState } from "react";
import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";
import { SettingsPageShell } from "./SettingsPageShell";
import { SettingsRowIcon, type SettingsTone } from "./SettingsRows";

/**
 * True inside a `SettingsGroup`: its cards render as rows of the group's one
 * panel rather than as boxes of their own.
 */
const InGroupContext = React.createContext(false);

/**
 * One setting. The card owns its anchor id, so a Cmd-K result or a deeplink of
 * the form `?tab=<tab>#<anchor>` lands exactly here.
 *
 * Inside a `SettingsGroup` it is a row of the group's panel, divided from its
 * neighbours by a hairline; on its own it is a panel with one row.
 */
export function SettingsCard({
  anchor,
  title,
  description,
  control,
  children,
  icon,
  tone,
  /** Renders the control below the description instead of to its right. */
  stacked = false,
  disabled = false,
}: {
  anchor: string;
  title: string;
  description?: React.ReactNode;
  control?: React.ReactNode;
  children?: React.ReactNode;
  /** A glyph in a tinted tile before the title, as `SettingsRow` draws it. */
  icon?: React.ReactNode;
  tone?: SettingsTone | string;
  stacked?: boolean;
  disabled?: boolean;
}) {
  const inGroup = React.useContext(InGroupContext);
  return (
    <SettingsPageShell
      anchor={anchor}
      title={title}
      description={description}
      icon={icon ? <SettingsRowIcon icon={icon} tone={tone} /> : undefined}
      sectionAttrs={inGroup ? { className: "ade-settings-row" } : undefined}
      sectionStyle={{
        opacity: disabled ? 0.6 : 1,
        ...(inGroup ? { padding: "14px 16px", background: "transparent", border: "none", borderRadius: 0 } : null),
      }}
      headerStacked={stacked}
      aside={control ? <div style={{ flexShrink: 0 }}>{control}</div> : null}
      bodyStyle={{ marginTop: 12 }}
    >
      {children}
    </SettingsPageShell>
  );
}

/** A labelled band of related settings: a quiet label over one panel of rows. */
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
    // were all filtered out by search, instead of leaving it stranded. Layout
    // lives in the class because that page clears the inline `display`.
    <div data-settings-group={title} className="ade-settings-section">
      <div className="ade-settings-head" style={{ padding: "0 2px" }}>
        <h2
          style={{
            margin: 0,
            fontFamily: SANS_FONT,
            fontSize: 13,
            fontWeight: 500,
            letterSpacing: "-0.005em",
            color: COLORS.textSecondary,
          }}
        >
          {title}
        </h2>
        {description ? (
          <p style={{ margin: "3px 0 0", fontFamily: SANS_FONT, fontSize: 12, color: COLORS.textDim }}>
            {description}
          </p>
        ) : null}
      </div>
      <div className="ade-settings-panel">
        <InGroupContext.Provider value={true}>{children}</InGroupContext.Provider>
      </div>
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
