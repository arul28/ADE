import { useCallback, useEffect, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, CircleNotch, LinkBreak, Warning } from "@phosphor-icons/react";
import {
  AGENT37_API_KEYS_URL,
  AGENT37_BILLING_URL,
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
import { Agent37SpendingCard } from "./Agent37SpendingCard";
import { Agent37Mark, AGENT37_NAME } from "../remoteTargets/agent37Brand";
import { agent37RetryLabel, useAgent37Template } from "../remoteTargets/useAgent37Template";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { openExternalUrl } from "../../lib/openExternal";
import "./IntegrationsSettings.css";

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

/** The template card: a status tag, one line while building, the reason and Retry when it failed. */
/**
 * The template card, only while it needs the person: still being set up (new
 * machines wait for it) or failed (Retry). A ready template is invisible.
 */
function Agent37TemplateCard({ status, loadError, onRetry }: { status: Agent37TemplateStatus | null; loadError: string | null; onRetry: () => void }) {
  // ADE couldn't ask at all: say so, with Retry, rather than "Checking…" forever.
  const state = loadError && !status ? "failed" : status?.state ?? "checking";
  if (state !== "failed" && !(state === "building" && status && !status.usable)) return null;
  const failed = state === "failed";
  return (
    <IntegrationCard
      anchor="agent37-template"
      icon={failed ? <Warning size={15} weight="fill" /> : <CircleNotch size={15} className="animate-spin" />}
      title={failed ? "Machine template failed" : "Setting up machines"}
      badge={failed ? null : (
        <span className="kit-tag" data-tone="warn">{status?.minutesLeft != null ? `About ${status.minutesLeft} min` : "Building"}</span>
      )}
      tone={failed ? "focus" : undefined}
      hint={failed ? undefined : `New machines can be made once ADE finishes its template in your ${AGENT37_NAME} workspace.`}
    >
      {failed ? (
        <Banner
          layout="inline"
          model={{
            id: "agent37-template-failed",
            tone: "error",
            title: "New machines can't be made until this is fixed",
            detail: `${status?.error ?? loadError ?? "The build failed."}${status?.nextRetryAt ? ` ${agent37RetryLabel(status.nextRetryAt)}` : ""}`,
            actions: [{ label: "Retry", icon: <ArrowClockwise size={12} />, onClick: onRetry }],
          }}
        />
      ) : null}
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
          <>
            <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => openConnectionsPanel("machines")}>
              Your machines
            </button>
            <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" onClick={() => openExternalUrl(AGENT37_BILLING_URL)}>
              <ArrowSquareOut size={12} /> Wallet
            </button>
            <button type="button" className="ade-modern-btn" data-variant="ghost" data-size="sm" disabled={busy} onClick={() => void disconnect()}>
              <LinkBreak size={12} /> Disconnect
            </button>
          </>
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
            {!status?.error ? <Agent37SpendingCard /> : null}
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
