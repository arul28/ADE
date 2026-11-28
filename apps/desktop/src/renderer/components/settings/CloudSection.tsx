import { useCallback, useEffect, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { BRING_YOUR_OWN_CLOUD_ENABLED, type CloudStatus } from "../../../shared/adeCloud";
import { BringYourOwnCloudCard } from "./integrations/BringYourOwnCloudCard";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { lastCloudMachinesResult, useCloudMachines } from "../remoteTargets/useCloudMachines";
import { ADE_CLOUD_NAME, CloudMark } from "../remoteTargets/cloudBrand";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { CloudDashboard } from "./cloudDashboard/CloudDashboard";
import "./cloudDashboard/cloudDashboard.css";
import { BRAND } from "../../../shared/brand";

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

/**
 * Settings › ADE Cloud (its own sidebar tab). Account-wide: access comes from
 * the account, so this page asks this desktop's own main process with no pin
 * (in the web app, the connected machine: `webclient/adapter/cloud.ts`), and
 * what it shows is true on every computer on the account.
 *
 * Only an account ADE Cloud lets in ever sees this page: the tab itself is
 * behind `useAdeCloudEnabled`, and so is this body.
 */
export function CloudSection() {
  const enabled = useAdeCloudEnabled();
  const bridge = window.ade.cloud;
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const live = enabled && status?.connected === true && !status?.error;
  // One read of the account's computers for the whole page, started with the
  // status read rather than after it (a list read without access answers
  // `not_connected`, which the page shows like the status).
  const machines = useCloudMachines(enabled);
  // The last account this window read, drawn at once while the fresh reads
  // run: the page opens in its final shape, then updates in place.
  const [lastKnown] = useState(lastCloudMachinesResult);

  const load = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    try {
      setStatus(await bridge.getStatus());
      setError(null);
    } catch (loadError) {
      setError(errorText(loadError, `Couldn't check ${ADE_CLOUD_NAME}.`));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  useEffect(() => {
    if (!enabled) return;
    const off = bridge?.onStatusChanged?.(() => { void load(); });
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => {
      off?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, enabled, load]);

  if (!enabled) return null;
  if (!bridge) {
    return <p className="adecd-pagestate-line">{ADE_CLOUD_NAME} is managed from the {BRAND.NAME} desktop app.</p>;
  }

  const shown = machines.result ?? (machines.loadError ? null : lastKnown);
  const account = shown?.state === "ok" ? shown.account : null;
  // A status read that has not answered yet does not hold the page back; one that says no does.
  const statusOk = live || (status === null && loading && !error);
  if (statusOk && account) {
    return (
      <>
        <CloudDashboard account={account} machines={shown === machines.result ? machines : { ...machines, result: shown }} />
        {BRING_YOUR_OWN_CLOUD_ENABLED ? <BringYourOwnCloudCard /> : null}
      </>
    );
  }

  // Main says this account has no ADE Cloud while the renderer still says yes: the tab goes
  // when the access change arrives, so show nothing meanwhile (never a spinner that never ends).
  if (!loading && status && !status.connected && !status.signedOut && !status.error) return null;

  const unreachable = machines.result && machines.result.state !== "ok" ? machines.result.message : null;
  const problem = error
    ?? (status?.error ?? null)
    ?? unreachable
    ?? (live && machines.result?.state === "ok" && !account ? `${ADE_CLOUD_NAME} couldn't read your plan and credits.` : null)
    ?? machines.loadError;
  // The first open in this window, still reading: the page's own shape (the hero, the lanes, the
  // sizes, the plans) with the line centred in the hero, so nothing jumps when the page lands.
  if (!status?.signedOut && !(problem && !loading)) {
    return <CloudPageSkeleton />;
  }
  return (
    <div className="adecd-pagestate">
      <CloudMark size={28} brand bold />
      {status?.signedOut ? (
        <p>Sign in to {BRAND.NAME} to use {ADE_CLOUD_NAME}.</p>
      ) : problem && !loading ? (
        <Banner
          layout="inline"
          model={{
            id: "cloud-status-error",
            tone: "warning",
            title: `Couldn't reach ${ADE_CLOUD_NAME}`,
            detail: problem,
            actions: [{ label: "Check again", onClick: () => { setError(null); void load(); machines.refresh(); } }],
          }}
        />
      ) : (
        <p className="adecd-pagestate-line"><CircleNotch size={14} className="animate-spin" /> Reading your {ADE_CLOUD_NAME} account…</p>
      )}
    </div>
  );
}

/** Settings › DAEX Cloud before its first read in this window: the page's shape, read-only, no motion but the spinner. */
function CloudPageSkeleton() {
  return (
    <div className="adecd adecd-skeleton" aria-busy="true">
      <div className="adecd-citycard adecd-skeleton-hero">
        <p className="adecd-pagestate-line"><CircleNotch size={14} className="animate-spin" /> Reading your {ADE_CLOUD_NAME} account…</p>
      </div>
      <div className="adecd-skeleton-card" data-rows="2" aria-hidden="true"><i /><i /><i /></div>
      <div className="adecd-skeleton-card" data-rows="4" aria-hidden="true"><i /><i /><i /><i /><i /></div>
      <div className="adecd-skeleton-plans" aria-hidden="true"><i /><i /><i /><i /></div>
    </div>
  );
}
