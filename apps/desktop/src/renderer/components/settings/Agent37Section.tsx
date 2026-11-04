import { useCallback, useEffect, useState } from "react";
import { ArrowSquareOut, CircleNotch, Cube, LinkBreak, Plus } from "@phosphor-icons/react";
import {
  AGENT37_API_KEYS_URL,
  AGENT37_BILLING_URL,
  type Agent37Status,
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
import "./IntegrationsSettings.css";

function errorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  // IPC wraps a main-process throw as "Error invoking remote method '…': Error: <message>".
  const message = raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "").trim();
  return message || fallback;
}

/**
 * Settings › Connections › Agent37. Account-wide: the workspace key is kept in
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

  const load = useCallback(async () => {
    if (!bridge) return;
    setLoading(true);
    try {
      setStatus(await bridge.getStatus());
    } catch (loadError) {
      setError(errorText(loadError, "Couldn't check Agent37."));
    } finally {
      setLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    if (!bridge || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await bridge.saveKey(apiKey));
      setApiKey("");
    } catch (saveError) {
      setError(errorText(saveError, "Couldn't connect Agent37."));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!bridge || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await bridge.removeKey());
    } catch (removeError) {
      setError(errorText(removeError, "Couldn't disconnect Agent37."));
    } finally {
      setBusy(false);
    }
  };

  if (!bridge) {
    return (
      <IntegrationPage id="agent37">
        <p className="ade-ig-note">Agent37 is set up from the ADE desktop app.</p>
      </IntegrationPage>
    );
  }

  const connected = status?.connected === true;
  const heroStatus = loading && !status
    ? { tone: "checking" as const, label: "Checking…" }
    : status?.error
      ? { tone: "warn" as const, label: connected ? "Couldn't reach Agent37" : "Needs attention" }
      : connected
        ? { tone: "ok" as const, label: "Connected" }
        : { tone: "neutral" as const, label: "Not connected" };
  const facts: IntegrationFact[] = connected && !status?.error
    ? [
        { label: "Wallet", value: status?.balanceUsd != null ? `$${status.balanceUsd.toFixed(2)}` : "—", mono: true },
        {
          label: "Machines",
          value: status?.instanceCount != null && status.instanceLimit != null
            ? `${status.instanceCount} of ${status.instanceLimit}`
            : "—",
          title: "Agent37 counts sleeping and stopped machines toward the limit.",
        },
        {
          label: "Sizes",
          value: status?.tier === 0 ? "Smallest box only" : "All sizes and VMs",
          title: status?.tier === 0 ? "Agent37 unlocks VMs and bigger sizes after your first top-up." : undefined,
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
          avatar: <Cube size={16} weight="duotone" />,
          title: "Agent37 workspace",
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
        <Banner layout="inline" model={{ id: "agent37-error", tone: "error", title: "Agent37", detail: error, actions: [{ label: "Check again", onClick: () => { setError(null); void load(); } }] }} />
      ) : null}
      {status?.error && !error ? (
        <Banner layout="inline" model={{ id: "agent37-saved-key-error", tone: "warning", title: connected ? "Couldn't reach Agent37" : "Agent37 refused the saved key", detail: status.error, actions: [{ label: "Check again", onClick: () => { void load(); } }] }} />
      ) : null}

      <IntegrationColumns>
        {connected ? (
          <IntegrationCard
            anchor="agent37-machines"
            icon={<Plus size={15} weight="bold" />}
            title="Make a machine"
            hint="Open your computers (the machine list), choose Add computer, then New Agent37 machine. It signs in to your account on its own and shows up ready to connect."
          >
            <p className="ade-ig-note">
              Boxes run lanes, agents and a Linux Desktop screen. VMs add the Android emulator and Docker. Agent37 bills each running minute; asleep, only the disk.
            </p>
            <div className="ade-ig-step-actions">
              <a className="ade-modern-btn" href={AGENT37_BILLING_URL} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <ArrowSquareOut size={12} /> Agent37 wallet
              </a>
            </div>
          </IntegrationCard>
        ) : (
          <IntegrationCard
            anchor="agent37-connection"
            icon={<Cube size={15} weight="duotone" />}
            title="Connect Agent37"
            hint="Paste a workspace API key. ADE keeps it in your account, so every computer you sign in to can make machines with it."
            actions={loading ? <CircleNotch size={14} className="animate-spin" /> : null}
          >
            <ol className="ade-ig-steps">
              <li className="ade-ig-step">
                <span className="ade-ig-step-num" aria-hidden>1</span>
                <div className="ade-ig-step-main">
                  <div className="ade-ig-step-head"><b>Create an API key</b></div>
                  <p className="ade-ig-note">In your Agent37 dashboard, under API keys. It starts with sk_live_.</p>
                  <div className="ade-ig-step-actions">
                    <a className="ade-modern-btn" href={AGENT37_API_KEYS_URL} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                      <ArrowSquareOut size={12} /> Open Agent37
                    </a>
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
                        ariaLabel="Agent37 API key"
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
