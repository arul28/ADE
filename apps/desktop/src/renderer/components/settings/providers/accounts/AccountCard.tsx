/**
 * One account in Settings → Accounts: its accent dot, label, status badge and
 * ⋯ menu, then the top-bar popover's own usage row. The panel decides the
 * card's state and badge; the card only draws them and reports clicks.
 */
import React, { useCallback, useRef, useState } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { AnchoredMenu } from "../../../ui/AnchoredMenu";
import { Banner } from "../../../ui/notice/Banner";
import { NoticeBadge } from "../../../ui/notice/NoticeParts";
import { UsageAccountRow } from "../../../usage/UsageAccountRow";
import type { AccountLimitRow } from "../../../usage/usageLimitModel";
import {
  isBaseProviderInstance,
  providerInstanceHasAccount,
  type ProviderInstance,
} from "../../../../../shared/types/providerInstances";
import { accountAccent, accountIdentityLine, accentTint } from "./accountPresentation";
import { AccentSwatchRow } from "./AccentSwatchRow";

/** The account's accent as a small dot, so cards read apart at a glance. */
function AccentDot({ accent, dim }: { accent: string; dim: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        flexShrink: 0,
        background: accent,
        boxShadow: `0 0 0 3px ${accentTint(accent, 18)}`,
        opacity: dim ? 0.45 : 1,
      }}
    />
  );
}

export type RowMenuAction = "rename" | "accent" | "signIn" | "remove";

/** Why a card is shown the way it is; one state per card, decided by the panel. */
export type CardState =
  | { kind: "ok" }
  | { kind: "signedOut" }
  | { kind: "copy"; ownerLabel: string };

