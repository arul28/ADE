/**
 * One account in Settings → Accounts: its name, status badge and
 * ⋯ menu, then the top-bar popover's own usage row. The panel decides the
 * card's state and badge; the card only draws them and reports clicks.
 */
import React, { useCallback, useRef, useState } from "react";
import { CaretLeft, CaretRight, Check, DotsThree } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { AnchoredMenu } from "../../../ui/AnchoredMenu";
import { Banner } from "../../../ui/notice/Banner";
import { NoticeBadge } from "../../../ui/notice/NoticeParts";
import { UsageAccountRow } from "../../../usage/UsageAccountRow";
import type { AccountLimitRow } from "../../../usage/usageLimitModel";
import {
  isBaseProviderInstance,
  PROVIDER_ACCOUNT_NOT_SIGNED_IN,
  PROVIDER_ACCOUNT_SIGNED_IN_NO_EMAIL,
  providerInstanceHasAccount,
  type ProviderInstance,
  type ProviderInstanceSettingsPatch,
} from "../../../../../shared/types/providerInstances";
import type { OpenProjectBinding } from "../../../../../shared/types/core";
import { accountIdentityLine } from "./accountPresentation";

export type RowMenuAction = "signIn" | "signOut" | "remove";

/** Why a card is shown the way it is; one state per card, decided by the panel. */
export type CardState =
  | { kind: "ok" }
  | { kind: "signedOut" }
  | { kind: "copy" };

type MenuView = "main" | "compaction" | "mainCache" | "cache" | "onExtraUsage";
const MENU_VIEW_WIDTH: Record<MenuView, number | undefined> = { main: undefined, compaction: 340, mainCache: 264, cache: 264, onExtraUsage: 264 };
/** The account settings that only a Claude account has. */
export type ClaudeAccountSettingPatch = Pick<ProviderInstanceSettingsPatch, "mainPromptCacheTtl" | "subagentPromptCacheTtl" | "onExtraUsage">;

/**
 * Only ever "around": the date can be a 30-day estimate and the login can end
 * up to 3 days sooner, and a past date means it has probably ended, not that it
 * has.
 */
function claudeLoginEndText(endsAt: string | undefined, nowMs: number): string | null {
  const ms = endsAt ? Date.parse(endsAt) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  const day = new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return ms > nowMs ? `Sign-in ends around ${day}` : `Sign-in may have ended around ${day}`;
}

