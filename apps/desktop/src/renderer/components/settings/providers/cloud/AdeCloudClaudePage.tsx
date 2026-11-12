/**
 * Claude's page on ADE Cloud: the account's Claude passes as cards, which one
 * new cloud chats use (or smart balance), each pass's state and use, and
 * Renew, Remove and "Add a pass" (the approve sheet, which the view owns so
 * the Claude tile opens the same one).
 *
 * Every write is account-wide and goes through This computer (`accountPin`),
 * with the pin of the flow's start; the view's `runWrite` applies its
 * returned status. Nothing here reads on a timer.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Plus, Ticket } from "@phosphor-icons/react";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { confirmDialog } from "../../../ui/dialog/confirm";
import { showToast } from "../../../app/toast/toastStore";
import { RoutingSwitch, SMART_BALANCE_HINT } from "../accounts/ProviderAccountsPanel";
import { ProviderHero } from "../ProviderHero";
import { providerBrand, providerThemeVars } from "../providerBrand";
import type { ProviderDescriptor } from "../types";
import { accountPassUse, adeCloudPageLine, type AdeCloudTile } from "./adeCloudSignInModel";
import { claudePageLine, cloudSmartBalance, passCards, type PassCardModel } from "./adeCloudClaudeModel";
import type { ClaudePassRequest } from "./ClaudePassSignInSheet";
import { PassCard } from "./PassCard";
import type { RunWrite } from "./signInWrites";
import type { AdeCloudSignInsState } from "./useAdeCloudSignIns";
import type { HeldWrites } from "./useHeldWrites";

const identity = (id: string) => id;

export function AdeCloudClaudePage({
  descriptor,
  tile,
  signIns,
  busy,
  runWrite,
  setSwitch,
  heldWrites,
  recheck,
  openPassSheet,
}: {
  descriptor: ProviderDescriptor;
  tile: AdeCloudTile;
  signIns: AdeCloudSignInsState;
  busy: ReadonlySet<string>;
  runWrite: RunWrite;
  setSwitch: (key: string, on: boolean, confirmOn: boolean) => Promise<void>;
  heldWrites: HeldWrites;
  recheck: () => void;
  openPassSheet: (request: ClaudePassRequest) => void;
}) {
  const { account, cloud, signInStatus, accountPin } = signIns;
  const { held, hold } = heldWrites;
  const brand = providerBrand(descriptor.id);
  const now = Date.now();
  const passUse = useMemo(() => accountPassUse(signInStatus?.passes), [signInStatus?.passes]);
  const cards = useMemo(
    () => passCards({ account, cloud, passUse, hidden: held, now }),
    // `now` changes every render; the cards only need it when a read lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, cloud, held, passUse],
  );
  const smartBalance = cloudSmartBalance(account);
  const onCount = cards.filter((card) => card.kind === "pass" && card.on && !card.ended).length;
  // The rule of the own-computer panel: with 2+ passes on, or while it is on.
  const canBalance = typeof window.ade?.providerLogins?.setCloudBalance === "function";
  const showBalance = canBalance && (onCount >= 2 || smartBalance);
  const line = claudePageLine(cards, smartBalance, account, cloud);
  const page = adeCloudPageLine(account, cloud);

  // ── The switch shows its new value at once; the returned status settles it ──
  const [switching, setSwitching] = useState<ReadonlyMap<string, boolean>>(new Map());
  const switchPass = useCallback(async (key: string, next: boolean) => {
    setSwitching((current) => new Map(current).set(key, next));
    try {
      await setSwitch(key, next, false);
    } finally {
      setSwitching((current) => {
        const rest = new Map(current);
        rest.delete(key);
        return rest;
      });
    }
  }, [setSwitch]);

  // ── "Use for new chats": the write, and a toast with Undo back to the pick before it ──
  const pickForNewChats = useCallback(async (card: Extract<PassCardModel, { kind: "pass" }>) => {
    // One pin for the flow: the write and its Undo reach the same brain.
    const pin = accountPin;
    const previous = account.state === "ok" ? account.status.cloud.inUse.claude ?? null : null;
    const done = await runWrite(
      `use:${card.key}`,
      () => window.ade?.providerLogins?.use?.({ provider: "claude", key: card.key }, pin),
      "ADE couldn't change the pass for new chats. Try again.",
    );
    if (!done) return;
    showToast({
      id: "ade-cloud-use-claude",
      tone: "success",
      title: `New cloud chats now use ${card.title}`,
      actions: previous === card.key ? [] : [{
        label: "Undo",
        onClick: () => {
          void runWrite(
            `use:${card.key}:undo`,
            () => window.ade?.providerLogins?.use?.({ provider: "claude", key: previous }, pin),
            "ADE couldn't change it back. Try again.",
          );
        },
      }],
    });
  }, [account, accountPin, runWrite]);

  // ── Remove: the short confirm, then the held write ──
  const removePass = useCallback(async (card: PassCardModel) => {
    const ok = await confirmDialog({
      title: "Remove this Claude pass?",
      message: "ADE Cloud stops using this pass.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    const pin = accountPin;
    hold({
      id: card.key,
      title: "Removed the Claude pass.",
      write: () => {
        void runWrite(
          `remove:${card.key}`,
          () => window.ade?.providerLogins?.remove?.({ key: card.key }, pin),
          "ADE couldn't remove the Claude pass. It is back on the page.",
        );
      },
    });
  }, [accountPin, hold, runWrite]);

  const setBalance = useCallback((on: boolean) => {
    void runWrite(
      "balance:claude",
      () => window.ade?.providerLogins?.setCloudBalance?.({ provider: "claude", on }, accountPin),
      "ADE couldn't change smart balance for ADE Cloud. Try again.",
    );
  }, [accountPin, runWrite]);

  return (
    <div className="ade-pv-provider" style={providerThemeVars(brand)} data-place="ade-cloud" data-provider="claude">
      <ProviderHero
        descriptor={descriptor}
        status={{ state: tile.state, label: tile.chipLabel, account: null }}
        version={null}
        pin={accountPin}
        modelLabel={identity}
        // The descriptor's line is about a computer's own sign-in; the line below says what ADE Cloud does.
        tagline={null}
        accountUsageOnly
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span data-testid="ade-cloud-provider-line" style={{ flex: "1 1 260px", fontSize: 12.5, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: 1.45 }}>
          {line}
        </span>
        {page.recheck ? (
          <button
            type="button"
            disabled={signIns.rechecking}
            aria-busy={signIns.rechecking || undefined}
            onClick={recheck}
            style={outlineButton({ height: 28, padding: "0 11px", fontSize: 12 })}
          >
            {signIns.rechecking ? "Checking…" : "Re-check"}
          </button>
        ) : null}
      </div>

      <section className="kit-card">
        <header className="kit-card-head">
          <Ticket size={14} />
          Claude passes for ADE Cloud
          {cards.length ? <span className="kit-card-head-count">{cards.length}</span> : null}
          <span style={{ flex: 1 }} />
          {account.state === "ok" && cards.length > 0 ? (
            <button
              type="button"
              onClick={() => openPassSheet({ renewKey: null, forEmail: null })}
              style={{ ...outlineButton({ height: 26, padding: "0 10px", fontSize: 12 }), display: "inline-flex", alignItems: "center", gap: 5 }}
            >
              <Plus size={11} weight="bold" /> Add a pass
            </button>
          ) : null}
        </header>
        <div className="kit-card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {showBalance ? (
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
              <RoutingSwitch label="Smart balance" hint={SMART_BALANCE_HINT} checked={smartBalance} onChange={setBalance} />
              {/* With smart balance on, the line under the banner says what it does. */}
              {smartBalance ? null : (
                <span style={{ marginLeft: "auto", fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textDim }}>
                  New chats use the pass marked New chats.
                </span>
              )}
            </div>
          ) : null}

          {account.state === "loading" ? (
            <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textDim }}>Reading your ADE account…</span>
          ) : cards.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 240px", fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 }}>
                {account.state === "failed" ? "ADE couldn't read your ADE account." : "No Claude pass yet. A pass lets cloud chats use your Claude plan."}
              </span>
              {account.state === "ok" ? (
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-tone="primary"
                  onClick={() => openPassSheet({ renewKey: null, forEmail: null })}
                >
                  Sign in
                </button>
              ) : null}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, alignItems: "stretch" }}>
              {cards.map((card) => {
                const pending = switching.get(card.key);
                const shown = card.kind === "pass" && pending !== undefined ? { ...card, on: pending } : card;
                return (
                  <PassCard
                    key={card.key}
                    card={shown}
                    smartBalance={smartBalance}
                    busy={busy.has(`switch:${card.key}`) || busy.has(`use:${card.key}`) || busy.has(`remove:${card.key}`)}
                    onUse={() => {
                      if (card.kind === "pass") void pickForNewChats(card);
                    }}
                    onSwitch={(next) => void switchPass(card.key, next)}
                    onRenew={() => {
                      if (card.kind === "pass") openPassSheet({ renewKey: card.key, forEmail: card.email });
                    }}
                    onRemove={() => void removePass(card)}
                  />
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
