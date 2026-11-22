/**
 * The parts the ADE Cloud account cards share (`PassCard`, `SignInAccountCard`):
 * the card with its title row (the accent marks the one in use), and the
 * card's "…" menu. The cards decide the words and run every write.
 */
import React, { useRef, useState } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { COLORS, SANS_FONT } from "../../../lanes/laneDesignTokens";
import { AnchoredMenu } from "../../../ui/AnchoredMenu";
import { cn } from "../../../ui/cn";
import { MENU_ITEM_CLASS, MENU_SURFACE_CLASS } from "../../../ui/paneMenuTokens";

/** The muted line under a card's title. */
export const accountCardLine: React.CSSProperties = { fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 };

export function AccountCardFrame({
  title,
  marked,
  dimTitle,
  badge,
  menu,
  testId,
  dataset,
  children,
}: {
  title: string;
  /** The accent border and fill: the one in use. */
  marked: boolean;
  /** The title in the muted colour (the card is off). */
  dimTitle: boolean;
  /** The title row's right end, before the menu: a badge or a button. */
  badge: React.ReactNode;
  menu: React.ReactNode;
  testId: string;
  /** `data-*` attributes, without the `data-` prefix. */
  dataset?: Record<string, string | undefined>;
  children: React.ReactNode;
}) {
  const data = Object.fromEntries(Object.entries(dataset ?? {}).map(([key, value]) => [`data-${key}`, value]));
  return (
    <div
      role="group"
      aria-label={title}
      data-testid={testId}
      {...data}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${marked ? "color-mix(in srgb, var(--color-accent) 38%, transparent)" : COLORS.borderMuted}`,
        background: marked ? "color-mix(in srgb, var(--color-accent) 5%, transparent)" : COLORS.cardBg,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, minHeight: 26 }}>
        <span
          title={title}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            fontWeight: 500,
            fontFamily: SANS_FONT,
            color: dimTitle ? COLORS.textMuted : COLORS.textPrimary,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        {badge}
        {menu}
      </div>
      {children}
    </div>
  );
}

type CardMenuItem = { label: string; onSelect: () => void; danger?: boolean };

/** The card's "…" button and its menu. Each item closes the menu, then runs. */
export function CardOverflowMenu({ title, busy, items }: { title: string; busy: boolean; items: CardMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <button
        ref={anchorRef}
        type="button"
        aria-label={`${title} actions`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 26,
          height: 26,
          padding: 0,
          border: "none",
          borderRadius: 6,
          background: open ? COLORS.hoverBg : "transparent",
          color: COLORS.textMuted,
          cursor: "pointer",
        }}
      >
        <DotsThree size={16} weight="bold" />
      </button>
      <AnchoredMenu open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} placement="bottom-end">
        <div className={cn(MENU_SURFACE_CLASS, "min-w-[150px]")} role="menu" aria-label={`${title} actions`}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={busy}
              className={cn(
                MENU_ITEM_CLASS,
                "w-full text-left disabled:cursor-not-allowed disabled:opacity-40",
                item.danger ? "text-error hover:bg-error/10" : "hover:bg-fg/[0.07] hover:text-fg",
              )}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </AnchoredMenu>
    </span>
  );
}
