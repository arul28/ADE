import type { CSSProperties, ReactNode } from "react";
import { Info, WarningCircle, X, XCircle } from "@phosphor-icons/react";
import { COLORS, SANS_FONT } from "../lanes/laneDesignTokens";

/**
 * The single, shared banner primitive for ADE's connection/health family.
 *
 * Before this, three unrelated one-offs (AlertBanner/WarningBanner/ErrorBanner)
 * and a stack of hand-ordered `? :` conditionals in AppShell each invented their
 * own colors, mono type, and dismiss mechanism. `Banner` is the one row every
 * integration banner renders through, so they finally read as one system: a
 * severity-tinted, quiet row with a left accent edge, in the normal UI font
 * (never monospace).
 */

export type BannerSeverity = "error" | "warning" | "info";

export type BannerAction = {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
};

export type BannerModel = {
  /** Stable identity for one logical banner (used as the React key). */
  id: string;
  severity: BannerSeverity;
  /** Overrides the default per-severity icon. */
  icon?: ReactNode;
  title: string;
  /** Muted secondary line; wraps to a second line when long. */
  detail?: string;
  actions?: BannerAction[];
  /**
   * When set, renders a dismiss `×`. `key` identifies the durable dismissal and
   * `fingerprint` captures the state being dismissed (see bannerDismiss.ts).
   * `false`/`undefined` = not dismissable.
   */
  dismiss?: { key: string; fingerprint: string } | false;
};

type SeverityTokens = {
  color: string;
  tint: string;
  edge: string;
  defaultIcon: ReactNode;
};

function severityTokens(severity: BannerSeverity): SeverityTokens {
  if (severity === "error") {
    return {
      color: COLORS.danger,
      tint: `color-mix(in srgb, ${COLORS.danger} 8%, transparent)`,
      edge: `color-mix(in srgb, ${COLORS.danger} 55%, transparent)`,
      defaultIcon: <XCircle size={15} weight="fill" />,
    };
  }
  if (severity === "info") {
    return {
      color: COLORS.accent,
      tint: `color-mix(in srgb, ${COLORS.accent} 8%, transparent)`,
      edge: `color-mix(in srgb, ${COLORS.accent} 50%, transparent)`,
      defaultIcon: <Info size={15} weight="fill" />,
    };
  }
  return {
    color: COLORS.warning,
    tint: `color-mix(in srgb, ${COLORS.warning} 9%, transparent)`,
    edge: `color-mix(in srgb, ${COLORS.warning} 55%, transparent)`,
    defaultIcon: <WarningCircle size={15} weight="fill" />,
  };
}

export function Banner({
  model,
  onDismiss,
}: {
  model: BannerModel;
  /** Invoked when the user clicks the dismiss `×`; receives the durable descriptor. */
  onDismiss?: (dismiss: { key: string; fingerprint: string }) => void;
}): JSX.Element {
  const tokens = severityTokens(model.severity);
  const dismiss = model.dismiss || undefined;

  return (
    <div
      role={model.severity === "error" ? "alert" : "status"}
      style={{
        ...rowStyle,
        background: tokens.tint,
        borderLeft: `3px solid ${tokens.edge}`,
      }}
    >
      <span style={{ ...iconWrapStyle, color: tokens.color }} aria-hidden="true">
        {model.icon ?? tokens.defaultIcon}
      </span>
      <div style={textWrapStyle}>
        <span style={titleStyle}>{model.title}</span>
        {model.detail ? <span style={detailStyle}>{model.detail}</span> : null}
      </div>
      {model.actions && model.actions.length > 0 ? (
        <div style={actionsStyle}>
          {model.actions.map((action) => (
            <button
              key={action.label}
              type="button"
              style={action.variant === "primary" ? primaryActionStyle(tokens.color) : secondaryActionStyle}
              onClick={action.onClick}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {dismiss ? (
        <button
          type="button"
          style={dismissButtonStyle}
          onClick={() => onDismiss?.(dismiss)}
          title="Dismiss"
          aria-label={`Dismiss: ${model.title}`}
        >
          <X size={12} weight="bold" />
        </button>
      ) : null}
    </div>
  );
}

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 9,
  padding: "8px 10px 8px 9px",
  borderRadius: 7,
  fontFamily: SANS_FONT,
};

const iconWrapStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  marginTop: 1,
};

const textWrapStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 1,
  minWidth: 0,
  flex: 1,
};

const titleStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  lineHeight: 1.35,
  color: COLORS.textPrimary,
};

const detailStyle: CSSProperties = {
  fontSize: 11.5,
  lineHeight: 1.4,
  color: COLORS.textMuted,
};

const actionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  flexShrink: 0,
  marginTop: 1,
};

function primaryActionStyle(color: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 24,
    padding: "0 10px",
    borderRadius: 6,
    fontSize: 11.5,
    fontWeight: 600,
    fontFamily: SANS_FONT,
    cursor: "pointer",
    color,
    background: `color-mix(in srgb, ${color} 14%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 32%, transparent)`,
  };
}

const secondaryActionStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 24,
  padding: "0 10px",
  borderRadius: 6,
  fontSize: 11.5,
  fontWeight: 500,
  fontFamily: SANS_FONT,
  cursor: "pointer",
  color: COLORS.textSecondary,
  background: "transparent",
  border: `1px solid ${COLORS.borderMuted}`,
};

const dismissButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  width: 20,
  height: 20,
  marginTop: 1,
  padding: 0,
  borderRadius: 5,
  border: "none",
  background: "transparent",
  color: COLORS.textMuted,
  cursor: "pointer",
};
