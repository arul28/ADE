/**
 * Settings → Agents & Models → Claude Code / Codex CLI → Accounts.
 *
 * One machine can hold several logins for these two providers, because both
 * keep their whole signed-in identity inside one config directory and both
 * honour an env var that names it. This panel is the only place that set of
 * accounts is visible: which ones exist, which one new chats use, how much room
 * each has left, and how to add another without disturbing the ones already
 * signed in.
 *
 * It sits above Models on purpose. Which account a chat runs as decides what
 * quota it spends and what it is allowed to see, so it is a more consequential
 * answer than which model it picks.
 *
 * The two header switches are about the whole set, not one account, which is
 * why they live in the header and not in a row menu. Each is gated on the fact
 * that makes it meaningful — smart balance on there being more than one account
 * to balance, auto-start on the provider actually reporting a five-hour window
 * — because a switch that cannot do anything still reads as a promise.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DotsThree, Plus, Question } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  outlineButton,
} from "../../../lanes/laneDesignTokens";
import { ProviderPanel } from "../../providerSectionPrimitives";
import { ConfirmDialog, useConfirmDialog } from "../../../shared/InlineDialogs";
import { providerColor } from "../../../usage/providerColors";
import { useAppStore } from "../../../../state/appStore";
import { useClickOutside } from "../../../../hooks/useClickOutside";
import { useUsageSnapshot } from "../../../usage/useUsageSnapshot";
import type {
  ProviderInstance,
  ProviderInstanceProvider,
} from "../../../../../shared/types/providerInstances";
import {
  accountAccent,
  accountIdentityLine,
  accountUsagePercents,
  accentTint,
  formatAccountUsage,
  providerHasFiveHourWindow,
} from "./accountPresentation";
import { AccentSwatchRow } from "./AccentSwatchRow";
import { AddProviderAccountSheet } from "./AddProviderAccountSheet";
import { useProviderInstances } from "./useProviderInstances";
import { providerActionMessage } from "../providerErrorMessage";

const SMART_BALANCE_HINT =
  "Smart balance picks the account with the most room when a chat starts, weighting the weekly window more as the week goes on. If that chat hits a usage limit and another account still has room, ADE continues the work there in a new chat. Off: new chats use the Default account, and a limit offers that move instead of taking it.";
const AUTO_START_HINT =
  "When a 5-hour window ends, ADE sends one tiny request on the cheapest model so the next window starts right away. Each request is logged with its cost.";

const HINT_TOOLTIP_WIDTH = 260;

/** A (?) that explains a switch without spending a line of the panel on it. */
function HintDot({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  // Both dots sit in a right-aligned header, so a tooltip hung from their left
  // edge runs past the window and the sentence it exists to show is cut off.
  // Measure at open time and hang it from whichever edge keeps it on screen.
  const show = useCallback(() => {
    const rect = anchorRef.current?.getBoundingClientRect();
    setAlignRight(rect ? rect.left + HINT_TOOLTIP_WIDTH > window.innerWidth - 8 : false);
    setOpen(true);
  }, []);

  return (
    <span ref={anchorRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        aria-label={`About ${label}`}
        title={text}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 14,
          height: 14,
          padding: 0,
          border: "none",
          background: "transparent",
          color: COLORS.textDim,
          cursor: "help",
        }}
      >
        <Question size={12} />
      </button>
      {open ? (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            ...(alignRight ? { right: 0 } : { left: 0 }),
            zIndex: 20,
            width: HINT_TOOLTIP_WIDTH,
            padding: "8px 10px",
            fontSize: 10,
            fontFamily: SANS_FONT,
            lineHeight: 1.5,
            color: COLORS.textSecondary,
            background: COLORS.cardBgSolid,
            border: `1px solid ${COLORS.outlineBorder}`,
            boxShadow: "0 12px 32px -18px rgba(0,0,0,0.85)",
          }}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

function HeaderToggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 20,
          padding: "0 6px 0 4px",
          border: `1px solid ${checked ? COLORS.accentBorder : COLORS.borderMuted}`,
          background: checked ? COLORS.accentSubtle : "transparent",
          borderRadius: 6,
          fontSize: 10,
          fontFamily: SANS_FONT,
          color: checked ? COLORS.textPrimary : COLORS.textMuted,
          cursor: "pointer",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 7,
            height: 7,
            borderRadius: 999,
            background: checked ? COLORS.accent : "transparent",
            border: `1px solid ${checked ? COLORS.accent : COLORS.border}`,
          }}
        />
        {label}
      </button>
      <HintDot label={label} text={hint} />
    </span>
  );
}

type RowMenuAction = "rename" | "default" | "accent" | "remove";

