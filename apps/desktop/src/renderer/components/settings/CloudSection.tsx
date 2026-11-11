import { useCallback, useEffect, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { BRING_YOUR_OWN_CLOUD_ENABLED, type CloudStatus } from "../../../shared/adeCloud";
import { BringYourOwnCloudCard } from "./integrations/BringYourOwnCloudCard";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { ADE_CLOUD_NAME, CloudMark } from "../remoteTargets/cloudBrand";
import { useAdeCloudEnabled } from "../../state/cloudAccess";
import { CloudDashboard } from "./cloudDashboard/CloudDashboard";
import "./cloudDashboard/cloudDashboard.css";

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
  // One read of the account's computers for the whole page.
  const machines = useCloudMachines(live);

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
    return <p className="adecd-pagestate-line">{ADE_CLOUD_NAME} is managed from the ADE desktop app.</p>;
  }

  const account = machines.result?.state === "ok" ? machines.result.account : null;
  if (live && account) {
    return (
      <>
        <CloudDashboard account={account} machines={machines} />
        {BRING_YOUR_OWN_CLOUD_ENABLED ? <BringYourOwnCloudCard /> : null}
      </>
    );
  }

  const unreachable = machines.result && machines.result.state !== "ok" ? machines.result.message : null;
  const problem = error
    ?? (status?.error ?? null)
    ?? unreachable
    ?? (live && machines.result?.state === "ok" && !account ? `${ADE_CLOUD_NAME} couldn't read your plan and hours.` : null)
    ?? machines.loadError;
  return (
    <div className="adecd-pagestate">
      <CloudMark size={28} brand bold />
      {status?.signedOut ? (
        <p>Sign in to ADE to use {ADE_CLOUD_NAME}.</p>
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
