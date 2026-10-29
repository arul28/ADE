import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CaretRight,
  ClockCounterClockwise,
  Desktop,
  Key,
  Plus,
  PlugsConnected,
  UserCircle,
} from "@phosphor-icons/react";
import type {
  RemoteMcpAction,
  RemoteMcpActivityEntry,
  RemoteMcpConnectionSummary,
  RemoteMcpCreatedToken,
  RemoteMcpMachine,
  RemoteMcpScope,
  RemoteMcpStatus,
} from "../../../shared/types/remoteMcp";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { SettingsSegmented, SettingsToggle } from "./primitives";
import { IntegrationCard, IntegrationHero, type IntegrationFact } from "./integrations/IntegrationChrome";
import { integrationThemeVars } from "./integrations/integrationBrand";
import {
  ADE_MCP_BRAND,
  GALLERY_APPS,
  galleryApp,
  galleryIdForKnownApp,
  McpAppLogo,
  type GalleryAppId,
  type TokenSnippetId,
} from "./adeMcp/adeMcpApps";
import { agoText, connectionHow, heroPanelNote, isAnswering, machineState, overallState, vaultFact } from "./adeMcp/adeMcpState";
import { CopyButton } from "./adeMcp/adeMcpParts";
import { AppSetupSheet } from "./adeMcp/AppSetupSheet";
import { TokenDialog } from "./adeMcp/TokenDialog";
import "./adeMcp/adeMcp.css";

/**
 * Settings → You → ADE MCP: one MCP server for the person's ADE account,
 * reached through ADE Relay (services/remoteMcp in the brain). Any included
 * computer on the account can answer its one URL, and a call meant for
 * another computer is forwarded there.
 *
 * Account-wide, so every call goes to this desktop's own brain with no pin:
 * the switch, the computer list and the connections live in the account
 * (settings store and vault), and any brain on the account reads and writes
 * the same values. Only Activity is this computer's own log.
 */

const ACCESS_OPTIONS = [
  { value: "write" as const, label: "Read & write" },
  { value: "read" as const, label: "Read only" },
];

const ACTIVITY_PREVIEW = 8;

const PAGE_VARS = integrationThemeVars(ADE_MCP_BRAND.accent);

/** App marks floating on the banner, between the name and the panel. */
const HERO_ART = (
  <div className="ade-amcp-hero-art" aria-hidden>
    {(["claude", "chatgpt", "grok", "cursor", "claude-code"] as const).map((app) => (
      <span key={app} className="ade-amcp-hero-orbit" data-app={app}>
        <McpAppLogo app={app} size={30} />
      </span>
    ))}
  </div>
);

const OUTCOME_TONE: Record<RemoteMcpActivityEntry["outcome"], string | undefined> = {
  ok: "ok",
  failed: "warn",
  timeout: "warn",
  busy: "warn",
  refused: "crit",
};

const OUTCOME_LABEL: Record<RemoteMcpActivityEntry["outcome"], string> = {
  ok: "done",
  failed: "failed",
  timeout: "timed out",
  busy: "busy",
  refused: "refused",
};

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

type TokenRequest = { label?: string; snippet?: TokenSnippetId };

