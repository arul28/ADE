import { useCallback, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { CaretRight, Key } from "@phosphor-icons/react";
import { isProviderLoginProvider, type ProviderLoginProvider } from "../../../../shared/types/providerLogins";
import { ipcErrorMessage } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { availableProviderDescriptors } from "../providers/descriptors";
import type { ProviderDescriptor } from "../providers/types";
import { providerListMark } from "../providers/ProviderTileView";
import { accountPassUse, adeCloudTile, cloudSignInsOn } from "../providers/cloud/adeCloudSignInModel";
import { useAdeCloudSignIns } from "../providers/cloud/useAdeCloudSignIns";
import { SettingsToggle } from "../primitives/SettingsControls";
import { adeCloudSettingsSearch } from "../SettingsMachineScope";

/** Claude's row: how Claude gets on ADE Cloud, then what its pass needs ("Approve a Claude pass for ADE Cloud"). */
function claudePassLine(fact: string | null): string {
  const lead = "Uses a Claude pass on ADE Cloud, not a sign-in";
  return fact ? `${lead}. ${fact}` : lead;
}

/**
 * The accounts cloud computers sign in with, one row per provider, in plain
 * words: which account, where the sign-in came from, and whether it's ready.
 * Providers with no sign-in yet are one line of logos that open their page.
 * The one switch (share my sign-ins) sits at the bottom. Each provider is
 * managed in Settings › Providers › ADE Cloud.
 *
 * Reads and writes go through This computer's pin (`useAdeCloudSignIns`), the
 * same as the Providers page. Nothing here wakes a cloud computer.
 */
export function CloudSignIns() {
  const signIns = useAdeCloudSignIns();
  const { account, cloud, saved, signInStatus, keyringIsThisComputer, accountPin } = signIns;
  const navigate = useNavigate();
  const location = useLocation();
  const passUse = useMemo(() => accountPassUse(signInStatus?.passes), [signInStatus?.passes]);
  const descriptors = useMemo(
    () => availableProviderDescriptors().filter((descriptor): descriptor is ProviderDescriptor & { id: ProviderLoginProvider } => isProviderLoginProvider(descriptor.id)),
    [],
  );
  const rows = useMemo(() => {
    const now = Date.now();
    return descriptors.map((descriptor) => ({
      descriptor,
      tile: adeCloudTile({ provider: descriptor.id, account, cloud, saved, keyringIsThisComputer, passUse, now }),
    }));
  }, [account, cloud, descriptors, keyringIsThisComputer, passUse, saved]);
  const ready = rows.filter((row) => row.tile.state === "connected");
  // Claude reaches ADE Cloud through a Claude pass, not a shared sign-in. Until
  // one is on it gets its own row saying so, not a chip under "Not signed in".
  const pass = rows.find((row) => row.descriptor.id === "claude" && (row.tile.state === "sign-in" || row.tile.state === "unknown")) ?? null;
  const rest = rows.filter((row) => row.tile.state !== "connected" && row !== pass);
  const on = cloudSignInsOn(account);
  const [pending, setPending] = useState<boolean | null>(null);
  const pinRef = useRef(accountPin);
  pinRef.current = accountPin;

  const open = useCallback((provider?: string) => {
    navigate({ pathname: location.pathname, search: adeCloudSettingsSearch(provider ? { provider } : {}) });
  }, [location.pathname, navigate]);

  const setAll = useCallback(async (next: boolean) => {
    setPending(next);
    try {
      const status = await window.ade?.providerLogins?.setCloudAll?.({ on: next }, pinRef.current);
      if (status) signIns.applyAccountStatus(status);
    } catch (error) {
      showToast({ tone: "error", title: "ADE couldn't change that", message: ipcErrorMessage(error) || "Try again." });
    } finally {
      setPending(null);
    }
  }, [signIns]);

  const loading = account.state === "loading";
  const failed = account.state === "failed";
  return (
    <section id="cloud-sign-ins" className="kit-card adecd-card" aria-label="Sign-ins on ADE Cloud">
      <header className="kit-card-head">
        <Key size={14} />
        Sign-ins on ADE Cloud
        {ready.length ? <span className="kit-card-head-count">{ready.length}</span> : null}
        <button type="button" className="kit-card-head-action" onClick={() => open()}>
          Manage <CaretRight size={10} />
        </button>
      </header>
      <div className="kit-card-body adecd-signins">
        {failed ? (
          <p className="adecd-empty">ADE couldn't read your sign-ins. It reads them again when they change.</p>
        ) : loading ? (
          <p className="adecd-empty">Reading your sign-ins…</p>
        ) : !on ? (
          <p className="adecd-empty">Your sign-ins aren't shared with ADE Cloud. Each cloud computer asks you to sign in on it.</p>
        ) : (
          <>
            <p className="adecd-lead">
              {ready.length
                ? "Your cloud computers sign in with these accounts. A sign-in on any of your computers reaches them in about a minute."
                : "No sign-in reaches ADE Cloud yet. Sign in to a provider on any of your computers and it reaches your cloud computers."}
            </p>
            {ready.length || pass ? (
              <ul className="kit-panel adecd-signin-list">
                {ready.map(({ descriptor, tile }) => (
                  <li key={descriptor.id}>
                    <button type="button" className="adecd-signin" onClick={() => open(descriptor.id)}>
                      <span className="adecd-signin-logo" aria-hidden="true">{providerListMark(descriptor, 22)}</span>
                      <span className="adecd-signin-text">
                        <b>{descriptor.label}</b>
                        <span>{tile.facts.map((fact) => fact.text).filter(Boolean).join(". ") || "Signed in"}</span>
                      </span>
                      <span className="kit-dot" data-state="ok" aria-label="Ready" />
                    </button>
                  </li>
                ))}
                {pass ? (
                  <li key={pass.descriptor.id}>
                    <button type="button" className="adecd-signin" onClick={() => open(pass.descriptor.id)}>
                      <span className="adecd-signin-logo" aria-hidden="true">{providerListMark(pass.descriptor, 22)}</span>
                      <span className="adecd-signin-text">
                        <b>{pass.descriptor.label}</b>
                        <span className="adecd-signin-wrap">{claudePassLine(pass.tile.facts[0]?.text ?? null)}</span>
                      </span>
                      <span
                        className="kit-dot"
                        data-state={pass.tile.facts[0]?.tone === "crit" ? "crit" : "warn"}
                        aria-label={pass.tile.state === "unknown" ? "Not known" : "Not set up"}
                      />
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
            {rest.length ? (
              <div className="adecd-signin-rest">
                <span>Not signed in</span>
                <div className="adecd-signin-chips">
                  {rest.map(({ descriptor, tile }) => (
                    <button key={descriptor.id} type="button" className="adecd-signin-chip" title={tile.facts[0]?.text ?? tile.chipLabel} onClick={() => open(descriptor.id)}>
                      {providerListMark(descriptor, 14)}
                      {descriptor.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
        <div className="adecd-signin-switch">
          <div>
            <b>Share my sign-ins with ADE Cloud</b>
            <small>{on ? "Cloud computers use the accounts you're signed in to on your computers." : "Off: you sign in on each cloud computer yourself."}</small>
          </div>
          <SettingsToggle
            checked={pending ?? on}
            disabled={loading || failed || pending !== null}
            label="Share my sign-ins with ADE Cloud"
            onChange={(next) => void setAll(next)}
          />
        </div>
      </div>
    </section>
  );
}