export function AccountCard({
  instance,
  brandColor,
  limitRow,
  state,
  badge,
  selectable,
  nowMs,
  reducedMotion,
  onSelect,
  onAction,
  onSignIn,
  replacedNote,
  renaming,
  accenting,
  onCommitRename,
  onCancelRename,
  onCommitAccent,
}: {
  instance: ProviderInstance;
  brandColor: string;
  limitRow: AccountLimitRow | null;
  state: CardState;
  /** "New chats" / "Next chat": where new chats go. Absent for every other card. */
  badge: string | null;
  /** The card picks the account on click (smart balance off, a working login). */
  selectable: boolean;
  nowMs: number;
  reducedMotion: boolean;
  onSelect: () => void;
  onAction: (action: RowMenuAction, instance: ProviderInstance) => void;
  onSignIn: (instance: ProviderInstance) => void;
  replacedNote: React.ReactNode;
  renaming: boolean;
  accenting: boolean;
  onCommitRename: (instance: ProviderInstance, label: string) => void;
  onCancelRename: () => void;
  onCommitAccent: (instance: ProviderInstance, accent: string | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [draftLabel, setDraftLabel] = useState(instance.label);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const accent = accountAccent(instance, brandColor);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const signedOut = state.kind === "signedOut";
  const isCopy = state.kind === "copy";
  const inUse = badge !== null;
  const email = instance.account?.email ?? null;
  // The usage row carries its own "Signed out" pill when the poller saw the
  // broken login; the header says it only when the row cannot.
  const rowSaysSignedOut = limitRow?.account?.login === "signed_out";

  const item = (action: RowMenuAction, text: string, danger = false) => (
    <button
      key={action}
      type="button"
      role="menuitem"
      onClick={() => {
        closeMenu();
        onAction(action, instance);
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
        color: danger ? COLORS.danger : COLORS.textSecondary,
        cursor: "pointer",
      }}
    >
      {text}
    </button>
  );

  return (
    <div
      role="group"
      aria-label={`${instance.label} account`}
      data-in-use={inUse ? "true" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
      }}
      // The whole card picks the account, except its own controls.
      onClick={selectable
        ? (event) => {
          if ((event.target as HTMLElement).closest("button, input, [role='menu']")) return;
          onSelect();
        }
        : undefined}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
        borderRadius: 12,
        border: `1px solid ${inUse ? "color-mix(in srgb, var(--color-accent) 38%, transparent)" : COLORS.borderMuted}`,
        background: inUse
          ? "color-mix(in srgb, var(--color-accent) 5%, transparent)"
          : hovered && selectable
            ? COLORS.hoverBg
            : COLORS.cardBg,
        cursor: selectable ? "pointer" : "default",
        transition: "background 120ms ease, border-color 120ms ease",
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, minHeight: 26 }}>
        <AccentDot accent={accent} dim={signedOut || isCopy} />
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: 1 }}>
          {renaming ? (
            <input
              aria-label={`Rename ${instance.label}`}
              autoFocus
              value={draftLabel}
              onChange={(event) => setDraftLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onCommitRename(instance, draftLabel);
                if (event.key === "Escape") onCancelRename();
              }}
              onBlur={() => onCommitRename(instance, draftLabel)}
              style={{
                height: 24,
                minWidth: 0,
                padding: "0 8px",
                fontSize: 13,
                fontFamily: SANS_FONT,
                color: COLORS.textPrimary,
                background: COLORS.cardBg,
                border: `1px solid ${COLORS.outlineBorder}`,
                borderRadius: 6,
                outline: "none",
              }}
            />
          ) : (
            <span
              style={{
                fontSize: 13,
                fontWeight: 500,
                fontFamily: SANS_FONT,
                color: COLORS.textPrimary,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {instance.label}
            </span>
          )}
          {badge ? <NoticeBadge tone="accent">{badge}</NoticeBadge> : null}
          {signedOut && !rowSaysSignedOut && providerInstanceHasAccount(instance) ? <NoticeBadge tone="warning">Signed out</NoticeBadge> : null}
          {isCopy ? <NoticeBadge tone="neutral">Copy</NoticeBadge> : null}
        </div>
        {signedOut ? (
          <button
            type="button"
            onClick={() => onSignIn(instance)}
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12 })}
          >
            Sign in
          </button>
        ) : selectable && !inUse && (hovered || focusWithin) ? (
          // Only while the card is pointed at or focused: a reserved invisible
          // button would squeeze every card's header.
          <button
            type="button"
            aria-pressed={false}
            aria-label={`Use ${instance.label} for new chats`}
            onClick={onSelect}
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12 })}
          >
            Use
          </button>
        ) : null}
        <span style={{ position: "relative", display: "inline-flex" }}>
          <button
            ref={menuButtonRef}
            type="button"
            aria-label={`${instance.label} account actions`}
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
            onClose={closeMenu}
            placement="bottom-end"
            role="menu"
            aria-label={`${instance.label} account actions`}
            style={{
              minWidth: 170,
              padding: "4px 0",
              background: COLORS.cardBgSolid,
              border: `1px solid ${COLORS.outlineBorder}`,
              borderRadius: 8,
              boxShadow: "0 14px 36px -20px rgba(0,0,0,0.85)",
            }}
          >
            {item("rename", "Rename")}
            {item("accent", "Change accent")}
            {item("signIn", signedOut ? "Sign in" : "Sign in again")}
            {/* The store refuses both: the default, and the machine's own login. */}
            {instance.isDefault || isBaseProviderInstance(instance) ? null : item("remove", "Remove", true)}
          </AnchoredMenu>
        </span>
      </div>

      {isCopy ? (
        <Banner
          layout="inline"
          model={{
            id: `same-login-${instance.id}`,
            tone: "neutral",
            title: `Same login as ${state.ownerLabel}`,
            detail: `${email ? `${email} is already signed in there, ` : "It "}so this adds no quota. Smart balance skips it.`,
            actions: [{ label: "Sign in to another account", variant: "link", onClick: () => onSignIn(instance) }],
          }}
        />
      ) : limitRow && providerInstanceHasAccount(instance) ? (
        <UsageAccountRow
          row={limitRow}
          fallbackEmail={email}
          nowMs={nowMs}
          reducedMotion={reducedMotion}
          dim={signedOut}
        />
      ) : (
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          {/* The header badge already says "Signed out". */}
          <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {accountIdentityLine(instance, false)}
          </span>
          {instance.signedIn ? (
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>No usage yet</span>
          ) : null}
        </span>
      )}

      {replacedNote}

      {accenting ? (
        <AccentSwatchRow
          label={`${instance.label} accent`}
          value={instance.accentColor ?? null}
          onChange={(next) => onCommitAccent(instance, next)}
        />
      ) : null}
    </div>
  );
}
