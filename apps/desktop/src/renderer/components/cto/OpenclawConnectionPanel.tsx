import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  CheckCircle,
  CircleNotch,
  WarningCircle,
} from "@phosphor-icons/react";
import type {
  CtoIdentity,
  OpenclawMessageRecord,
  OpenclawBridgeState,
  OpenclawBridgeStatus,
  OpenclawNotificationRoute,
  OpenclawNotificationType,
} from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { ConnectionStatusDot } from "./shared/ConnectionStatusDot";
import { cardCls, inputCls, labelCls } from "./shared/designTokens";

const NOTIFICATION_TYPES: OpenclawNotificationType[] = [
  "mission_complete",
  "ci_broken",
  "blocked_run",
];

const CONNECTION_STATUS_LABEL: Record<"connected" | "degraded" | "disconnected", string> = {
  connected: "Connected",
  degraded: "Connecting",
  disconnected: "Disconnected",
};

type DraftState = {
  enabled: boolean;
  bridgePort: string;
  gatewayUrl: string;
  gatewayToken: string;
  hooksToken: string;
  allowedAgentIds: string;
  defaultTarget: string;
  allowEmployeeTargets: boolean;
  notificationRoutes: Record<OpenclawNotificationType, { agentId: string; sessionKey: string; enabled: boolean }>;
};

type ManualDraftState = {
  agentId: string;
  sessionKey: string;
  message: string;
};

function routesToDraft(routes: OpenclawNotificationRoute[]): DraftState["notificationRoutes"] {
  const base = Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [
      type,
      {
        agentId: "",
        sessionKey: "",
        enabled: false,
      },
    ]),
  ) as DraftState["notificationRoutes"];

  for (const route of routes) {
    base[route.notificationType] = {
      agentId: route.agentId ?? "",
      sessionKey: route.sessionKey ?? "",
      enabled: route.enabled !== false,
    };
  }
  return base;
}

function stateToDraft(state: OpenclawBridgeState | null): DraftState {
  return {
    enabled: state?.config.enabled === true,
    bridgePort: String(state?.config.bridgePort ?? 18791),
    gatewayUrl: state?.config.gatewayUrl ?? "",
    gatewayToken: state?.config.gatewayToken ?? "",
    hooksToken: state?.config.hooksToken ?? "",
    allowedAgentIds: (state?.config.allowedAgentIds ?? []).join(", "),
    defaultTarget: state?.config.defaultTarget ?? "cto",
    allowEmployeeTargets: state?.config.allowEmployeeTargets !== false,
    notificationRoutes: routesToDraft(state?.config.notificationRoutes ?? []),
  };
}

function normalizeRoutes(
  routes: DraftState["notificationRoutes"],
): OpenclawNotificationRoute[] {
  return NOTIFICATION_TYPES
    .map((notificationType) => ({
      notificationType,
      agentId: routes[notificationType].agentId.trim() || null,
      sessionKey: routes[notificationType].sessionKey.trim() || null,
      enabled: routes[notificationType].enabled,
    }))
    .filter((route) => route.enabled || route.agentId || route.sessionKey);
}

