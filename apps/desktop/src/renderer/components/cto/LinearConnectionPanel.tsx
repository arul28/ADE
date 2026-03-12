import React, { useCallback, useEffect, useState } from "react";
import {
  ArrowCounterClockwise,
  CheckCircle,
  CircleNotch,
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
}: {
  compact?: boolean;
  onStatusChange?: (status: LinearConnectionStatus | null) => void;
}) {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [projects, setProjects] = useState<CtoLinearProject[]>([]);
  const [error, setError] = useState<string | null>(null);

  const updateConnection = useCallback((status: LinearConnectionStatus | null) => {
    setConnection(status);
    onStatusChange?.(status);
  }, [onStatusChange]);

  const loadStatus = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const status = await window.ade.cto.getLinearConnectionStatus();
      updateConnection(status);
      if (status.connected) {
        const nextProjects = await window.ade.cto.getLinearProjects();
        setProjects(nextProjects);
      } else {
        setProjects([]);
      }
    } catch {
      updateConnection(null);
      setProjects([]);
    }
  }, [updateConnection]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleValidate = useCallback(async () => {
    if (!window.ade?.cto || !tokenInput.trim()) return;
    setValidating(true);
    setError(null);
    try {
      const status = await window.ade.cto.setLinearToken({ token: tokenInput.trim() });
      updateConnection(status);
      if (status.connected) {
        const nextProjects = await window.ade.cto.getLinearProjects();
        setProjects(nextProjects);
      } else {
        setProjects([]);
        setError(status.message ?? "Token validation failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed.");
    } finally {
      setValidating(false);
    }
  }, [tokenInput, updateConnection]);

  const handleDisconnect = useCallback(async () => {
    if (!window.ade?.cto) return;
    const status = await window.ade.cto.clearLinearToken();
    updateConnection(status);
    setProjects([]);
    setTokenInput("");
    setError(null);
  }, [updateConnection]);

  const connectionStatus: "connected" | "degraded" | "disconnected" =
    connection?.connected ? "connected" : connection?.tokenStored ? "degraded" : "disconnected";

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
        {connection?.connected && (
          <Button variant="ghost" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        )}
      </div>

      {connection?.tokenStored && !connection.connected && (
        <div className="flex items-center gap-3 border border-error/20 bg-error/5 px-3 py-2">
          <WarningCircle size={14} className="shrink-0 text-error" />
          <span className="flex-1 font-mono text-[10px] text-fg/80">
            {connection.message ?? "Linear connection lost."}
          </span>
          <Button variant="outline" size="sm" onClick={() => void loadStatus()}>
            <ArrowCounterClockwise size={10} />
            Retry
          </Button>
        </div>
      )}

      {connection?.connected && connection.viewerName && (
        <div className={cn(cardCls, compact ? "p-2.5" : "p-3")}>
          <div className="flex items-center gap-2">
            <CheckCircle size={14} weight="fill" className="text-success" />
            <span className="font-mono text-[10px] text-fg">
              Connected as <span className="font-bold">{connection.viewerName}</span>
            </span>
          </div>
          {connection.checkedAt && (
            <div className="mt-1 font-mono text-[9px] text-muted-fg/40">
              Last checked: {new Date(connection.checkedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {!connection?.connected && (
        <div className="space-y-2">
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
              variant="primary"
              onClick={() => void handleValidate()}
              disabled={validating || !tokenInput.trim()}
            >
              {validating ? <CircleNotch size={10} className="animate-spin" /> : "Connect"}
            </Button>
          </div>
          {error && (
            <div className="flex items-center gap-1.5 font-mono text-[10px] text-error">
              <XCircle size={10} />
              {error}
            </div>
          )}
          {!compact && (
            <div className="font-mono text-[9px] text-muted-fg/30">
              Generate a personal API key at linear.app/settings/api
            </div>
          )}
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
                <span className="font-mono text-[10px] text-fg">{project.name}</span>
                <span className="font-mono text-[9px] text-muted-fg/40">{project.teamName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
