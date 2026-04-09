import React from "react";
import { DesktopTower } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import type { AdeExecutionTargetProfile } from "../../../shared/types";
import { ADE_LOCAL_EXECUTION_TARGET_ID, executionTargetSummaryLabel } from "../../../shared/types";

export function ExecutionTargetContextBanner({
  profile,
  className,
  variant = "bar",
}: {
  profile: AdeExecutionTargetProfile | undefined;
  className?: string;
  variant?: "bar" | "inline";
}) {
  const label = executionTargetSummaryLabel(profile);
  const isRemote = profile?.kind === "ssh";
  const detail =
    profile?.kind === "ssh"
      ? `${profile.sshHost} · ${profile.workspacePath} · Saved remote target only; work still runs on this computer.`
      : "Files, terminals, and lanes use this machine.";

  if (variant === "inline") {
    return (
      <span className={cn("inline-flex items-center gap-1 text-[10px] text-muted-fg/70", className)} title={detail}>
        <DesktopTower size={11} className={cn(isRemote ? "text-sky-400/80" : "text-muted-fg/50")} />
        <span className="font-medium text-fg/75">{label}</span>
        {profile?.kind === "ssh" ? (
          <span className="text-amber-400/80">(saved target only; local execution)</span>
        ) : null}
      </span>
    );
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-[11px]",
        className,
      )}
      role="status"
    >
      <DesktopTower size={14} className={cn("shrink-0", isRemote ? "text-sky-400/90" : "text-muted-fg/50")} weight="regular" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg/85">
          Active target: <span className="text-fg">{label}</span>
          {profile?.id === ADE_LOCAL_EXECUTION_TARGET_ID ? null : (
            <span className="ml-1.5 font-normal text-muted-fg/55">· workspace focus</span>
          )}
        </div>
        <div className="truncate text-[10px] text-muted-fg/45">{detail}</div>
      </div>
      {profile?.kind === "ssh" && profile.connectionMode === "planned" ? (
        <span className="shrink-0 rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-200/80">
          Planned
        </span>
      ) : null}
    </div>
  );
}
