import React, { useCallback, useEffect, useState } from "react";
import {
  CheckCircle,
  CircleNotch,
  WarningCircle,
  XCircle,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";
import type { CtoLinearProject, LinearConnectionStatus } from "../../../shared/types";
import { ConnectionStatusDot } from "./shared/ConnectionStatusDot";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { inputCls, labelCls, cardCls } from "./shared/designTokens";

export function LinearConnectionPanel() {
  const [connection, setConnection] = useState<LinearConnectionStatus | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [validating, setValidating] = useState(false);
  const [projects, setProjects] = useState<CtoLinearProject[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!window.ade?.cto) return;
    try {
      const status = await window.ade.cto.getLinearConnectionStatus();
      setConnection(status);
      if (status.connected) {
        const p = await window.ade.cto.getLinearProjects();
        setProjects(p);
      }
    } catch { /* non-fatal */ }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const handleValidate = useCallback(async () => {
    if (!window.ade?.cto || !tokenInput.trim()) return;
    setValidating(true);
    setError(null);
    try {
      const status = await window.ade.cto.setLinearToken({ token: tokenInput.trim() });
      setConnection(status);
      if (status.connected) {
        const p = await window.ade.cto.getLinearProjects();
        setProjects(p);
      } else {
        setError(status.message ?? "Token validation failed.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Validation failed.");
    } finally {
      setValidating(false);
    }
  }, [tokenInput]);

  const handleDisconnect = useCallback(async () => {
    if (!window.ade?.cto) return;
    const status = await window.ade.cto.clearLinearToken();
    setConnection(status);
    setProjects([]);
    setTokenInput("");
  }, []);

  const connectionStatus: "connected" | "degraded" | "disconnected" =
    connection?.connected ? "connected" : connection?.tokenStored ? "degraded" : "disconnected";

  return (
    <div className="space-y-4">
      {/* Status header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={cn(labelCls)}>Connection Status</span>
          <ConnectionStatusDot status={connectionStatus} />
        </div>
        {connection?.connected && (
          <Button variant="ghost" size="sm" onClick={handleDisconnect}>
            Disconnect
          </Button>
        )}
      </div>

      {/* Error/reconnect banner */}
      {connection?.tokenStored && !connection.connected && (
        <div className="flex items-center gap-3 px-3 py-2 border border-error/20 bg-error/5">
          <WarningCircle size={14} className="text-error shrink-0" />
          <span className="font-mono text-[10px] text-fg/80 flex-1">
            {connection.message ?? "Linear connection lost."}
          </span>
          <Button variant="outline" size="sm" onClick={loadStatus}>
            <ArrowCounterClockwise size={10} />
            Retry
          </Button>
        </div>
      )}

      {/* Connected info */}
      {connection?.connected && connection.viewerName && (
        <div className={cn(cardCls, "p-3")}>
          <div className="flex items-center gap-2">
            <CheckCircle size={14} weight="fill" className="text-success" />
            <span className="font-mono text-[10px] text-fg">
              Connected as <span className="font-bold">{connection.viewerName}</span>
            </span>
          </div>
          {connection.checkedAt && (
            <div className="font-mono text-[9px] text-muted-fg/40 mt-1">
              Last checked: {new Date(connection.checkedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Token input (when not connected) */}
      {!connection?.connected && (
        <div className="space-y-2">
          <div className={labelCls}>API Token</div>
          <div className="flex gap-2">
            <input
              className={cn(inputCls, "flex-1")}
              type="password"
              placeholder="lin_api_..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
            />
            <Button
              variant="primary"
              onClick={handleValidate}
              disabled={validating || !tokenInput.trim()}
            >
              {validating ? (
                <CircleNotch size={10} className="animate-spin" />
              ) : (
                "Connect"
              )}
            </Button>
          </div>
          {error && (
            <div className="flex items-center gap-1.5 font-mono text-[10px] text-error">
              <XCircle size={10} />
              {error}
            </div>
          )}
          <div className="font-mono text-[9px] text-muted-fg/30">
            Generate a personal API key at linear.app/settings/api
          </div>
        </div>
      )}

      {/* Project list */}
      {projects.length > 0 && (
        <div>
          <div className={cn(labelCls, "mb-1")}>Projects ({projects.length})</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {projects.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between px-2.5 py-1.5 bg-surface-recessed border border-border/10"
              >
                <span className="font-mono text-[10px] text-fg">{p.name}</span>
                <span className="font-mono text-[9px] text-muted-fg/40">{p.teamName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
