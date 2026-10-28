import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AppWindow, Check, Copy, Desktop, Key, Plus, UserCircle } from "@phosphor-icons/react";
import type {
  RemoteMcpAction,
  RemoteMcpActivityEntry,
  RemoteMcpConnectionSummary,
  RemoteMcpCreatedToken,
  RemoteMcpMachine,
  RemoteMcpScope,
  RemoteMcpStatus,
} from "../../../shared/types/remoteMcp";
import { usageProviderLogo } from "../terminals/ToolLogos";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { ModernPage, ModernRow, ModernRows, ModernSection, SettingsSegmented, SettingsToggle } from "./primitives";
import "./adeMcpPage.css";

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

type KnownApp = "claude" | "codex" | "cursor" | "grok" | "copilot";

/** The app a connection belongs to, from its name and where it signed in from. */
function knownAppFor(connection: Pick<RemoteMcpConnectionSummary, "label" | "redirectHost">): KnownApp | null {
  const text = `${connection.label} ${connection.redirectHost ?? ""}`.toLowerCase();
  if (/claude|anthropic/.test(text)) return "claude";
  if (/chatgpt|openai/.test(text)) return "codex";
  if (/cursor/.test(text)) return "cursor";
  if (/grok|x\.ai/.test(text)) return "grok";
  if (/copilot|github|vscode|vs code/.test(text)) return "copilot";
  return null;
}

function AppMark({ connection }: { connection: RemoteMcpConnectionSummary }) {
  const known = knownAppFor(connection);
  if (known) {
    const Logo = usageProviderLogo(known);
    return <span className="ade-mcp-mark"><Logo size={16} /></span>;
  }
  return (
    <span className="ade-mcp-mark" data-generic="true">
      {connection.kind === "token" ? <Key size={14} /> : <AppWindow size={14} />}
    </span>
  );
}

function errorText(error: unknown, fallback: string): string {
  return ipcErrorMessage(error) || fallback;
}

