/**
 * One provider's page on ADE Cloud (every provider but Claude): the banner,
 * one line on what ADE Cloud does with it now, the account's sign-ins as
 * cards, and the saved ADE Cloud key.
 *
 * Every write is account-wide and goes through This computer (`accountPin`);
 * the view's `runWrite` applies its returned status. A sign-in on the cloud
 * computer (fallback providers) goes through that computer's pin, for the
 * whole sheet. Nothing here reads on a timer.
 */
import React, { useCallback, useMemo, useState } from "react";
import { ArrowSquareOut, Key, UserCircle } from "@phosphor-icons/react";
import type { CloudSignInStatus } from "../../../../../shared/cloudSignIns";
import { isAgentCliLoginProvider } from "../../../../../shared/types/agentCliLogin";
import type { ProviderLoginProvider, ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { ipcErrorMessage } from "../../../../lib/format";
import { openExternalUrl } from "../../../../lib/openExternal";
import { COLORS, SANS_FONT, outlineButton } from "../../../lanes/laneDesignTokens";
import { confirmDialog } from "../../../ui/dialog/confirm";
import { NoticeBadge } from "../../../ui/notice/NoticeParts";
import { showToast } from "../../../app/toast/toastStore";
import { SettingsTextField } from "../../primitives";
import { ProviderHero } from "../ProviderHero";
import { providerBrand, providerThemeVars } from "../providerBrand";
import { CliSignInSheet, TerminalSignInSheet, agentCliSignInSupported } from "../ProviderSignInSheet";
import { connectionKeyFor, providerSignIn } from "../providerSignInCommands";
import type { ProviderTileAction } from "../ProviderTileView";
import type { ProviderDescriptor } from "../types";
import { COPILOT_REPO_LINE, accountUnreadable, type AdeCloudTile } from "./adeCloudSignInModel";
import {
  inUseCard,
  previousPick,
  providerPageLine,
  savedKeyRow,
  signInCardGroups,
  type SavedKeyRowModel,
  type SignInCardModel,
} from "./adeCloudPageModel";
import { SignInAccountCard } from "./SignInAccountCard";
import type { AdeCloudSignInsState } from "./useAdeCloudSignIns";
import type { HeldWrites } from "./useHeldWrites";

export type RunWrite = (id: string, write: () => Promise<ProviderLoginStatus> | undefined, failure: string) => Promise<boolean>;

const identity = (id: string) => id;

export function AdeCloudProviderPage({
  descriptor,
  tile,
  signIns,
  busy,
  runWrite,
  setSwitch,
  heldWrites,
  tileAction,
  carried,
}: {
  descriptor: ProviderDescriptor;
  tile: AdeCloudTile;
  signIns: AdeCloudSignInsState;
  busy: ReadonlySet<string>;
  runWrite: RunWrite;
  /** The view's switch write (it asks first for Copilot). */
  setSwitch: (key: string, on: boolean, confirmOn: boolean) => Promise<void>;
  heldWrites: HeldWrites;
  /** The tile's own action (Sign in here, Allow, Re-check), for a page with no card. */
  tileAction: ProviderTileAction | null;
  /** The account carries this provider's sign-ins (cards); else it is a fallback provider. */
  carried: boolean;
}) {
  const provider = descriptor.id as ProviderLoginProvider;
  const { account, cloud, saved, reporting, accountPin } = signIns;
  const { held, hold } = heldWrites;
  const now = Date.now();
  const brand = providerBrand(descriptor.id);

  const groups = useMemo(
    () => signInCardGroups(provider, account, held, now),
    // `now` changes every render; the cards only need it when a read lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, held, provider],
  );
  const cardCount = groups.reduce((sum, group) => sum + group.cards.length, 0);
  const keyRow = savedKeyRow(provider, account, saved);
  const line = providerPageLine(tile, account, cloud);

  // ── The switch shows its new value at once; the returned status settles it ──
  const [switching, setSwitching] = useState<ReadonlyMap<string, boolean>>(new Map());
  const switchCard = useCallback(async (card: SignInCardModel, next: boolean) => {
    setSwitching((current) => new Map(current).set(card.key, next));
    try {
      await setSwitch(card.key, next, provider === "copilot");
    } finally {
      setSwitching((current) => {
        const rest = new Map(current);
        rest.delete(card.key);
        return rest;
      });
    }
  }, [provider, setSwitch]);

  // ── "Use on ADE Cloud": confirm, write, toast with Undo ──
  const pickOnCloud = useCallback(async (args: { key: string; slot: string | null; place: string; name: string; busyId: string }) => {
    const current = inUseCard(groups, args.place);
    const repo = provider === "copilot" ? ` ${COPILOT_REPO_LINE}` : "";
    const ok = await confirmDialog({
      title: `Use ${args.name} on ADE Cloud?`,
      message: current && current.key !== args.key
        ? `A turn that runs now finishes on ${current.name}. The next message in each cloud chat uses ${args.name}.${repo}`
        : `The next message in each cloud chat uses ${args.name}.${repo}`,
      confirmLabel: "Use it",
    });
    if (!ok) return;
    // The flow keeps one pin: the write and its Undo reach the same brain.
    const pin = accountPin;
    const previous = previousPick(account, args.place);
    const done = await runWrite(
      args.busyId,
      () => window.ade?.providerLogins?.use?.({ provider, key: args.key, slot: args.slot }, pin),
      "ADE couldn't change the sign-in for ADE Cloud. Try again.",
    );
    if (!done) return;
    showToast({
      id: `ade-cloud-use-${args.place}`,
      tone: "success",
      title: `ADE Cloud now uses ${args.name}`,
      actions: previous === args.key ? [] : [{
        label: "Undo",
        onClick: () => {
          void runWrite(
            `${args.busyId}:undo`,
            () => window.ade?.providerLogins?.use?.({ provider, key: previous, slot: args.slot }, pin),
            "ADE couldn't change it back. Try again.",
          );
        },
      }],
    });
  }, [account, accountPin, groups, provider, runWrite]);

  // ── Remove: confirm, hide, toast with Undo, the write when the toast ends ──
  const removeCard = useCallback(async (card: SignInCardModel) => {
    const from = card.originIsThisComputer ? "this computer" : card.origin;
    const keeps = card.originIsThisComputer ? "This computer keeps its own sign-in." : `${card.origin} keeps its own sign-in.`;
    const ok = await confirmDialog({
      title: `Remove the ${descriptor.label} sign-in from ${from}?`,
      message: `ADE Cloud stops using it, and each cloud computer drops it. ${keeps}`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    const pin = accountPin;
    hold({
      id: card.key,
      title: `Removed the ${descriptor.label} sign-in from ${from}.`,
      write: () => {
        void runWrite(
          `remove:${card.key}`,
          () => window.ade?.providerLogins?.remove?.({ key: card.key }, pin),
          `ADE couldn't remove the ${descriptor.label} sign-in. It is back on the page.`,
        );
      },
    });
  }, [accountPin, descriptor.label, hold, runWrite]);

  // ── A sign-in on the cloud computer (fallback providers), through its pin ──
  const [sheet, setSheet] = useState<{ kind: "cli" | "terminal"; machine: NonNullable<typeof reporting> } | null>(null);
  const terminalSignIn = providerSignIn(descriptor.id);
  const cloudSignInKind: "cli" | "terminal" | null = isAgentCliLoginProvider(descriptor.id) && agentCliSignInSupported()
    ? "cli"
    : terminalSignIn ? "terminal" : null;
  const cloudSignedIn = tile.row === "F1";

  const recheckButton = tileAction?.kind === "button" && tileAction.label === "Re-check" ? tileAction : null;

  return (
    <div className="ade-pv-provider" style={providerThemeVars(brand)} data-place="ade-cloud" data-provider={descriptor.id}>
      <ProviderHero
        descriptor={descriptor}
        status={{ state: tile.state, label: tile.chipLabel, account: null }}
        version={null}
        pin={accountPin}
        modelLabel={identity}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span data-testid="ade-cloud-provider-line" style={{ flex: "1 1 260px", fontSize: 12.5, fontFamily: SANS_FONT, color: COLORS.textSecondary, lineHeight: 1.45 }}>
          {line}
        </span>
        {recheckButton ? (
          <button
            type="button"
            disabled={recheckButton.busy}
            aria-busy={recheckButton.busy || undefined}
            aria-label={recheckButton.aria}
            onClick={recheckButton.run}
            style={outlineButton({ height: 28, padding: "0 11px", fontSize: 12 })}
          >
            {recheckButton.busy ? "Checking…" : "Re-check"}
          </button>
        ) : null}
      </div>

      {carried ? (
        <section className="kit-card">
          <header className="kit-card-head">
            <UserCircle size={14} />
            Sign-ins in your ADE account
            {cardCount ? <span className="kit-card-head-count">{cardCount}</span> : null}
          </header>
          <div className="kit-card-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {account.state === "loading" ? (
              <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textDim }}>Reading your ADE account…</span>
            ) : cardCount === 0 ? (
              <NoSignInRow
                text={accountUnreadable(account) ? "ADE couldn't read your ADE account." : "No sign-in in your ADE account yet."}
                action={accountUnreadable(account) ? null : tileAction}
              />
            ) : (
              groups.map((group) => (
                <div key={group.place} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {group.title ? (
                    <span style={{ fontSize: 12, fontWeight: 600, fontFamily: SANS_FONT, color: COLORS.textSecondary }}>{group.title}</span>
                  ) : null}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12, alignItems: "stretch" }}>
                    {group.cards.map((card) => {
                      const pending = switching.get(card.key);
                      const shown = pending === undefined ? card : { ...card, on: pending, inUse: pending ? card.inUse : false };
                      return (
                        <SignInAccountCard
                          key={card.key}
                          card={shown}
                          busy={busy.has(`switch:${card.key}`) || busy.has(`use:${card.key}`) || busy.has(`remove:${card.key}`)}
                          onUse={() => void pickOnCloud({ key: card.key, slot: card.slot, place: card.place, name: card.name, busyId: `use:${card.key}` })}
                          onSwitch={(next) => void switchCard(card, next)}
                          onRemove={() => void removeCard(card)}
                        />
                      );
                    })}
                  </div>
                </div>
              ))
            )}
            {provider === "copilot" && cardCount > 0 ? <span style={noteStyle}>{COPILOT_REPO_LINE}</span> : null}
            {provider === "pi" ? <span style={noteStyle}>Pi's Claude sign-in stays on each computer.</span> : null}
          </div>
        </section>
      ) : (
        <section className="kit-card">
          <header className="kit-card-head">
            <UserCircle size={14} />
            Sign-in on the cloud computer
          </header>
          <div className="kit-card-body" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ ...noteStyle, flex: "1 1 240px" }}>
              {cloudSignedIn && reporting
                ? `Signed in on ${reporting.machineName}. Each cloud computer keeps its own sign-in.`
                : `ADE can't bring this sign-in from your computers. Each cloud computer signs in to ${descriptor.label} on its own.`}
            </span>
            {reporting && cloudSignInKind && !cloudSignedIn ? (
              <button
                type="button"
                onClick={() => setSheet({ kind: cloudSignInKind, machine: reporting })}
                style={outlineButton({ height: 28, padding: "0 11px", fontSize: 12 })}
              >
                Sign in on {reporting.machineName}
              </button>
            ) : null}
          </div>
        </section>
      )}

      {keyRow ? (
        <SavedKeyRow
          row={keyRow}
          held={held.has(`key:${keyRow.spec.id}`)}
          busy={busy.has(`use-key:${provider}`)}
          applySaved={signIns.applySaved}
          // "your saved key": the words the chat's switch line uses for it.
          onUse={() => void pickOnCloud({ key: "key", slot: null, place: provider, name: "your saved key", busyId: `use-key:${provider}` })}
          onRemove={() => {
            hold({
              id: `key:${keyRow.spec.id}`,
              title: `Removed the ${keyRow.spec.keyName} from ADE Cloud.`,
              write: () => {
                // The key store is the account's, through this computer's brain (no pin to pass).
                void window.ade?.cloud?.cloudSignInRemove?.(keyRow.spec.id).then(
                  (status) => signIns.applySaved(status),
                  (error: unknown) => {
                    console.warn("[providers] removing the ADE Cloud key failed", error);
                    showToast({ tone: "error", title: `ADE couldn't remove the ${keyRow.spec.keyName}. It is back on the page.` });
                  },
                );
              },
            });
          }}
        />
      ) : null}

      {sheet?.kind === "cli" && isAgentCliLoginProvider(descriptor.id) ? (
        <CliSignInSheet
          provider={descriptor.id}
          providerLabel={descriptor.label}
          pin={sheet.machine.pin}
          isThisMachine={false}
          machineName={sheet.machine.machineName}
          onClose={() => {
            setSheet(null);
            signIns.refreshCloudAi();
          }}
        />
      ) : null}
      {sheet?.kind === "terminal" && terminalSignIn ? (
        <TerminalSignInSheet
          pin={sheet.machine.pin}
          isThisMachine={false}
          machineName={sheet.machine.machineName}
          providerId={descriptor.id}
          providerLabel={terminalSignIn.label}
          command={terminalSignIn.command}
          toolType={terminalSignIn.toolType}
          onClose={() => {
            setSheet(null);
            signIns.refreshCloudAi();
          }}
          checkSignedIn={async () => {
            // The same pin as the sheet: the login is read where it was made.
            const next = await window.ade.ai.getStatus({ force: true }, sheet.machine.pin).catch(() => null);
            const key = connectionKeyFor(descriptor.id);
            return key !== null && next?.providerConnections?.[key]?.authAvailable === true;
          }}
        />
      ) : null}
    </div>
  );
}

