import { describe, expect, it, beforeEach, vi } from "vitest";
import { createPortAllocationService } from "./portAllocationService";
import type { PortLease, PortAllocationEvent } from "../../../shared/types";

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

describe("portAllocationService", () => {
  let events: PortAllocationEvent[];
  let persisted: PortLease[];

  beforeEach(() => {
    events = [];
    persisted = [];
  });

  function createService(opts?: {
    basePort?: number;
    portsPerLane?: number;
    maxPort?: number;
    initialLeases?: PortLease[];
  }) {
    const initial = opts?.initialLeases ?? [];
    return createPortAllocationService({
      logger: createLogger(),
      config: {
        basePort: opts?.basePort ?? 3000,
        portsPerLane: opts?.portsPerLane ?? 100,
        maxPort: opts?.maxPort ?? 9999,
      },
      broadcastEvent: (ev) => events.push(ev),
      persistLeases: (leases) => {
        persisted = [...leases];
      },
      loadLeases: () => initial,
    });
  }

  describe("acquire", () => {
    it("allocates first available port range to a lane", () => {
      const svc = createService();
      const lease = svc.acquire("lane-1");

      expect(lease.laneId).toBe("lane-1");
      expect(lease.rangeStart).toBe(3000);
      expect(lease.rangeEnd).toBe(3099);
      expect(lease.status).toBe("active");
      expect(lease.leasedAt).toBeTruthy();
    });

    it("allocates sequential non-overlapping ranges for multiple lanes", () => {
      const svc = createService();
      const l1 = svc.acquire("lane-1");
      const l2 = svc.acquire("lane-2");
      const l3 = svc.acquire("lane-3");

      expect(l1.rangeStart).toBe(3000);
      expect(l2.rangeStart).toBe(3100);
      expect(l3.rangeStart).toBe(3200);

      // Ranges must not overlap
      expect(l1.rangeEnd).toBeLessThan(l2.rangeStart);
      expect(l2.rangeEnd).toBeLessThan(l3.rangeStart);
    });

    it("returns existing lease if lane already has an active lease", () => {
      const svc = createService();
      const first = svc.acquire("lane-1");
      const second = svc.acquire("lane-1");

      expect(first.rangeStart).toBe(second.rangeStart);
      expect(first.rangeEnd).toBe(second.rangeEnd);
    });

    it("broadcasts port-lease-acquired event", () => {
      const svc = createService();
      svc.acquire("lane-1");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("port-lease-acquired");
      expect(events[0].lease?.laneId).toBe("lane-1");
    });

    it("persists leases on acquisition", () => {
      const svc = createService();
      svc.acquire("lane-1");

      expect(persisted).toHaveLength(1);
      expect(persisted[0].laneId).toBe("lane-1");
      expect(persisted[0].status).toBe("active");
    });
  });

  describe("release", () => {
    it("marks lease as released", () => {
      const svc = createService();
      svc.acquire("lane-1");
      svc.release("lane-1");

      const lease = svc.getLease("lane-1");
      expect(lease?.status).toBe("released");
      expect(lease?.releasedAt).toBeTruthy();
    });

    it("broadcasts port-lease-released event", () => {
      const svc = createService();
      svc.acquire("lane-1");
      events.length = 0;
      svc.release("lane-1");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("port-lease-released");
    });

    it("frees the slot for reuse after release", () => {
      const svc = createService();
      svc.acquire("lane-1"); // 3000-3099
      svc.acquire("lane-2"); // 3100-3199
      svc.release("lane-1");

      const l3 = svc.acquire("lane-3"); // should reuse 3000-3099
      expect(l3.rangeStart).toBe(3000);
    });

    it("does nothing for unknown lane", () => {
      const svc = createService();
      svc.release("nonexistent");
      expect(events).toHaveLength(0);
    });
  });

  describe("port exhaustion", () => {
    it("throws when no port ranges are available", () => {
      // Only room for 2 slots: 3000-3004, 3005-3009
      const svc = createService({ basePort: 3000, portsPerLane: 5, maxPort: 3009 });
      svc.acquire("lane-1");
      svc.acquire("lane-2");

      expect(() => svc.acquire("lane-3")).toThrow(/port exhaustion/i);
    });

    it("can re-acquire after releasing under exhaustion", () => {
      const svc = createService({ basePort: 3000, portsPerLane: 5, maxPort: 3009 });
      svc.acquire("lane-1");
      svc.acquire("lane-2");
      svc.release("lane-1");

      const lease = svc.acquire("lane-3");
      expect(lease.rangeStart).toBe(3000);
      expect(lease.status).toBe("active");
    });
  });

  describe("conflict detection", () => {
    it("detects no conflicts for non-overlapping ranges", () => {
      const svc = createService();
      svc.acquire("lane-1");
      svc.acquire("lane-2");

      const detected = svc.detectConflicts();
      expect(detected).toHaveLength(0);
    });

    it("detects conflicts for overlapping ranges loaded from persistence", () => {
      const svc = createService({
        initialLeases: [
          {
            laneId: "lane-a",
            rangeStart: 3000,
            rangeEnd: 3099,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
          {
            laneId: "lane-b",
            rangeStart: 3050,
            rangeEnd: 3149,
            status: "active",
            leasedAt: "2026-01-01T00:00:01Z",
          },
        ],
      });
      svc.restore();

      const detected = svc.detectConflicts();
      expect(detected).toHaveLength(1);
      expect(detected[0].laneIdA).toBe("lane-a");
      expect(detected[0].laneIdB).toBe("lane-b");
      expect(detected[0].port).toBe(3050);
      expect(detected[0].resolved).toBe(false);
    });

    it("does not double-report the same conflict", () => {
      const svc = createService({
        initialLeases: [
          {
            laneId: "lane-a",
            rangeStart: 3000,
            rangeEnd: 3099,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
          {
            laneId: "lane-b",
            rangeStart: 3050,
            rangeEnd: 3149,
            status: "active",
            leasedAt: "2026-01-01T00:00:01Z",
          },
        ],
      });
      svc.restore();

      svc.detectConflicts();
      const second = svc.detectConflicts();
      expect(second).toHaveLength(0);
    });

    it("broadcasts port-conflict-detected event", () => {
      const svc = createService({
        initialLeases: [
          {
            laneId: "lane-a",
            rangeStart: 3000,
            rangeEnd: 3099,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
          {
            laneId: "lane-b",
            rangeStart: 3050,
            rangeEnd: 3149,
            status: "active",
            leasedAt: "2026-01-01T00:00:01Z",
          },
        ],
      });
      svc.restore();
      events.length = 0;

      svc.detectConflicts();
      expect(events.some((e) => e.type === "port-conflict-detected")).toBe(true);
    });

    it("resolves conflict by reassigning the later-leased lane", () => {
      const svc = createService({
        initialLeases: [
          {
            laneId: "lane-a",
            rangeStart: 3000,
            rangeEnd: 3099,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
          {
            laneId: "lane-b",
            rangeStart: 3050,
            rangeEnd: 3149,
            status: "active",
            leasedAt: "2026-01-02T00:00:00Z",
          },
        ],
      });
      svc.restore();
      svc.detectConflicts();

      const newLease = svc.resolveConflict("lane-a", "lane-b");
      expect(newLease).not.toBeNull();
      expect(newLease!.laneId).toBe("lane-b");
      // New range should not overlap with lane-a
      expect(newLease!.rangeStart).toBeGreaterThan(3099);

      const conflicts = svc.listConflicts();
      expect(conflicts.every((c) => c.resolved)).toBe(true);
    });

    it("marks conflict as resolved when a conflicting lane is released", () => {
      const svc = createService({
        initialLeases: [
          {
            laneId: "lane-a",
            rangeStart: 3000,
            rangeEnd: 3099,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
          {
            laneId: "lane-b",
            rangeStart: 3050,
            rangeEnd: 3149,
            status: "active",
            leasedAt: "2026-01-02T00:00:00Z",
          },
        ],
      });
      svc.restore();
      svc.detectConflicts();

      svc.release("lane-b");
      const allConflicts = svc.listConflicts();
      expect(allConflicts.every((c) => c.resolved)).toBe(true);
    });
  });

  describe("crash recovery — orphan detection", () => {
    it("marks leases for non-existent lanes as orphaned", () => {
      const svc = createService({
        initialLeases: [
          {
            laneId: "lane-alive",
            rangeStart: 3000,
            rangeEnd: 3099,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
          {
            laneId: "lane-dead",
            rangeStart: 3100,
            rangeEnd: 3199,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      svc.restore();

      const orphaned = svc.recoverOrphans(new Set(["lane-alive"]));
      expect(orphaned).toHaveLength(1);
      expect(orphaned[0].laneId).toBe("lane-dead");
      expect(orphaned[0].status).toBe("orphaned");

      // Orphaned slot should now be available for reuse
      const newLease = svc.acquire("lane-new");
      expect(newLease.rangeStart).toBe(3100);
    });

    it("does nothing when all leases have valid lanes", () => {
      const svc = createService({
        initialLeases: [
          {
            laneId: "lane-1",
            rangeStart: 3000,
            rangeEnd: 3099,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      svc.restore();

      const orphaned = svc.recoverOrphans(new Set(["lane-1"]));
      expect(orphaned).toHaveLength(0);
    });

    it("persists orphaned state changes", () => {
      const svc = createService({
        initialLeases: [
          {
            laneId: "lane-ghost",
            rangeStart: 3000,
            rangeEnd: 3099,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      svc.restore();

      svc.recoverOrphans(new Set());
      expect(persisted.some((l) => l.laneId === "lane-ghost" && l.status === "orphaned")).toBe(true);
    });
  });

  describe("multi-lane port collision", () => {
    it("allocates 10 lanes without any port overlap", () => {
      const svc = createService();
      const leases: PortLease[] = [];
      for (let i = 0; i < 10; i++) {
        leases.push(svc.acquire(`lane-${i}`));
      }

      // Check no range overlaps
      for (let i = 0; i < leases.length; i++) {
        for (let j = i + 1; j < leases.length; j++) {
          const a = leases[i];
          const b = leases[j];
          expect(a.rangeEnd < b.rangeStart || b.rangeEnd < a.rangeStart).toBe(true);
        }
      }

      // Verify no conflicts detected
      const conflicts = svc.detectConflicts();
      expect(conflicts).toHaveLength(0);
    });

    it("handles interleaved acquire/release correctly", () => {
      const svc = createService({ basePort: 3000, portsPerLane: 10, maxPort: 3039 });

      svc.acquire("a"); // 3000-3009
      svc.acquire("b"); // 3010-3019
      svc.acquire("c"); // 3020-3029
      svc.acquire("d"); // 3030-3039

      svc.release("b"); // frees 3010-3019
      svc.release("d"); // frees 3030-3039

      const e = svc.acquire("e"); // should get 3010-3019 (first free)
      const f = svc.acquire("f"); // should get 3030-3039
      expect(e.rangeStart).toBe(3010);
      expect(f.rangeStart).toBe(3030);

      const conflicts = svc.detectConflicts();
      expect(conflicts).toHaveLength(0);
    });
  });

  describe("listLeases / listActiveLeases", () => {
    it("listLeases returns all leases including released", () => {
      const svc = createService();
      svc.acquire("lane-1");
      svc.acquire("lane-2");
      svc.release("lane-1");

      expect(svc.listLeases()).toHaveLength(2);
    });

    it("listActiveLeases returns only active leases", () => {
      const svc = createService();
      svc.acquire("lane-1");
      svc.acquire("lane-2");
      svc.release("lane-1");

      const active = svc.listActiveLeases();
      expect(active).toHaveLength(1);
      expect(active[0].laneId).toBe("lane-2");
    });
  });

  describe("restore", () => {
    it("restores leases from persistence layer", () => {
      const svc = createService({
        initialLeases: [
          {
            laneId: "lane-restored",
            rangeStart: 3000,
            rangeEnd: 3099,
            status: "active",
            leasedAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      svc.restore();

      const lease = svc.getLease("lane-restored");
      expect(lease).not.toBeNull();
      expect(lease!.status).toBe("active");
      expect(lease!.rangeStart).toBe(3000);

      // Next acquire should skip the occupied slot
      const next = svc.acquire("lane-new");
      expect(next.rangeStart).toBe(3100);
    });
  });

  describe("getConfig", () => {
    it("returns current port allocation config", () => {
      const svc = createService({ basePort: 4000, portsPerLane: 50, maxPort: 5000 });
      const cfg = svc.getConfig();

      expect(cfg.basePort).toBe(4000);
      expect(cfg.portsPerLane).toBe(50);
      expect(cfg.maxPort).toBe(5000);
    });
  });

  describe("dispose", () => {
    it("clears all in-memory state", () => {
      const svc = createService();
      svc.acquire("lane-1");
      svc.dispose();

      expect(svc.listLeases()).toHaveLength(0);
      expect(svc.getLease("lane-1")).toBeNull();
    });
  });
});