export function OpenclawConnectionPanel({
  compact = false,
  showConfig = true,
  showRecentTraffic = !compact,
  identity,
  onSaveIdentity,
  onStateChange,
}: {
  compact?: boolean;
  showConfig?: boolean;
  showRecentTraffic?: boolean;
  identity?: CtoIdentity | null;
  onSaveIdentity?: (patch: Record<string, unknown>) => Promise<void>;
  onStateChange?: (state: OpenclawBridgeState | null) => void;
}) {
  const [state, setState] = useState<OpenclawBridgeState | null>(null);
  const [draft, setDraft] = useState<DraftState>(stateToDraft(null));
  const [messages, setMessages] = useState<OpenclawMessageRecord[]>([]);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextSaving, setContextSaving] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [manualDraft, setManualDraft] = useState<ManualDraftState>({
    agentId: "",
    sessionKey: "",
    message: "",
  });
  const [manualSending, setManualSending] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualSuccess, setManualSuccess] = useState<string | null>(null);
  const [contextDraft, setContextDraft] = useState({
    shareMode: identity?.openclawContextPolicy?.shareMode ?? "filtered",
    blockedCategories: (identity?.openclawContextPolicy?.blockedCategories ?? []).join(", "),
  });
  const onStateChangeRef = useRef(onStateChange);

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
  }, [onStateChange]);

  const connectionStatus: "connected" | "degraded" | "disconnected" = useMemo(() => {
    if (state?.status.state === "connected") return "connected";
    if (state?.status.state === "reconnecting" || state?.status.state === "connecting") return "degraded";
    return "disconnected";
  }, [state?.status.state]);

  const load = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const [nextState, nextMessages] = await Promise.all([
        window.ade.cto.getOpenclawState(),
        window.ade.cto.listOpenclawMessages({ limit: compact ? 6 : 12 }),
      ]);
      setState(nextState);
      setDraft(stateToDraft(nextState));
      setMessages(nextMessages);
      setError(null);
      onStateChangeRef.current?.(nextState);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load OpenClaw state.");
      setState(null);
      setMessages([]);
      onStateChangeRef.current?.(null);
    }
  }, [compact]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const unsubscribe = window.ade?.cto?.onOpenclawConnectionStatus?.((nextStatus) => {
      setState((current) => current ? { ...current, status: nextStatus } : current);
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    setContextDraft({
      shareMode: identity?.openclawContextPolicy?.shareMode ?? "filtered",
      blockedCategories: (identity?.openclawContextPolicy?.blockedCategories ?? []).join(", "),
    });
  }, [identity]);

  const saveConfig = useCallback(async () => {
    if (!window.ade?.cto) return;
    setSaving(true);
    setError(null);
    try {
      const nextState = await window.ade.cto.updateOpenclawConfig({
        patch: {
          enabled: draft.enabled,
          bridgePort: Number(draft.bridgePort) || 18791,
          gatewayUrl: draft.gatewayUrl.trim() || null,
          gatewayToken: draft.gatewayToken.trim() || null,
          hooksToken: draft.hooksToken.trim() || null,
          allowedAgentIds: draft.allowedAgentIds
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
          defaultTarget: (draft.defaultTarget.trim() || "cto") as "cto" | `agent:${string}`,
          allowEmployeeTargets: draft.allowEmployeeTargets,
          notificationRoutes: normalizeRoutes(draft.notificationRoutes),
        },
      });
      setState(nextState);
      onStateChange?.(nextState);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save OpenClaw settings.");
    } finally {
      setSaving(false);
    }
  }, [draft, load, onStateChange]);

  const testConnection = useCallback(async () => {
    if (!window.ade?.cto) return;
    setTesting(true);
    setError(null);
    try {
      await saveConfig();
      const nextStatus = await window.ade.cto.testOpenclawConnection({});
      setState((current) => current ? { ...current, status: nextStatus } : current);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "OpenClaw connection test failed.");
    } finally {
      setTesting(false);
    }
  }, [load, saveConfig]);

  const saveContextPolicy = useCallback(async () => {
    if (!onSaveIdentity) return;
    setContextSaving(true);
    setContextError(null);
    try {
      await onSaveIdentity({
        openclawContextPolicy: {
          shareMode: contextDraft.shareMode,
          blockedCategories: contextDraft.blockedCategories
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        },
      });
    } catch (err) {
      setContextError(err instanceof Error ? err.message : "Failed to save context policy.");
    } finally {
      setContextSaving(false);
    }
  }, [contextDraft, onSaveIdentity]);

  const sendManualMessage = useCallback(async () => {
    if (!window.ade?.cto) return;
    const message = manualDraft.message.trim();
    const sessionKey = manualDraft.sessionKey.trim();
    const agentId = manualDraft.agentId.trim();
    if (!message.length) {
      setManualError("Enter a message before sending.");
      return;
    }
    if (!sessionKey && !agentId) {
      setManualError("Provide either a session key or an agent ID.");
      return;
    }
    setManualSending(true);
    setManualError(null);
    setManualSuccess(null);
    try {
      await window.ade.cto.sendOpenclawMessage({
        sessionKey: sessionKey || null,
        agentId: agentId || null,
        message,
      });
      setManualDraft((current) => ({ ...current, message: "" }));
      setManualSuccess("Message queued for delivery.");
      await load();
    } catch (err) {
      setManualError(err instanceof Error ? err.message : "Failed to send OpenClaw message.");
    } finally {
      setManualSending(false);
    }
  }, [load, manualDraft]);

  return (
    <div className={cn("space-y-4", compact && "space-y-3")} data-testid="openclaw-connection-panel">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={labelCls}>Connection Status</span>
          <ConnectionStatusDot
            status={connectionStatus}
            label={CONNECTION_STATUS_LABEL[connectionStatus]}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={saving || testing} onClick={() => void load()}>
            <ArrowCounterClockwise size={10} />
            Refresh
          </Button>
          <Button variant="primary" size="sm" disabled={saving || testing} onClick={() => void testConnection()}>
            {testing ? <CircleNotch size={10} className="animate-spin" /> : "Test"}
          </Button>
        </div>
      </div>

      {showConfig && (
        <div className={cn(cardCls, compact ? "p-3" : "p-4")}>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <div className={labelCls}>Enable Bridge</div>
              <label className="flex items-center gap-2 font-mono text-[10px] text-fg">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
                />
                Accept incoming hooks/queries and attempt operator pairing
              </label>
            </label>

            <label className="space-y-1">
              <div className={labelCls}>Bridge Port</div>
              <input
                className={inputCls}
                value={draft.bridgePort}
                onChange={(event) => setDraft((current) => ({ ...current, bridgePort: event.target.value }))}
              />
            </label>

            <label className="space-y-1 md:col-span-2">
              <div className={labelCls}>Gateway URL</div>
              <input
                className={inputCls}
                placeholder="ws://127.0.0.1:18789"
                value={draft.gatewayUrl}
                onChange={(event) => setDraft((current) => ({ ...current, gatewayUrl: event.target.value }))}
              />
            </label>

            <label className="space-y-1">
              <div className={labelCls}>Gateway Token</div>
              <input
                className={inputCls}
                type="password"
                placeholder="optional gateway/operator token"
                value={draft.gatewayToken}
                onChange={(event) => setDraft((current) => ({ ...current, gatewayToken: event.target.value }))}
              />
            </label>

            <label className="space-y-1">
              <div className={labelCls}>Hook Token</div>
              <input
                className={inputCls}
                type="password"
                placeholder="token for /openclaw/hook and /openclaw/query"
                value={draft.hooksToken}
                onChange={(event) => setDraft((current) => ({ ...current, hooksToken: event.target.value }))}
              />
            </label>

            <label className="space-y-1">
              <div className={labelCls}>Default Target</div>
              <input
                className={inputCls}
                placeholder="cto or agent:frontend"
                value={draft.defaultTarget}
                onChange={(event) => setDraft((current) => ({ ...current, defaultTarget: event.target.value }))}
              />
            </label>

            <label className="space-y-1">
              <div className={labelCls}>Allowed OpenClaw Agents</div>
              <input
                className={inputCls}
                placeholder="cto-bot, qa-bot"
                value={draft.allowedAgentIds}
                onChange={(event) => setDraft((current) => ({ ...current, allowedAgentIds: event.target.value }))}
              />
            </label>
          </div>

          <label className="mt-3 flex items-center gap-2 font-mono text-[10px] text-fg">
            <input
              type="checkbox"
              checked={draft.allowEmployeeTargets}
              onChange={(event) => setDraft((current) => ({ ...current, allowEmployeeTargets: event.target.checked }))}
            />
            Allow `targetHint` values like `agent:worker-slug`
          </label>

          {!compact && (
            <div className="mt-4 space-y-2">
              <div className={labelCls}>Notification Routes</div>
              {NOTIFICATION_TYPES.map((notificationType) => (
                <div key={notificationType} className="grid gap-2 rounded border border-border/10 bg-surface-recessed p-3 md:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)]">
                  <label className="flex items-center gap-2 font-mono text-[10px] text-fg">
                    <input
                      type="checkbox"
                      checked={draft.notificationRoutes[notificationType].enabled}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        notificationRoutes: {
                          ...current.notificationRoutes,
                          [notificationType]: {
                            ...current.notificationRoutes[notificationType],
                            enabled: event.target.checked,
                          },
                        },
                      }))}
                    />
                    {notificationType}
                  </label>
                  <input
                    className={inputCls}
                    placeholder="agentId"
                    value={draft.notificationRoutes[notificationType].agentId}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      notificationRoutes: {
                        ...current.notificationRoutes,
                        [notificationType]: {
                          ...current.notificationRoutes[notificationType],
                          agentId: event.target.value,
                        },
                      },
                    }))}
                  />
                  <input
                    className={inputCls}
                    placeholder="sessionKey (optional)"
                    value={draft.notificationRoutes[notificationType].sessionKey}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      notificationRoutes: {
                        ...current.notificationRoutes,
                        [notificationType]: {
                          ...current.notificationRoutes[notificationType],
                          sessionKey: event.target.value,
                        },
                      },
                    }))}
                  />
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <div className="font-mono text-[9px] text-muted-fg/50">
              {state?.endpoints.healthUrl ? (
                <>
                  Health: {state.endpoints.healthUrl}
                  <br />
                  Hook: {state.endpoints.hookUrl}
                  <br />
                  Query: {state.endpoints.queryUrl}
                </>
              ) : (
                "Health, hook, and query endpoints appear once the local bridge listener starts."
              )}
            </div>
            <Button variant="outline" size="sm" disabled={saving} onClick={() => void saveConfig()}>
              {saving ? "Saving..." : "Save Settings"}
            </Button>
          </div>
        </div>
      )}

      {state?.status.lastError && (
        <div className="flex items-start gap-2 rounded border border-error/20 bg-error/5 px-3 py-2">
          <WarningCircle size={14} className="mt-0.5 shrink-0 text-error" />
          <div className="font-mono text-[10px] text-fg/80">{state.status.lastError}</div>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded border border-error/20 bg-error/5 px-3 py-2">
          <WarningCircle size={14} className="mt-0.5 shrink-0 text-error" />
          <div className="font-mono text-[10px] text-fg/80">{error}</div>
        </div>
      )}

      {state?.status.state === "connected" && (
        <div className={cn(cardCls, compact ? "p-2.5" : "p-3")}>
          <div className="flex items-center gap-2">
            <CheckCircle size={14} weight="fill" className="text-success" />
            <span className="font-mono text-[10px] text-fg">
              Paired device <span className="font-bold">{state.status.deviceId ?? "unknown"}</span>
            </span>
          </div>
          <div className="mt-1 font-mono text-[9px] text-muted-fg/45">
            Last connected: {state.status.lastConnectedAt ? new Date(state.status.lastConnectedAt).toLocaleString() : "n/a"}
          </div>
        </div>
      )}

      {!compact && onSaveIdentity && (
        <div className={cn(cardCls, "p-4")}>
          <div className="mb-3">
            <div className="font-sans text-xs font-bold text-fg">OpenClaw Context Policy</div>
            <div className="mt-1 font-mono text-[10px] text-muted-fg/55">
              Controls which metadata ADE includes when it sends notifications or bridge replies back into OpenClaw.
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <div className={labelCls}>Share Mode</div>
              <select
                className={inputCls}
                value={contextDraft.shareMode}
                onChange={(event) => setContextDraft((current) => ({ ...current, shareMode: event.target.value as "full" | "filtered" }))}
              >
                <option value="filtered">Filtered</option>
                <option value="full">Full</option>
              </select>
            </label>

            <label className="space-y-1">
              <div className={labelCls}>Blocked Categories</div>
              <input
                className={inputCls}
                placeholder="secret, token, system_prompt"
                value={contextDraft.blockedCategories}
                onChange={(event) => setContextDraft((current) => ({ ...current, blockedCategories: event.target.value }))}
              />
            </label>
          </div>

          {contextError && <div className="mt-3 font-mono text-[10px] text-error">{contextError}</div>}

          <div className="mt-4 flex justify-end">
            <Button variant="outline" size="sm" disabled={contextSaving} onClick={() => void saveContextPolicy()}>
              {contextSaving ? "Saving..." : "Save Context Policy"}
            </Button>
          </div>
        </div>
      )}

      {!compact && showConfig && (
        <div className={cn(cardCls, "p-4")}>
          <div className="mb-3">
            <div className="font-sans text-xs font-bold text-fg">Manual Outbound Message</div>
            <div className="mt-1 font-mono text-[10px] text-muted-fg/55">
              Send a direct bridge message to a known OpenClaw session or agent to validate routing end to end.
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1">
              <div className={labelCls}>Session Key</div>
              <input
                className={inputCls}
                placeholder="chat:discord:thread:123"
                value={manualDraft.sessionKey}
                onChange={(event) => setManualDraft((current) => ({ ...current, sessionKey: event.target.value }))}
              />
            </label>

            <label className="space-y-1">
              <div className={labelCls}>Agent ID</div>
              <input
                className={inputCls}
                placeholder="main"
                value={manualDraft.agentId}
                onChange={(event) => setManualDraft((current) => ({ ...current, agentId: event.target.value }))}
              />
            </label>

            <label className="space-y-1 md:col-span-2">
              <div className={labelCls}>Message</div>
              <textarea
                className={cn(inputCls, "min-h-[84px] resize-y py-2")}
                placeholder="Bridge health check from ADE."
                value={manualDraft.message}
                onChange={(event) => setManualDraft((current) => ({ ...current, message: event.target.value }))}
              />
            </label>
          </div>

          {manualError && <div className="mt-3 font-mono text-[10px] text-error">{manualError}</div>}
          {manualSuccess && <div className="mt-3 font-mono text-[10px] text-success">{manualSuccess}</div>}

          <div className="mt-4 flex justify-end">
            <Button variant="outline" size="sm" disabled={manualSending} onClick={() => void sendManualMessage()}>
              {manualSending ? "Sending..." : "Send Message"}
            </Button>
          </div>
        </div>
      )}

      {showRecentTraffic && (
        <div className={cn(cardCls, "p-4")}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="font-sans text-xs font-bold text-fg">Recent Bridge Traffic</div>
              <div className="mt-1 font-mono text-[10px] text-muted-fg/55">
                Last inbound and outbound bridge records persisted under `.ade/cto/`.
              </div>
            </div>
          </div>

          <div className="space-y-2">
            {messages.map((message) => (
              <div key={message.id} className="rounded border border-border/10 bg-surface-recessed px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-mono text-[10px] text-fg">
                    {message.direction} · {message.mode} · {message.status}
                  </div>
                  <div className="font-mono text-[9px] text-muted-fg/45">
                    {new Date(message.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="mt-1 font-mono text-[10px] text-muted-fg/80">{message.summary}</div>
              </div>
            ))}
            {messages.length === 0 && (
              <div className="font-mono text-[10px] text-muted-fg/50">No OpenClaw traffic has been recorded yet.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
