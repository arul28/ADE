import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, CircleNotch, LinkBreak, Wallet } from "@phosphor-icons/react";
import {
  AGENT37_API_KEYS_URL,
  AGENT37_BILLING_URL,
  AGENT37_DASHBOARD_URL,
  formatAgent37Usd,
  type Agent37CreateMachineResult,
  type Agent37Status,
  type Agent37TemplateStatus,
} from "../../../shared/agent37";
import { SettingsTextField } from "./primitives";
import {
  IntegrationCard,
  IntegrationColumns,
  IntegrationHero,
  IntegrationPage,
  type IntegrationFact,
} from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { Agent37ReadyMachinesCard } from "./Agent37ReadyMachinesCard";
import { Agent37MachinesCard } from "./Agent37MachinesCard";
import { Agent37CloudSignInsCard, useAgent37CloudSignIns } from "./Agent37CloudSignInsCard";
import { useAgent37Machines } from "../remoteTargets/useAgent37Machines";
import { agent37GroupTotals, agent37WalletWarning } from "../remoteTargets/agent37MachineModel";
import agent37ApiKeyShot from "./integrations/steps/agent37-api-key.webp";
import { Agent37AgentLimitsCard } from "./Agent37AgentLimitsCard";
import { Agent37Mark, AGENT37_NAME } from "../remoteTargets/agent37Brand";
import { agent37RetryLabel, useAgent37Template } from "../remoteTargets/useAgent37Template";
import { openExternalUrl } from "../../lib/openExternal";
import { showToast } from "../app/toast/toastStore";
import { NewAgent37MachineDialog } from "../remoteTargets/NewAgent37MachineDialog";
import "./IntegrationsSettings.css";

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

/** The template, as the hero's fact: Ready, Step 2 of 5, Updating, Failed. */
function templateFact(status: Agent37TemplateStatus | null, loadError: string | null): IntegrationFact {
  if (loadError && !status) return { label: "Template", value: "Failed", tone: "warn" };
  if (!status || status.state === "checking" || status.state === "idle") return { label: "Template", value: "Checking…" };
  if (status.state === "ready") return { label: "Template", value: "Ready" };
  if (status.state === "failed") return { label: "Template", value: "Failed", tone: "warn" };
  if (status.usable) return { label: "Template", value: "Updating" };
  return {
    label: "Template",
    value: status.progress ? `Step ${status.progress.step} of ${status.progress.steps}` : "Building",
    tone: "warn",
  };
}

/**
 * The template's state inside the hero, only while the person should see it:
 * the first build (new machines wait for it), an update (a quiet line; new
 * machines still work), a failure (the reason and Retry). Ready shows nothing.
 */
function Agent37TemplateFoot({ status, loadError, onRetry }: { status: Agent37TemplateStatus | null; loadError: string | null; onRetry: () => void }) {
  if ((loadError && !status) || status?.state === "failed") {
    const reason = status?.error ?? loadError ?? "The build failed.";
    const retryLine = status?.nextRetryAt ? agent37RetryLabel(status.nextRetryAt) : null;
    return (
      <Banner
        layout="inline"
        model={{
          id: "agent37-template-failed",
          tone: "error",
          title: "New machines can't be made yet.",
          detail: `${reason}${retryLine ? ` ${retryLine}` : ""}`,
          actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: onRetry }],
        }}
      />
    );
  }
  if (status?.state !== "building") return null;
  const progress = status.progress ?? null;
  if (status.usable) {
    return (
      <div className="ade-ig-hero-foot-row" role="status">
        <CircleNotch size={13} className="animate-spin" />
        <span>
          Updating the machine template{status.adeVersion ? ` to ADE ${status.adeVersion}` : ""}. New machines still work.
          {progress ? ` Step ${progress.step} of ${progress.steps}: ${progress.label}.` : ""}
        </span>
      </div>
    );
  }
  const percent = progress && progress.steps > 0 ? Math.min(100, Math.max(4, (progress.step / progress.steps) * 100)) : null;
  return (
    <>
      <div className="ade-ig-hero-foot-row" role="status">
        <CircleNotch size={14} className="animate-spin" />
        <b>Getting {AGENT37_NAME} ready for ADE. This happens once.</b>
        <span>You can leave this page.</span>
      </div>
      <div
        className="ade-ig-progress"
        data-indeterminate={percent == null ? "true" : undefined}
        role="progressbar"
        aria-label="Template build"
        aria-valuemin={percent == null ? undefined : 0}
        aria-valuemax={percent == null ? undefined : 100}
        aria-valuenow={percent == null ? undefined : Math.round(percent)}
      >
        <i style={percent == null ? undefined : { width: `${percent}%` }} />
      </div>
      {progress ? (
        <div className="ade-ig-hero-foot-row"><span>Step {progress.step} of {progress.steps}: {progress.label}</span></div>
      ) : null}
    </>
  );
}

