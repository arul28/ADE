import React, { useEffect, useId, useState } from "react";
import type { Icon as PhosphorIcon, IconWeight } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, adeVar, cardStyle } from "../tokens";

export const settingsSectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  marginBottom: 10,
};

export const settingsSectionDescriptionStyle: React.CSSProperties = {
  color: COLORS.textMuted,
  fontFamily: SANS_FONT,
  fontSize: 12,
  lineHeight: 1.6,
  marginBottom: 14,
};

export function SettingsSectionShell({
  id,
  title,
  description,
  icon: Icon,
  iconNode,
  brandColor,
  iconWeight = "duotone",
  children,
}: {
  id?: string;
  title: string;
  description: React.ReactNode;
  icon?: PhosphorIcon;
  iconNode?: React.ReactNode;
  brandColor: string;
  iconWeight?: IconWeight;
  children: React.ReactNode;
}) {
  return (
    // `data-settings-anchor` mirrors the id so shell-based sections take part
    // in settings search and Cmd-K landing like `SettingsCard` does. Without
    // it they stay visible through every filter and can't be deep-linked to.
    <section id={id} data-settings-anchor={id}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 24 }}>
        <div
          style={{
            width: 42,
            height: 42,
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: brandColor,
            background: `color-mix(in srgb, ${brandColor} 16%, ${adeVar("--ade-card", "color-card")})`,
            border: `1px solid color-mix(in srgb, ${brandColor} 34%, transparent)`,
          }}
        >
          {iconNode ?? (Icon ? <Icon size={22} weight={iconWeight} style={{ color: brandColor }} /> : null)}
        </div>
        <div style={{ minWidth: 0, flex: 1, paddingTop: 2 }}>
          <h2
            style={{
              ...settingsSectionTitleStyle,
              marginBottom: 4,
              fontSize: 14,
              letterSpacing: "-0.01em",
            }}
          >
            {title}
          </h2>
          <p style={{ ...settingsSectionDescriptionStyle, marginBottom: 0 }}>{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * One privacy consent control: a labelled switch, what it shares in plain
 * words, a live footnote, and an error line that never disappears silently.
 *
 * ADE has two of these — anonymous analytics and automatic diagnostics — and
 * they were the same eighty lines twice. They are also the two screens where a
 * copy-paste divergence matters most: these read and write the real persisted
 * value rather than assuming, because a consent toggle that renders optimism
 * is a consent toggle that can show "off" for something that is on.
 *
 * `read`/`write` may be absent, which is a build whose preload predates the
 * setting: the switch renders in its default position and stays disabled
 * rather than pretending to work.
 */
export function ConsentToggleSection<TStatus extends { enabled: boolean }>({
  id,
  title,
  description,
  icon,
  brandColor,
  label,
  body,
  footnote,
  read,
  write,
  readErrorMessage,
  writeErrorMessage,
  children,
}: {
  id: string;
  title: string;
  description: React.ReactNode;
  icon: PhosphorIcon;
  brandColor: string;
  /** The switch's own label: what the user is agreeing to, in one line. */
  label: string;
  /** What leaves the computer, and what never does. */
  body: React.ReactNode;
  /** The quieter line beneath, given the live status (`null` until it loads). */
  footnote: (status: TStatus | null) => React.ReactNode;
  read: (() => Promise<TStatus>) | undefined;
  write: ((enabled: boolean) => Promise<TStatus>) | undefined;
  readErrorMessage: string;
  writeErrorMessage: string;
  /**
   * An action that belongs to this consent, rendered below the switch and its
   * copy — the diagnostics section's "Send a report to ADE". Given the live
   * status, because whether the toggle is on changes what the action has to
   * say for itself.
   */
  children?: (status: TStatus | null) => React.ReactNode;
}) {
  const toggleId = useId();
  const [status, setStatus] = useState<TStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!read) return;
    void read()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setError(readErrorMessage);
      });
    return () => {
      cancelled = true;
    };
    // `read`/`write` are stable per section; re-running on identity alone would
    // refetch on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setEnabled = async (enabled: boolean) => {
    if (saving || !write) return;
    setSaving(true);
    setError(null);
    try {
      setStatus(await write(enabled));
    } catch {
      setError(writeErrorMessage);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSectionShell
      id={id}
      title={title}
      description={description}
      icon={icon}
      brandColor={brandColor}
    >
      <div style={cardStyle({ padding: 16, maxWidth: 720 })}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <label
              htmlFor={toggleId}
              style={{
                display: "block",
                color: COLORS.textPrimary,
                cursor: "pointer",
                fontFamily: SANS_FONT,
                fontSize: 14,
                fontWeight: 600,
                lineHeight: 1.4,
              }}
            >
              {label}
            </label>
            <p style={{ margin: "6px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 12, lineHeight: 1.6 }}>
              {body}
            </p>
            <p style={{ margin: "8px 0 0", color: COLORS.textMuted, fontFamily: SANS_FONT, fontSize: 11, lineHeight: 1.5 }}>
              {footnote(status)}
            </p>
            {error ? (
              <p role="alert" style={{ margin: "8px 0 0", color: COLORS.danger, fontFamily: SANS_FONT, fontSize: 11 }}>
                {error}
              </p>
            ) : null}
          </div>
          <SettingsToggle
            id={toggleId}
            checked={status?.enabled ?? true}
            disabled={!status || saving}
            onChange={(enabled) => void setEnabled(enabled)}
          />
        </div>
        {children ? (
          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: `1px solid ${COLORS.outlineBorder}`,
            }}
          >
            {children(status)}
          </div>
        ) : null}
      </div>
    </SettingsSectionShell>
  );
}

export function SettingsToggle({
  checked,
  onChange,
  id,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  id: string;
  disabled?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 36,
        height: 20,
        borderRadius: 10,
        border: "none",
        background: checked ? COLORS.accent : COLORS.outlineBorder,
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
        transition: "background 150ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 8,
          background: COLORS.textPrimary,
          transition: "left 150ms ease",
        }}
      />
    </button>
  );
}