function AccountRow({
  instance,
  brandColor,
  usageLine,
  onAction,
  onSignIn,
  renaming,
  accenting,
  onCommitRename,
  onCancelRename,
  onCommitAccent,
}: {
  instance: ProviderInstance;
  brandColor: string;
  usageLine: string | null;
  onAction: (action: RowMenuAction, instance: ProviderInstance) => void;
  onSignIn: (instance: ProviderInstance) => void;
  renaming: boolean;
  accenting: boolean;
  onCommitRename: (instance: ProviderInstance, label: string) => void;
  onCancelRename: () => void;
  onCommitAccent: (instance: ProviderInstance, accent: string | null) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftLabel, setDraftLabel] = useState(instance.label);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const accent = accountAccent(instance, brandColor);

  const closeMenu = useCallback(() => setMenuOpen(false), []);

  // A row menu is a popover, so it has to answer the two gestures every popover
  // answers: click somewhere else, or press Escape. Without them the menu of
  // every row you ever opened stays on screen at once, stacked over the panel
  // below it.
  useClickOutside(menuRef, closeMenu, menuOpen);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, closeMenu]);

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
        padding: "6px 10px",
        border: "none",
        background: "transparent",
        fontSize: 11,
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
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "8px 0",
        borderTop: `1px solid ${COLORS.borderMuted}`,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            flexShrink: 0,
            borderRadius: 999,
            background: accent,
            border: `1px solid ${accentTint(accent, 60)}`,
          }}
        />
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
              height: 22,
              padding: "0 6px",
              fontSize: 12,
              fontFamily: SANS_FONT,
              color: COLORS.textPrimary,
              background: COLORS.cardBg,
              border: `1px solid ${COLORS.border}`,
              borderRadius: 6,
              outline: "none",
            }}
          />
        ) : (
          <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textPrimary, flexShrink: 0 }}>
            {instance.label}
          </span>
        )}
        <span
          style={{
            fontSize: 10,
            fontFamily: SANS_FONT,
            color: COLORS.textMuted,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {accountIdentityLine(instance)}
        </span>
        {instance.signedIn ? null : (
          <button
            type="button"
            onClick={() => onSignIn(instance)}
            style={{ ...outlineButton({ height: 20, padding: "0 8px", fontSize: 10 }), marginLeft: 4, flexShrink: 0 }}
          >
            Sign in
          </button>
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, minWidth: 0 }}>
          {usageLine ?? (instance.signedIn ? "No usage yet" : "")}
        </span>
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
          {instance.isDefault ? (
            <span style={{ fontSize: 10, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>Default</span>
          ) : null}
          <span style={{ position: "relative", display: "inline-flex" }} ref={menuRef}>
            <button
              type="button"
              aria-label={`${instance.label} account actions`}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 20,
                height: 20,
                padding: 0,
                border: "none",
                background: "transparent",
                color: COLORS.textMuted,
                cursor: "pointer",
              }}
            >
              <DotsThree size={14} weight="bold" />
            </button>
            {menuOpen ? (
              <div
                role="menu"
                aria-label={`${instance.label} account actions`}
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  zIndex: 25,
                  minWidth: 150,
                  padding: "4px 0",
                  background: COLORS.cardBgSolid,
                  border: `1px solid ${COLORS.outlineBorder}`,
                  boxShadow: "0 14px 36px -20px rgba(0,0,0,0.85)",
                }}
              >
                {item("rename", "Rename")}
                {instance.isDefault ? null : item("default", "Set as default")}
                {item("accent", "Change accent")}
                {item("remove", "Remove", true)}
              </div>
            ) : null}
          </span>
        </span>
      </div>

      {accenting ? (
        <div style={{ paddingTop: 4 }}>
          <AccentSwatchRow
            label={`${instance.label} accent`}
            value={instance.accentColor ?? null}
            onChange={(next) => onCommitAccent(instance, next)}
          />
        </div>
      ) : null}
    </div>
  );
}

