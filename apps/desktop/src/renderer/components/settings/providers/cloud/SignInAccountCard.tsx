/**
 * One sign-in in the ADE account: its name, where it came from, who renewed
 * it, whether ADE Cloud uses it, its switch, and Remove. The look of
 * `AccountCard`; the page decides what it says (`adeCloudPageModel.ts`) and
 * runs every write.
 *
 * Three places draw it (`where`):
 *  - the ADE Cloud page: "In use on ADE Cloud" or "Use on ADE Cloud", and the switch;
 *  - an own computer's page: "In use here" for the sign-in that computer
 *    uses. Until own computers can take a sign-in from the account, the
 *    others say how to use them there, with no button that would fail;
 *  - a cloud computer's page: "In use here" for the one it applied, and "Use
 *    on ADE Cloud" on the others (the choice is account-wide).
 */
import React, { useRef, useState } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { AnchoredMenu } from "../../../ui/AnchoredMenu";
import { NoticeBadge } from "../../../ui/notice/NoticeParts";
import { SettingsToggle } from "../../primitives";
import type { SignInCardModel } from "./adeCloudPageModel";

export type SignInCardPlace =
  | { kind: "ade-cloud" }
  /** `machineWords`: "this computer", or the page's computer by name. */
  | { kind: "own-computer"; inUseHere: boolean; machineWords: string }
  | { kind: "cloud-computer"; inUseHere: boolean };

export function SignInAccountCard({
  card,
  busy,
  onUse,
  onSwitch,
  onRemove,
  where = { kind: "ade-cloud" },
}: {
  card: SignInCardModel;
  /** A write for this card waits: its controls wait too. */
  busy: boolean;
  onUse?: () => void;
  /** The "On for ADE Cloud" switch; without it the card has none. */
  onSwitch?: (next: boolean) => void;
  onRemove: () => void;
  where?: SignInCardPlace;
}) {
  const onComputer = where.kind !== "ade-cloud";
  const inUseHere = onComputer && where.inUseHere;
  // The accent marks the sign-in the place in front of the person uses.
  const marked = onComputer ? inUseHere : card.inUse;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const line: React.CSSProperties = { fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 };

  return (
    <div
      role="group"
      aria-label={card.title}
      data-testid={`ade-cloud-sign-in-${card.key}`}
      data-in-use={marked ? "true" : undefined}
      data-place={where.kind}
      data-off={card.on ? undefined : "true"}
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
        {/* K7 on a computer; K1 / K3 / K2 on ADE Cloud: in use, off, or the button that picks it. */}
        {inUseHere ? (
          <NoticeBadge tone="accent">In use here</NoticeBadge>
        ) : where.kind === "own-computer" ? null : card.inUse ? (
          // On a cloud computer's page the line below says it; the badge is for the place in front.
          where.kind === "ade-cloud" ? <NoticeBadge tone="accent">In use on ADE Cloud</NoticeBadge> : null
        ) : !card.on ? (
          <NoticeBadge tone="neutral">Off for ADE Cloud</NoticeBadge>
        ) : !onUse ? null : (
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
        {/* K8: an own computer takes a sign-in from the account later; until then, how to use it there. */}
        {where.kind === "own-computer" && !inUseHere ? (
          <span style={{ ...line, color: COLORS.textSecondary }}>To use it here, sign in on {where.machineWords}.</span>
        ) : null}
        {onComputer && card.inUse ? <span style={line}>In use on ADE Cloud</span> : null}
      </div>

      {onSwitch ? (
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
      ) : null}
    </div>
  );
}
