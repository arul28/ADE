import { useEffect, useState } from "react";
import { COLORS, MONO_FONT, LABEL_STYLE, inlineBadge, cardStyle, recessedStyle } from "./laneDesignTokens";
import type { PortLease, PortConflict } from "../../../shared/types";

function statusColor(status: string): string {
  switch (status) {
    case "active":
      return COLORS.success;
    case "released":
      return COLORS.textMuted;
    case "orphaned":
      return COLORS.warning;
    default:
      return COLORS.textDim;
  }
}

function PortRangeBar({ lease }: { lease: PortLease }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={inlineBadge(statusColor(lease.status))}>
        {lease.status}
      </span>
      <span
        style={{
          fontFamily: MONO_FONT,
          fontSize: 13,
          fontWeight: 600,
          color: COLORS.textPrimary,
          letterSpacing: "0.5px",
        }}
      >
        {lease.rangeStart}–{lease.rangeEnd}
      </span>
      <span style={{ fontSize: 10, color: COLORS.textDim, fontFamily: MONO_FONT }}>
        ({lease.rangeEnd - lease.rangeStart + 1} ports)
      </span>
    </div>
  );
}

function ConflictRow({ conflict }: { conflict: PortConflict }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 0",
      }}
    >
      <span style={inlineBadge(conflict.resolved ? COLORS.success : COLORS.danger)}>
        {conflict.resolved ? "RESOLVED" : "CONFLICT"}
      </span>
      <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textSecondary }}>
        port {conflict.port}
      </span>
      <span style={{ fontSize: 10, color: COLORS.textDim }}>
        {conflict.laneIdA.slice(0, 8)} vs {conflict.laneIdB.slice(0, 8)}
      </span>
    </div>
  );
}

export function PortAllocationPanel({ laneId }: { laneId: string }) {
  const [lease, setLease] = useState<PortLease | null>(null);
  const [conflicts, setConflicts] = useState<PortConflict[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      window.ade.lanes.portGetLease({ laneId }),
      window.ade.lanes.portListConflicts(),
    ]).then(([leaseResult, conflictsResult]) => {
      if (!cancelled) {
        setLease(leaseResult);
        setConflicts(
          conflictsResult.filter(
            (c: PortConflict) => c.laneIdA === laneId || c.laneIdB === laneId
          )
        );
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });

    const unsub = window.ade.lanes.onPortEvent((ev) => {
      if (ev.lease && ev.lease.laneId === laneId) {
        setLease(ev.lease);
      }
      if (ev.conflict) {
        setConflicts((prev) => {
          const existing = prev.find(
            (c) =>
              (c.laneIdA === ev.conflict!.laneIdA && c.laneIdB === ev.conflict!.laneIdB) ||
              (c.laneIdA === ev.conflict!.laneIdB && c.laneIdB === ev.conflict!.laneIdA)
          );
          if (existing) {
            return prev.map((c) =>
              c === existing ? ev.conflict! : c
            );
          }
          if (ev.conflict!.laneIdA === laneId || ev.conflict!.laneIdB === laneId) {
            return [...prev, ev.conflict!];
          }
          return prev;
        });
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [laneId]);

  if (loading) {
    return (
      <div style={{ ...cardStyle(), display: "flex", alignItems: "center", justifyContent: "center", minHeight: 60 }}>
        <span style={{ color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 11 }}>Loading port allocation…</span>
      </div>
    );
  }

  return (
    <div style={cardStyle({ display: "flex", flexDirection: "column", gap: 12 })}>
      <div style={LABEL_STYLE}>Port Allocation</div>

      {lease ? (
        <PortRangeBar lease={lease} />
      ) : (
        <div style={{ ...recessedStyle(), display: "flex", alignItems: "center", gap: 8 }}>
          <span style={inlineBadge(COLORS.textDim)}>UNALLOCATED</span>
          <span style={{ fontFamily: MONO_FONT, fontSize: 11, color: COLORS.textMuted }}>
            No port range assigned
          </span>
        </div>
      )}

      {lease && (
        <div style={recessedStyle({ display: "flex", flexDirection: "column", gap: 4 })}>
          <div style={{ display: "flex", gap: 16 }}>
            <span style={{ fontSize: 10, color: COLORS.textDim, fontFamily: MONO_FONT }}>
              PRIMARY PORT
            </span>
            <span style={{ fontSize: 12, color: COLORS.textPrimary, fontFamily: MONO_FONT, fontWeight: 600 }}>
              {lease.rangeStart}
            </span>
          </div>
          <div style={{ display: "flex", gap: 16 }}>
            <span style={{ fontSize: 10, color: COLORS.textDim, fontFamily: MONO_FONT }}>
              LEASED AT
            </span>
            <span style={{ fontSize: 10, color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              {new Date(lease.leasedAt).toLocaleString()}
            </span>
          </div>
        </div>
      )}

      {conflicts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ ...LABEL_STYLE, color: COLORS.danger }}>Port Conflicts</div>
          {conflicts.map((c, i) => (
            <ConflictRow key={`${c.laneIdA}-${c.laneIdB}-${i}`} conflict={c} />
          ))}
        </div>
      )}
    </div>
  );
}
