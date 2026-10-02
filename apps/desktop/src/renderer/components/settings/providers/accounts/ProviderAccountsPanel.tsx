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
 * Layout: one slim routing strip (smart balance, auto-start), then one card per
 * account in a responsive grid, so a wide window shows accounts side by side
 * instead of stretching one row across it. Each card's usage IS the top-bar
 * popover's `UsageAccountRow` (email, pace pill, reset credit, meters), so the
 * two surfaces draw one account the same way.
 *
 * The routing switches are gated on the fact that makes them meaningful —
 * smart balance on there being more than one account, auto-start on the
 * provider reporting a five-hour window — because an inert switch still reads
 * as a promise.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, Plus, Question } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { ProviderPanel } from "../../providerSectionPrimitives";
import { SettingsToggle } from "../../primitives/SettingsControls";
import { confirmDialog } from "../../../ui/dialog";
import { Banner } from "../../../ui/notice/Banner";
import { providerColor } from "../../../usage/providerColors";
import { useAppStore } from "../../../../state/appStore";
import { useUsageSnapshot } from "../../../usage/useUsageSnapshot";
import { usePrefersReducedMotion } from "../../../../hooks/usePrefersReducedMotion";
import type { ProviderInstance, ProviderInstanceProvider } from "../../../../../shared/types/providerInstances";
import { accountLimitRow, accountSignedOut, providerHasFiveHourWindow } from "./accountPresentation";
import { AccountCard, type CardState, type RowMenuAction } from "./AccountCard";
import { useAccountSignInSheet } from "./AddProviderAccountSheet";
import { pinnedProviderInstances, useProviderInstances } from "./useProviderInstances";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import { providerActionMessage } from "../providerErrorMessage";

const SMART_BALANCE_HINT =
  "On: each new chat goes to the account whose weekly room resets soonest, so no account's room expires unused. A chat that hits a usage limit moves to another account that still has room. Off: new chats use the account marked New chats. Click an account to use it.";
const AUTO_START_HINT =
  "When a 5-hour window ends, ADE sends one tiny request on the cheapest model so the next window starts right away. Each request is logged with its cost.";

const HINT_TOOLTIP_WIDTH = 280;

/** A (?) that explains a switch without spending a line of the panel on it. */
function HintDot({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  // A tooltip hung from the dot's left edge can run past the window and cut
  // off the sentence it exists to show. Measure at open time and hang it from
  // whichever edge keeps it on screen.
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
          width: 16,
          height: 16,
          padding: 0,
          border: "none",
          borderRadius: 999,
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
            padding: "9px 11px",
            fontSize: 11,
            fontFamily: SANS_FONT,
            lineHeight: 1.5,
            color: COLORS.textSecondary,
            background: COLORS.cardBgSolid,
            border: `1px solid ${COLORS.outlineBorder}`,
            borderRadius: 8,
            boxShadow: "0 12px 32px -18px rgba(0,0,0,0.85)",
          }}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

/** One routing switch in the strip: switch, name, (?). */
function RoutingSwitch({
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
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <SettingsToggle checked={checked} onChange={onChange} label={label} />
      <span style={{ fontSize: 12, fontWeight: 500, fontFamily: SANS_FONT, color: checked ? COLORS.textPrimary : COLORS.textSecondary }}>
        {label}
      </span>
      <HintDot label={label} text={hint} />
    </span>
  );
}

const CARD_MIN_WIDTH = 290;
const CARD_GAP = 10;

/**
 * How many card columns the grid uses. As many as fit, then evened out over
 * the rows: four cards that fit three across go two by two instead of three
 * and a widow, and two cards never leave an empty column beside them.
 */
function balancedColumns(count: number, width: number): number {
  if (count <= 1 || width <= 0) return 1;
  const fit = Math.max(1, Math.floor((width + CARD_GAP) / (CARD_MIN_WIDTH + CARD_GAP)));
  const rows = Math.ceil(count / Math.min(fit, count));
  return Math.ceil(count / rows);
}

/** The grid's content width, kept current as the window resizes. */
function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** `name@host` → `name`, the label a re-added account starts with. */
function labelFromEmail(email: string): string {
  return email.split("@")[0]?.slice(0, 32) || email;
}