/**
 * Settings › Integrations › Agent 37. Account-wide: the workspace key is kept in
 * the account vault, so this page asks this desktop's own main process with no
 * pin, and what it shows is true on every computer on the account.
 */
export function Agent37Section() {
  const bridge = window.ade.agent37;
  const [status, setStatus] = useState<Agent37Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** What the error banner's button does: check again, or retry the disconnect that failed. */
  const [errorRetry, setErrorRetry] = useState<"load" | "disconnect">("load");
  const connected = status?.connected === true;
  /**
   * The New machine dialog lives here, not in the machines card: the card goes
   * away while a status read fails, and closing the dialog mid-create cancels
   * the create and deletes the half-made machine.
   */
  const [creating, setCreating] = useState(false);
  const [accountChangedAt, setAccountChangedAt] = useState(0);
  const template = useAgent37Template(connected && !status?.error);
  // One read of the workspace's machines for the hero's month, the warnings and the machines card.
  const machines = useAgent37Machines(connected && !status?.error);

  const load = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    try {
      setStatus(await bridge.getStatus());
    } catch (loadError) {
      setErrorRetry("load");
      setError(errorText(loadError, `Couldn't check ${AGENT37_NAME}.`));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);
  // A key saved or removed elsewhere (a chat's connect card, another window, or
  // another computer through the account) shows here without reopening the page.
  useEffect(() => {
    const off = bridge?.onStatusChanged?.(() => { void load(); });
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => {
      off?.();
      window.removeEventListener("focus", onFocus);
    };
  }, [bridge, load]);

  const connect = async () => {
    if (!bridge || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await bridge.saveKey(apiKey));
      setApiKey("");
    } catch (saveError) {
      setErrorRetry("load");
      setError(errorText(saveError, `Couldn't connect ${AGENT37_NAME}.`));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!bridge || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.removeKey();
      if (next && !next.connected && next.error) {
        // This computer's copy is gone but the account's may not be: say so, with a retry.
        setStatus({ ...next, error: null });
        setErrorRetry("disconnect");
        setError(next.error);
      } else {
        setStatus(next);
      }
    } catch (removeError) {
      setErrorRetry("disconnect");
      setError(errorText(removeError, `Couldn't disconnect ${AGENT37_NAME}.`));
    } finally {
      setBusy(false);
    }
  };

  const onCreated = useCallback((result: Agent37CreateMachineResult) => {
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
  const cloudSignIns = useAgent37CloudSignIns(connected && !status?.error);

  if (!bridge) {
    return (
      <IntegrationPage id="agent37">
        <p className="ade-ig-note">{AGENT37_NAME} is set up from the ADE desktop app.</p>
      </IntegrationPage>
    );
  }

  const heroStatus = loading && !status
    ? { tone: "checking" as const, label: "Checking…" }
    : status?.error
      ? { tone: "warn" as const, label: connected ? `Couldn't reach ${AGENT37_NAME}` : "Needs attention" }
      : connected
        ? { tone: "ok" as const, label: "Connected" }
        : { tone: "neutral" as const, label: "Not connected" };
  const live = connected && !status?.error;
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
            ? `${formatAgent37Usd(spending.monthSpentUsd)}${cap != null ? ` of ${formatAgent37Usd(cap)}` : ""}`
            : "—",
          mono: true,
          tone: spending?.capReached || spending?.capNear ? "warn" : undefined,
          title: `${AGENT37_NAME} settles spend once an hour, so the newest hour shows later.`,
        },
        templateFact(template.status, template.loadError),
      ]
    : [];
  const templateFoot = live ? <Agent37TemplateFoot status={template.status} loadError={template.loadError} onRetry={template.retry} /> : null;
  const templateReady = template.status?.usable === true && template.status.state !== "failed";
  const showNext = live && templateReady && template.status?.state === "ready" && status?.instanceCount === 0;
  const heroFoot = templateFoot && (template.status?.state === "building" || template.status?.state === "failed" || (template.loadError && !template.status))
    ? templateFoot
    : showNext
      ? <div className="ade-ig-hero-foot-row"><b>Next</b><span>Make a machine below, or pick {AGENT37_NAME} when you start a chat.</span></div>
      : null;
  const storage = status?.credentialStorage ?? null;
  const walletWarning = machines.result?.state === "ok" && !machines.result.pastDue
    ? agent37WalletWarning(machines.result.balanceUsd, agent37GroupTotals(machines.result.machines).hourlyUsd)
    : null;

  return (
    <IntegrationPage id="agent37">
      <IntegrationHero
        id="agent37"
        anchor={connected ? "agent37-connection" : undefined}
        status={heroStatus}
        panel={connected ? (
          <>
            <div className="ade-ig-account">
              <span className="ade-ig-avatar" aria-hidden><Agent37Mark size={16} /></span>
              <div className="ade-ig-account-id">
                <b>{AGENT37_NAME} workspace</b>
                {status?.balanceUsd != null ? <span>{formatAgent37Usd(status.balanceUsd)} in the wallet</span> : null}
              </div>
            </div>
            {status?.tier === 0 ? (
              <p className="ade-ig-hero-panel-warn">Top up once to unlock VMs and bigger sizes.</p>
            ) : null}
            <div className="ade-ig-hero-panel-actions">
              <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => openExternalUrl(AGENT37_DASHBOARD_URL)}>
                <ArrowSquareOut size={12} /> Open dashboard
              </button>
              <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" onClick={() => openExternalUrl(AGENT37_BILLING_URL)}>
                <Wallet size={12} /> Top up
              </button>
              <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => void disconnect()}>
                <LinkBreak size={12} /> Disconnect
              </button>
            </div>
            {storage ? (
              <p className="ade-ig-hero-panel-quiet" title={storage.storage === "account" ? undefined : storage.message ?? undefined}>
                {storage.storage === "account" ? "Key kept in your ADE account" : "Key kept on this computer only"}
              </p>
            ) : null}
          </>
        ) : undefined}
        facts={facts}
        footer={heroFoot}
      />

      {error ? (
        <Banner
          layout="inline"
          model={{
            id: "agent37-error",
            tone: "error",
            title: AGENT37_NAME,
            detail: error,
            actions: [errorRetry === "disconnect"
              ? { label: "Try again", onClick: () => { void disconnect(); } }
              : { label: "Check again", onClick: () => { setError(null); void load(); } }],
          }}
        />
      ) : null}
      {status?.error && !error ? (
        <Banner layout="inline" model={{ id: "agent37-saved-key-error", tone: "warning", title: connected ? `Couldn't reach ${AGENT37_NAME}` : `${AGENT37_NAME} refused the saved key`, detail: status.error, actions: [{ label: "Check again", onClick: () => { void load(); } }] }} />
      ) : null}

      {live && machines.result?.state === "ok" && machines.result.pastDue ? (
        <Banner layout="inline" model={{ id: "agent37-suspended", tone: "error", title: `${AGENT37_NAME} suspended your machines`, detail: "Your wallet ran out, so every machine is asleep and not billing. Top up to wake them. A machine left suspended for 30 days is deleted.", actions: [{ label: "Top up", href: AGENT37_BILLING_URL }], report: false }} />
      ) : walletWarning ? (
        <Banner layout="inline" model={{ id: "agent37-wallet-low", tone: "warning", title: machines.result?.state === "ok" && machines.result.balanceUsd != null && machines.result.balanceUsd <= 0 ? "Your wallet is empty" : "Your wallet is running low", detail: walletWarning, actions: [{ label: "Top up", href: AGENT37_BILLING_URL }], report: false }} />
      ) : null}
      {live && spending && (spending.capReached || spending.capNear) ? (
        <Banner
          layout="inline"
          model={{
            id: spending.capReached ? "agent37-cap-reached" : "agent37-cap-near",
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
        {connected ? (
          <>
            {live ? <Agent37CloudSignInsCard signIns={cloudSignIns} /> : null}
            {live ? <Agent37ReadyMachinesCard status={status} cloudSignIns={cloudSignIns.status} /> : null}
            {live ? <Agent37MachinesCard status={status} machines={machines} onNewMachine={() => setCreating(true)} accountChangedAt={accountChangedAt} /> : null}
            {live ? <Agent37AgentLimitsCard /> : null}
          </>
        ) : (
          <IntegrationCard
            anchor="agent37-connection"
            icon={<Agent37Mark size={15} />}
            title={`Connect ${AGENT37_NAME}`}
            hint="ADE keeps the key in your ADE account, so every computer you sign in to can use it."
            actions={loading ? <CircleNotch size={14} className="animate-spin" /> : null}
          >
            <ol className="ade-ig-steps">
              <li className="ade-ig-step">
                <span className="ade-ig-step-num" aria-hidden>1</span>
                <div className="ade-ig-step-main">
                  <div className="ade-ig-step-head"><b>Create an API key</b></div>
                  <p className="ade-ig-note">In your {AGENT37_NAME} dashboard, under API keys. It starts with sk_live_.</p>
                  <img className="ade-ig-step-shot" src={agent37ApiKeyShot} alt={`${AGENT37_NAME}'s API keys page, with the Create API key button at the top right`} loading="lazy" draggable={false} />
                  <div className="ade-ig-step-actions">
                    <button type="button" className="ade-modern-btn" onClick={() => openExternalUrl(AGENT37_API_KEYS_URL)}>
                      <ArrowSquareOut size={12} /> Open {AGENT37_NAME}
                    </button>
                  </div>
                </div>
              </li>
              <li className="ade-ig-step">
                <span className="ade-ig-step-num" aria-hidden>2</span>
                <div className="ade-ig-step-main">
                  <div className="ade-ig-step-head"><b>Paste it here</b></div>
                  <div className="ade-ig-form" style={{ marginTop: 6 }}>
                    <div className="ade-ig-form-row">
                      <SettingsTextField
                        value={apiKey}
                        onChange={setApiKey}
                        type="password"
                        placeholder="sk_live_…"
                        ariaLabel={`${AGENT37_NAME} API key`}
                        autoComplete="new-password"
                        mono
                        onKeyDown={(event) => { if (event.key === "Enter") void connect(); }}
                      />
                      <button type="button" className="ade-modern-btn" data-tone="primary" disabled={busy || loading || !apiKey.trim()} onClick={() => void connect()}>
                        {busy ? <CircleNotch size={12} className="animate-spin" /> : null}
                        Connect
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            </ol>
          </IntegrationCard>
        )}
      </IntegrationColumns>
      {creating && status ? (
        <NewAgent37MachineDialog status={status} onCreated={onCreated} onClose={() => setCreating(false)} />
      ) : null}
    </IntegrationPage>
  );
}
