import net from "node:net";
import type {
  LaneHealthCheck,
  LaneHealthStatus,
  LaneHealthIssue,
  RuntimeDiagnosticsStatus,
  RuntimeDiagnosticsEvent,
  PortLease,
  PortConflict,
  ProxyStatus,
  ProxyRoute,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";

/**
 * Runtime Diagnostics Service (Phase 5 W6).
 *
 * Aggregates health signals from port allocation, proxy, and environment
 * services into a unified per-lane health view. Provides fallback mode
 * activation when isolation fails.
 */
export function createRuntimeDiagnosticsService({
  logger,
  broadcastEvent,
  getPortLease,
  getPortConflicts,
  detectPortConflicts,
  getProxyStatus,
  getProxyRoute,
}: {
  logger: Logger;
  broadcastEvent: (ev: RuntimeDiagnosticsEvent) => void;
  getPortLease: (laneId: string) => PortLease | null;
  getPortConflicts: () => PortConflict[];
  detectPortConflicts: () => PortConflict[];
  getProxyStatus: () => ProxyStatus;
  getProxyRoute: (laneId: string) => ProxyRoute | null;
}) {
  // Internal state
  const healthCache = new Map<string, LaneHealthCheck>();
  const fallbackLanes = new Set<string>();

  // --- helpers ---

  /** Check if a TCP port is accepting connections. */
  function checkPort(port: number, timeoutMs = 500): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
      socket.connect(port, "127.0.0.1");
    });
  }

  function deriveStatus(issues: LaneHealthIssue[], fallback: boolean): LaneHealthStatus {
    if (issues.length === 0) return fallback ? "degraded" : "healthy";
    const hasCritical = issues.some((i) =>
      i.type === "process-dead" || i.type === "port-unresponsive"
    );
    return hasCritical ? "unhealthy" : "degraded";
  }

  /** Build a health check for a single lane (async for port probe). */
  async function runCheck(
    laneId: string,
    options?: { refreshConflicts?: boolean },
  ): Promise<LaneHealthCheck> {
    const issues: LaneHealthIssue[] = [];
    if (options?.refreshConflicts) {
      detectPortConflicts();
    }
    const lease = getPortLease(laneId);
    const route = getProxyRoute(laneId);
    const proxyStatus = getProxyStatus();
    const isFallback = fallbackLanes.has(laneId);

    // 1. Port responding check
    let portResponding = false;
    if (lease && lease.status === "active") {
      portResponding = await checkPort(lease.rangeStart);
      if (!portResponding) {
        issues.push({
          type: "port-unresponsive",
          message: `Port ${lease.rangeStart} is not responding. The dev server may not be running.`,
          actionLabel: "Check dev server",
        });
      }
    } else {
      issues.push({
        type: "port-unresponsive",
        message: "No active port lease. Port range has not been allocated.",
        actionLabel: "Allocate ports",
      });
    }

    // 2. Process alive — inferred from port responding (if port responds, process is alive)
    const processAlive = portResponding;
    if (!processAlive && lease?.status === "active") {
      issues.push({
        type: "process-dead",
        message: "Lane process appears to be stopped. No response on the allocated port.",
        actionLabel: "Start dev server",
      });
    }

    // 3. Proxy route active
    const proxyRouteActive = !!(route && route.status === "active" && proxyStatus.running);
    if (!proxyRouteActive) {
      if (isFallback) {
        issues.push({
          type: "proxy-route-missing",
          message: proxyStatus.running
            ? "Fallback mode is active. This lane is bypassing proxy isolation and using direct port access."
            : "Fallback mode is active because the proxy server is unavailable. Direct port access is being used.",
        });
      } else if (!proxyStatus.running) {
        issues.push({
          type: "proxy-route-missing",
          message: "Proxy server is not running. Lane isolation is inactive.",
          actionLabel: "Start proxy",
          actionType: "restart-proxy",
        });
      } else if (!route) {
        issues.push({
          type: "proxy-route-missing",
          message: "No proxy route registered for this lane. Enable fallback to keep working on the direct port.",
          actionLabel: "Enable fallback",
          actionType: "enable-fallback",
        });
      } else {
        issues.push({
          type: "proxy-route-missing",
          message: `Proxy route is ${route.status}. Enable fallback to keep working on the direct port.`,
          actionLabel: "Enable fallback",
          actionType: "enable-fallback",
        });
      }
    }

    // 4. Port conflicts
    const conflicts = getPortConflicts().filter(
      (c) => !c.resolved && (c.laneIdA === laneId || c.laneIdB === laneId)
    );
    for (const conflict of conflicts) {
      const other = conflict.laneIdA === laneId ? conflict.laneIdB : conflict.laneIdA;
      issues.push({
        type: "port-conflict",
        message: `Port conflict with lane ${other.slice(0, 8)}\u2026 on port ${conflict.port}. Click to reassign.`,
        actionLabel: "Reassign port",
        actionType: "reassign-port",
      });
    }

    // Deduplicate: if we have both process-dead and port-unresponsive, keep only port-unresponsive
    const dedupedIssues = issues.filter((issue, idx) => {
      if (issue.type === "process-dead") {
        return !issues.some((other, otherIdx) => otherIdx !== idx && other.type === "port-unresponsive");
      }
      return true;
    });

    const health: LaneHealthCheck = {
      laneId,
      status: deriveStatus(dedupedIssues, isFallback),
      processAlive,
      portResponding,
      proxyRouteActive,
      fallbackMode: isFallback,
      lastCheckedAt: new Date().toISOString(),
      issues: dedupedIssues,
    };

    healthCache.set(laneId, health);
    broadcastEvent({ type: "health-updated", laneId, health });
    logger.debug("runtime_diagnostics.health_check", { laneId, status: health.status, issues: dedupedIssues.length });

    return health;
  }

  // --- public API ---
  return {
    /**
     * Run a health check for a single lane.
     */
    async checkLaneHealth(laneId: string): Promise<LaneHealthCheck> {
      return runCheck(laneId, { refreshConflicts: true });
    },

    /**
     * Run health checks for all provided lane IDs.
     */
    async checkAllLanes(laneIds: string[]): Promise<LaneHealthCheck[]> {
      // Run port conflict detection first
      detectPortConflicts();
      const results = await Promise.all(laneIds.map((id) => runCheck(id)));
      const status = buildStatus(results);
      broadcastEvent({ type: "diagnostics-refresh", status });
      logger.info("runtime_diagnostics.full_check", {
        lanes: results.length,
        healthy: results.filter((r) => r.status === "healthy").length,
        degraded: results.filter((r) => r.status === "degraded").length,
        unhealthy: results.filter((r) => r.status === "unhealthy").length,
      });
      return results;
    },

    /**
     * Get the cached health for a lane (no network check).
     */
    getLaneHealth(laneId: string): LaneHealthCheck | null {
      return healthCache.get(laneId) ?? null;
    },

    /**
     * Build aggregated diagnostics status.
     */
    getStatus(laneIds: string[]): RuntimeDiagnosticsStatus {
      const lanes = laneIds.map((id) => healthCache.get(id)).filter(Boolean) as LaneHealthCheck[];
      return buildStatus(lanes);
    },

    /**
     * Activate fallback mode for a lane (bypass isolation, route directly).
     */
    activateFallback(laneId: string): void {
      if (fallbackLanes.has(laneId)) return;
      fallbackLanes.add(laneId);
      const cached = healthCache.get(laneId);
      if (cached) {
        cached.fallbackMode = true;
        cached.status = deriveStatus(cached.issues, true);
      }
      broadcastEvent({
        type: "fallback-activated",
        laneId,
        health: cached ?? undefined,
        status: buildStatus(Array.from(healthCache.values())),
      });
      logger.info("runtime_diagnostics.fallback_activated", { laneId });
    },

    /**
     * Deactivate fallback mode for a lane.
     */
    deactivateFallback(laneId: string): void {
      if (!fallbackLanes.has(laneId)) return;
      fallbackLanes.delete(laneId);
      const cached = healthCache.get(laneId);
      if (cached) {
        cached.fallbackMode = false;
        cached.status = deriveStatus(cached.issues, false);
      }
      broadcastEvent({
        type: "fallback-deactivated",
        laneId,
        health: cached ?? undefined,
        status: buildStatus(Array.from(healthCache.values())),
      });
      logger.info("runtime_diagnostics.fallback_deactivated", { laneId });
    },

    /**
     * Check if fallback mode is active for a lane.
     */
    isFallbackActive(laneId: string): boolean {
      return fallbackLanes.has(laneId);
    },

    /**
     * List all lanes with fallback mode active.
     */
    listFallbackLanes(): string[] {
      return Array.from(fallbackLanes);
    },

    /**
     * Dispose service — clear all state.
     */
    dispose(): void {
      healthCache.clear();
      fallbackLanes.clear();
    },
  };

  function buildStatus(lanes: LaneHealthCheck[]): RuntimeDiagnosticsStatus {
    const proxyStatus = getProxyStatus();
    const conflicts = getPortConflicts().filter((c) => !c.resolved);
    return {
      lanes,
      proxyRunning: proxyStatus.running,
      proxyPort: proxyStatus.proxyPort,
      totalRoutes: proxyStatus.routes.length,
      activeConflicts: conflicts.length,
      fallbackLanes: Array.from(fallbackLanes),
    };
  }
}
