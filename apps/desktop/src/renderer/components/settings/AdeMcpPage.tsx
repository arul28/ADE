import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, Check, Copy, Key, Plus } from "@phosphor-icons/react";
import type {
  RemoteMcpAction,
  RemoteMcpActivityEntry,
  RemoteMcpConnectionSummary,
  RemoteMcpCreatedToken,
  RemoteMcpScope,
  RemoteMcpStatus,
} from "../../../shared/types/remoteMcp";
import { usageProviderLogo } from "../terminals/ToolLogos";
import { confirmDialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { ipcErrorMessage } from "../../lib/format";
import { ModernPage, ModernRow, ModernRows, ModernSection, SettingsSegmented, SettingsToggle } from "./primitives";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import "./adeMcpPage.css";

/**
 * Settings → Computer → ADE MCP: this machine as an MCP server for the AI apps
 * the person picks, through ADE Relay (services/remoteMcp in the brain).
 *
 * A machine page: every call carries the page's pin, so it reads and changes
 * the machine shown, never the tab's project runtime.
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
  if (/copilot|github/.test(text)) return "copilot";
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

export function AdeMcpPage() {
  const { pin, isThisMachine, machineName } = useSettingsMachineScope();
  const pinKey = pin?.key ?? null;
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const mounted = useRef(true);
  const loadRequest = useRef(0);
  const [status, setStatus] = useState<RemoteMcpStatus | null>(null);
  const [activity, setActivity] = useState<RemoteMcpActivityEntry[]>([]);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  // A null pin is this computer; the preload routes it to this machine's brain.
  const call = useCallback(<T,>(action: RemoteMcpAction, args?: Record<string, unknown>): Promise<T> =>
    window.ade.remoteMcpCall<T>(action, args, pinRef.current), []);

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
      setLoadError(errorText(error, "Couldn't load ADE MCP for this computer."));
    }
  }, [call]);

  // Keyed on the pin's key, not the object: a rebuilt pin for the same machine
  // must not reset what the person is looking at.
  useEffect(() => {
    setStatus(null);
    setCreated(null);
    setTokenFormOpen(false);
    setActionError(null);
    void load();
  }, [load, pinKey]);

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

  const setEnabled = (enabled: boolean) => void run(async () => {
    const next = await call<RemoteMcpStatus>("setEnabled", { enabled });
    if (mounted.current) setStatus(next);
  }, "ADE couldn't change that.");

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
    const ok = await confirmDialog({
      title: `Disconnect ${connection.label}?`,
      message: "Its token stops working now. Connecting it again needs a new sign-in or token.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    await run(async () => {
      await call("removeConnection", { id: connection.id });
      if (created?.connection.id === connection.id) setCreated(null);
      await load();
    }, "ADE couldn't disconnect that.");
  };

  const enabled = status?.enabled === true;
  const computer = isThisMachine ? "this computer" : machineName;
  const connections = status?.connections ?? [];
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

  return (
    <ModernPage>
      <ModernSection group="ADE MCP" anchor="ade-mcp" title="Server">
        <ModernRows>
          <ModernRow
            title={`Let AI apps use ${computer}`}
            hint={enabled ? "On. Only apps you connect can use it." : "Off. Nothing outside can reach ADE here."}
            control={(
              <SettingsToggle
                checked={enabled}
                disabled={busy || !status}
                onChange={setEnabled}
                label={`Let AI apps use ${computer}`}
              />
            )}
          />
          {enabled ? (
            <ModernRow
              title="Server URL"
              hint={(
                <span className="ade-mcp-status">
                  <span className="kit-dot" data-state={status?.serverUrl && status.relayConnected ? "ok" : "warn"} />
                  {!status?.serverUrl
                    ? `Sign in to your ADE account on ${computer} to get an address.`
                    : status.relayConnected
                      ? "Reachable through ADE Relay."
                      : "ADE Relay isn't connected, so apps can't reach it right now."}
                </span>
              )}
              control={status?.serverUrl ? <CopyButton value={status.serverUrl} label="Copy server URL" /> : null}
            >
              {status?.serverUrl ? <code className="ade-mcp-url">{status.serverUrl}</code> : null}
            </ModernRow>
          ) : null}
        </ModernRows>
      </ModernSection>

      {enabled ? (
        <ModernSection
          group="ADE MCP"
          anchor="ade-mcp-connect"
          title="Connect an app"
          hint="Either way, you choose read only or read & write."
        >
          <ModernRows>
            <ModernRow
              title={(
                <span className="ade-mcp-title">
                  <span className="ade-mcp-logos" aria-hidden>
                    {(["claude", "codex", "cursor"] as const).map((app) => {
                      const Logo = usageProviderLogo(app);
                      return <Logo key={app} size={14} />;
                    })}
                  </span>
                  Sign in from the app
                </span>
              )}
              hint="Add the server URL as a custom connector. The app opens ADE sign-in."
              control={status?.serverUrl ? <CopyButton value={status.serverUrl} label="Copy server URL" children="Copy URL" /> : null}
            />
            <ModernRow
              title={(
                <span className="ade-mcp-title">
                  <span className="ade-mcp-logos" aria-hidden>
                    {(() => {
                      const Logo = usageProviderLogo("grok");
                      return <Logo size={14} />;
                    })()}
                    <Key size={14} />
                  </span>
                  Use a token
                </span>
              )}
              hint="For apps and APIs that send a header, like Grok."
              control={tokenFormOpen ? null : (
                <button
                  type="button"
                  className="ade-modern-btn"
                  data-size="sm"
                  disabled={busy}
                  onClick={() => {
                    setCreated(null);
                    setTokenFormOpen(true);
                  }}
                >
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
                    placeholder="Name, e.g. Grok"
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
            </ModernRow>
          </ModernRows>
        </ModernSection>
      ) : null}

      {connections.length ? (
        <ModernSection
          group="ADE MCP"
          anchor="ade-mcp-connections"
          title={`Connected (${connections.length})`}
          hint="Change what each one may do, or disconnect it."
        >
          <ModernRows>
            {connections.map((connection) => (
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
                  usedText(connection.lastUsedAt),
                ].join(" · ")}
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
                      className="ade-modern-btn"
                      data-size="sm"
                      data-variant="ghost"
                      disabled={busy}
                      aria-label={`Disconnect ${connection.label}`}
                      onClick={() => void confirmRemove(connection)}
                    >
                      Disconnect
                    </button>
                  </>
                )}
              />
            ))}
          </ModernRows>
        </ModernSection>
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
          title="Activity"
          hint="What connected apps ran here, newest first."
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
