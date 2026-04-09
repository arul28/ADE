import React, { useCallback, useEffect, useRef, useState } from "react";
import { CaretDown, DesktopTower, GearSix } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import { cn } from "../ui/cn";
import type { AdeExecutionTargetProfile } from "../../../shared/types";
import { executionTargetSummaryLabel } from "../../../shared/types";
import { useExecutionTargets } from "../../hooks/useExecutionTargets";

export function TopBarExecutionTargetSelect({ projectRoot }: { projectRoot: string | null }) {
  const navigate = useNavigate();
  const { profiles, activeProfile, activeTargetId, setActiveTargetId, loading } = useExecutionTargets(projectRoot);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const onPick = useCallback(
    async (id: string) => {
      try {
        await setActiveTargetId(id);
        setOpen(false);
      } catch (error) {
        console.error("Failed to set execution target.", error);
      }
    },
    [setActiveTargetId],
  );

  if (!projectRoot?.trim()) return null;

  const label = loading ? "…" : executionTargetSummaryLabel(activeProfile);

  return (
    <div ref={rootRef} className="relative shrink-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
      <button
        type="button"
        className={cn(
          "ade-shell-control inline-flex max-w-[200px] items-center gap-1 rounded-md px-2 py-1",
          "text-[11px] font-medium text-fg/80 transition-colors hover:text-fg",
        )}
        data-variant="ghost"
        onClick={() => setOpen((v) => !v)}
        title="Workspace target — files and terminals follow this selection"
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <DesktopTower size={12} weight="regular" className="shrink-0 text-muted-fg/50" />
        <span className="min-w-0 truncate">{label}</span>
        <CaretDown size={10} className="shrink-0 text-muted-fg/40" />
      </button>
      {open ? (
        <div
          className="absolute left-0 top-full z-50 mt-1 min-w-[240px] overflow-hidden rounded-lg border border-white/[0.08] bg-card py-1 shadow-lg"
          role="listbox"
        >
          <div className="border-b border-white/[0.06] px-2 py-1.5 text-[9px] font-medium uppercase tracking-wide text-muted-fg/45">
            Workspace target
          </div>
          {profiles.map((p: AdeExecutionTargetProfile) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === activeTargetId}
              className={cn(
                "flex w-full items-start gap-2 px-2 py-1.5 text-left text-[11px] transition-colors hover:bg-white/[0.04]",
                p.id === activeTargetId && "bg-white/[0.06]",
              )}
              onClick={() => void onPick(p.id)}
            >
              <DesktopTower size={14} className="mt-0.5 shrink-0 text-muted-fg/45" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-fg/90">{executionTargetSummaryLabel(p)}</span>
                {p.kind === "ssh" ? (
                  <span className="block truncate text-[10px] text-muted-fg/45">{p.sshHost}</span>
                ) : (
                  <span className="block text-[10px] text-muted-fg/45">This Mac or PC running ADE</span>
                )}
              </span>
            </button>
          ))}
          <div className="border-t border-white/[0.06] px-1 py-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-muted-fg/70 transition-colors hover:bg-white/[0.04] hover:text-fg/80"
              onClick={() => {
                setOpen(false);
                navigate("/settings?tab=workspace#execution-targets");
              }}
            >
              <GearSix size={14} className="shrink-0" />
              Manage targets…
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
