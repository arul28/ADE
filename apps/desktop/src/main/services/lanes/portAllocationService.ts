import type {
  PortLease,
  PortLeaseStatus,
  PortConflict,
  PortAllocationConfig,
  PortAllocationEvent,
} from "../../../shared/types";

import type { Logger } from "../logging/logger";

const DEFAULT_CONFIG: PortAllocationConfig = {
  basePort: 3000,
  portsPerLane: 100,
  maxPort: 9999,
};

/**
 * Port Allocation & Lease Service (Phase 5 W3).
 *
 * Manages deterministic port-range allocation per lane with lease/release
 * lifecycle, crash recovery, and conflict detection.
 *
 * Port ranges are slotted sequentially: lane 0 → 3000-3099, lane 1 → 3100-3199, etc.
 * Leases are persisted via a callback so the caller can store them in SQLite/KV.
 */
export function createPortAllocationService({
  logger,
  config: userConfig,
  broadcastEvent,
  persistLeases,
  loadLeases,
}: {
  logger: Logger;
  config?: Partial<PortAllocationConfig>;
  broadcastEvent: (ev: PortAllocationEvent) => void;
  /** Called whenever the lease map changes so the caller can persist to disk/DB. */
  persistLeases: (leases: PortLease[]) => void;
  /** Called once at startup to restore previously persisted leases. */
  loadLeases: () => PortLease[];
}) {
  const cfg: PortAllocationConfig = { ...DEFAULT_CONFIG, ...userConfig };
  const leases = new Map<string, PortLease>();
  const conflicts: PortConflict[] = [];

  // --- helpers ---------------------------------------------------------------

  function maxSlots(): number {
    return Math.floor((cfg.maxPort - cfg.basePort + 1) / cfg.portsPerLane);
  }

  /** Return the set of range-start values currently occupied by active leases. */
  function occupiedStarts(): Set<number> {
    const starts = new Set<number>();
    for (const lease of leases.values()) {
      if (lease.status === "active") starts.add(lease.rangeStart);
    }
    return starts;
  }

  /** Find the first free slot and return its range start, or null if exhausted. */
  function findFreeSlot(): { start: number; end: number } | null {
    const occupied = occupiedStarts();
    const slots = maxSlots();
    for (let i = 0; i < slots; i++) {
      const start = cfg.basePort + i * cfg.portsPerLane;
      if (!occupied.has(start)) {
        return { start, end: start + cfg.portsPerLane - 1 };
      }
    }
    return null;
  }

  function persist(): void {
    persistLeases(Array.from(leases.values()));
  }

  function detectConflictsBetween(a: PortLease, b: PortLease): PortConflict | null {
    if (a.status !== "active" || b.status !== "active") return null;
    if (a.laneId === b.laneId) return null;

    // Check overlap: ranges overlap when a.start <= b.end AND b.start <= a.end
    if (a.rangeStart <= b.rangeEnd && b.rangeStart <= a.rangeEnd) {
      const overlapStart = Math.max(a.rangeStart, b.rangeStart);
      return {
        port: overlapStart,
        laneIdA: a.laneId,
        laneIdB: b.laneId,
        detectedAt: new Date().toISOString(),
        resolved: false,
      };
    }
    return null;
  }

  // --- public API ------------------------------------------------------------

  return {
    /**
     * Restore leases from persistence layer. Call once at startup.
     */
    restore(): void {
      const persisted = loadLeases();
      for (const lease of persisted) {
        leases.set(lease.laneId, lease);
      }
      logger.info("port_allocation.restored", { count: persisted.length });
    },

    /**
     * Acquire a port range lease for a lane.
     * Returns the lease, or throws if port space is exhausted.
     */
    acquire(laneId: string): PortLease {
      // If already leased and active, return existing
      const existing = leases.get(laneId);
      if (existing && existing.status === "active") {
        logger.debug("port_allocation.already_leased", { laneId, range: `${existing.rangeStart}-${existing.rangeEnd}` });
        return existing;
      }

      const slot = findFreeSlot();
      if (!slot) {
        throw new Error(
          `Port exhaustion: no free port range available (base=${cfg.basePort}, portsPerLane=${cfg.portsPerLane}, maxPort=${cfg.maxPort})`
        );
      }

      const lease: PortLease = {
        laneId,
        rangeStart: slot.start,
        rangeEnd: slot.end,
        status: "active",
        leasedAt: new Date().toISOString(),
      };

      leases.set(laneId, lease);
      persist();

      broadcastEvent({ type: "port-lease-acquired", lease });
      logger.info("port_allocation.acquired", { laneId, range: `${slot.start}-${slot.end}` });

      return lease;
    },

    /**
     * Release a port range lease for a lane.
     */
    release(laneId: string): void {
      const lease = leases.get(laneId);
      if (!lease) {
        logger.warn("port_allocation.release_not_found", { laneId });
        return;
      }

      const released: PortLease = {
        ...lease,
        status: "released",
        releasedAt: new Date().toISOString(),
      };
      leases.set(laneId, released);
      persist();

      // Resolve any conflicts involving this lane
      for (const conflict of conflicts) {
        if (!conflict.resolved && (conflict.laneIdA === laneId || conflict.laneIdB === laneId)) {
          conflict.resolved = true;
          conflict.resolvedAt = new Date().toISOString();
          broadcastEvent({ type: "port-conflict-resolved", conflict });
        }
      }

      broadcastEvent({ type: "port-lease-released", lease: released });
      logger.info("port_allocation.released", { laneId });
    },

    /**
     * Get the port lease for a specific lane.
     */
    getLease(laneId: string): PortLease | null {
      return leases.get(laneId) ?? null;
    },

    /**
     * List all leases (all statuses).
     */
    listLeases(): PortLease[] {
      return Array.from(leases.values());
    },

    /**
     * List active leases only.
     */
    listActiveLeases(): PortLease[] {
      return Array.from(leases.values()).filter((l) => l.status === "active");
    },

    /**
     * Detect port conflicts across all active leases.
     * Returns newly detected conflicts.
     */
    detectConflicts(): PortConflict[] {
      const active = Array.from(leases.values()).filter((l) => l.status === "active");
      const newConflicts: PortConflict[] = [];

      for (let i = 0; i < active.length; i++) {
        for (let j = i + 1; j < active.length; j++) {
          const conflict = detectConflictsBetween(active[i], active[j]);
          if (conflict) {
            // Check if this conflict pair already exists (unresolved)
            const alreadyExists = conflicts.some(
              (c) =>
                !c.resolved &&
                ((c.laneIdA === conflict.laneIdA && c.laneIdB === conflict.laneIdB) ||
                  (c.laneIdA === conflict.laneIdB && c.laneIdB === conflict.laneIdA))
            );
            if (!alreadyExists) {
              conflicts.push(conflict);
              newConflicts.push(conflict);
              broadcastEvent({ type: "port-conflict-detected", conflict });
              logger.warn("port_allocation.conflict_detected", {
                laneA: conflict.laneIdA,
                laneB: conflict.laneIdB,
                port: conflict.port,
              });
            }
          }
        }
      }

      return newConflicts;
    },

    /**
     * List all detected conflicts.
     */
    listConflicts(): PortConflict[] {
      return [...conflicts];
    },

    /**
     * Recover orphaned leases — leases that are active but whose lanes no longer exist.
     * Pass the set of currently valid lane IDs.
     */
    recoverOrphans(validLaneIds: Set<string>): PortLease[] {
      const orphaned: PortLease[] = [];

      for (const lease of leases.values()) {
        if (lease.status === "active" && !validLaneIds.has(lease.laneId)) {
          const updated: PortLease = {
            ...lease,
            status: "orphaned",
            releasedAt: new Date().toISOString(),
          };
          leases.set(lease.laneId, updated);
          orphaned.push(updated);
          logger.warn("port_allocation.orphan_detected", {
            laneId: lease.laneId,
            range: `${lease.rangeStart}-${lease.rangeEnd}`,
          });
        }
      }

      if (orphaned.length > 0) {
        persist();
        logger.info("port_allocation.orphans_recovered", { count: orphaned.length });
      }

      return orphaned;
    },

    /**
     * Resolve a port conflict by reassigning one lane to a new range.
     * Picks the lane with the later lease timestamp to move.
     */
    resolveConflict(laneIdA: string, laneIdB: string): PortLease | null {
      const leaseA = leases.get(laneIdA);
      const leaseB = leases.get(laneIdB);
      if (!leaseA || !leaseB) return null;
      if (leaseA.status !== "active" || leaseB.status !== "active") return null;

      // Move the later-leased lane
      const laneToMove = leaseA.leasedAt > leaseB.leasedAt ? laneIdA : laneIdB;

      // Release and re-acquire
      const old = leases.get(laneToMove)!;
      leases.set(laneToMove, { ...old, status: "released", releasedAt: new Date().toISOString() });

      const slot = findFreeSlot();
      if (!slot) {
        // Restore the old lease if no free slot
        leases.set(laneToMove, old);
        logger.warn("port_allocation.conflict_resolve_exhausted", { laneToMove });
        return null;
      }

      const newLease: PortLease = {
        laneId: laneToMove,
        rangeStart: slot.start,
        rangeEnd: slot.end,
        status: "active",
        leasedAt: new Date().toISOString(),
      };
      leases.set(laneToMove, newLease);
      persist();

      // Mark conflicts between these two as resolved
      for (const c of conflicts) {
        if (
          !c.resolved &&
          ((c.laneIdA === laneIdA && c.laneIdB === laneIdB) ||
            (c.laneIdA === laneIdB && c.laneIdB === laneIdA))
        ) {
          c.resolved = true;
          c.resolvedAt = new Date().toISOString();
          broadcastEvent({ type: "port-conflict-resolved", conflict: c });
        }
      }

      broadcastEvent({ type: "port-lease-acquired", lease: newLease });
      logger.info("port_allocation.conflict_resolved", {
        movedLane: laneToMove,
        newRange: `${slot.start}-${slot.end}`,
      });

      return newLease;
    },

    /**
     * Get current allocation config.
     */
    getConfig(): PortAllocationConfig {
      return { ...cfg };
    },

    /**
     * Dispose service — clear all in-memory state.
     */
    dispose(): void {
      leases.clear();
      conflicts.length = 0;
    },
  };
}
