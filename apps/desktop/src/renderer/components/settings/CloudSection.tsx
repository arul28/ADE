import { useCallback, useEffect, useState } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import {
  BRING_YOUR_OWN_CLOUD_ENABLED,
  formatCloudUsd,
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
import { CloudReadyMachinesCard } from "./CloudReadyMachinesCard";
import { CloudMachinesCard } from "./CloudMachinesCard";
import { CloudSignInsCard, useCloudSignIns } from "./CloudSignInsCard";
import { useCloudMachines } from "../remoteTargets/useCloudMachines";
import { CloudAgentLimitsCard } from "./CloudAgentLimitsCard";
import { ADE_CLOUD_NAME } from "../remoteTargets/cloudBrand";
import { showToast } from "../app/toast/toastStore";
import { NewCloudMachineDialog } from "../remoteTargets/NewCloudMachineDialog";
import "./IntegrationsSettings.css";

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

/**
 * Settings › Integrations › ADE Cloud. Account-wide: access comes from the
 * account, so this page asks this desktop's own main process with no
 * pin, and what it shows is true on every computer on the account.
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
  // One read of the account's machines for the hero's month, the warnings and the machines card.
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
  const spending = machines.result?.state === "ok" ? machines.result.spending : null;
  const cap = spending?.monthlyCapUsd ?? null;
  const facts: IntegrationFact[] = live
    ? [
        {
          label: "Machines",
          value: status?.instanceCount == null
            ? "—"
            : status.instanceCount === 0
              ? "None yet"
              : `${status.instanceCount} · ${status.runningCount ?? 0} awake`,
        },
        {
          label: "This month",
          value: spending?.monthSpentUsd != null
            ? `${formatCloudUsd(spending.monthSpentUsd)}${cap != null ? ` of ${formatCloudUsd(cap)}` : ""}`
            : "—",
          mono: true,
          tone: spending?.capReached || spending?.capNear ? "warn" : undefined,
          title: `${ADE_CLOUD_NAME} settles spend once an hour, so the newest hour shows later.`,
        },
      ]
    : [];
  const heroFoot = live && status?.instanceCount === 0
    ? <div className="ade-ig-hero-foot-row"><b>Next</b><span>Make a machine below, or pick {ADE_CLOUD_NAME} when you start a chat.</span></div>
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

      {live && spending && (spending.capReached || spending.capNear) ? (
        <Banner
          layout="inline"
          model={{
            id: spending.capReached ? "cloud-cap-reached" : "cloud-cap-near",
            tone: spending.capReached ? "warning" : "info",
            title: spending.capReached ? "You reached this month's cap" : "Close to this month's cap",
            detail: spending.capReached
              ? "ADE makes, wakes and resizes nothing until the 1st or until you raise the cap below. Running work carries on."
              : "At the cap ADE stops making and waking machines. You can raise it below.",
            report: false,
          }}
        />
      ) : null}

      <IntegrationColumns>
        {live ? (
          <>
            <CloudSignInsCard signIns={cloudSignIns} />
            <CloudReadyMachinesCard status={status} cloudSignIns={cloudSignIns.status} />
            <CloudMachinesCard status={status} machines={machines} onNewMachine={() => setCreating(true)} accountChangedAt={accountChangedAt} />
            <CloudAgentLimitsCard />
          </>
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
