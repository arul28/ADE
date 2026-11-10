/**
 * Settings › Providers on ADE Cloud: one tile per provider, saying whether
 * cloud chats can use it and where its sign-in comes from.
 *
 * ADE Cloud is not a machine. The tiles come from the account part at once;
 * the reporting cloud computer's part fills them in when it answers. No tile
 * waits on a cloud computer and nothing here wakes one.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { CaretDown, Check } from "@phosphor-icons/react";
import type { ProviderLoginProvider, ProviderLoginStatus } from "../../../../../shared/types/providerLogins";
import { isProviderLoginProvider } from "../../../../../shared/types/providerLogins";
import { AnchoredMenu } from "../../../ui/AnchoredMenu";
import { Banner } from "../../../ui/notice";
import { confirmDialog } from "../../../ui/dialog/confirm";
import { showToast } from "../../../app/toast/toastStore";
import { availableProviderDescriptors } from "../descriptors";
import { providerBrand } from "../providerBrand";
import { ProviderTileView, type ProviderTileAction } from "../ProviderTileView";
import type { ProviderDescriptor } from "../types";
import {
  ADE_CLOUD_OFF_BANNER,
  ADE_CLOUD_REACH_LINE,
  ADE_CLOUD_TILE_ORDER,
  COPILOT_REPO_LINE,
  adeCloudPageLine,
  adeCloudTile,
  cloudSignInsOn,
  type AdeCloudTile,
} from "./adeCloudSignInModel";
import { useAdeCloudSignIns, type AdeCloudSignInsState } from "./useAdeCloudSignIns";
import { useHeldWrites } from "./useHeldWrites";
import { AdeCloudProviderPage } from "./AdeCloudProviderPage";
import "../../machines/machinesPage.css";

const PROVIDER_ANCHOR_PREFIX = "ai-provider-";

/**
 * The Allow on this Mac read in flight, kept outside the view: macOS shows
 * its prompt while it waits, so leaving the page and coming back must not
 * start a second one. Cleared when the read ends, whatever the view does.
 */
let allowInFlight: Promise<unknown> | null = null;

/**
 * What the page and the tiles draw while a Remove waits on its toast: the
 * account and the saved keys without the held items, so nothing names a
 * sign-in or key that is about to go.
 */
function withoutHeld(state: AdeCloudSignInsState, held: ReadonlySet<string>): AdeCloudSignInsState {
  if (held.size === 0) return state;
  const account = state.account.state === "ok"
    ? { state: "ok" as const, status: { ...state.account.status, signIns: state.account.status.signIns.filter((signIn) => !held.has(signIn.key)) } }
    : state.account;
  const saved = state.saved?.map((entry) => (held.has(`key:${entry.id}`) ? { ...entry, saved: false } : entry)) ?? null;
  return { ...state, account, saved };
}

