import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { inputCls, ACCENT } from "./shared/designTokens";

export function LinearConnectionPanel({
  compact = false,
  reloadToken = 0,
  onStatusChange,
  onProjectsChange,
}: {
  compact?: boolean;
  reloadToken?: number;
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
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onStatusChangeRef = useRef(onStatusChange);
  const onProjectsChangeRef = useRef(onProjectsChange);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    onProjectsChangeRef.current = onProjectsChange;
  }, [onProjectsChange]);

  const updateConnection = useCallback((status: LinearConnectionStatus | null) => {
    setConnection(status);
    onStatusChangeRef.current?.(status);
  }, []);

  const updateProjects = useCallback((nextProjects: CtoLinearProject[]) => {
    setProjects(nextProjects);
    onProjectsChangeRef.current?.(nextProjects);
  }, []);

  const loadProjects = useCallback(async () => {
    if (!window.ade?.cto) return;
    setProjectsLoading(true);
    try {
      updateProjects(await window.ade.cto.getLinearProjects());
    } catch {
      updateProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, [updateProjects]);

  const loadStatus = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const status = await window.ade.cto.getLinearConnectionStatus();
      updateConnection(status);
      if (status.connected) {
        void loadProjects();
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
  }, [loadStatus, reloadToken]);

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
          if (session.connection?.connected) {
            void loadProjects();
          } else {
            void loadStatus();
          }
          return;
        }
        if (session.status === "failed" || session.status === "expired") {
          resetOAuth();
          setError(session.error ?? "OAuth failed.");
        }
      } catch (err) {
        if (!active) return;
        resetOAuth();
        setError(err instanceof Error ? err.message : "OAuth failed.");
      }
    };

    void poll();
    const timer = window.setInterval(() => {
      void poll();
    }, 1500);
    const timeout = window.setTimeout(() => {
      if (!active) return;
      resetOAuth();
      setError("OAuth timed out. Please try again.");
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
        void loadProjects();
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
      setError(err instanceof Error ? err.message : "Unable to start OAuth.");
    }
  }, []);

  const connectionStatus: "connected" | "degraded" | "disconnected" =
    connection?.connected ? "connected" : connection?.tokenStored ? "degraded" : "disconnected";

  const disconnectedMessage = useMemo(() => {
    if (oauthSessionId) {
      return "Waiting for Linear authorization...";
    }
    if (connection?.tokenStored && !connection.connected) {
      return connection.message ?? "Connection lost.";
    }
    return null;
  }, [connection?.connected, connection?.message, connection?.tokenStored, oauthSessionId]);

  return (
    <div
      className={cn("space-y-3", compact && "space-y-2")}
      data-testid="linear-connection-panel"
    >
      {/* Status row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ConnectionStatusDot
            status={connectionStatus}
            label={connectionStatus === "connected" ? "Connected" : connectionStatus === "degraded" ? "Degraded" : "Disconnected"}
          />
        </div>
        {connection?.connected && (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="!h-5 !px-1.5 !text-[9px]" onClick={() => void loadProjects()}>
              <ArrowCounterClockwise size={9} />
            </Button>
            <button
              type="button"
              onClick={() => void handleDisconnect()}
              className="text-[10px] text-muted-fg/35 hover:text-error transition-colors"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      {/* Connected state */}
      {connection?.connected && connection.viewerName && (
        <div className="flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ background: `${ACCENT.green}08`, border: `1px solid ${ACCENT.green}15` }}>
          <CheckCircle size={12} weight="fill" style={{ color: ACCENT.green }} />
          <span className="text-[11px] text-fg/70">
            {connection.viewerName}
            {connection.authMode ? ` (${connection.authMode})` : ""}
          </span>
        </div>
      )}

      {/* Error / warning */}
      {disconnectedMessage && (
        <div className="flex items-center gap-2 rounded-lg px-2.5 py-2" style={{ background: "rgba(251,191,36,0.04)", border: "1px solid rgba(251,191,36,0.1)" }}>
          <WarningCircle size={11} style={{ color: ACCENT.amber }} />
          <span className="text-[10px] text-fg/60 flex-1">{disconnectedMessage}</span>
          {!oauthSessionId && (
            <button type="button" onClick={() => void loadStatus()} className="text-[10px] font-medium" style={{ color: ACCENT.amber }}>Retry</button>
          )}
        </div>
      )}

      {/* Auth methods */}
      {!connection?.connected && (
        <div className="space-y-2">
          {/* API Key */}
          <div className="rounded-lg p-3" style={{ background: "rgba(96,165,250,0.03)", border: "1px solid rgba(96,165,250,0.08)" }}>
            <div className="flex items-center gap-1.5 mb-2">
              <Key size={11} style={{ color: ACCENT.blue }} />
              <span className="text-[11px] font-medium text-fg/70">API Key</span>
            </div>
            <div className="flex gap-2">
              <input
                className={cn(inputCls, "flex-1 !h-8 !text-xs")}
                type="password"
                placeholder="lin_api_..."
                value={tokenInput}
                onChange={(event) => setTokenInput(event.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleValidate()}
                disabled={validating || !tokenInput.trim()}
              >
                {validating ? <CircleNotch size={9} className="animate-spin" /> : "Connect"}
              </Button>
            </div>
            <div className="mt-1.5 text-[10px] text-muted-fg/30">
              Get one at linear.app/settings/api
            </div>
          </div>

          {/* OAuth */}
          <div className="rounded-lg p-3" style={{ background: "rgba(167,139,250,0.03)", border: "1px solid rgba(167,139,250,0.08)" }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Plugs size={11} style={{ color: ACCENT.purple }} />
                <span className="text-[11px] font-medium text-fg/70">OAuth</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleStartOAuth()}
                disabled={oauthStarting || connection?.oauthAvailable === false}
              >
                {oauthStarting ? <CircleNotch size={9} className="animate-spin" /> : <ArrowSquareOut size={9} />}
                Sign in with Linear
              </Button>
            </div>
            {connection?.oauthAvailable === false && (
              <div className="mt-1.5 text-[10px] text-muted-fg/30">
                Browser sign-in is not configured yet for this ADE build.
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-1.5 text-[11px] text-error">
          <XCircle size={10} />
          {error}
        </div>
      )}

      {projects.length > 0 && !compact && (
        <div>
          <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-fg/35">
            <span>Projects ({projects.length})</span>
            {projectsLoading ? <span className="text-[9px] text-muted-fg/28">Refreshing...</span> : null}
          </div>
          <div className="space-y-0.5 overflow-y-auto max-h-32">
            {projects.map((project) => (
              <div
                key={project.id}
                className="flex items-center justify-between rounded-md px-2 py-1"
                style={{ background: "rgba(24,20,35,0.3)" }}
              >
                <span className="text-[11px] text-fg/60">{project.name}</span>
                <span className="text-[10px] text-muted-fg/30">{project.teamName}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {connection?.connected && projects.length === 0 && !compact ? (
        <div className="text-[10px] text-muted-fg/32">
          {projectsLoading ? "Loading project access..." : "Connected. Project list is still empty or has not loaded yet."}
        </div>
      ) : null}
    </div>
  );
}
