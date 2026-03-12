import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  CheckCircle,
  CircleNotch,
  Key,
  Plugs,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";
import type { CtoLinearProject, LinearConnectionStatus } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { ConnectionStatusDot } from "./shared/ConnectionStatusDot";
import { cardCls, inputCls, labelCls } from "./shared/designTokens";

export function LinearConnectionPanel({
  compact = false,
  onStatusChange,
  onProjectsChange,
}: {
  compact?: boolean;
  onStatusChange?: (status: LinearConnectionStatus | null) => void;
  onProjectsChange?: (projects: CtoLinearProject[]) => void;
}) {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [oauthStarting, setOauthStarting] = useState(false);
  const [oauthSessionId, setOauthSessionId] = useState<string | null>(null);
  const [oauthRedirectUri, setOauthRedirectUri] = useState<string | null>(null);
  const [projects, setProjects] = useState<CtoLinearProject[]>([]);
  const [error, setError] = useState<string | null>(null);

  const updateConnection = useCallback((status: LinearConnectionStatus | null) => {
    setConnection(status);
    onStatusChange?.(status);
  }, [onStatusChange]);

  const updateProjects = useCallback((nextProjects: CtoLinearProject[]) => {
    setProjects(nextProjects);
    onProjectsChange?.(nextProjects);
  }, [onProjectsChange]);

  const loadProjects = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      updateProjects(await window.ade.cto.getLinearProjects());
    } catch {
      updateProjects([]);
    }
  }, [updateProjects]);

  const loadStatus = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const status = await window.ade.cto.getLinearConnectionStatus();
      updateConnection(status);
      if (status.connected) {
        await loadProjects();
      } else {
        updateProjects([]);
      }
    } catch {
      updateConnection(null);
      updateProjects([]);
    }
  }, [loadProjects, updateConnection, updateProjects]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const ctoBridge = window.ade?.cto;
    if (!oauthSessionId || !ctoBridge) return;
    let active = true;
    const resetOAuth = () => {
      setOauthSessionId(null);
      setOauthRedirectUri(null);
      setOauthStarting(false);
    };
    const poll = async () => {
      try {
        const session = await ctoBridge.getLinearOAuthSession({ sessionId: oauthSessionId });
        if (!active) return;
        if (session.status === "completed") {
          resetOAuth();
          updateConnection(session.connection ?? null);
          setError(null);
          await loadStatus();
          return;
        }
        if (session.status === "failed" || session.status === "expired") {
          resetOAuth();
          setError(session.error ?? "Linear OAuth failed.");
        }
      } catch (err) {
        if (!active) return;
        resetOAuth();
        setError(err instanceof Error ? err.message : "Linear OAuth failed.");
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1500);
    const timeout = window.setTimeout(() => {
      if (!active) return;
      resetOAuth();
      setError("OAuth timed out after 5 minutes. Please try again.");
    }, 5 * 60 * 1000);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
    };
  }, [loadStatus, oauthSessionId, updateConnection]);

  const handleValidate = useCallback(async () => {
    if (!window.ade?.cto || !tokenInput.trim()) return;
    setValidating(true);
    setError(null);
    try {
      const status = await window.ade.cto.setLinearToken({ token: tokenInput.trim() });
      updateConnection(status);
      if (status.connected) {
        await loadProjects();
      } else {
        updateProjects([]);
        setError(status.message ?? "Token validation failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed.");
    } finally {
      setValidating(false);
    }
  }, [loadProjects, tokenInput, updateConnection, updateProjects]);

  const handleDisconnect = useCallback(async () => {
    if (!window.ade?.cto) return;
    const status = await window.ade.cto.clearLinearToken();
    updateConnection(status);
    updateProjects([]);
    setTokenInput("");
    setError(null);
    setOauthRedirectUri(null);
    setOauthSessionId(null);
    setOauthStarting(false);
  }, [updateConnection, updateProjects]);

  const handleStartOAuth = useCallback(async () => {
    if (!window.ade?.cto) return;
    setOauthStarting(true);
    setError(null);
    try {
      const session = await window.ade.cto.startLinearOAuth();
      setOauthSessionId(session.sessionId);
      setOauthRedirectUri(session.redirectUri);
      if (window.ade.app?.openExternal) {
        await window.ade.app.openExternal(session.authUrl);
      }
    } catch (err) {
      setOauthStarting(false);
      setError(err instanceof Error ? err.message : "Unable to start Linear OAuth.");
    }
  }, []);

  const connectionStatus: "connected" | "degraded" | "disconnected" =
    connection?.connected ? "connected" : connection?.tokenStored ? "degraded" : "disconnected";

  const disconnectedMessage = useMemo(() => {
    if (oauthSessionId) {
      return "Waiting for the Linear authorization callback.";
    }
    if (connection?.tokenStored && !connection.connected) {
      return connection.message ?? "Linear connection lost.";
    }
    return null;
  }, [connection?.connected, connection?.message, connection?.tokenStored, oauthSessionId]);

  return (
    <div
      className={cn("space-y-4", compact && "space-y-3")}
      data-testid="linear-connection-panel"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn(labelCls)}>Connection Status</span>
          <ConnectionStatusDot
            status={connectionStatus}
            label={
              connectionStatus === "connected"
                ? "Connected"
                : connectionStatus === "degraded"
                  ? "Degraded"
                  : "Disconnected"
            }
          />
        </div>
        <div className="flex items-center gap-2">
          {connection?.connected && (
            <Button variant="outline" size="sm" onClick={() => void loadProjects()}>
              <ArrowCounterClockwise size={10} />
              Refresh Projects
            </Button>
          )}
          {connection?.connected && (
            <Button variant="ghost" size="sm" onClick={() => void handleDisconnect()}>
              Disconnect
            </Button>
          )}
        </div>
      </div>

      {disconnectedMessage && (
        <div className="flex items-center gap-3 border border-error/20 bg-error/5 px-3 py-2">
          <WarningCircle size={14} className="shrink-0 text-error" />
          <span className="flex-1 font-mono text-[10px] text-fg/80">
            {disconnectedMessage}
          </span>
          {!oauthSessionId && (
            <Button variant="outline" size="sm" onClick={() => void loadStatus()}>
              <ArrowCounterClockwise size={10} />
              Retry
            </Button>
          )}
        </div>
      )}

      {connection?.connected && connection.viewerName && (
        <div className={cn(cardCls, compact ? "p-2.5" : "p-3")}>
          <div className="flex items-center gap-2">
            <CheckCircle size={14} weight="fill" className="text-success" />
            <span className="font-mono text-[10px] text-fg">
              Connected as <span className="font-bold">{connection.viewerName}</span>
              {connection.authMode ? ` via ${connection.authMode}` : ""}
            </span>
          </div>
          {connection.checkedAt && (
            <div className="mt-1 font-mono text-[9px] text-muted-fg/40">
              Last checked: {new Date(connection.checkedAt).toLocaleString()}
            </div>
          )}
          {connection.tokenExpiresAt && (
            <div className="mt-1 font-mono text-[9px] text-muted-fg/40">
              Token expires: {new Date(connection.tokenExpiresAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {!connection?.connected && (
        <div className="space-y-3">
          <div className={cn(cardCls, compact ? "p-3" : "p-4")}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-sans text-xs font-bold text-fg">OAuth Connection</div>
                <div className="mt-1 font-mono text-[10px] text-muted-fg/55">
                  Recommended when `.ade/secrets/linear-oauth.v1.json` is configured with your Linear OAuth client credentials.
                </div>
              </div>
              <Plugs size={14} className="text-accent" />
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void handleStartOAuth()}
                disabled={oauthStarting || connection?.oauthAvailable === false}
              >
                {oauthStarting ? <CircleNotch size={10} className="animate-spin" /> : <ArrowSquareOut size={10} />}
                Connect with Linear
              </Button>
              {connection?.oauthAvailable === false && (
                <span className="font-mono text-[10px] text-muted-fg/50">
                  Add OAuth client credentials to enable this path.
                </span>
              )}
            </div>

            {oauthRedirectUri && (
              <div className="mt-3 border border-border/10 bg-surface-recessed px-3 py-2">
                <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-fg/40">
                  Loopback Redirect URI
                </div>
                <div className="mt-1 break-all font-mono text-[10px] text-fg/80">
                  {oauthRedirectUri}
                </div>
              </div>
            )}
          </div>

          <div className={cn(cardCls, compact ? "p-3" : "p-4")}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-sans text-xs font-bold text-fg">Manual Token Fallback</div>
                <div className="mt-1 font-mono text-[10px] text-muted-fg/55">
                  Keep this path for personal API keys or when OAuth credentials are not configured.
                </div>
              </div>
              <Key size={14} className="text-muted-fg/60" />
            </div>

            <div className="mt-3 space-y-2">
              <div className={labelCls}>API Token</div>
              <div className="flex gap-2">
                <input
                  className={cn(inputCls, "flex-1")}
                  type="password"
                  placeholder="lin_api_..."
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                />
                <Button
                  variant="outline"
                  onClick={() => void handleValidate()}
                  disabled={validating || !tokenInput.trim()}
                >
                  {validating ? <CircleNotch size={10} className="animate-spin" /> : "Connect"}
                </Button>
              </div>
              {!compact && (
                <div className="font-mono text-[9px] text-muted-fg/30">
                  Generate a personal API key at linear.app/settings/api
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-error">
          <XCircle size={10} />
          {error}
        </div>
      )}

      {projects.length > 0 && (
        <div>
          <div className={cn(labelCls, "mb-1")}>Projects ({projects.length})</div>
          <div className={cn("space-y-1 overflow-y-auto", compact ? "max-h-32" : "max-h-48")}>
            {projects.map((project) => (
              <div
                key={project.id}
                className="flex items-center justify-between border border-border/10 bg-surface-recessed px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <div className="font-mono text-[10px] text-fg">{project.name}</div>
                  <div className="font-mono text-[9px] text-muted-fg/40">{project.slug}</div>
                </div>
                <span className="font-mono text-[9px] text-muted-fg/40">{project.teamName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