export function ProviderAccountsPanel({
  provider,
  providerLabel,
}: {
  provider: ProviderInstanceProvider;
  providerLabel: string;
}) {
  const theme = useAppStore((state) => state.theme);
  const brandColor = providerColor(provider, theme);
  const { instances, settings, loading, bridgeMissing, error, reload, saveSettings } =
    useProviderInstances(provider);
  const { snapshot } = useUsageSnapshot();
  const confirm = useConfirmDialog();

  const [actionError, setActionError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [accentingId, setAccentingId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ existing: ProviderInstance | null } | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);

  const usageByInstance = useMemo(() => {
    const out = new Map<string, string | null>();
    for (const instance of instances) {
      out.set(instance.id, formatAccountUsage(accountUsagePercents(snapshot, provider, instance)));
    }
    return out;
  }, [instances, provider, snapshot]);

  const showSmartBalance = instances.length >= 2;
  const showAutoStart = providerHasFiveHourWindow(snapshot, provider);

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await work();
        await reload();
      } catch (err) {
        // The store is the authority on what is allowed — it refuses to remove
        // the default account, for one — so its sentence is shown verbatim
        // rather than replaced with a guess about why.
        setActionError(providerActionMessage(err, "That account change did not go through."));
      }
    },
    [reload],
  );

  const onAction = useCallback(
    (action: RowMenuAction, instance: ProviderInstance) => {
      const api = window.ade?.providerInstances;
      if (!api) return;
      if (action === "rename") {
        setAccentingId(null);
        setRenamingId(instance.id);
        return;
      }
      if (action === "accent") {
        setRenamingId(null);
        setAccentingId((current) => (current === instance.id ? null : instance.id));
        return;
      }
      if (action === "default") {
        void run(() => api.setDefault({ id: instance.id }));
        return;
      }
      void confirm
        .confirmAsync({
          title: "Remove account",
          message: `Remove ${instance.label} from ${providerLabel}? Its sign-in stays on disk — only ADE forgets the account.`,
          confirmLabel: "REMOVE",
          danger: true,
        })
        .then((ok) => {
          if (ok) void run(() => api.remove({ id: instance.id }));
        });
    },
    [confirm, providerLabel, run],
  );

  const onCommitRename = useCallback(
    (instance: ProviderInstance, label: string) => {
      setRenamingId(null);
      const next = label.trim();
      if (!next || next === instance.label) return;
      const api = window.ade?.providerInstances;
      if (!api) return;
      void run(() => api.rename({ id: instance.id, label: next }));
    },
    [run],
  );

  const onCommitAccent = useCallback(
    (instance: ProviderInstance, accent: string | null) => {
      const api = window.ade?.providerInstances;
      if (!api) return;
      void run(() => api.setAccent({ id: instance.id, accentColor: accent }));
    },
    [run],
  );

  // A refusal is filed at the top of the panel, which on a machine with ten
  // accounts is far above the row whose menu you just used. Scrolled out of
  // sight it reads as "nothing happened", so the alert brings itself into view.
  useEffect(() => {
    const node = errorRef.current;
    if (!node || typeof node.scrollIntoView !== "function") return;
    node.scrollIntoView({ block: "nearest" });
  }, [actionError, error]);

  // No bridge means no accounts to talk about. The page is still complete
  // without this panel, so it says nothing rather than apologising.
  if (bridgeMissing) return null;

  const shownError = actionError ?? error;

  return (
    <ProviderPanel
      title="Accounts"
      count={instances.length}
      actions={
        <>
          {showSmartBalance ? (
            <HeaderToggle
              label="Smart balance"
              hint={SMART_BALANCE_HINT}
              checked={settings.smartBalance}
              onChange={(next) => void saveSettings({ smartBalance: next })}
            />
          ) : null}
          {showAutoStart ? (
            <HeaderToggle
              label="Auto-start 5-hour windows"
              hint={AUTO_START_HINT}
              checked={settings.autoStartWindows}
              onChange={(next) => void saveSettings({ autoStartWindows: next })}
            />
          ) : null}
          {/* Top right, like every other panel's primary action. It used to sit
              alone at the bottom of the list, which is the one place the eye
              does not look for "add". */}
          <button
            type="button"
            style={outlineButton({ height: 26, padding: "0 9px", fontSize: 11 })}
            onClick={() => setSheet({ existing: null })}
          >
            <Plus size={11} weight="bold" /> Add account
          </button>
        </>
      }
    >
      {shownError ? (
        <div
          role="alert"
          ref={errorRef}
          style={{
            padding: "6px 8px",
            fontSize: 11,
            fontFamily: SANS_FONT,
            lineHeight: 1.5,
            color: COLORS.danger,
            background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
            overflowWrap: "anywhere",
          }}
        >
          {shownError}
        </div>
      ) : null}

      {loading && instances.length === 0 ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>Reading accounts…</div>
      ) : null}

      {instances.map((instance) => (
        <AccountRow
          key={instance.id}
          instance={instance}
          brandColor={brandColor}
          usageLine={usageByInstance.get(instance.id) ?? null}
          onAction={onAction}
          onSignIn={(target) => setSheet({ existing: target })}
          renaming={renamingId === instance.id}
          accenting={accentingId === instance.id}
          onCommitRename={onCommitRename}
          onCancelRename={() => setRenamingId(null)}
          onCommitAccent={onCommitAccent}
        />
      ))}

      {sheet ? (
        <AddProviderAccountSheet
          provider={provider}
          providerLabel={providerLabel}
          existingInstance={sheet.existing}
          defaultAccent={brandColor}
          onClose={(changed) => {
            setSheet(null);
            if (changed) void reload();
          }}
        />
      ) : null}

      <ConfirmDialog state={confirm.state} onClose={confirm.close} />
    </ProviderPanel>
  );
}