export function ProviderAccountsPanel({
  provider,
  providerLabel,
}: {
  provider: ProviderInstanceProvider;
  providerLabel: string;
}) {
  const theme = useAppStore((state) => state.theme);
  // Accounts belong to the machine the Settings page is showing.
  const { pin } = useSettingsMachineScope();
  const brandColor = providerColor(provider, theme);
  const { instances, settings, loading, bridgeMissing, error, reload, saveSettings } =
    useProviderInstances(provider);
  const { snapshot } = useUsageSnapshot();
  const signInSheet = useAccountSignInSheet({ provider, providerLabel, onChanged: () => void reload() });
  const openSheet = signInSheet.open;
  const reducedMotion = usePrefersReducedMotion();
  const nowMs = Date.now();

  const [actionError, setActionError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [accentingId, setAccentingId] = useState<string | null>(null);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const gridWidth = useElementWidth(gridRef);
  const columns = balancedColumns(instances.length, gridWidth);

  const showSmartBalance = instances.length >= 2;
  const showAutoStart = providerHasFiveHourWindow(snapshot, provider);
  const labelById = useMemo(() => new Map(instances.map((instance) => [instance.id, instance.label])), [instances]);
  const nextPickId = snapshot?.balanceNext?.find((entry) => entry.provider === provider)?.instanceId ?? null;

  const run = useCallback(
    async (work: () => Promise<unknown>) => {
      setActionError(null);
      try {
        await work();
        await reload();
      } catch (err) {
        // The store is the authority on what is allowed, so its sentence is
        // shown verbatim rather than replaced with a guess about why.
        setActionError(providerActionMessage(err, "That account change did not go through."));
      }
    },
    [reload],
  );

  const onAction = useCallback(
    (action: RowMenuAction, instance: ProviderInstance) => {
      const api = pinnedProviderInstances(pin);
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
      if (action === "signIn") {
        openSheet({ existing: instance });
        return;
      }
      void confirmDialog({
        title: "Remove account",
        message: `Remove ${instance.label} from ${providerLabel}? Its sign-in stays on disk — only ADE forgets the account.`,
        confirmLabel: "REMOVE",
        destructive: true,
      }).then((ok) => {
        if (ok) void run(() => api.remove({ id: instance.id }));
      });
    },
    [openSheet, pin, providerLabel, run],
  );

  const signedOutById = useMemo(() => {
    const out = new Map<string, boolean>();
    for (const instance of instances) out.set(instance.id, accountSignedOut(snapshot, provider, instance));
    return out;
  }, [instances, provider, snapshot]);

  /**
   * Picking an account means "use this one": it turns smart balance off when
   * it was on, then makes the account the one new chats start on.
   */
  const selectAccount = useCallback(
    async (instance: ProviderInstance) => {
      const api = pinnedProviderInstances(pin);
      if (!api) return;
      if (!settings.smartBalance && instance.isDefault) return;
      if (settings.smartBalance) await saveSettings({ smartBalance: false });
      if (!instance.isDefault) await run(() => api.setDefault({ id: instance.id }));
    },
    [pin, run, saveSettings, settings.smartBalance],
  );

  const onCommitRename = useCallback(
    (instance: ProviderInstance, label: string) => {
      setRenamingId(null);
      const next = label.trim();
      if (!next || next === instance.label) return;
      const api = pinnedProviderInstances(pin);
      if (!api) return;
      void run(() => api.rename({ id: instance.id, label: next }));
    },
    [pin, run],
  );

  const onCommitAccent = useCallback(
    (instance: ProviderInstance, accent: string | null) => {
      const api = pinnedProviderInstances(pin);
      if (!api) return;
      void run(() => api.setAccent({ id: instance.id, accentColor: accent }));
    },
    [pin, run],
  );

  /**
   * Bring a replaced login back. A copy is the natural slot: signing it in to
   * the replaced email turns two cards of one login back into two accounts.
   * Without one, a new account is added, named after the email.
   */
  const restoreReplaced = useCallback(
    (email: string) => {
      const slot = instances.find((instance) => instance.sameLoginAs);
      if (slot) openSheet({ existing: slot });
      else openSheet({ existing: null, label: labelFromEmail(email) });
    },
    [instances, openSheet],
  );

  const dismissReplaced = useCallback(
    (instance: ProviderInstance) => {
      const api = pinnedProviderInstances(pin);
      if (!api?.dismissReplaced) return;
      void run(() => api.dismissReplaced({ id: instance.id }));
    },
    [pin, run],
  );

  // A refusal is filed at the top of the panel, which on a machine with ten
  // accounts is far above the card whose menu you just used. Scrolled out of
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
    <>
      <ProviderPanel
        title="Accounts"
        count={instances.length}
        bodyStyle={{ gap: 12 }}
        actions={
          <button
            type="button"
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12 })}
            onClick={() => openSheet({ existing: null })}
          >
            <Plus size={11} weight="bold" /> Add account
          </button>
        }
      >
        {shownError ? (
          <div ref={errorRef} tabIndex={-1}>
            <Banner
              layout="inline"
              model={{ id: "provider-accounts-error", tone: "error", title: shownError }}
            />
          </div>
        ) : null}

        {showSmartBalance || showAutoStart ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              columnGap: 22,
              rowGap: 8,
              padding: "8px 12px",
              borderRadius: 10,
              border: `1px solid ${COLORS.borderMuted}`,
              background: COLORS.recessedBg,
            }}
          >
            {showSmartBalance ? (
              <RoutingSwitch
                label="Smart balance"
                hint={SMART_BALANCE_HINT}
                checked={settings.smartBalance}
                onChange={(next) => void saveSettings({ smartBalance: next })}
              />
            ) : null}
            {showAutoStart ? (
              <RoutingSwitch
                label="Auto-start 5-hour windows"
                hint={AUTO_START_HINT}
                checked={settings.autoStartWindows}
                onChange={(next) => void saveSettings({ autoStartWindows: next })}
              />
            ) : null}
            {showSmartBalance ? (
              <span style={{ marginLeft: "auto", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                {settings.smartBalance
                  ? "New chats go to the account whose weekly room resets soonest."
                  : "New chats use the account marked New chats."}
              </span>
            ) : null}
          </div>
        ) : null}

        {loading && instances.length === 0 ? (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
            <ArrowsClockwise size={12} className="animate-spin motion-reduce:animate-none" />
            Reading accounts…
          </div>
        ) : null}

        <div
          ref={gridRef}
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: CARD_GAP,
            // Cards in one row share a height, so the grid's edges line up.
            alignItems: "stretch",
          }}
        >
          {instances.map((instance) => {
            const signedOut = signedOutById.get(instance.id) === true;
            const ownerLabel = instance.sameLoginAs ? labelById.get(instance.sameLoginAs) ?? instance.sameLoginAs : null;
            const state: CardState = signedOut
              ? { kind: "signedOut" }
              : ownerLabel
                ? { kind: "copy", ownerLabel }
                : { kind: "ok" };
            const usable = state.kind === "ok";
            const badge = !usable
              ? null
              : settings.smartBalance && showSmartBalance
                ? (nextPickId === instance.id ? "Next chat" : null)
                : instance.isDefault ? "New chats" : null;
            const replaced = instance.replacedAccount;
            const replacedNote = replaced ? (
              <Banner
                layout="inline"
                model={{
                  id: `replaced-${instance.id}`,
                  tone: "warning",
                  title: `${replaced.email} was replaced`,
                  detail: "A sign-in outside ADE put another login in this account.",
                  actions: [{ label: "Sign it back in", onClick: () => restoreReplaced(replaced.email) }],
                  dismiss: { onDismiss: () => dismissReplaced(instance), label: `Dismiss: ${replaced.email} was replaced` },
                }}
              />
            ) : null;
            return (
              <AccountCard
                key={instance.id}
                instance={instance}
                brandColor={brandColor}
                limitRow={accountLimitRow(snapshot, provider, instance, nowMs)}
                state={state}
                badge={badge}
                selectable={usable && !(!settings.smartBalance && instance.isDefault)}
                nowMs={nowMs}
                reducedMotion={reducedMotion}
                onSelect={() => void selectAccount(instance)}
                onAction={onAction}
                onSignIn={(target) => openSheet({ existing: target })}
                replacedNote={replacedNote}
                renaming={renamingId === instance.id}
                accenting={accentingId === instance.id}
                onCommitRename={onCommitRename}
                onCancelRename={() => setRenamingId(null)}
                onCommitAccent={onCommitAccent}
              />
            );
          })}
        </div>
      </ProviderPanel>

      {/* Outside the panel: a folded panel must still open its own sheet. */}
      {signInSheet.element}
    </>
  );
}
