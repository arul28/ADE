/**
 * One sign-in in the ADE account, on a provider's ADE Cloud page: its name,
 * where it came from, who renewed it, whether ADE Cloud uses it, its switch,
 * and Remove. The look of `AccountCard`; the page decides what it says
 * (`adeCloudPageModel.ts`) and runs every write.
 */
import React, { useRef, useState } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { AnchoredMenu } from "../../../ui/AnchoredMenu";
import { NoticeBadge } from "../../../ui/notice/NoticeParts";
import { SettingsToggle } from "../../primitives";
import type { SignInCardModel } from "./adeCloudPageModel";

export function SignInAccountCard({
  card,
  busy,
  onUse,
  onSwitch,
  onRemove,
}: {
  card: SignInCardModel;
  /** A write for this card waits: its controls wait too. */
  busy: boolean;
  onUse: () => void;
  onSwitch: (next: boolean) => void;
  onRemove: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const line: React.CSSProperties = { fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 };

  return (
    <div
      role="group"
      aria-label={card.title}
      data-testid={`ade-cloud-sign-in-${card.key}`}
      data-in-use={card.inUse ? "true" : undefined}
      data-off={card.on ? undefined : "true"}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${card.inUse ? "color-mix(in srgb, var(--color-accent) 38%, transparent)" : COLORS.borderMuted}`,
        background: card.inUse ? "color-mix(in srgb, var(--color-accent) 5%, transparent)" : COLORS.cardBg,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, minHeight: 26 }}>
        <span
          title={card.title}
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            fontWeight: 500,
            fontFamily: SANS_FONT,
            color: card.on ? COLORS.textPrimary : COLORS.textMuted,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {card.title}
        </span>
        {/* K1 / K3 / K2: in use, off, or the button that picks it. */}
        {card.inUse ? (
          <NoticeBadge tone="accent">In use on ADE Cloud</NoticeBadge>
        ) : !card.on ? (
          <NoticeBadge tone="neutral">Off for ADE Cloud</NoticeBadge>
        ) : (
          <button
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onUse}
            aria-label={`Use ${card.title} on ADE Cloud`}
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12, flexShrink: 0 })}
          >
            Use on ADE Cloud
          </button>
        )}
        <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
          <button
            ref={menuButtonRef}
            type="button"
            aria-label={`${card.title} actions`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 26,
              height: 26,
              padding: 0,
              border: "none",
              borderRadius: 6,
              background: menuOpen ? COLORS.hoverBg : "transparent",
              color: COLORS.textMuted,
              cursor: "pointer",
            }}
          >
            <DotsThree size={16} weight="bold" />
          </button>
          <AnchoredMenu
            open={menuOpen}
            anchorRef={menuButtonRef}
            onClose={() => setMenuOpen(false)}
            placement="bottom-end"
            role="menu"
            aria-label={`${card.title} actions`}
            style={{
              minWidth: 150,
              padding: "4px 0",
              background: COLORS.cardBgSolid,
              border: `1px solid ${COLORS.outlineBorder}`,
              borderRadius: 8,
              boxShadow: "0 14px 36px -20px rgba(0,0,0,0.85)",
            }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setMenuOpen(false);
                onRemove();
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "7px 12px",
                border: "none",
                background: "transparent",
                fontSize: 12,
                fontFamily: SANS_FONT,
                color: COLORS.danger,
                cursor: "pointer",
              }}
            >
              Remove
            </button>
          </AnchoredMenu>
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, opacity: card.on ? 1 : 0.7 }}>
        <span style={line}>{card.sourceLine}</span>
        {card.renewedLine ? <span style={line}>{card.renewedLine}</span> : null}
        {card.renewsNowLine ? <span style={{ ...line, color: COLORS.textSecondary }}>{card.renewsNowLine}</span> : null}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: "auto" }}>
        <span style={{ flex: 1, fontSize: 12, fontFamily: SANS_FONT, color: card.on ? COLORS.textSecondary : COLORS.textMuted }}>
          On for ADE Cloud
        </span>
        <SettingsToggle
          checked={card.on}
          disabled={busy}
          label={`On for ADE Cloud: ${card.title}`}
          onChange={onSwitch}
        />
      </div>
    </div>
  );
}
