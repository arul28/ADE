import React from "react";
import { Stack } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import type { AutoRebaseLaneStatus, LaneSummary, RestackSuggestion } from "../../../shared/types";

export function LaneRestackBanner({
  visibleRestackSuggestions,
  visibleAutoRebaseNeedsAttention,
  showAutoRebaseSettingsHint,
  lanesById,
  restackBusyLaneId,
  restackSuggestionError,
  onRestackNow,
  onDismissRestack,
  onDeferRestack,
  onOpenAutoRebaseSettings,
  onOpenRebaseConflictResolver
}: {
  visibleRestackSuggestions: RestackSuggestion[];
  visibleAutoRebaseNeedsAttention: AutoRebaseLaneStatus[];
  showAutoRebaseSettingsHint: boolean;
  lanesById: Map<string, LaneSummary>;
  restackBusyLaneId: string | null;
  restackSuggestionError: string | null;
  onRestackNow: (laneId: string) => void;
  onDismissRestack: (laneId: string) => void;
  onDeferRestack: (laneId: string, minutes: number) => void;
  onOpenAutoRebaseSettings: () => void;
  onOpenRebaseConflictResolver: (laneId: string, parentLaneId: string | null) => void;
}) {
  return (
    <>
      {visibleRestackSuggestions.length > 0 ? (
        <div className="border-b border-border/15 bg-amber-500/5 px-2 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-fg/70">Restack suggested</div>
            <div className="text-xs text-muted-fg">{visibleRestackSuggestions.length} lane(s) behind parent</div>
          </div>
          {showAutoRebaseSettingsHint ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded border border-sky-500/25 bg-sky-500/8 px-2 py-1.5">
              <div className="text-xs text-sky-700">
                Auto-rebase is off. Enable it in Settings to auto-restack child lanes after parent updates.
              </div>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onOpenAutoRebaseSettings}>
                Open settings
              </Button>
            </div>
          ) : null}
          <div className="mt-2 space-y-2">
            {visibleRestackSuggestions.slice(0, 3).map((s) => {
              const lane = lanesById.get(s.laneId) ?? null;
              if (!lane) return null;
              const busy = restackBusyLaneId === s.laneId;
              return (
                <div key={`restack:${s.laneId}`} className="flex flex-wrap items-start justify-between gap-2 rounded shadow-card bg-card/40 p-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-semibold text-fg">{lane.name}</span>
                      {s.hasPr ? <span className="rounded-lg bg-sky-500/10 px-1 text-[11px] text-sky-700">PR</span> : null}
                      <span className="text-xs text-muted-fg">{s.behindCount} behind</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-fg">Rebase this lane onto its parent to pick up new commits.</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={Boolean(restackBusyLaneId)} onClick={() => onDeferRestack(s.laneId, 60)}>
                      Defer 1h
                    </Button>
                    <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={Boolean(restackBusyLaneId)} onClick={() => onDismissRestack(s.laneId)}>
                      Dismiss
                    </Button>
                    <Button size="sm" variant="primary" className="h-7 px-2 text-xs" disabled={Boolean(restackBusyLaneId)} onClick={() => onRestackNow(s.laneId)}>
                      <Stack size={12} className="mr-1" />
                      {busy ? "Restacking..." : "Restack now"}
                    </Button>
                  </div>
                </div>
              );
            })}
            {visibleRestackSuggestions.length > 3 ? (
              <div className="text-xs text-muted-fg">+ {visibleRestackSuggestions.length - 3} more suggestions.</div>
            ) : null}
            {restackSuggestionError ? (
              <div className="rounded bg-red-500/10 p-2 text-xs text-red-200">{restackSuggestionError}</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {showAutoRebaseSettingsHint && visibleRestackSuggestions.length === 0 ? (
        <div className="border-b border-border/15 bg-sky-500/8 px-2 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-sky-500/25 bg-card/30 px-2 py-1.5">
            <div className="text-xs text-sky-700">
              Auto-rebase is off. Enable it in Settings to auto-restack child lanes after parent updates.
            </div>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={onOpenAutoRebaseSettings}>
              Open settings
            </Button>
          </div>
        </div>
      ) : null}

      {visibleAutoRebaseNeedsAttention.length > 0 ? (
        <div className="border-b border-border/15 bg-amber-500/5 px-2 py-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs text-muted-fg/70">Auto-rebase needs attention</div>
            <div className="text-xs text-muted-fg">{visibleAutoRebaseNeedsAttention.length} lane(s)</div>
          </div>
          <div className="mt-2 space-y-2">
            {visibleAutoRebaseNeedsAttention.slice(0, 3).map((status) => {
              const lane = lanesById.get(status.laneId) ?? null;
              if (!lane) return null;
              return (
                <div key={`auto-rebase:${status.laneId}`} className="flex flex-wrap items-start justify-between gap-2 rounded bg-card/40 p-2 shadow-card">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-xs font-semibold text-fg">{lane.name}</span>
                      {status.state === "rebaseConflict" ? (
                        <span className="rounded-lg bg-red-500/12 px-1 text-[11px] text-red-200">conflict</span>
                      ) : (
                        <span className="rounded-lg bg-amber-500/12 px-1 text-[11px] text-amber-800">pending</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-fg">
                      {status.message ?? "Manual rebase and publish may be required for this lane."}
                    </div>
                  </div>
                  <div className="shrink-0">
                    {status.state === "rebaseConflict" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => onOpenRebaseConflictResolver(status.laneId, status.parentLaneId ?? lane.parentLaneId ?? null)}
                      >
                        Resolve in Conflicts
                      </Button>
                    ) : (
                      <Button size="sm" variant="primary" className="h-7 px-2 text-xs" onClick={() => onRestackNow(status.laneId)}>
                        <Stack size={12} className="mr-1" />
                        Restack now
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
            {visibleAutoRebaseNeedsAttention.length > 3 ? (
              <div className="text-xs text-muted-fg">+ {visibleAutoRebaseNeedsAttention.length - 3} more lanes.</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
