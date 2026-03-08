import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createRuntimeDiagnosticsService } from "./runtimeDiagnosticsService";
import type {
  RuntimeDiagnosticsEvent,
  PortLease,
  PortConflict,
  ProxyStatus,
  ProxyRoute,
} from "../../../shared/types";

// ---------------------------------------------------------------------------
// Mock node:net — control Socket behaviour per-test
// ---------------------------------------------------------------------------

const mockSocket = {
  setTimeout: vi.fn().mockReturnThis(),
  once: vi.fn().mockReturnThis(),
  connect: vi.fn().mockReturnThis(),
  destroy: vi.fn(),
};

// The service uses `new net.Socket()`. A constructor that explicitly returns
// an object will hand that object back to the caller — standard JS semantics.
function MockSocket() {
  return mockSocket;
}

vi.mock("node:net", () => ({
  default: { Socket: MockSocket },
  Socket: MockSocket,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

/** Make the mock socket simulate a successful TCP connection. */
function simulatePortResponding() {
  mockSocket.once.mockImplementation((event: string, cb: Function) => {
    if (event === "connect") setTimeout(() => cb(), 0);
    return mockSocket;
  });
}

/** Make the mock socket simulate a failed TCP connection. */
function simulatePortUnresponsive() {
  mockSocket.once.mockImplementation((event: string, cb: Function) => {
    if (event === "error") setTimeout(() => cb(new Error("ECONNREFUSED")), 0);
    return mockSocket;
  });
}

function makeLease(laneId: string, rangeStart = 3000): PortLease {
  return {
    laneId,
    rangeStart,
    rangeEnd: rangeStart + 99,
    status: "active",
    leasedAt: new Date().toISOString(),
  };
}

function makeRoute(laneId: string, targetPort = 3000): ProxyRoute {
  return {
    laneId,
    hostname: `${laneId}.localhost`,
    targetPort,
    status: "active",
    createdAt: new Date().toISOString(),
  };
}

function makeProxyStatus(overrides?: Partial<ProxyStatus>): ProxyStatus {
  return {
    running: true,
    proxyPort: 8080,
    routes: [],
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("createRuntimeDiagnosticsService", () => {
  let events: RuntimeDiagnosticsEvent[];
  let leases: Map<string, PortLease>;
  let routes: Map<string, ProxyRoute>;
  let conflicts: PortConflict[];
  let proxyStatus: ProxyStatus;
  let svc: ReturnType<typeof createRuntimeDiagnosticsService>;

  beforeEach(() => {
    events = [];
    leases = new Map();
    routes = new Map();
    conflicts = [];
    proxyStatus = makeProxyStatus();

    // Reset mock socket state
    mockSocket.setTimeout.mockClear().mockReturnThis();
    mockSocket.once.mockClear().mockReturnThis();
    mockSocket.connect.mockClear().mockReturnThis();
    mockSocket.destroy.mockClear();

    svc = createRuntimeDiagnosticsService({
      logger: createLogger(),
      broadcastEvent: (ev) => events.push(ev),
      getPortLease: (laneId) => leases.get(laneId) ?? null,
      getPortConflicts: () => conflicts,
      detectPortConflicts: () => {
        // simulate detecting — just return current conflicts
        return conflicts;
      },
      getProxyStatus: () => proxyStatus,
      getProxyRoute: (laneId) => routes.get(laneId) ?? null,
    });
  });

  afterEach(() => {
    svc.dispose();
  });

  // =========================================================================
  // checkLaneHealth
  // =========================================================================

  describe("checkLaneHealth", () => {
    it("returns healthy when port responds and proxy route is active", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      routes.set("lane-1", makeRoute("lane-1"));
      simulatePortResponding();

      const health = await svc.checkLaneHealth("lane-1");

      expect(health.laneId).toBe("lane-1");
      expect(health.status).toBe("healthy");
      expect(health.processAlive).toBe(true);
      expect(health.portResponding).toBe(true);
      expect(health.proxyRouteActive).toBe(true);
      expect(health.fallbackMode).toBe(false);
      expect(health.issues).toHaveLength(0);
    });

    it("returns unhealthy when port is not responding", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      routes.set("lane-1", makeRoute("lane-1"));
      simulatePortUnresponsive();

      const health = await svc.checkLaneHealth("lane-1");

      expect(health.status).toBe("unhealthy");
      expect(health.portResponding).toBe(false);
      expect(health.processAlive).toBe(false);
      expect(health.issues.some((i) => i.type === "port-unresponsive")).toBe(true);
    });

    it("returns degraded when proxy route is missing but port responds", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      // No route registered
      simulatePortResponding();

      const health = await svc.checkLaneHealth("lane-1");

      expect(health.status).toBe("degraded");
      expect(health.portResponding).toBe(true);
      expect(health.proxyRouteActive).toBe(false);
      expect(health.issues.some((i) => i.type === "proxy-route-missing")).toBe(true);
    });

    it("returns unhealthy when no port lease exists", async () => {
      // No lease, no route
      simulatePortUnresponsive();

      const health = await svc.checkLaneHealth("lane-1");

      expect(health.status).toBe("unhealthy");
      expect(health.portResponding).toBe(false);
      expect(health.issues.some((i) => i.type === "port-unresponsive")).toBe(true);
    });

    it("reports port-conflict issues when conflicts exist", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      routes.set("lane-1", makeRoute("lane-1"));
      simulatePortResponding();
      conflicts.push({
        port: 3000,
        laneIdA: "lane-1",
        laneIdB: "lane-2",
        detectedAt: new Date().toISOString(),
        resolved: false,
      });

      const health = await svc.checkLaneHealth("lane-1");

      expect(health.issues.some((i) => i.type === "port-conflict")).toBe(true);
      const conflictIssue = health.issues.find((i) => i.type === "port-conflict")!;
      expect(conflictIssue.actionType).toBe("reassign-port");
    });

    it("includes actionable messages with fix suggestions", async () => {
      // No lease -> port-unresponsive issue with actionLabel
      simulatePortUnresponsive();
      proxyStatus = makeProxyStatus({ running: false });

      const health = await svc.checkLaneHealth("lane-1");

      const portIssue = health.issues.find((i) => i.type === "port-unresponsive");
      expect(portIssue).toBeDefined();
      expect(portIssue!.actionLabel).toBeTruthy();

      const proxyIssue = health.issues.find((i) => i.type === "proxy-route-missing");
      expect(proxyIssue).toBeDefined();
      expect(proxyIssue!.actionType).toBe("restart-proxy");
    });

    it("deduplicates process-dead and port-unresponsive issues", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      routes.set("lane-1", makeRoute("lane-1"));
      simulatePortUnresponsive();

      const health = await svc.checkLaneHealth("lane-1");

      // Both process-dead and port-unresponsive would be generated internally,
      // but process-dead should be deduplicated away
      const processDead = health.issues.filter((i) => i.type === "process-dead");
      const portUnresponsive = health.issues.filter((i) => i.type === "port-unresponsive");
      expect(processDead).toHaveLength(0);
      expect(portUnresponsive).toHaveLength(1);
    });
  });

  // =========================================================================
  // checkAllLanes
  // =========================================================================

  describe("checkAllLanes", () => {
    it("runs health checks for all provided lane IDs", async () => {
      leases.set("lane-1", makeLease("lane-1", 3000));
      leases.set("lane-2", makeLease("lane-2", 3100));
      routes.set("lane-1", makeRoute("lane-1", 3000));
      routes.set("lane-2", makeRoute("lane-2", 3100));
      simulatePortResponding();

      const results = await svc.checkAllLanes(["lane-1", "lane-2"]);

      expect(results).toHaveLength(2);
      expect(results[0].laneId).toBe("lane-1");
      expect(results[1].laneId).toBe("lane-2");
    });

    it("calls detectPortConflicts before checking", async () => {
      const detectFn = vi.fn(() => conflicts);
      svc.dispose();
      svc = createRuntimeDiagnosticsService({
        logger: createLogger(),
        broadcastEvent: (ev) => events.push(ev),
        getPortLease: (laneId) => leases.get(laneId) ?? null,
        getPortConflicts: () => conflicts,
        detectPortConflicts: detectFn,
        getProxyStatus: () => proxyStatus,
        getProxyRoute: (laneId) => routes.get(laneId) ?? null,
      });

      simulatePortUnresponsive();
      await svc.checkAllLanes(["lane-1"]);

      expect(detectFn).toHaveBeenCalledTimes(1);
    });

    it("broadcasts diagnostics-refresh event with aggregated status", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      routes.set("lane-1", makeRoute("lane-1"));
      simulatePortResponding();

      events.length = 0;
      await svc.checkAllLanes(["lane-1"]);

      const refreshEvent = events.find((e) => e.type === "diagnostics-refresh");
      expect(refreshEvent).toBeDefined();
      expect(refreshEvent!.status).toBeDefined();
      expect(refreshEvent!.status!.lanes).toHaveLength(1);
      expect(refreshEvent!.status!.proxyRunning).toBe(true);
    });
  });

  // =========================================================================
  // fallback mode
  // =========================================================================

  describe("fallback mode", () => {
    it("activateFallback sets lane as fallback", () => {
      svc.activateFallback("lane-1");
      expect(svc.isFallbackActive("lane-1")).toBe(true);
    });

    it("deactivateFallback removes fallback", () => {
      svc.activateFallback("lane-1");
      svc.deactivateFallback("lane-1");
      expect(svc.isFallbackActive("lane-1")).toBe(false);
    });

    it("isFallbackActive returns correct state", () => {
      expect(svc.isFallbackActive("lane-1")).toBe(false);
      svc.activateFallback("lane-1");
      expect(svc.isFallbackActive("lane-1")).toBe(true);
      expect(svc.isFallbackActive("lane-2")).toBe(false);
    });

    it("listFallbackLanes returns all fallback lane IDs", () => {
      svc.activateFallback("lane-1");
      svc.activateFallback("lane-2");
      svc.activateFallback("lane-3");

      const lanes = svc.listFallbackLanes();
      expect(lanes).toHaveLength(3);
      expect(lanes).toContain("lane-1");
      expect(lanes).toContain("lane-2");
      expect(lanes).toContain("lane-3");
    });

    it("fallback mode changes status from unhealthy to degraded", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      routes.set("lane-1", makeRoute("lane-1"));
      simulatePortUnresponsive();

      // Without fallback, should be unhealthy
      const before = await svc.checkLaneHealth("lane-1");
      expect(before.status).toBe("unhealthy");

      // Activate fallback, re-check
      svc.activateFallback("lane-1");
      // Reset mock for second check
      simulatePortUnresponsive();
      const after = await svc.checkLaneHealth("lane-1");
      expect(after.status).toBe("degraded");
      expect(after.fallbackMode).toBe(true);
    });

    it("broadcasts fallback-activated event", () => {
      events.length = 0;
      svc.activateFallback("lane-1");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("fallback-activated");
      expect(events[0].laneId).toBe("lane-1");
    });

    it("broadcasts fallback-deactivated event", () => {
      svc.activateFallback("lane-1");
      events.length = 0;

      svc.deactivateFallback("lane-1");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("fallback-deactivated");
      expect(events[0].laneId).toBe("lane-1");
    });
  });

  // =========================================================================
  // getStatus
  // =========================================================================

  describe("getStatus", () => {
    it("aggregates health from cache", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      routes.set("lane-1", makeRoute("lane-1"));
      simulatePortResponding();
      await svc.checkLaneHealth("lane-1");

      const status = svc.getStatus(["lane-1"]);

      expect(status.lanes).toHaveLength(1);
      expect(status.lanes[0].laneId).toBe("lane-1");
      expect(status.lanes[0].status).toBe("healthy");
    });

    it("includes proxy running state and conflict count", async () => {
      proxyStatus = makeProxyStatus({
        running: true,
        proxyPort: 9090,
        routes: [makeRoute("lane-1")],
      });
      conflicts.push({
        port: 3000,
        laneIdA: "lane-1",
        laneIdB: "lane-2",
        detectedAt: new Date().toISOString(),
        resolved: false,
      });

      const status = svc.getStatus([]);

      expect(status.proxyRunning).toBe(true);
      expect(status.proxyPort).toBe(9090);
      expect(status.totalRoutes).toBe(1);
      expect(status.activeConflicts).toBe(1);
    });
  });

  // =========================================================================
  // getLaneHealth
  // =========================================================================

  describe("getLaneHealth", () => {
    it("returns null when no cached health exists", () => {
      expect(svc.getLaneHealth("lane-unknown")).toBeNull();
    });

    it("returns cached health after checkLaneHealth", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      routes.set("lane-1", makeRoute("lane-1"));
      simulatePortResponding();
      await svc.checkLaneHealth("lane-1");

      const cached = svc.getLaneHealth("lane-1");

      expect(cached).not.toBeNull();
      expect(cached!.laneId).toBe("lane-1");
      expect(cached!.status).toBe("healthy");
    });
  });

  // =========================================================================
  // dispose
  // =========================================================================

  describe("dispose", () => {
    it("clears all cached state", async () => {
      leases.set("lane-1", makeLease("lane-1"));
      routes.set("lane-1", makeRoute("lane-1"));
      simulatePortResponding();
      await svc.checkLaneHealth("lane-1");
      svc.activateFallback("lane-1");

      svc.dispose();

      expect(svc.getLaneHealth("lane-1")).toBeNull();
      expect(svc.listFallbackLanes()).toHaveLength(0);
      expect(svc.isFallbackActive("lane-1")).toBe(false);
    });
  });
});