export function AdeCloudProvidersView({
  providerParam = null,
  onProviderChange,
}: {
  /** `?provider=<id>`: that provider's ADE Cloud page. Claude's page is not built yet; it shows the list. */
  providerParam?: string | null;
  onProviderChange?: (providerId: string | null) => void;
} = {}) {
  const readSignIns = useAdeCloudSignIns();
  // Remove waits on its toast; the page and the list share one set, so leaving either runs it.
  const heldWrites = useHeldWrites();
  const signIns = useMemo(() => withoutHeld(readSignIns, heldWrites.held), [heldWrites.held, readSignIns]);
  const { account, cloud, saved, candidates, reporting, accountPin, keychainIsThisMac } = signIns;
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const accountKey = accountPin?.key ?? null;
  const accountKeyRef = useRef(accountKey);
  accountKeyRef.current = accountKey;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const descriptors = useMemo(
    () => availableProviderDescriptors().filter((descriptor) => isProviderLoginProvider(descriptor.id)),
    [],
  );
  const now = Date.now();
  const rows = useMemo(
    () => descriptors.map((descriptor, index) => ({
      descriptor,
      index,
      tile: adeCloudTile({
        provider: descriptor.id as ProviderLoginProvider,
        account,
        cloud,
        saved,
        keychainIsThisMac,
        now,
      }),
    })),
    // `now` changes every render; the tiles only need it when a read lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [account, cloud, descriptors, keychainIsThisMac, saved],
  );

  // ── The order: set while the place opens and on Re-check, never by a switch or a change event ──
  // A tile that moved when its own switch changed put the next press on
  // another tile. The order is sorted when the account part first lands, once
  // more when the cloud part first lands (both while the place opens), and
  // after each Re-check; between those, a tile keeps its place.
  const accountSettled = account.state !== "loading";
  const cloudSettledRef = useRef(false);
  if (cloud.state !== "unknown" && cloud.state !== "loading") cloudSettledRef.current = true;
  const [sortGen, setSortGen] = useState(0);
  const sortToken = `${accountSettled ? 1 : 0}:${cloudSettledRef.current ? 1 : 0}:${sortGen}`;
  const orderRef = useRef<{ token: string; ids: readonly string[] } | null>(null);
  if (orderRef.current?.token !== sortToken) {
    const sorted = accountSettled
      ? [...rows].sort((a, b) => ADE_CLOUD_TILE_ORDER[a.tile.state] - ADE_CLOUD_TILE_ORDER[b.tile.state] || a.index - b.index)
      : rows;
    orderRef.current = { token: sortToken, ids: sorted.map((row) => row.descriptor.id) };
  }
  const orderIds = orderRef.current.ids;
  const tiles = useMemo(() => {
    const place = new Map(orderIds.map((id, index) => [id, index]));
    return [...rows].sort((a, b) => (place.get(a.descriptor.id) ?? rows.length + a.index) - (place.get(b.descriptor.id) ?? rows.length + b.index));
  }, [orderIds, rows]);

  const recheck = useCallback(async () => {
    if (signIns.rechecking) return;
    await signIns.recheck();
    if (mountedRef.current) setSortGen((gen) => gen + 1);
  }, [signIns]);

  // ── Writes: account-wide, through This computer; the returned status replaces the account part ──
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const busyRef = useRef(new Set<string>());
  const runWrite = useCallback(async (id: string, write: () => Promise<ProviderLoginStatus> | undefined, failure: string): Promise<boolean> => {
    // A second press while one waits starts nothing.
    if (busyRef.current.has(id)) return false;
    busyRef.current.add(id);
    setBusy(new Set(busyRef.current));
    const keyAtStart = accountKeyRef.current;
    try {
      const status = await write();
      if (status && mountedRef.current && accountKeyRef.current === keyAtStart) signIns.applyAccountStatus(status);
      return true;
    } catch (error) {
      console.warn("[providers] ADE Cloud sign-in change failed", error);
      if (mountedRef.current) showToast({ tone: "error", title: failure });
      return false;
    } finally {
      busyRef.current.delete(id);
      // Leaving the page while it waits leaves nothing behind: the state goes with the view.
      if (mountedRef.current) setBusy(new Set(busyRef.current));
    }
  }, [signIns]);

  const setSwitch = useCallback(async (key: string, on: boolean, confirmOn: boolean) => {
    if (on && confirmOn) {
      const ok = await confirmDialog({
        title: "Use this GitHub login on ADE Cloud?",
        message: `Copilot works on each cloud computer with no new sign-in. ${COPILOT_REPO_LINE}`,
        confirmLabel: "Turn on",
      });
      if (!ok) return;
    }
    await runWrite(`switch:${key}`, () => window.ade?.providerLogins?.setCloud?.({ key, on }, accountPin), "ADE couldn't change that sign-in. Try again.");
  }, [accountPin, runWrite]);

  const turnOnAll = useCallback(() => {
    void runWrite("all", () => window.ade?.providerLogins?.setCloudAll?.({ on: true }, accountPin), "ADE couldn't turn on sign-ins for ADE Cloud. Try again.");
  }, [accountPin, runWrite]);

  const [allowing, setAllowing] = useState(() => allowInFlight != null);
  useEffect(() => {
    // Opened while an earlier view's read still waits: show it as busy until it ends.
    if (!allowInFlight) return;
    void allowInFlight.finally(() => {
      if (mountedRef.current) setAllowing(false);
    });
  }, []);
  const allowKeychain = useCallback(() => {
    if (allowInFlight) return;
    setAllowing(true);
    const run = runWrite(
      "allow:antigravity",
      () => window.ade?.providerLogins?.allowKeychain?.({ provider: "antigravity" }, accountPin),
      "ADE couldn't copy the Antigravity sign-in from this Mac.",
    );
    allowInFlight = run;
    void run.finally(() => {
      if (allowInFlight === run) allowInFlight = null;
      if (mountedRef.current) setAllowing(false);
    });
  }, [accountPin, runWrite]);

  // Sign in for a carried provider runs on this computer: its own provider page has the sign-in.
  const openOnThisComputer = useCallback((providerId: string) => {
    const next = new URLSearchParams(searchParams);
    next.delete("machine");
    next.delete("harnesses");
    next.set("provider", providerId);
    navigate({ pathname: location.pathname, search: `?${next.toString()}`, hash: `#${PROVIDER_ANCHOR_PREFIX}${providerId}` }, { replace: true });
  }, [location.pathname, navigate, searchParams]);

  const tileAction = (descriptor: ProviderDescriptor, tile: AdeCloudTile): ProviderTileAction | null => {
    const action = tile.action;
    if (!action) return null;
    switch (action.kind) {
      case "switch":
        return {
          kind: "switch",
          aria: `Use ${descriptor.label} on ADE Cloud`,
          checked: action.on,
          busy: busy.has(`switch:${action.key}`),
          run: (next) => void setSwitch(action.key, next, action.confirmOn),
        };
      case "recheck":
        return { kind: "button", label: "Re-check", aria: `Re-check ${descriptor.label} on ADE Cloud`, busy: signIns.rechecking, run: () => void recheck() };
      case "sign-in-here":
        return { kind: "button", label: "Sign in", aria: `Sign in to ${descriptor.label} on this computer`, run: () => openOnThisComputer(descriptor.id) };
      case "allow-keychain":
        // A short label leaves the tile room for its line; the full words are its name.
        return { kind: "button", label: "Allow", aria: "Allow on this Mac: ADE copies the Antigravity sign-in from this Mac's Keychain", busy: allowing, run: allowKeychain };
      // The page has the sign-in on the cloud computer, through that computer's pin.
      case "sign-in-cloud":
        return onProviderChange
          ? { kind: "button", label: "Sign in", aria: `Sign in to ${descriptor.label} on the cloud computer`, run: () => onProviderChange(descriptor.id) }
          : null;
      // The Claude pass approve (step 4) is not built yet.
      default:
        return null;
    }
  };

  const line = adeCloudPageLine(account, cloud);
  const signInsOn = cloudSignInsOn(account);

  // One provider's page. Claude's (passes) comes later; until then its tile stays on the list.
  const opened = providerParam && providerParam !== "claude"
    ? rows.find((row) => row.descriptor.id === providerParam) ?? null
    : null;
  if (opened) {
    const providerRow = account.state === "ok"
      ? account.status.providers.find((entry) => entry.provider === opened.descriptor.id) ?? null
      : null;
    return (
      <div className="ade-pv-page">
        <AdeCloudProviderPage
          descriptor={opened.descriptor}
          tile={opened.tile}
          signIns={signIns}
          busy={busy}
          runWrite={runWrite}
          setSwitch={setSwitch}
          heldWrites={heldWrites}
          tileAction={tileAction(opened.descriptor, opened.tile)}
          // Until the account answers, the sign-ins part says it is reading.
          carried={account.state !== "ok" || providerRow?.carry === "carried"}
        />
      </div>
    );
  }

  return (
    <div className="ade-pv-page">
      <section className="ade-pvl" id="ai-providers" data-settings-anchor="ai-providers" data-settings-group="Connections" data-place="ade-cloud">
        {signInsOn ? null : (
          <Banner
            layout="inline"
            model={{
              id: "ade-cloud-sign-ins-off",
              tone: "warning",
              title: ADE_CLOUD_OFF_BANNER,
              actions: [{ label: "Turn on", onClick: turnOnAll, disabled: busy.has("all") }],
            }}
          />
        )}
        <header className="ade-pvl-head">
          <span className="ade-pvl-summary" data-testid="ade-cloud-page-line">
            {candidates.length > 1 && reporting && line.text === ADE_CLOUD_REACH_LINE ? (
              <>
                <ReportingPicker candidates={candidates} reportingId={reporting.machineId} onPick={signIns.pickReporting} />
                {" · "}
              </>
            ) : null}
            {line.text}
          </span>
          {cloud.state === "no_computer" ? null : (
            <button
              type="button"
              className="ade-pvl-action"
              style={{ "--pvl-accent": "var(--color-fg)", marginRight: 0 } as React.CSSProperties}
              disabled={signIns.rechecking}
              aria-busy={signIns.rechecking || undefined}
              onClick={() => void recheck()}
            >
              {signIns.rechecking ? "Checking…" : "Re-check"}
            </button>
          )}
        </header>
        <div className="ade-pvl-grid">
          {tiles.map(({ descriptor, tile }) => {
            const brand = providerBrand(descriptor.id);
            return (
              <ProviderTileView
                key={descriptor.id}
                descriptor={descriptor}
                state={tile.state}
                chipLabel={tile.chipLabel}
                chipTone={tile.chipTone}
                facts={tile.facts}
                accent={brand.neutral ? "var(--color-fg)" : brand.accent}
                action={tileAction(descriptor, tile)}
                row={tile.row}
                wrapLast
                // Claude's page (passes) comes later: its tile is not a button yet.
                onOpen={onProviderChange && descriptor.id !== "claude" ? () => onProviderChange(descriptor.id) : undefined}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}

/** "Checked on cloud-a ▾": which cloud computer the tiles were read on, with 2+. */
function ReportingPicker({
  candidates,
  reportingId,
  onPick,
}: {
  candidates: readonly { machineId: string; machineName: string }[];
  reportingId: string;
  onPick: (machineId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const current = candidates.find((machine) => machine.machineId === reportingId) ?? candidates[0]!;
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="ade-pvl-reporting"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Checked on <span className="ade-pvl-reporting-name">{current.machineName}</span>
        <CaretDown size={10} weight="bold" aria-hidden />
      </button>
      <AnchoredMenu open={open} anchorRef={anchorRef} onClose={() => setOpen(false)} role="menu" aria-label="Cloud computer" className="ade-mpick-menu">
        {candidates.map((machine) => {
          const selected = machine.machineId === current.machineId;
          return (
            <button
              key={machine.machineId}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              className="ade-mpick-item"
              onClick={() => {
                setOpen(false);
                if (!selected) onPick(machine.machineId);
              }}
            >
              <span aria-hidden />
              <span className="ade-mpick-item-name">{machine.machineName}</span>
              {selected ? <Check size={12} weight="bold" aria-hidden /> : <span aria-hidden />}
            </button>
          );
        })}
      </AnchoredMenu>
    </>
  );
}
