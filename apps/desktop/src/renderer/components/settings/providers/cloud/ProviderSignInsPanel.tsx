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
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UserCircle } from "@phosphor-icons/react";
import type { ProviderLoginProvider, ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { showToast } from "../../../app/toast/toastStore";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import { signInMachineWords } from "../signInSheetParts";
import { COPILOT_REPO_LINE } from "./adeCloudSignInModel";
import { inUseCard, previousPick, signInCardGroups, type SignInCardModel } from "./adeCloudPageModel";
import { SignInAccountCard } from "./SignInAccountCard";
import { confirmRemoveSignIn, confirmUseOnCloud, type RunWrite } from "./signInWrites";
import { useAllowKeychain } from "./useAllowKeychain";
import { GitHubCliLoginRow } from "./GitHubCliLoginRow";
import { useHeldWrites } from "./useHeldWrites";
import { useThisComputerPin } from "./useAdeCloudSignIns";

const noteStyle: React.CSSProperties = { fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 };

export function ProviderSignInsPanel({ provider, providerLabel }: { provider: ProviderLoginProvider; providerLabel: string }) {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const pageKey = pin?.key ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const { accountPin, keychainIsThisMac } = useThisComputerPin();
  const { held, hold } = useHeldWrites();

  // ── The page machine's read ──
  const [read, setRead] = useState<{ key: string | null; status: ProviderLoginStatus } | null>(null);
  const [tick, setTick] = useState(0);
  const bridge = typeof window === "undefined" ? undefined : window.ade?.providerLogins;
  useEffect(() => {
    const off = bridge?.onChanged?.(() => setTick((value) => value + 1));
    return () => off?.();
  }, [bridge]);
  useEffect(() => {
    if (typeof bridge?.status !== "function") return undefined;
    let cancelled = false;
    const key = pageKey;
    bridge.status({ provider }, pinRef.current).then(
      (status) => {
        if (!cancelled) setRead({ key, status });
      },
      (error: unknown) => console.warn("[providers] reading the account's sign-ins for this page failed", error),
    );
    return () => {
      cancelled = true;
    };
  }, [bridge, pageKey, provider, tick]);
  // A read for another machine (the page changed) is not this page's.
  const status = read && read.key === pageKey ? read.status : null;

  // ── Writes: through This computer; its status is this page's only when the page is This computer ──
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const runWrite = useCallback<RunWrite>(async (id, write, failure) => {
    if (busyRef.current.has(id)) return false;
    busyRef.current.add(id);
    setBusy(new Set(busyRef.current));
    const keyAtStart = pageKey;
    try {
      const next = await write();
      if (!mountedRef.current || (pinRef.current?.key ?? null) !== keyAtStart) return true;
      // The write answered from This computer: that status is this page's only on This computer's page.
      if (next && isThisMachine) setRead({ key: keyAtStart, status: next });
      else setTick((value) => value + 1);
      return true;
    } catch (error) {
      console.warn("[providers] changing a sign-in from a computer's page failed", error);
      if (mountedRef.current) showToast({ tone: "error", title: failure });
      return false;
    } finally {
      busyRef.current.delete(id);
      if (mountedRef.current) setBusy(new Set(busyRef.current));
    }
  }, [isThisMachine, pageKey]);

  const allowRun = useCallback(() => runWrite(
    "allow:antigravity",
    () => window.ade?.providerLogins?.allowKeychain?.({ provider: "antigravity" }, accountPin),
    "ADE couldn't copy the Antigravity sign-in from this Mac.",
  ), [accountPin, runWrite]);
  const { allowing, allow } = useAllowKeychain(allowRun);
  // A GitHub CLI write answers from the page's own machine: apply it while the page still shows that machine.
  const applyPageStatus = useCallback((key: string | null, next: ProviderLoginStatus) => {
    if (mountedRef.current && (pinRef.current?.key ?? null) === key) setRead({ key, status: next });
  }, []);

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
  // Nothing to show: no sign-in in the account, nothing is captured here, no Keychain to allow, no GitHub CLI login.
  if (cardCount === 0 && status.thisComputer.capture === "off" && !keychain && !ghCli && !ghCliCloudLine) return null;

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
        {cardCount === 0 ? (
          <span style={noteStyle}>No {providerLabel} sign-in in your ADE account yet.</span>
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
