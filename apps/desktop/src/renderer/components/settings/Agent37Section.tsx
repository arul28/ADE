import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, Check, CircleNotch, LinkBreak, Plus, Warning } from "@phosphor-icons/react";
import {
  AGENT37_API_KEYS_URL,
  AGENT37_BILLING_URL,
  describeAgent37TemplateStatus,
  type Agent37Status,
  type Agent37TemplateStatus,
} from "../../../shared/agent37";
import { SettingsTextField } from "./primitives";
import {
  credentialStorageFact,
  IntegrationCard,
  IntegrationColumns,
  IntegrationHero,
  IntegrationPage,
  type IntegrationFact,
} from "./integrations/IntegrationChrome";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { Agent37ReadyMachinesCard } from "./Agent37ReadyMachinesCard";
import { Agent37Mark, AGENT37_NAME } from "../remoteTargets/agent37Brand";
import { agent37RetryLabel, useAgent37Template } from "../remoteTargets/useAgent37Template";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { openExternalUrl } from "../../lib/openExternal";
import "./IntegrationsSettings.css";

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

/** The template row: setting up (about N min left), ready, or failed with a reason and Retry. */
function Agent37TemplateCard({ status, loadError, onRetry }: { status: Agent37TemplateStatus | null; loadError: string | null; onRetry: () => void }) {
  // ADE couldn't ask at all: say so, with Retry, rather than "Checking…" forever.
  const state = loadError && !status ? "failed" : status?.state ?? "checking";
  const icon = state === "ready"
    ? <Check size={15} weight="bold" />
    : state === "failed"
      ? <Warning size={15} weight="fill" />
      : <CircleNotch size={15} className="animate-spin" />;
  const title = state === "ready"
    ? "Machine template ready"
    : state === "failed"
      ? "Machine template failed"
      : state === "building"
        ? (status?.usable ? "Updating the machine template" : "Setting up the machine template")
        : "Checking the machine template";
  return (
    <IntegrationCard
      anchor="agent37-template"
      icon={icon}
      title={title}
      tone={state === "failed" ? "focus" : undefined}
      hint={`New machines start from ADE's template in your ${AGENT37_NAME} workspace. ADE builds it there when you connect, and again when ADE updates. Building is free.`}
      actions={state === "failed" ? (
        <button type="button" className="ade-modern-btn" data-size="sm" onClick={onRetry}>
          <ArrowClockwise size={12} /> Retry
        </button>
      ) : null}
    >
      <p className="ade-ig-note" role="status">
        {status
          ? describeAgent37TemplateStatus(status)
          : loadError
            ? `ADE couldn't check its machine template: ${loadError}`
            : "Checking ADE's machine template…"}
        {state === "failed" && status?.nextRetryAt ? ` ${agent37RetryLabel(status.nextRetryAt)}` : ""}
        {state === "ready" && status?.adeVersion ? ` It installs ADE ${status.adeVersion}.` : ""}
      </p>
    </IntegrationCard>
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
  const template = useAgent37Template(connected && !status?.error);

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
  const facts: IntegrationFact[] = connected && !status?.error
    ? [
        { label: "Wallet", value: status?.balanceUsd != null ? `$${status.balanceUsd.toFixed(2)}` : "—", mono: true },
        status?.tier === 0
          ? {
              label: "Machines",
              value: status.instanceCount != null && status.instanceLimit != null
                ? `${status.instanceCount} of ${status.instanceLimit}`
                : "—",
              title: `Until your first top-up, ${AGENT37_NAME} counts sleeping and stopped machines toward the limit.`,
            }
          : {
              label: "Awake",
              value: status?.runningCount != null && status.instanceLimit != null
                ? `${status.runningCount} of ${status.instanceLimit}`
                : "—",
              title: status?.instanceCount != null
                ? `${AGENT37_NAME} counts only awake machines toward the limit. You have ${status.instanceCount} in all.`
                : `${AGENT37_NAME} counts only awake machines toward the limit.`,
            },
        {
          label: "Sizes",
          value: status?.tier === 0 ? "Smallest box only" : "All sizes and VMs",
          title: status?.tier === 0 ? `${AGENT37_NAME} unlocks VMs and bigger sizes after your first top-up.` : undefined,
        },
        ...[credentialStorageFact(status?.credentialStorage)].filter((fact): fact is IntegrationFact => fact != null),
      ]
    : [];

  return (
    <IntegrationPage id="agent37">
      <IntegrationHero
        id="agent37"
        anchor={connected ? "agent37-connection" : undefined}
        status={heroStatus}
        account={connected ? {
          avatar: <Agent37Mark size={16} />,
          title: `${AGENT37_NAME} workspace`,
          detail: status?.balanceUsd != null ? `$${status.balanceUsd.toFixed(2)} in the wallet` : undefined,
        } : null}
        actions={connected ? (
          <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => void disconnect()}>
            <LinkBreak size={12} /> Disconnect
          </button>
        ) : null}
        facts={facts}
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

      <IntegrationColumns>
        {connected ? (
          <>
            {!status?.error ? <Agent37TemplateCard status={template.status} loadError={template.loadError} onRetry={template.retry} /> : null}
            {!status?.error ? <Agent37ReadyMachinesCard status={status} /> : null}
            <IntegrationCard
              anchor="agent37-machines"
              icon={<Plus size={15} weight="bold" />}
              title="Your machines"
              hint={`Your ${AGENT37_NAME} machines have their own group in your computers. Each one shows its state, size, price and spend, and its menu has Sleep, Resize, Back up and Delete box.`}
            >
              <p className="ade-ig-note">
                To make one, choose Add computer, then New {AGENT37_NAME} machine. It signs in to your account on its own and shows up ready to connect. Boxes run lanes, agents and a Linux Desktop screen. VMs add the Android emulator and Docker. {AGENT37_NAME} bills each running minute; asleep, only the disk.
              </p>
              <div className="ade-ig-step-actions">
                <button type="button" className="ade-modern-btn" onClick={() => openConnectionsPanel("machines")}>
                  Open your computers
                </button>
                <button type="button" className="ade-modern-btn" onClick={() => openExternalUrl(AGENT37_BILLING_URL)}>
                  <ArrowSquareOut size={12} /> {AGENT37_NAME} wallet
                </button>
              </div>
            </IntegrationCard>
          </>
        ) : (
          <IntegrationCard
            anchor="agent37-connection"
            icon={<Agent37Mark size={15} />}
            title={`Connect ${AGENT37_NAME}`}
            hint="Paste a workspace API key. ADE keeps it in your account, so every computer you sign in to can make machines with it."
            actions={loading ? <CircleNotch size={14} className="animate-spin" /> : null}
          >
            <ol className="ade-ig-steps">
              <li className="ade-ig-step">
                <span className="ade-ig-step-num" aria-hidden>1</span>
                <div className="ade-ig-step-main">
                  <div className="ade-ig-step-head"><b>Create an API key</b></div>
                  <p className="ade-ig-note">In your {AGENT37_NAME} dashboard, under API keys. It starts with sk_live_.</p>
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
    </IntegrationPage>
  );
}