function usedText(iso: string | null): string {
  if (!iso) return "never used";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "never used";
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "used just now";
  if (minutes < 60) return `used ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `used ${hours} h ago`;
  return `used ${new Date(at).toLocaleDateString()}`;
}

function CopyButton({ value, label, children = "Copy" }: { value: string; label: string; children?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ade-modern-btn"
      data-size="sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        }).catch(() => undefined);
      }}
    >
      {copied ? <Check size={12} weight="bold" /> : <Copy size={12} />}
      {copied ? "Copied" : children}
    </button>
  );
}

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

/** The apps the "Connect an app" helper knows how to set up. */
type ConnectApp = "web" | "claude-code" | "cursor" | "vscode" | "token";

const CONNECT_OPTIONS: readonly { value: ConnectApp; label: string }[] = [
  { value: "web", label: "claude.ai / ChatGPT" },
  { value: "claude-code", label: "Claude Code" },
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VS Code" },
  { value: "token", label: "Script" },
];

/** What to paste, and one line on where, for each app. */
function connectHowTo(app: Exclude<ConnectApp, "token">, url: string): { line: string; snippet: string; copyLabel: string } {
  switch (app) {
    case "web":
      return {
        line: "Add a custom connector with this URL in the app's connector settings. It opens ADE sign-in.",
        snippet: url,
        copyLabel: "Copy server URL",
      };
    case "claude-code":
      return {
        line: "Run this in a terminal, then /mcp in Claude Code to sign in.",
        snippet: `claude mcp add --transport http ade ${url}`,
        copyLabel: "Copy Claude Code command",
      };
    case "cursor":
      return {
        line: "Add this to ~/.cursor/mcp.json. Cursor opens ADE sign-in.",
        snippet: JSON.stringify({ mcpServers: { ade: { url } } }),
        copyLabel: "Copy Cursor config",
      };
    case "vscode":
      return {
        line: "Run this in a terminal. VS Code opens ADE sign-in.",
        snippet: `code --add-mcp '${JSON.stringify({ name: "ade", type: "http", url })}'`,
        copyLabel: "Copy VS Code command",
      };
  }
}

type MachineState = { dot: "ok" | "warn" | null; text: string };

function machineState(machine: RemoteMcpMachine, status: RemoteMcpStatus): MachineState {
  if (!machine.supported) return { dot: "warn", text: "Not joined yet. Open the latest ADE on it." };
  if (!machine.included) return { dot: null, text: "Left out. Apps can't reach it." };
  if (machine.isThisMachine) {
    if (!status.relayConnected) return { dot: "warn", text: "ADE Relay isn't connected here." };
    return status.thisMachineServing
      ? { dot: "ok", text: "Online, answering." }
      : { dot: "warn", text: "Not answering yet." };
  }
  if (machine.online === true) return { dot: "ok", text: "Online." };
  if (machine.online === false) return { dot: null, text: "Offline. Apps reach it again once it's back." };
  return { dot: null, text: "Couldn't check whether it's online." };
}

/** Whether any computer can answer the account URL right now. */
function anyComputerAnswering(status: RemoteMcpStatus): boolean {
  if (status.thisMachineServing && status.relayConnected) return true;
  return status.machines.some((machine) => !machine.isThisMachine && machine.serving);
}

export function AdeMcpPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const connectionsRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<RemoteMcpStatus | null>(null);
  const [activity, setActivity] = useState<RemoteMcpActivityEntry[]>([]);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectApp, setConnectApp] = useState<ConnectApp>("web");
  const [tokenFormOpen, setTokenFormOpen] = useState(false);
  const [tokenLabel, setTokenLabel] = useState("");
  const [tokenScope, setTokenScope] = useState<RemoteMcpScope>("write");
  const [created, setCreated] = useState<RemoteMcpCreatedToken | null>(null);
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

  const openTokenForm = () => {
    setCreated(null);
    setTokenFormOpen(true);
    connectionsRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const createToken = () => void run(async () => {
    const next = await call<RemoteMcpCreatedToken>("createToken", {
      label: tokenLabel.trim() || "Token",
      scope: tokenScope,
    });
    if (!mounted.current) return;
    setCreated(next);
    setTokenFormOpen(false);
    setTokenLabel("");
    setTokenScope("write");
    await load();
  }, "ADE couldn't make a token.");

  const setScope = (connection: RemoteMcpConnectionSummary, scope: RemoteMcpScope) => void run(async () => {
    await call("updateConnection", { id: connection.id, scope });
    await load();
  }, "ADE couldn't change that.");

  const confirmRemove = async (connection: RemoteMcpConnectionSummary) => {
    const isToken = connection.kind === "token";
    const ok = await confirmDialog({
      title: isToken ? `Revoke ${connection.label}?` : `Disconnect ${connection.label}?`,
      message: "Its token stops working on every computer within about a minute. Connecting it again needs a new sign-in or token.",
      confirmLabel: isToken ? "Revoke" : "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    await run(async () => {
      await call("removeConnection", { id: connection.id });
      if (created?.connection.id === connection.id) setCreated(null);
      await load();
    }, "ADE couldn't disconnect that.");
  };

  const signedIn = status?.signedIn === true;
  const enabled = signedIn && status?.enabled === true;
  const connections = status?.connections ?? [];
  const machines = status?.machines ?? [];
  const shownActivity = useMemo(
    () => (showAllActivity ? activity : activity.slice(0, ACTIVITY_PREVIEW)),
    [activity, showAllActivity],
  );

  if (loadError && !status) {
    return (
      <ModernPage>
        <ModernSection group="ADE MCP" anchor="ade-mcp" title="ADE MCP">
          <Banner
            layout="inline"
            model={{
              id: "ade-mcp-load-error",
              tone: "warning",
              title: loadError,
              actions: [{ label: "Retry", onClick: () => { void load(); } }],
            }}
          />
        </ModernSection>
      </ModernPage>
    );
  }

  const serverHint = (() => {
    if (!status || !enabled) return null;
    if (!status.serverUrl) return { dot: "warn", text: "ADE is setting up your account's address." };
    if (anyComputerAnswering(status)) return { dot: "ok", text: "Reachable through ADE Relay." };
    return {
      dot: "warn",
      text: status.relayConnected
        ? "None of your included computers is online, so apps can't reach it right now."
        : "ADE Relay isn't connected here, and no other computer is answering.",
    };
  })();

  return (
    <ModernPage>
      <ModernSection
        group="ADE MCP"
        anchor="ade-mcp"
        title="Server"
        hint="One address for your account. Apps reach every computer you include."
      >
        {status && !signedIn ? (
          <Banner
            layout="inline"
            model={{
              id: "ade-mcp-signed-out",
              tone: "info",
              icon: <UserCircle size={14} />,
              title: "ADE MCP needs your ADE account",
              detail: "Apps sign in through it, and it holds the address and connections for all your computers.",
              actions: [{
                label: "Sign in",
                onClick: () => navigate({ pathname: location.pathname, search: "?tab=account", hash: "" }),
              }],
            }}
          />
        ) : null}
        <ModernRows>
          <ModernRow
            title="Let AI apps use ADE"
            hint={!signedIn
              ? "Off. Sign in to turn it on."
              : enabled
                ? "On for your account. Only apps you connect can use it."
                : "Off. Nothing outside can reach ADE on any of your computers."}
            control={(
              <SettingsToggle
                checked={enabled}
                disabled={busy || !status || !signedIn}
                onChange={setEnabled}
                label="Let AI apps use ADE"
              />
            )}
          />
          {enabled && serverHint ? (
            <ModernRow
              title="Server URL"
              hint={(
                <span className="ade-mcp-status">
                  <span className="kit-dot" data-state={serverHint.dot} />
                  {serverHint.text}
                </span>
              )}
              control={status?.serverUrl ? <CopyButton value={status.serverUrl} label="Copy server URL" /> : null}
            >
              {status?.serverUrl ? <code className="ade-mcp-url">{status.serverUrl}</code> : null}
            </ModernRow>
          ) : null}
          {enabled && status?.serverUrl ? (
            <ModernRow
              title="Connect an app"
              hint="Pick the app. You choose read only or read & write when it signs in."
            >
              <div className="ade-mcp-howto">
                <SettingsSegmented
                  value={connectApp}
                  options={CONNECT_OPTIONS}
                  onChange={setConnectApp}
                  ariaLabel="App to connect"
                />
                {connectApp === "token" ? (
                  <div className="ade-mcp-howto-body">
                    <p className="ade-mcp-howto-line">
                      For scripts and apps that send a header: make a token, then send{" "}
                      <code>Authorization: Bearer &lt;token&gt;</code> to the server URL.
                    </p>
                    <div className="ade-mcp-howto-actions">
                      <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={openTokenForm}>
                        <Plus size={12} />
                        New token
                      </button>
                    </div>
                  </div>
                ) : (() => {
                  const howTo = connectHowTo(connectApp, status.serverUrl);
                  return (
                    <div className="ade-mcp-howto-body">
                      <p className="ade-mcp-howto-line">{howTo.line}</p>
                      <div className="ade-mcp-token-value">
                        <code className="ade-mcp-url">{howTo.snippet}</code>
                        <CopyButton value={howTo.snippet} label={howTo.copyLabel} />
                      </div>
                    </div>
                  );
                })()}
              </div>
            </ModernRow>
          ) : null}
        </ModernRows>
      </ModernSection>

      {enabled && status ? (
        <ModernSection
          group="ADE MCP"
          anchor="ade-mcp-computers"
          title="Computers"
          hint="Apps reach the computers you include. Ask for one by name, or let ADE pick."
        >
          <ModernRows>
            {machines.length ? machines.map((machine) => {
              const state = machineState(machine, status);
              return (
                <ModernRow
                  key={machine.machineKey}
                  icon={<Desktop size={14} />}
                  tone="slate"
                  title={(
                    <span className="ade-mcp-title">
                      {machine.name}
                      {machine.isThisMachine ? <span className="kit-tag">This computer</span> : null}
                    </span>
                  )}
                  hint={(
                    <span className="ade-mcp-status">
                      <span className="kit-dot" data-state={state.dot ?? undefined} />
                      {state.text}
                    </span>
                  )}
                  control={(
                    <SettingsToggle
                      checked={machine.supported && machine.included}
                      disabled={busy || !machine.supported}
                      onChange={(included) => setIncluded(machine, included)}
                      label={`Include ${machine.name}`}
                    />
                  )}
                />
              );
            }) : (
              <ModernRow title="No computers yet" hint="Computers show here once they sign in to your account." />
            )}
          </ModernRows>
        </ModernSection>
      ) : null}

      {signedIn && (enabled || connections.length || created || tokenFormOpen) ? (
        <div ref={connectionsRef}>
          <ModernSection
            group="ADE MCP"
            anchor="ade-mcp-connections"
            title={connections.length ? `Connections (${connections.length})` : "Connections"}
            hint="Each one works on every computer you include."
            actions={tokenFormOpen ? null : (
              <button type="button" className="ade-modern-btn" data-size="sm" disabled={busy} onClick={openTokenForm}>
                <Plus size={12} />
                New token
              </button>
            )}
          >
            {tokenFormOpen ? (
              <form
                className="ade-mcp-token-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  createToken();
                }}
              >
                <input
                  className="kit-input"
                  value={tokenLabel}
                  maxLength={60}
                  placeholder="Name, e.g. Grok or nightly script"
                  aria-label="Token name"
                  autoFocus
                  onChange={(event) => setTokenLabel(event.target.value)}
                />
                <SettingsSegmented
                  value={tokenScope}
                  options={ACCESS_OPTIONS}
                  onChange={setTokenScope}
                  ariaLabel="Token access"
                  disabled={busy}
                />
                <button type="submit" className="ade-modern-btn" data-size="sm" data-tone="primary" disabled={busy}>
                  Create
                </button>
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  data-variant="ghost"
                  onClick={() => setTokenFormOpen(false)}
                >
                  Cancel
                </button>
              </form>
            ) : null}
            {created ? (
              <div className="ade-modern-note ade-mcp-token" data-tone="ok" aria-live="polite">
                <Key size={14} />
                <div className="ade-modern-note-body">
                  <span>
                    Token for <strong>{created.connection.label}</strong>. Copy it now; ADE won't show it again.
                  </span>
                  <div className="ade-mcp-token-value">
                    <code className="ade-mcp-url">{created.token}</code>
                    <CopyButton value={created.token} label="Copy token" />
                  </div>
                </div>
              </div>
            ) : null}
            <ModernRows>
              {connections.length ? connections.map((connection) => (
                <ModernRow
                  key={connection.id}
                  title={(
                    <span className="ade-mcp-title">
                      <AppMark connection={connection} />
                      {connection.label}
                    </span>
                  )}
                  hint={[
                    connection.kind === "token" ? `Token …${connection.tokenHint}` : connection.redirectHost ?? "App",
                    // Made for one computer before ADE MCP covered the account.
                    connection.onlyMachine ? `${connection.onlyMachine.name} only. Reconnect to reach every computer` : null,
                    usedText(connection.lastUsedAt),
                  ].filter(Boolean).join(" · ")}
                  control={(
                    <>
                      <SettingsSegmented
                        value={connection.scope}
                        options={ACCESS_OPTIONS}
                        onChange={(scope) => setScope(connection, scope)}
                        ariaLabel={`${connection.label} access`}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="ade-modern-btn ade-mcp-remove"
                        data-size="sm"
                        data-variant="ghost"
                        disabled={busy}
                        aria-label={`${connection.kind === "token" ? "Revoke" : "Disconnect"} ${connection.label}`}
                        onClick={() => void confirmRemove(connection)}
                      >
                        {connection.kind === "token" ? "Revoke" : "Disconnect"}
                      </button>
                    </>
                  )}
                />
              )) : (
                <ModernRow title="No apps connected yet" hint="Apps you connect, and tokens you make, show here." />
              )}
            </ModernRows>
          </ModernSection>
        </div>
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

      {activity.length ? (
        <ModernSection
          group="ADE MCP"
          anchor="ade-mcp-activity"
          title="Activity on this computer"
          hint={`What connected apps ran on ${status?.machineName || "this computer"}, newest first.`}
        >
          <div className="kit-card">
            <div className="kit-card-body" data-flush="true" role="list">
              {shownActivity.map((entry, index) => (
                <div key={`${entry.at}-${index}`} role="listitem" className="kit-row ade-mcp-activity-row">
                  <span className="kit-num ade-mcp-activity-time">
                    {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                  </span>
                  <span className="ade-mcp-activity-app">{entry.label}</span>
                  <code className="ade-mcp-activity-cmd" title={entry.detail ?? `ade ${entry.command}`}>ade {entry.command}</code>
                  <span className="ade-mcp-activity-hop" title={entry.via ? `${entry.via} took the call and sent it here` : entry.forwardedTo ? `Sent on to ${entry.forwardedTo}` : undefined}>
                    {entry.via ? `via ${entry.via}` : entry.forwardedTo ? `→ ${entry.forwardedTo}` : null}
                  </span>
                  <span className="kit-tag" data-tone={OUTCOME_TONE[entry.outcome]}>{OUTCOME_LABEL[entry.outcome]}</span>
                </div>
              ))}
            </div>
          </div>
          {activity.length > ACTIVITY_PREVIEW ? (
            <button
              type="button"
              className="ade-modern-btn"
              data-size="sm"
              data-variant="link"
              onClick={() => setShowAllActivity((value) => !value)}
            >
              {showAllActivity ? "Show less" : `Show all ${activity.length}`}
            </button>
          ) : null}
        </ModernSection>
      ) : null}
    </ModernPage>
  );
}