export function AccountCard({
  instance,
  limitRow,
  pin,
  state,
  badge,
  selectable,
  nowMs,
  reducedMotion,
  onSelect,
  onAction,
  onSignIn,
  replacedNote,
  compactionControl,
  onSetClaudeSetting,
  pass = null,
}: {
  instance: ProviderInstance;
  limitRow: AccountLimitRow | null;
  /** The machine this Settings page shows (`useSettingsMachineScope().pin`); null is this one. */
  pin: OpenProjectBinding | null;
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
  /** This account's own compaction settings, shown as a page of the actions menu. */
  compactionControl?: React.ReactNode;
  /** Claude only: sets one of this account's Claude settings; null restores Claude Code's own behavior. */
  onSetClaudeSetting?: (instance: ProviderInstance, patch: ClaudeAccountSettingPatch) => void;
  /**
   * A Claude pass on a cloud computer (ADE Cloud made the account): it is
   * not signed in or out, or removed, here. The card shows the pass's state
   * and a way to ADE Cloud, in place of the sign-in end date.
   */
  pass?: { line: React.ReactNode; title: string } | null;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [menuView, setMenuView] = useState<MenuView>("main");
  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setMenuView("main");
  }, []);
  const signedOut = state.kind === "signedOut";
  const isCopy = state.kind === "copy";
  const inUse = badge !== null;
  // The registry's copy of the email, else the one the usage poll read.
  const email = instance.account?.email ?? limitRow?.account?.email ?? null;
  // An account is its email; it has no other name (its id is a storage key).
  // Without one, a working login (a key login has no plan either) is still
  // signed in: the registry's signed-in state decides, not the plan.
  const name = email?.trim()
    || pass?.title
    || (providerInstanceHasAccount(instance) ? PROVIDER_ACCOUNT_SIGNED_IN_NO_EMAIL : PROVIDER_ACCOUNT_NOT_SIGNED_IN);
  // The usage row carries its own signed-out pill when the poller saw the
  // broken login; the header says it only when the row cannot.
  const rowSaysSignedOut = limitRow?.account?.login === "signed_out";
  const loginEnd = !pass && !signedOut && providerInstanceHasAccount(instance) ? claudeLoginEndText(instance.claudeLoginEndsAt, nowMs) : null;
  const longPromptCache = instance.subagentPromptCacheTtl === "1h";
  const mainPromptCache = instance.mainPromptCacheTtl ?? null;
  const stopsOnExtraUsage = instance.onExtraUsage === "stop";
  const menuItemStyle = (danger = false): React.CSSProperties => ({
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
  });

  const item = (action: RowMenuAction, text: string, danger = false) => (
    <button
      key={action}
      type="button"
      role="menuitem"
      onClick={() => {
        closeMenu();
        onAction(action, instance);
      }}
      style={menuItemStyle(danger)}
    >
      {text}
    </button>
  );

  const menuRuleStyle: React.CSSProperties = { height: 1, margin: "4px 0", background: COLORS.borderMuted };
  const menuNoteStyle: React.CSSProperties = {
    margin: 0,
    padding: "4px 12px 6px",
    fontSize: 11,
    lineHeight: 1.45,
    fontFamily: SANS_FONT,
    color: COLORS.textMuted,
  };
  /** A main-menu row that opens one page of the menu and shows that page's current value. */
  const subviewRow = (view: Exclude<MenuView, "main">, text: string, value: string) => (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      onClick={() => setMenuView(view)}
      style={{ ...menuItemStyle(), display: "flex", alignItems: "center", gap: 10 }}
    >
      <span style={{ flex: 1 }}>{text}</span>
      <span style={{ fontSize: 11, color: COLORS.textDim }}>{value}</span>
      <CaretRight size={10} weight="bold" color={COLORS.textDim} />
    </button>
  );
  const subviewHead = (text: string) => (
    <button
      type="button"
      role="menuitem"
      aria-label={`Back from ${text}`}
      onClick={() => setMenuView("main")}
      style={{ ...menuItemStyle(), display: "flex", alignItems: "center", gap: 6, fontWeight: 500, color: COLORS.textPrimary }}
    >
      <CaretLeft size={10} weight="bold" color={COLORS.textDim} />
      {text}
    </button>
  );
  /** One page of the menu that picks between a few values of one Claude setting. */
  const choicePage = (page: {
    title: string;
    lead: string;
    footnote: string;
    choices: Array<{ checked: boolean; patch: ClaudeAccountSettingPatch; text: string; note: string }>;
  }) => (
    <>
      {subviewHead(page.title)}
      <p style={menuNoteStyle}>{page.lead}</p>
      {page.choices.map((choice) => (
        <button
          key={choice.text}
          type="button"
          role="menuitemradio"
          aria-checked={choice.checked}
          onClick={() => {
            closeMenu();
            if (!choice.checked) onSetClaudeSetting?.(instance, choice.patch);
          }}
          style={{ ...menuItemStyle(), display: "flex", alignItems: "flex-start", gap: 8 }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: "block", color: COLORS.textPrimary }}>{choice.text}</span>
            <span style={{ display: "block", marginTop: 1, fontSize: 11, lineHeight: 1.4, color: COLORS.textMuted }}>{choice.note}</span>
          </span>
          {choice.checked ? <Check size={12} weight="bold" style={{ marginTop: 2, flex: "none" }} /> : null}
        </button>
      ))}
      <p style={{ ...menuNoteStyle, color: COLORS.textDim }}>{page.footnote}</p>
    </>
  );

  return (
    <div
      role="group"
      aria-label={`${name} account`}
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
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, flex: 1 }}>
          {/* An account is its login: the email. Before it signs in it has
              none, and the body says why. With no email, two cards would read
              the same, so the hover names the one thing that tells them apart:
              the id `--instance` takes. Never shown as visible text. */}
          <span
            title={email?.trim() ? name : `${name} · account id ${instance.id}`}
            style={{
              fontSize: 13,
              fontWeight: 500,
              fontFamily: SANS_FONT,
              color: email ? COLORS.textPrimary : COLORS.textMuted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </span>
          {badge ? <NoticeBadge tone="accent">{badge}</NoticeBadge> : null}
          {signedOut && !pass && !rowSaysSignedOut && providerInstanceHasAccount(instance) ? <NoticeBadge tone="warning">Not signed in</NoticeBadge> : null}
          {isCopy ? <NoticeBadge tone="neutral">Copy</NoticeBadge> : null}
          {longPromptCache ? <NoticeBadge tone="neutral">1h cache</NoticeBadge> : null}
        </div>
        {signedOut && !pass ? (
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
            aria-label={`Use ${name} for new chats`}
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
            aria-label={`${name} account actions`}
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
            aria-label={`${name} account actions`}
            remeasureKey={`${menuView}:${instance.compaction ? "custom" : "default"}`}
            style={{
              minWidth: 170,
              width: MENU_VIEW_WIDTH[menuView],
              padding: "4px 0",
              background: COLORS.cardBgSolid,
              border: `1px solid ${COLORS.outlineBorder}`,
              borderRadius: 8,
              boxShadow: "0 14px 36px -20px rgba(0,0,0,0.85)",
            }}
          >
            {menuView === "main" ? (
              <>
                {pass ? null : item("signIn", signedOut ? "Sign in" : "Sign in again")}
                {!pass && (compactionControl || onSetClaudeSetting) ? <div style={menuRuleStyle} /> : null}
                {compactionControl ? subviewRow("compaction", "Auto-compact", instance.compaction ? "Custom" : "Default") : null}
                {onSetClaudeSetting ? subviewRow("mainCache", "Main chat cache", mainPromptCache === "1h" ? "1 hour" : mainPromptCache === "5m" ? "5 minutes" : "Automatic") : null}
                {onSetClaudeSetting ? subviewRow("cache", "Subagent cache", longPromptCache ? "1 hour" : "5 minutes") : null}
                {onSetClaudeSetting ? subviewRow("onExtraUsage", "Extra usage", stopsOnExtraUsage ? "Stop the turn" : "Continue") : null}
                {/* The store refuses both on the default, and Remove on the machine's own login. */}
                {instance.isDefault || pass ? null : (
                  <>
                    <div style={menuRuleStyle} />
                    {instance.signedIn || instance.loginBroken ? item("signOut", "Sign out", true) : null}
                    {isBaseProviderInstance(instance) ? null : item("remove", "Remove", true)}
                  </>
                )}
              </>
            ) : menuView === "compaction" ? (
              <>
                {subviewHead("Auto-compact")}
                <div style={{ padding: "2px 8px 6px" }}>{compactionControl}</div>
              </>
            ) : menuView === "onExtraUsage" ? choicePage({
              title: "Extra usage",
              lead: "What happens when a turn passes the plan limit and Claude starts to bill extra usage.",
              footnote: "Applies to ADE chats on this account, on this machine.",
              choices: [
                { checked: !stopsOnExtraUsage, patch: { onExtraUsage: null }, text: "Continue", note: "Default. The turn keeps going and Claude bills the extra usage." },
                { checked: stopsOnExtraUsage, patch: { onExtraUsage: "stop" }, text: "Stop the turn", note: "ADE stops the turn, as it does at a plan limit. One request can be billed before the stop." },
              ],
            }) : menuView === "mainCache" ? choicePage({
              title: "Main chat cache",
              lead: "How long Claude keeps a chat's context ready between your messages.",
              footnote: "Applies to new sessions.",
              choices: [
                { checked: mainPromptCache === null, patch: { mainPromptCacheTtl: null }, text: "Automatic", note: "Default — 1 hour on a subscription, 5 minutes on an API key or extra usage." },
                { checked: mainPromptCache === "5m", patch: { mainPromptCacheTtl: "5m" }, text: "5 minutes", note: "Each save costs less. A pause over 5 minutes re-sends the whole chat." },
                { checked: mainPromptCache === "1h", patch: { mainPromptCacheTtl: "1h" }, text: "1 hour", note: "Each save costs more. The chat stays ready through breaks up to an hour." },
              ],
            }) : choicePage({
              title: "Subagent cache",
              lead: "How long Claude keeps a subagent's context ready between its requests.",
              footnote: "Applies to new sessions.",
              choices: [
                { checked: !longPromptCache, patch: { subagentPromptCacheTtl: null }, text: "5 minutes", note: "Default — lowest cost per save." },
                { checked: longPromptCache, patch: { subagentPromptCacheTtl: "1h" }, text: "1 hour", note: "Each save costs more — worth it only when subagents often wait over 5 minutes." },
              ],
            })}
          </AnchoredMenu>
        </span>
      </div>

      {isCopy ? (
        <Banner
          layout="inline"
          model={{
            id: `same-login-${instance.id}`,
            tone: "neutral",
            title: "Same login as another account here",
            detail: `${email ? `${email} is already signed in on another card, ` : "Another card already holds this login, "}so this adds no quota. Smart balance skips it.`,
            actions: [{ label: "Sign in to another account", variant: "link", onClick: () => onSignIn(instance) }],
          }}
        />
      ) : limitRow && providerInstanceHasAccount(instance) ? (
        <UsageAccountRow
          row={limitRow}
          pin={pin}
          fallbackEmail={email}
          nowMs={nowMs}
          reducedMotion={reducedMotion}
          dim={signedOut}
          hideIdentity
        />
      ) : pass && !providerInstanceHasAccount(instance) ? null : (
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          {/* The header badge already says "Not signed in". */}
          <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textSecondary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {/* The title already says "Not signed in". */}
            {providerInstanceHasAccount(instance) ? accountIdentityLine(instance, false) : "Sign in to use it for chats."}
          </span>
          {instance.signedIn ? (
            <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>No usage yet</span>
          ) : null}
        </span>
      )}

      {loginEnd ? <span style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>{loginEnd}</span> : null}
      {pass ? pass.line : null}

      {replacedNote}
    </div>
  );
}
