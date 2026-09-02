import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { CaretDown } from "@phosphor-icons/react";

import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import { pluginIcon } from "../pluginIcons";
import type { PluginActionButtonMenuItem, PluginBadgeTone } from "../../../../shared/plugins/sockets";

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
  destructive: COLORS.danger,
};

/**
 * A button's declared tint, spent the way `SocketBadge` already spends a tone.
 *
 * The colour reaches the label, the icon (which inherits `currentColor`) and a
 * hairline border, over a fill at 12% — a plugin gets a button that is visibly
 * ITS button, not a block of brand colour sitting in ADE's chrome. The same
 * three percentages as the badge, so a plugin's tinted button and its tinted
 * badge on the row below read as the same object.
 *
 * `null` in, nothing out: the caller spreads `{}` and keeps every class it
 * already had. The colour itself was proven legible against both themes by
 * `sanitizePluginActionColor` before it ever became a payload field, so there
 * is nothing left for this function to judge.
 */
export function socketTintStyle(color: string | null | undefined): React.CSSProperties {
  if (!color) return {};
  return {
    color,
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    borderColor: `color-mix(in srgb, ${color} 34%, transparent)`,
  };
}

/**
 * The two halves of a split button, joined.
 *
 * The alpha test read "Take a drink" and its chevron as two detached pills,
 * because they were: two independently bordered controls with a flex `gap`
 * between them. They are one control — one contribution, one busy state, one
 * primary press — so they get one outline, and the seam between them is the
 * chevron's own left border rather than a gap.
 *
 * A wrapper rather than a class on each caller because the joint is a LAYOUT
 * fact (no gap, shared baseline) that has to survive whatever chrome the three
 * button kinds wear. `PluginToolbarActions` had already built this inline; this
 * is that arrangement made shared so the composer and the chat header cannot
 * drift back apart.
 */
export function SocketSplitGroup({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center" }}>{children}</span>
  );
}

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
  style,
}: {
  label: string;
  icon?: string;
  disabled?: boolean;
  onClick: () => void;
  dataTour?: string;
  /** Overrides: the split-button joint, and a plugin's own sanitized tint. */
  style?: React.CSSProperties;
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
        ...style,
      }}
    >
      <SocketIcon name={icon} size={12} />
      {label}
    </button>
  );
}

/**
 * The chevron half of a split button, and the menu it opens.
 *
 * Three chromes host this — the toolbar button, the composer accessory button
 * and the chat header button — and they differ only in the trigger's own
 * styling, which is why that arrives as props while the popover does not. A
 * dropdown that looked like three different dropdowns depending on which button
 * it hung from would undo the point of `socketUi` having one file.
 *
 * Rendered ONLY when a payload carries a menu. A caller with no menu draws the
 * button it always drew, unchanged, which is the contract the payload field
 * promises: the arrow is additive and nothing about a plain button moves.
 */
export function SocketSplitMenu({
  items,
  onSelect,
  label,
  dataTour,
  style,
  className,
  iconSize = 9,
}: {
  items: readonly PluginActionButtonMenuItem[];
  onSelect: (item: PluginActionButtonMenuItem) => void;
  /** Accessible name — the primary button's label is the useful half of it. */
  label: string;
  dataTour?: string;
  style?: React.CSSProperties;
  className?: string;
  iconSize?: number;
}) {
  if (items.length === 0) return null;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${label} — more actions`}
          data-tour={dataTour}
          className={className}
          style={style}
          onClick={(event) => event.stopPropagation()}
        >
          <CaretDown size={iconSize} weight="bold" />
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
            gap: 2,
            minWidth: 160,
            maxWidth: 280,
            padding: 6,
            background: COLORS.panelCard,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADII.md,
            boxShadow: "var(--shadow-panel)",
          }}
        >
          {items.map((item) => (
            <Popover.Close asChild key={`${item.actionId} ${item.label}`}>
              <div>
                <SocketMenuRow
                  label={item.label}
                  {...(item.icon ? { icon: item.icon } : {})}
                  {...(item.danger ? { danger: true } : {})}
                  onClick={() => onSelect(item)}
                />
              </div>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * A split button's menu, flattened into rows for an overflow popover.
 *
 * A button that folded into "+N" cannot also open a dropdown — the chevron went
 * with the button — so its extra actions would simply vanish at the width where
 * the overflow appears. They are drawn as indented rows under their primary
 * instead, which keeps every action a plugin declared reachable at every width.
 */
export function SocketMenuSubRows({
  items,
  onSelect,
}: {
  items: readonly PluginActionButtonMenuItem[];
  onSelect: (item: PluginActionButtonMenuItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", paddingLeft: 12 }}>
      {items.map((item) => (
        <SocketMenuRow
          key={`${item.actionId} ${item.label}`}
          label={item.label}
          {...(item.icon ? { icon: item.icon } : {})}
          {...(item.danger ? { danger: true } : {})}
          onClick={() => onSelect(item)}
        />
      ))}
    </div>
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
      // The colour below is a CSS custom property, which means it is not
      // readable from a computed style in a test environment. This attribute is
      // the same fact in a form the DOM keeps, next to `data-busy` and
      // `data-tour`, which the sockets already lean on for the same reason.
      data-danger={danger || undefined}
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
