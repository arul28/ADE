/**
 * A computer's provider page (one-account providers: Grok, Cursor, Droid,
 * Copilot, Kimi, Devin, Qwen, Antigravity, OpenCode, Pi): the provider's
 * sign-ins in the ADE account, as cards, and which one this computer uses.
 *
 * - On an own computer, "In use here" is the sign-in this computer has. Own
 *   computers can't take a sign-in from the account yet, so the other cards
 *   say how to use them there, with no button that would fail.
 * - On a cloud computer, "In use here" is the one it applied, and the others
 *   offer "Use on ADE Cloud" (the choice is account-wide).
 * - Antigravity on a Mac: the Keychain state, with "Allow on this Mac" only
 *   on this Mac's own page.
 * - Copilot: this computer's GitHub CLI login (`GitHubCliLoginRow`), turned
 *   on only on its own page, off from any page with that page's pin.
 *
 * Reads go to the page's machine (`useSettingsMachineScope().pin`), on open
 * and on `providerLogins.onChanged`, keyed on the pin's key. Writes are
 * account-wide and go through This computer, with the pin of the flow's start.
 * No timer and no poll.
 */
import React, { useCallback, useMemo, useRef } from "react";
import { UserCircle } from "@phosphor-icons/react";
import type { ProviderLoginProvider, ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import { signInMachineWords } from "../signInSheetParts";
import { COPILOT_REPO_LINE } from "./adeCloudSignInModel";
import { inUseCard, previousPick, signInCardGroups, type SignInCardModel } from "./adeCloudPageModel";
import { SignInAccountCard } from "./SignInAccountCard";
import { confirmRemoveSignIn, confirmUseOnCloud, useSignInWrites } from "./signInWrites";
import { useAllowAntigravityKeychain } from "./useAllowKeychain";
import { Banner } from "../../../ui/notice/Banner";
import { usePinnedProviderLoginStatus } from "./usePinnedProviderLoginStatus";
import { GitHubCliLoginRow } from "./GitHubCliLoginRow";
import { useHeldWrites } from "./useHeldWrites";
import { useThisComputerPin } from "./useAdeCloudSignIns";

const noteStyle: React.CSSProperties = { fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 };

export function ProviderSignInsPanel({ provider, providerLabel }: { provider: ProviderLoginProvider; providerLabel: string }) {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const pageKey = pin?.key ?? null;
  const { accountPin, keychainIsThisMac } = useThisComputerPin();
  const { held, hold } = useHeldWrites();

  // ── The page machine's read ──
  const { status, apply: applyPageStatus, refresh } = usePinnedProviderLoginStatus({
    provider,
    pin,
    warning: "[providers] reading the account's sign-ins for this page failed",
  });

  // ── Writes: through This computer; its status is this page's only when the page is This computer ──
  const pageKeyRef = useRef(pageKey);
  pageKeyRef.current = pageKey;
  const { busy, runWrite } = useSignInWrites({
    keyRef: pageKeyRef,
    onStatus: useCallback((next: ProviderLoginStatus | undefined, keyAtStart: string | null) => {
      // The write answered from This computer: that status is this page's only on This computer's page.
      if (next && isThisMachine) applyPageStatus(keyAtStart, next);
      else refresh();
    }, [applyPageStatus, isThisMachine, refresh]),
    warning: "[providers] changing a sign-in from a computer's page failed",
  });
  const { allowing, allow } = useAllowAntigravityKeychain(runWrite, accountPin);
  // A GitHub CLI write answers from the page's own machine: `applyPageStatus` keeps it while the page still shows that machine.

  const account = useMemo(() => (status ? { state: "ok" as const, status } : { state: "loading" as const }), [status]);
  const now = Date.now();
  const groups = useMemo(
    () => signInCardGroups(provider, account, held, now),
    // `now` changes every render; the cards only need it when a read lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, held, provider],
  );

  if (!status) return null;
  const row = status.providers.find((entry) => entry.provider === provider) ?? null;
  // Copilot (and any provider) follows its carry state: a provider the account doesn't carry has no cards.
  if (row?.carry !== "carried") return null;
  const cardCount = groups.reduce((sum, group) => sum + group.cards.length, 0);
  const cloudComputer = status.thisComputer.cloudComputer;
  const keychain = provider === "antigravity" ? row.keychain ?? null : null;
  // Copilot's GitHub CLI login: on an own computer its row, on a cloud computer where to turn it on.
  const ghCli = provider === "copilot" ? row.ghCli ?? null : null;
  const ghCliCloudLine = provider === "copilot" && !ghCli && cloudComputer;
  // This computer's copy in the account can't be read here (another key wrote it, or a newer ADE):
  // capture keeps it, so the person removes it, and this computer saves its own sign-in again.
  const unreadableKey = row.local.state === "account_unreadable" ? row.local.key : null;
  // Nothing to show: no sign-in in the account, nothing is captured here, no Keychain to allow, no GitHub CLI login.
  if (cardCount === 0 && status.thisComputer.capture === "off" && !keychain && !ghCli && !ghCliCloudLine && !unreadableKey) return null;

  const machineWords = signInMachineWords(isThisMachine, machineName);
  const inUseHere = (card: SignInCardModel): boolean => {
    if (!cloudComputer) return row.local.key === card.key;
    const applied = (status.applied ?? []).find((entry) => entry.place === card.place);
    return applied?.state === "applied" && applied.key === card.key;
  };

  const pickOnCloud = (card: SignInCardModel) => {
    const current = inUseCard(groups, card.place);
    void confirmUseOnCloud({
      provider,
      key: card.key,
      slot: card.slot,
      name: card.name,
      current: current ? { key: current.key, name: current.name } : null,
      previous: previousPick(account, card.place),
      place: card.place,
      busyId: `use:${card.key}`,
      pin: accountPin,
      runWrite,
    });
  };

  return (
    <section className="kit-card" data-testid="provider-sign-ins-panel" data-provider={provider}>
      <header className="kit-card-head">
        <UserCircle size={14} />
        Sign-ins in your ADE account
        {cardCount ? <span className="kit-card-head-count">{cardCount}</span> : null}
      </header>
      <div className="kit-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {unreadableKey ? (
          <Banner
            layout="inline"
            model={{
              id: `sign-in-unreadable-${unreadableKey}`,
              tone: "warning",
              title: `ADE can't read this computer's ${providerLabel} sign-in in your account.`,
              detail: "Remove it, and ADE saves this computer's sign-in again.",
              actions: [{
                label: "Remove from account",
                busy: busy.has(`remove:${unreadableKey}`),
                onClick: () => {
                  void confirmRemoveSignIn({
                    key: unreadableKey,
                    providerLabel,
                    origin: "this computer",
                    originIsThisComputer: true,
                    pin: accountPin,
                    hold,
                    runWrite,
                  });
                },
              }],
            }}
          />
        ) : null}
        {cardCount === 0 ? (
          unreadableKey ? null : <span style={noteStyle}>No {providerLabel} sign-in in your ADE account yet.</span>
        ) : (
          groups.map((group) => (
            <div key={group.place} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {group.title ? (
                <span style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>{group.title}</span>
              ) : null}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, alignItems: "stretch" }}>
                {group.cards.map((card) => (
                  <SignInAccountCard
                    key={card.key}
                    card={card}
                    busy={busy.has(`use:${card.key}`) || busy.has(`remove:${card.key}`)}
                    where={cloudComputer
                      ? { kind: "cloud-computer", inUseHere: inUseHere(card) }
                      : { kind: "own-computer", inUseHere: inUseHere(card), machineWords }}
                    onUse={cloudComputer ? () => pickOnCloud(card) : undefined}
                    onRemove={() => {
                      void confirmRemoveSignIn({
                        key: card.key,
                        providerLabel,
                        origin: card.origin,
                        originIsThisComputer: card.originIsThisComputer,
                        pin: accountPin,
                        hold,
                        runWrite,
                      });
                    }}
                  />
                ))}
              </div>
            </div>
          ))
        )}
        {provider === "copilot" && cardCount > 0 ? <span style={noteStyle}>{COPILOT_REPO_LINE}</span> : null}
        {provider === "pi" ? <span style={noteStyle}>Pi's Claude sign-in stays on each computer.</span> : null}
        {ghCli ? (
          <GitHubCliLoginRow
            row={row}
            gh={ghCli}
            status={status}
            pin={pin}
            pageKey={pageKey}
            isThisMachine={isThisMachine}
            machineName={machineName}
            onStatus={applyPageStatus}
          />
        ) : null}
        {ghCliCloudLine ? (
          <span style={{ ...noteStyle, borderTop: `1px solid ${COLORS.borderMuted}`, paddingTop: 12 }}>
            A cloud computer does not copy a GitHub CLI login. Turn it on on the computer where you use the GitHub CLI.
          </span>
        ) : null}
        {keychain ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", borderTop: `1px solid ${COLORS.borderMuted}`, paddingTop: 12 }}>
            <span style={{ ...noteStyle, flex: "1 1 240px" }}>
              {/* Only this Mac's ADE can ask its Keychain; another Mac's page says where to do it. */}
              {isThisMachine ? keychain.message : `Allow it on ${machineName}. ADE reads a Mac's Keychain only on that Mac.`}
            </span>
            {isThisMachine && keychainIsThisMac && keychain.canAllow ? (
              <button
                type="button"
                disabled={allowing}
                aria-busy={allowing || undefined}
                aria-label="Allow on this Mac: ADE copies the Antigravity sign-in from this Mac's Keychain"
                onClick={allow}
                style={outlineButton({ height: 28, padding: "0 11px", fontSize: 12 })}
              >
                {allowing ? "Waiting for macOS…" : "Allow on this Mac"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
