import React from "react";
import * as Popover from "@radix-ui/react-popover";

import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import { pluginIcon } from "../pluginIcons";
import type { PluginBadgeTone } from "../../../../shared/plugins/sockets";

/**
 * The chrome every socket shares.
 *
 * Kept in one file so a plugin badge on the Lanes tab and a plugin badge on a PR
 * row are the same object at the same size — the taxonomy is only uniform if it
 * *looks* uniform, and six surfaces each rolling their own pill is how that
 * stops being true by the second one.
 */

/** Tone → token colour. Mirrors `TONE_COLOR` in the vocabulary renderer. */
export const SOCKET_TONE_COLOR: Record<PluginBadgeTone, string> = {
  neutral: COLORS.textMuted,
  accent: COLORS.accent,
  success: COLORS.success,
  warning: COLORS.warning,
};

/** A plugin's declared icon, or the puzzle-piece default. */
export function SocketIcon({ name, size = 11, color }: { name?: string; size?: number; color?: string }) {
  const Icon = pluginIcon(name);
  return <Icon size={size} weight="regular" color={color} />;
}

/**
 * A contributed row badge.
 *
 * Deliberately one step quieter than the product's own row metadata: smaller
 * text, tinted fill, no bold. A plugin gets to be present on a row, not to
 * out-shout the branch name.
 */
export function SocketBadge({
  text,
  tone,
  icon,
  tooltip,
  dataTour,
}: {
  text: string;
  tone: PluginBadgeTone;
  icon?: string;
  tooltip?: string;
  dataTour?: string;
}) {
  const color = SOCKET_TONE_COLOR[tone];
  return (
    <span
      data-tour={dataTour}
      title={tooltip ?? text}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        maxWidth: 140,
        padding: "1px 6px",
        fontSize: 10,
        fontWeight: 500,
        fontFamily: SANS_FONT,
        lineHeight: "16px",
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 24%, transparent)`,
        borderRadius: RADII.sm,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {icon ? <SocketIcon name={icon} color={color} /> : null}
      {text}
    </span>
  );
}

const OVERFLOW_TRIGGER_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "1px 5px",
  fontSize: 10,
  fontWeight: 500,
  fontFamily: SANS_FONT,
  lineHeight: "16px",
  color: COLORS.textMuted,
  background: "color-mix(in srgb, var(--color-fg) 5%, transparent)",
  border: `1px solid ${COLORS.borderMuted}`,
  borderRadius: RADII.sm,
  cursor: "pointer",
};

/**
 * The "+N" affordance.
 *
 * Every surface caps visible badges at two, so the rest need somewhere to live
 * that is not the row. A popover rather than a tooltip because the hidden
 * badges can carry their own tooltips, and because it is reachable from the
 * keyboard.
 */
export function SocketOverflow({
  count,
  children,
  label,
  dataTour,
}: {
  count: number;
  children: React.ReactNode;
  label: string;
  dataTour?: string;
}) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          data-tour={dataTour}
          style={OVERFLOW_TRIGGER_STYLE}
          onClick={(event) => event.stopPropagation()}
        >
          +{count}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          onClick={(event) => event.stopPropagation()}
          style={{
            zIndex: 60,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            minWidth: 160,
            maxWidth: 280,
            padding: 8,
            background: COLORS.panelCard,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADII.md,
            boxShadow: "var(--shadow-panel)",
          }}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A contributed toolbar/menu button, sized to sit beside the surface's own. */
export function SocketButton({
  label,
  icon,
  disabled,
  onClick,
  dataTour,
}: {
  label: string;
  icon?: string;
  disabled?: boolean;
  onClick: () => void;
  dataTour?: string;
}) {
  return (
    <button
      type="button"
      data-tour={dataTour}
      disabled={disabled}
      onClick={onClick}
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        padding: "0 10px",
        fontSize: 11,
        fontWeight: 500,
        fontFamily: SANS_FONT,
        color: disabled ? COLORS.textDim : COLORS.textSecondary,
        background: "color-mix(in srgb, var(--color-fg) 4%, transparent)",
        border: `1px solid ${COLORS.borderMuted}`,
        borderRadius: RADII.sm,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        whiteSpace: "nowrap",
      }}
    >
      <SocketIcon name={icon} size={12} />
      {label}
    </button>
  );
}

/** A row inside an overflow popover: same affordance, menu-shaped. */
export function SocketMenuRow({
  label,
  icon,
  danger,
  onClick,
}: {
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        padding: "5px 8px",
        fontSize: 11,
        fontFamily: SANS_FONT,
        textAlign: "left",
        color: danger ? COLORS.danger : COLORS.textSecondary,
        background: "transparent",
        border: "none",
        borderRadius: RADII.sm,
        cursor: "pointer",
      }}
    >
      <SocketIcon name={icon} size={12} />
      {label}
    </button>
  );
}