export function AdeMcpPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const [status, setStatus] = useState<RemoteMcpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [activity, setActivity] = useState<RemoteMcpActivityEntry[]>([]);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupApp, setSetupApp] = useState<GalleryAppId | null>(null);
  // Only what the dialog opens with. The token itself lives inside
  // TokenDialog and goes when it unmounts; the page never holds it.
  const [tokenRequest, setTokenRequest] = useState<TokenRequest | null>(null);
  const [showAllActivity, setShowAllActivity] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // No pin, on purpose: ADE MCP is the account's, so this desktop's own brain
  // reads and writes it for every computer (see the note at the top).
  const call = useCallback(<T,>(action: RemoteMcpAction, args?: Record<string, unknown>): Promise<T> =>
    window.ade.remoteMcpCall<T>(action, args, null), []);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const [next, recent] = await Promise.all([
        call<RemoteMcpStatus>("getStatus"),
        call<RemoteMcpActivityEntry[]>("listActivity", { limit: 50 })
          .then((entries) => ({ entries, error: null }))
          .catch((error: unknown) => ({ entries: null, error: errorText(error, "Couldn't load recent activity.") })),
      ]);
      if (!mounted.current || request !== loadRequest.current) return;
      setStatus(next);
      // A failed read keeps what was shown and says so, rather than looking empty.
      if (recent.entries) setActivity(Array.isArray(recent.entries) ? recent.entries : []);
      setActivityError(recent.error);
      setLoadError(null);
    } catch (error) {
      if (!mounted.current || request !== loadRequest.current) return;
      setStatus(null);
      setLoadError(errorText(error, "Couldn't load ADE MCP."));
    } finally {
      if (mounted.current && request === loadRequest.current) setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(async (work: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await work();
    } catch (error) {
      if (mounted.current) setActionError(errorText(error, fallback));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [busy]);

  // Both actions answer with the account's status.
  const setEnabled = (enabled: boolean) => void run(async () => {
    const next = await call<RemoteMcpStatus>("setEnabled", { enabled });
    if (mounted.current) setStatus(next);
  }, "ADE couldn't change that.");

  const setIncluded = (machine: RemoteMcpMachine, included: boolean) => void run(async () => {
    const next = await call<RemoteMcpStatus>("setMachineIncluded", { machineKey: machine.machineKey, included });
    if (mounted.current) setStatus(next);
  }, `ADE couldn't change ${machine.name}.`);

  // The dialog shows its own error; the page only refreshes its list.
  const createToken = useCallback(async (label: string, scope: RemoteMcpScope): Promise<RemoteMcpCreatedToken> => {
    const created = await call<RemoteMcpCreatedToken>("createToken", { label, scope });
    void load();
    return created;
  }, [call, load]);

  const setScope = (connection: RemoteMcpConnectionSummary, scope: RemoteMcpScope) => void run(async () => {
    await call("updateConnection", { id: connection.id, scope });
    await load();
  }, "ADE couldn't change that.");

  const confirmRemove = async (connection: RemoteMcpConnectionSummary) => {
    const isToken = connection.kind === "token";
    const ok = await confirmDialog({
      title: isToken ? `Revoke ${connection.label}?` : `Disconnect ${connection.label}?`,
      message: "It stops working on every computer within about a minute. Connecting it again needs a new sign-in or token.",
      confirmLabel: isToken ? "Revoke" : "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    await run(async () => {
      await call("removeConnection", { id: connection.id });
      await load();
    }, "ADE couldn't disconnect that.");
  };

  const signedIn = status?.signedIn === true;
  const enabled = signedIn && status?.enabled === true;
  const serverUrl = enabled ? status?.serverUrl ?? null : null;
  const connections = useMemo(() => status?.connections ?? [], [status]);
  const machines = status?.machines ?? [];
  const overall = overallState(status, loading);
  const shownActivity = useMemo(
    () => (showAllActivity ? activity : activity.slice(0, ACTIVITY_PREVIEW)),
    [activity, showAllActivity],
  );
  const connectedByApp = useMemo(() => {
    const counts = new Map<GalleryAppId, number>();
    for (const connection of connections) {
      const id = galleryIdForKnownApp(connection.app ?? null);
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
  }, [connections]);

  const goSignIn = () => navigate({ pathname: location.pathname, search: "?tab=account", hash: "" });
  const scrollToConnect = () => document.getElementById("ade-mcp-connect")?.scrollIntoView({ block: "start", behavior: "smooth" });

  if (loadError && !status) {
    return (
      <div className="ade-pv-provider ade-ig-page ade-amcp-page" style={PAGE_VARS}>
        <Banner
          layout="inline"
          model={{
            id: "ade-mcp-load-error",
            tone: "warning",
            title: loadError,
            actions: [{ label: "Retry", onClick: () => { void load(); } }],
          }}
        />
      </div>
    );
  }

  const included = machines.filter((machine) => machine.included);
  const answering = included.filter(isAnswering).length;
  const sheetApp = setupApp ? galleryApp(setupApp) : null;
  const heroFacts: IntegrationFact[] | undefined = enabled && status ? [
    {
      label: "Computers",
      value: included.length ? `${answering} of ${included.length} answering` : "None included",
      tone: included.length && answering < included.length ? "warn" : undefined,
    },
    {
      label: "Connections",
      value: connections.length ? `${connections.length} ${connections.length === 1 ? "app or token" : "apps and tokens"}` : "None yet",
    },
    vaultFact(status.vault),
  ] : undefined;
  // This computer's account sync, when it is signed in and the sync isn't working.
  const unsyncedVault = status?.signedIn && status.vault.state !== "ok" ? status.vault : null;

  return (
    <div className="ade-pv-provider ade-ig-page ade-amcp-page" style={PAGE_VARS}>
      {/* ── The account's server: what it is, the switch, the address ── */}
      <IntegrationHero
        brand={ADE_MCP_BRAND}
        className="ade-amcp-hero"
        anchor="ade-mcp"
        group="ADE MCP"
        status={overall}
        art={HERO_ART}
        panel={(
          <>
            <span className="ade-ig-hero-panel-label">Server URL</span>
            {serverUrl ? (
              <div className="ade-amcp-hero-url">
                <code title={serverUrl}>{serverUrl}</code>
                <CopyButton value={serverUrl} label="Copy server URL" />
              </div>
            ) : (
              <p className="ade-ig-hero-panel-empty">{heroPanelNote(status)}</p>
            )}
            {status && !signedIn ? (
              <div className="ade-ig-hero-panel-actions">
                <button type="button" className="ade-modern-btn" data-size="sm" onClick={goSignIn}>
                  <UserCircle size={13} />
                  Sign in
                </button>
              </div>
            ) : null}
            <div className="ade-ig-hero-toggle">
              <span>
                <b>{enabled ? "On" : "Off"}</b>
                <small>Let AI apps use ADE</small>
              </span>
              <SettingsToggle
                checked={enabled}
                disabled={busy || !status || !signedIn}
                onChange={setEnabled}
                label="Let AI apps use ADE"
              />
            </div>
          </>
        )}
        facts={heroFacts}
      />

      {unsyncedVault ? (
        <Banner
          layout="inline"
          model={{
            id: "ade-mcp-vault",
            tone: unsyncedVault.state === "failing" ? "error" : "warning",
            title: "Account sync isn't working on this computer",
            detail: [
              unsyncedVault.message ?? "ADE MCP's settings and connections can't reach this computer until it syncs.",
              unsyncedVault.pendingChanges > 0 ? `${unsyncedVault.pendingChanges} change${unsyncedVault.pendingChanges === 1 ? "" : "s"} waiting to upload.` : null,
              agoText(unsyncedVault.lastSyncedAt) ? `Last synced ${agoText(unsyncedVault.lastSyncedAt)}.` : null,
            ].filter(Boolean).join(" "),
            report: { surface: "ade_mcp_vault", code: `vault_${unsyncedVault.state}` },
            actions: [{ label: "Check again", onClick: () => { void load(); } }],
          }}
        />
      ) : null}

      {actionError ? (
        <Banner
          layout="inline"
          model={{
            id: "ade-mcp-action-error",
            tone: "error",
            title: actionError,
            report: { surface: "ade_mcp_action" },
            dismiss: { onDismiss: () => setActionError(null) },
          }}
        />
      ) : null}

      {/* ── Connect an app ── */}
      {serverUrl ? (
        <IntegrationCard
          anchor="ade-mcp-connect"
          icon={<PlugsConnected size={16} weight="duotone" />}
          title="Connect an app"
          hint="Pick your app for its steps. When it signs in, you choose read only or read & write."
          actions={(
            <button type="button" className="ade-modern-btn" data-size="sm" onClick={() => setTokenRequest({})}>
              <Key size={12} />
              Use a token
            </button>
          )}
        >
          <div className="ade-amcp-gallery">
            {GALLERY_APPS.map((app) => {
              const connected = connectedByApp.get(app.id) ?? 0;
              return (
                <button
                  key={app.id}
                  type="button"
                  className="ade-amcp-app"
                  data-other={app.id === "other" ? "true" : undefined}
                  data-testid={`ade-mcp-app-${app.id}`}
                  onClick={() => setSetupApp(app.id)}
                >
                  <McpAppLogo app={app.id} size={34} />
                  <span className="ade-amcp-app-text">
                    <b>{app.label}</b>
                    <small>
                      {connected ? (
                        <><i className="ade-ig-dot" data-tone="ok" /> Connected</>
                      ) : app.token ? "Sign in or token" : "Sign in"}
                    </small>
                  </span>
                  <CaretRight size={12} weight="bold" className="ade-amcp-app-caret" />
                </button>
              );
            })}
          </div>
        </IntegrationCard>
      ) : status && !enabled ? (
        <IntegrationCard
          anchor="ade-mcp-connect"
          icon={<PlugsConnected size={16} weight="duotone" />}
          title="How it works"
        >
          <ol className="ade-ig-steps ade-amcp-how">
            {[
              ["Turn it on", "Your account gets one address. It's the same on every computer."],
              ["Connect an app", "claude.ai, ChatGPT, Grok, Cursor, Claude Code and others sign in with your ADE account. Scripts and APIs use a token."],
              ["Choose what it can do", "Read only or read & write, for each app. Change it or revoke it here any time."],
            ].map(([title, detail], index) => (
              <li key={title} className="ade-ig-step">
                <span className="ade-ig-step-num">{index + 1}</span>
                <div className="ade-ig-step-main">
                  <div className="ade-ig-step-head"><b>{title}</b></div>
                  <p className="ade-amcp-step-detail">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </IntegrationCard>
      ) : null}

      {/* ── Computers ── */}
      {enabled && status ? (
        <IntegrationCard
          anchor="ade-mcp-computers"
          icon={<Desktop size={16} weight="duotone" />}
          title="Computers"
          hint="Apps reach the computers you include. They can ask for one by name, or let ADE pick."
        >
          <div className="ade-ig-rows">
            {machines.length ? machines.map((machine) => {
              const state = machineState(machine);
              const reported = machine.isThisMachine ? null : agoText(machine.reportedAt);
              return (
                <div key={machine.machineKey} className="ade-amcp-row ade-amcp-machine" data-tone={state.tone}>
                  <span className="ade-amcp-machine-icon" aria-hidden><Desktop size={16} /></span>
                  <div className="ade-amcp-row-main">
                    <div className="ade-amcp-row-title">
                      <b>{machine.name}</b>
                      {machine.isThisMachine ? <span className="kit-tag">This computer</span> : null}
                    </div>
                    <div className="ade-amcp-row-detail">
                      <span className="ade-amcp-state" data-tone={state.tone}>
                        <i className="ade-ig-dot" data-tone={state.tone} />
                        {state.label}
                      </span>
                      <span>{state.detail}</span>
                    </div>
                    {reported ? <span className="ade-amcp-row-meta">Reported {reported}</span> : null}
                  </div>
                  <div className="ade-amcp-row-side">
                    {machine.isThisMachine && machine.notServingReason === "signed_out" ? (
                      <button type="button" className="ade-modern-btn" data-size="sm" onClick={goSignIn}>Sign in</button>
                    ) : null}
                    <SettingsToggle
                      checked={machine.supported && machine.included}
                      disabled={busy || !machine.supported}
                      onChange={(next) => setIncluded(machine, next)}
                      label={`Include ${machine.name}`}
                    />
                  </div>
                </div>
              );
            }) : (
              <div className="ade-amcp-empty">Computers show here once they sign in to your account.</div>
            )}
          </div>
        </IntegrationCard>
      ) : null}

      {/* ── Connections ── */}
      {signedIn && (enabled || connections.length) ? (
        <IntegrationCard
          anchor="ade-mcp-connections"
          icon={<PlugsConnected size={16} weight="duotone" />}
          title="Connections"
          badge={connections.length ? <span className="kit-tag">{connections.length}</span> : undefined}
          hint="Each one works on every computer you include."
          actions={enabled ? (
            <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={() => setTokenRequest({})}>
              <Plus size={12} />
              New token
            </button>
          ) : undefined}
        >
          {connections.length ? (
            <div className="ade-ig-rows">
              {connections.map((connection) => {
                const used = agoText(connection.lastUsedAt);
                const isToken = connection.kind === "token";
                return (
                  <div key={connection.id} className="ade-amcp-row ade-amcp-connection">
                    <McpAppLogo app={connection.app ?? (isToken ? "token" : "other")} size={30} />
                    <div className="ade-amcp-row-main">
                      <div className="ade-amcp-row-title"><b>{connection.label}</b></div>
                      <div className="ade-amcp-row-detail ade-amcp-row-detail-quiet">
                        <span>{connectionHow(connection)}</span>
                        <span>{used ? `Used ${used}` : "Not used yet"}</span>
                      </div>
                      {/* Kept to one computer: made before ADE MCP covered the account, or signed in on that computer's own address. */}
                      {connection.onlyMachine ? (
                        <span className="ade-amcp-row-meta" data-tone="warn">
                          Reaches only {connection.onlyMachine.name}. Connect it with your account's address to reach every computer.
                        </span>
                      ) : null}
                    </div>
                    <div className="ade-amcp-row-side">
                      <SettingsSegmented
                        value={connection.scope}
                        options={ACCESS_OPTIONS}
                        onChange={(scope) => setScope(connection, scope)}
                        ariaLabel={`${connection.label} access`}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="ade-modern-btn ade-amcp-remove"
                        data-size="sm"
                        data-variant="ghost"
                        disabled={busy}
                        aria-label={`${isToken ? "Revoke" : "Disconnect"} ${connection.label}`}
                        onClick={() => void confirmRemove(connection)}
                      >
                        {isToken ? "Revoke" : "Disconnect"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="ade-amcp-empty-state">
              <b>No apps connected yet</b>
              <span>Apps you connect, and tokens you make, show here.</span>
              {serverUrl ? (
                <button type="button" className="ade-modern-btn" data-size="sm" onClick={scrollToConnect}>
                  Connect an app
                </button>
              ) : null}
            </div>
          )}
        </IntegrationCard>
      ) : null}

      {activityError ? (
        <Banner
          layout="inline"
          model={{
            id: "ade-mcp-activity-error",
            tone: "warning",
            title: activityError,
            actions: [{ label: "Retry", onClick: () => { void load(); } }],
          }}
        />
      ) : null}

      {/* ── Activity: this computer's own log ── */}
      {activity.length ? (
        <IntegrationCard
          anchor="ade-mcp-activity"
          icon={<ClockCounterClockwise size={16} weight="duotone" />}
          title="Activity on this computer"
          hint={`What connected apps ran on ${status?.machineName || "this computer"}, newest first.`}
        >
          <div className="ade-ig-rows" role="list">
            {shownActivity.map((entry, index) => (
              <div key={`${entry.at}-${index}`} role="listitem" className="ade-amcp-activity-row">
                <span className="kit-num ade-amcp-activity-time">
                  {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
                <span className="ade-amcp-activity-app">{entry.label}</span>
                <code className="ade-amcp-activity-cmd" title={entry.detail ?? `ade ${entry.command}`}>ade {entry.command}</code>
                <span className="ade-amcp-activity-hop" title={entry.via ? `${entry.via} took the call and sent it here` : entry.forwardedTo ? `Sent on to ${entry.forwardedTo}` : undefined}>
                  {entry.via ? `via ${entry.via}` : entry.forwardedTo ? `→ ${entry.forwardedTo}` : null}
                </span>
                <span className="kit-tag" data-tone={OUTCOME_TONE[entry.outcome]}>{OUTCOME_LABEL[entry.outcome]}</span>
              </div>
            ))}
          </div>
          {activity.length > ACTIVITY_PREVIEW ? (
            <button
              type="button"
              className="ade-ig-link ade-amcp-activity-more"
              onClick={() => setShowAllActivity((value) => !value)}
            >
              {showAllActivity ? "Show less" : `Show all ${activity.length}`}
            </button>
          ) : null}
        </IntegrationCard>
      ) : null}

      {sheetApp && serverUrl ? (
        <AppSetupSheet
          app={sheetApp}
          serverUrl={serverUrl}
          connectedCount={connectedByApp.get(sheetApp.id) ?? 0}
          onClose={() => setSetupApp(null)}
          onUseToken={() => {
            setSetupApp(null);
            setTokenRequest({
              label: sheetApp.tokenLabel ?? sheetApp.label,
              snippet: sheetApp.tokenSnippet,
            });
          }}
        />
      ) : null}

      {tokenRequest ? (
        <TokenDialog
          initialLabel={tokenRequest.label}
          initialSnippet={tokenRequest.snippet}
          serverUrl={status?.serverUrl ?? null}
          createToken={createToken}
          onClose={() => setTokenRequest(null)}
        />
      ) : null}
    </div>
  );
}