const noteStyle: React.CSSProperties = { fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.45 };

/** A carried provider with no sign-in in the account: the line above says why; this row has the action. */
function NoSignInRow({ text, action }: { text: string; action: ProviderTileAction | null }) {
  const button = action?.kind === "button" && action.label !== "Re-check" ? action : null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <span style={{ ...noteStyle, flex: "1 1 240px" }}>{text}</span>
      {button ? (
        <button
          type="button"
          disabled={button.busy}
          aria-busy={button.busy || undefined}
          aria-label={button.aria}
          onClick={button.run}
          style={outlineButton({ height: 28, padding: "0 11px", fontSize: 12 })}
        >
          {/* The page has room for the whole label the tile shortens. */}
          {button.label === "Allow" ? "Allow on this Mac" : button.label === "Sign in" ? "Sign in on this computer" : button.label}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The saved ADE Cloud key (moved here from the cloud sign-ins card, which
 * stays until the ADE Cloud page drops it): Save, Replace, Remove, and "Use
 * on ADE Cloud". The key store is the account's, written through this
 * computer's brain, so these calls take no pin.
 */
function SavedKeyRow({
  row,
  held,
  busy,
  applySaved,
  onUse,
  onRemove,
}: {
  row: SavedKeyRowModel;
  /** Its Remove waits on the toast: it shows as not saved. */
  held: boolean;
  busy: boolean;
  applySaved: (status: CloudSignInStatus | null | undefined) => void;
  onUse: () => void;
  onRemove: () => void;
}) {
  const { spec } = row;
  const saved = row.saved === true && !held;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyUrl = spec.keyUrl;

  const save = async () => {
    if (saving || !draft.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const next = await window.ade?.cloud?.cloudSignInSaveKey?.(spec.id, draft);
      applySaved(next);
      setDraft("");
      setEditing(false);
    } catch (saveError) {
      setError(ipcErrorMessage(saveError) || "ADE couldn't save the key. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="kit-card" data-testid={`ade-cloud-key-${spec.id}`}>
      <header className="kit-card-head">
        <Key size={14} />
        Saved key for ADE Cloud
      </header>
      <div className="kit-card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 500, fontFamily: SANS_FONT, color: COLORS.textPrimary }}>{spec.keyName}</span>
          <span style={{ fontSize: 12, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
            {row.saved === null && !held ? "· Checking…" : saved ? "· Saved" : "· Not saved"}
          </span>
          {saved && row.inUse ? <NoticeBadge tone="accent">In use on ADE Cloud</NoticeBadge> : null}
          <span style={{ flex: 1 }} />
          {saved && row.canUse ? (
            <button type="button" disabled={busy} aria-busy={busy || undefined} onClick={onUse} style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12 })}>
              Use on ADE Cloud
            </button>
          ) : null}
          <button
            type="button"
            disabled={row.saved === null || saving}
            onClick={() => {
              setDraft("");
              setError(null);
              setEditing((open) => !open);
            }}
            style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12 })}
          >
            {editing ? "Cancel" : saved ? "Replace" : "Add key"}
          </button>
          {saved ? (
            <button type="button" onClick={onRemove} style={{ ...outlineButton({ height: 26, padding: "0 10px", fontSize: 12 }), color: COLORS.danger }}>
              Remove
            </button>
          ) : null}
        </div>
        <span style={noteStyle}>
          Used when no sign-in is on.{row.sharedNote ? ` ${row.sharedNote}` : ""}
          {keyUrl ? (
            <>
              {" "}
              <button
                type="button"
                onClick={() => openExternalUrl(keyUrl)}
                style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: 0, border: 0, background: "transparent", color: "var(--color-accent)", font: "inherit", cursor: "pointer" }}
              >
                Get a key <ArrowSquareOut size={11} />
              </button>
            </>
          ) : null}
        </span>
        {editing ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <SettingsTextField
                type="password"
                value={draft}
                onChange={setDraft}
                placeholder={`Paste your ${spec.keyName}`}
                ariaLabel={spec.keyName}
                mono
                autoFocus
                autoComplete="off"
                spellCheck={false}
                onKeyDown={(event) => { if (event.key === "Enter") void save(); }}
              />
            </div>
            <button
              type="button"
              className="ade-modern-btn"
              data-tone="primary"
              disabled={saving || !draft.trim()}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
        {error ? <span role="alert" style={{ ...noteStyle, color: COLORS.danger }}>{error}</span> : null}
      </div>
    </section>
  );
}
