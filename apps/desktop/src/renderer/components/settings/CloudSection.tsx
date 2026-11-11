import { useCallback, useEffect, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import {
  BRING_YOUR_OWN_CLOUD_ENABLED,
  cloudAccountBanner,
  formatCloudHours,
  type CloudCreateMachineResult,
  type CloudStatus,
} from "../../../shared/adeCloud";
import {
  IntegrationColumns,
  IntegrationHero,
  IntegrationPage,
  type IntegrationFact,
} from "./integrations/IntegrationChrome";
import { BringYourOwnCloudCard } from "./integrations/BringYourOwnCloudCard";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { isWebClientMode } from "../../lib/webClientMode";
import { CloudReadyMachinesCard } from "./CloudReadyMachinesCard";
import { CloudMachinesCard } from "./CloudMachinesCard";
import { CloudSignInsCard, useCloudSignIns } from "./CloudSignInsCard";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { ADE_CLOUD_NAME } from "../remoteTargets/cloudBrand";
import { showToast } from "../app/toast/toastStore";
import { NewCloudMachineDialog } from "../remoteTargets/NewCloudMachineDialog";
import { CloudDashboard, cloudOtherComputersCount, cloudSignInsValue } from "./cloudDashboard/CloudDashboard";
import "./IntegrationsSettings.css";

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

/**
 * Settings › Integrations › ADE Cloud. Account-wide: access comes from the
 * account, so this page asks this desktop's own main process with no
 * pin (in the web app, the connected machine: `webclient/adapter/cloud.ts`),
 * and what it shows is true on every computer on the account.
 */
export function CloudSection() {
  const bridge = window.ade.cloud;
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const connected = status?.connected === true;
  const live = connected && !status?.error;
  /**
   * The New machine dialog lives here, not in the machines card: the card goes
   * away while a status read fails, and closing the dialog mid-create cancels
   * the create and deletes the half-made machine.
   */
  const [creating, setCreating] = useState(false);
  const [accountChangedAt, setAccountChangedAt] = useState(0);
  // One read of the account's machines for the hero, the warnings and the machines card.
  const machines = useCloudMachines(live);

  const load = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    try {
      setStatus(await bridge.getStatus());
    } catch (loadError) {
      setError(errorText(loadError, `Couldn't check ${ADE_CLOUD_NAME}.`));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const off = bridge?.onStatusChanged?.(() => { void load(); });
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => {
      off?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, load]);

  const onCreated = useCallback((result: CloudCreateMachineResult) => {
    setCreating(false);
    machines.refresh();
    setAccountChangedAt(Date.now());
    showToast({
      tone: "success",
      title: `Made ${result.name}`,
      message: result.joined ? "It's in Your computers. Connect it there, or pick it when you start a chat." : "It's still starting. It shows in Your computers once it's ready.",
      replayMask: { title: true },
    });
  }, [machines]);

  // Before the early return below: a hook runs on every render.
  const cloudSignIns = useCloudSignIns(live);
  // The web app reads ADE Cloud through the connected machine but makes no computers.
  const newMachine = () => {
    if (isWebClientMode()) {
      showToast({ tone: "info", title: "Make computers in the ADE desktop app", message: "The web app shows your ADE Cloud lanes and computers." });
      return;
    }
    setCreating(true);
  };

  if (!bridge) {
    return (
      <IntegrationPage id="cloud">
        <p className="ade-ig-note">{ADE_CLOUD_NAME} is managed from the ADE desktop app.</p>
      </IntegrationPage>
    );
  }

  const heroStatus = loading && !status
    ? { tone: "checking" as const, label: "Checking…" }
    : status?.signedOut
      ? { tone: "neutral" as const, label: "Sign in to ADE" }
    : status?.error
      ? { tone: "warn" as const, label: connected ? `Couldn't reach ${ADE_CLOUD_NAME}` : "Not available" }
      : connected
        ? { tone: "ok" as const, label: "Ready" }
        : { tone: "neutral" as const, label: "Not available yet" };
  const account = machines.result?.state === "ok" ? machines.result.account : null;
  const accountBanner = account ? cloudAccountBanner(account) : null;
  const facts: IntegrationFact[] = live
    ? [
        {
          label: "Computers",
          value: status?.instanceCount == null
            ? "—"
            : status.instanceCount === 0
              ? "None yet"
              : `${status.instanceCount} · ${status.runningCount ?? 0} awake`,
        },
        {
          label: "Hours left",
          value: account ? `${formatCloudHours(account.hours.leftMilli)} of ${formatCloudHours(account.hours.includedMilli)}` : "—",
          mono: true,
          tone: account && account.hours.state !== "none" ? "warn" : undefined,
        },
      ]
    : [];
  const heroFoot = live && status?.instanceCount === 0
    ? <div className="ade-ig-hero-foot-row"><b>Next</b><span>Make a computer below, or pick {ADE_CLOUD_NAME} when you start a chat.</span></div>
    : null;

  return (
    <IntegrationPage id="cloud">
      <IntegrationHero
        id="cloud"
        anchor="cloud-connection"
        status={heroStatus}
        facts={facts}
        footer={heroFoot}
      />

      {error ? (
        <Banner
          layout="inline"
          model={{
            id: "cloud-error",
            tone: "error",
            title: ADE_CLOUD_NAME,
            detail: error,
            actions: [{ label: "Check again", onClick: () => { setError(null); void load(); } }],
          }}
        />
      ) : null}
      {status?.error && !error ? (
        <Banner layout="inline" model={{ id: "cloud-status-error", tone: "warning", title: connected ? `Couldn't reach ${ADE_CLOUD_NAME}` : `${ADE_CLOUD_NAME} refused this account`, detail: status.error, actions: [{ label: "Check again", onClick: () => { void load(); } }] }} />
      ) : null}

      {live && accountBanner ? <Banner layout="inline" model={{ ...accountBanner, report: false }} /> : null}

      {/* One dashboard tab in place of the column of cards. The older cards stay as its panels until Cloud 4's PR merges. */}
      {live && account ? (
        <CloudDashboard
          account={account}
          machines={machines}
          // Cloud 4: AdeCloudSignInsRow mounts here once its PR is in main. Until then, today's sign-ins card.
          signIns={<CloudSignInsCard signIns={cloudSignIns} />}
          signInsValue={cloudSignInsValue(cloudSignIns.status)}
          otherComputers={(
            <div className="adecd-other">
              <CloudReadyMachinesCard cloudSignIns={cloudSignIns.status} />
              <CloudMachinesCard status={status} machines={machines} onNewMachine={newMachine} accountChangedAt={accountChangedAt} />
            </div>
          )}
          otherComputersCount={cloudOtherComputersCount(machines)}
        />
      ) : null}

      <IntegrationColumns>
        {live ? (
          account ? null : (
            <p className="ade-ig-note">
              {machines.loadError ?? <CircleNotch size={14} className="animate-spin" />}
            </p>
          )
        ) : !connected ? (
          <p className="ade-ig-note">
            {loading ? <CircleNotch size={14} className="animate-spin" /> : status?.signedOut ? `Sign in to ADE to use ${ADE_CLOUD_NAME}.` : `${ADE_CLOUD_NAME} isn't available on this account yet.`}
          </p>
        ) : null}
        {BRING_YOUR_OWN_CLOUD_ENABLED ? <BringYourOwnCloudCard /> : null}
      </IntegrationColumns>
      <p className="ade-ig-note">Powered by Agent 37</p>
      {creating && status ? (
        <NewCloudMachineDialog onCreated={onCreated} onClose={() => setCreating(false)} />
      ) : null}
    </IntegrationPage>
  );
}
