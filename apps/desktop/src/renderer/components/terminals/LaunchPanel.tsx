import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CaretDown as ChevronDown,
  ChatCircleDots as MessageSquarePlus,
  GearSix,
  Terminal,
  Brain as BrainCircuit,
} from "@phosphor-icons/react";
import type { TerminalLaunchProfile, TerminalProfilesSnapshot, TerminalToolType } from "../../../shared/types";
import { ToolLogo } from "./ToolLogos";
import { TerminalSettingsDialog, readLaunchTracked, persistLaunchTracked } from "./TerminalSettingsDialog";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";

const DEFAULT_PROFILE_IDS = ["claude", "codex", "shell"] as const;

function toolTypeFromProfileId(profileId: string): TerminalToolType | null {
  const id = profileId.trim().toLowerCase();
  if (id === "claude") return "claude";
  if (id === "codex") return "codex";
  if (id === "shell") return "shell";
  if (id === "aider") return "aider";
  if (id === "cursor") return "cursor";
  if (id === "continue") return "continue";
  return "other";
}

export function LaunchPanel({
  lanes,
  onLaunchPty,
  onLaunchChat,
}: {
  lanes: { id: string; name: string }[];
  onLaunchPty: (laneId: string, profile: "claude" | "codex" | "shell") => void;
  onLaunchChat: (laneId: string, provider: "claude" | "codex") => void;
}) {
  const [laneId, setLaneId] = useState<string>(lanes[0]?.id ?? "");
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [terminalProfiles, setTerminalProfiles] = useState<TerminalProfilesSnapshot | null>(null);
  const [launchTracked, setLaunchTracked] = useState(readLaunchTracked());

  useEffect(() => {
    if (!laneId && lanes.length > 0) setLaneId(lanes[0]!.id);
  }, [lanes, laneId]);

  useEffect(() => {
    let cancelled = false;
    window.ade.terminalProfiles
      .get()
      .then((snapshot) => {
        if (cancelled) return;
        setTerminalProfiles(snapshot);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const customProfiles = useMemo(() => {
    if (!terminalProfiles) return [];
    return terminalProfiles.profiles.filter(
      (p) => !(DEFAULT_PROFILE_IDS as readonly string[]).includes(p.id),
    );
  }, [terminalProfiles]);

  const launchCustomProfile = useCallback(
    (profile: TerminalLaunchProfile) => {
      if (!laneId) return;
      const toolType = toolTypeFromProfileId(profile.id);
      const command = (profile.command ?? "").trim();
      window.ade.pty
        .create({
          laneId,
          cols: 100,
          rows: 30,
          title: profile.name || "Shell",
          tracked: launchTracked,
          toolType,
          startupCommand: command || undefined,
        })
        .catch(() => {});
    },
    [laneId, launchTracked],
  );

  return (
    <>
      <div className="bg-[--color-surface-recessed]/40 px-3 py-2.5 space-y-2">
        {/* Lane selector */}
        <div className="flex items-center gap-2">
          <label className="text-[11px] uppercase tracking-wider text-muted-fg/70 shrink-0">Lane</label>
          <div className="relative flex-1">
            <select
              className="h-6 w-full appearance-none rounded-md border border-border/15 bg-surface-recessed pl-2 pr-6 text-xs text-fg outline-none hover:border-accent/30 transition-colors cursor-pointer"
              value={laneId}
              onChange={(e) => setLaneId(e.target.value)}
            >
              {lanes.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
            <ChevronDown size={12} weight="regular" className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-fg/60" />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 shrink-0"
            title="Terminal settings"
            onClick={() => setSettingsOpen(true)}
          >
            <GearSix size={14} />
          </Button>
        </div>

        {/* Quick-launch row */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            disabled={!laneId}
            onClick={() => onLaunchPty(laneId, "claude")}
            className="inline-flex items-center gap-1.5 rounded-md bg-orange-500/15 px-2 py-1 text-xs font-medium text-orange-400 transition-all hover:bg-orange-500/25 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
          >
            <ToolLogo toolType="claude" size={12} />
            Claude
          </button>
          <button
            type="button"
            disabled={!laneId}
            onClick={() => onLaunchPty(laneId, "codex")}
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-400/15 px-2 py-1 text-xs font-medium text-slate-300 transition-all hover:bg-slate-400/25 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
          >
            <ToolLogo toolType="codex" size={12} />
            Codex
          </button>
          <button
            type="button"
            disabled={!laneId}
            onClick={() => onLaunchPty(laneId, "shell")}
            className="inline-flex items-center gap-1.5 rounded-md bg-zinc-500/15 px-2 py-1 text-xs font-medium text-zinc-400 transition-all hover:bg-zinc-500/25 hover:text-zinc-300 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
          >
            <ToolLogo toolType="shell" size={12} />
            Shell
          </button>

          {/* Custom profile buttons */}
          {customProfiles.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={!laneId}
              onClick={() => launchCustomProfile(p)}
              className="inline-flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-1 text-xs font-medium text-muted-fg transition-all hover:bg-muted/70 hover:text-fg active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
              style={p.color ? { backgroundColor: `${p.color}20`, color: p.color } : undefined}
              title={p.command ? `${p.name} (${p.command})` : p.name}
            >
              <Terminal size={12} weight="regular" />
              {p.name}
            </button>
          ))}

          <div className="mx-0.5 h-3.5 w-px bg-border/20" />

          {/* Chat launch */}
          <div className="relative">
            <button
              type="button"
              disabled={!laneId}
              onClick={() => setChatOpen((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md border border-accent/20 bg-accent/8 px-2 py-1 text-xs font-medium text-accent transition-all hover:bg-accent/15 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40"
            >
              <MessageSquarePlus size={12} weight="regular" />
              Chat
              <ChevronDown size={12} weight="regular" className={cn("opacity-60 transition-transform", chatOpen && "rotate-180")} />
            </button>
            {chatOpen && (
              <div className="absolute left-0 top-full z-50 mt-1 w-40 rounded-lg border border-border/30 bg-[--color-surface-overlay] py-0.5 shadow-float backdrop-blur-md">
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
                  onClick={() => { onLaunchChat(laneId, "claude"); setChatOpen(false); }}
                >
                  <BrainCircuit size={14} weight="regular" className="text-violet-400" />
                  Claude chat
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted/40 transition-colors"
                  onClick={() => { onLaunchChat(laneId, "codex"); setChatOpen(false); }}
                >
                  <BrainCircuit size={14} weight="regular" className="text-sky-400" />
                  Codex chat
                </button>
              </div>
            )}
          </div>

          {/* Tracked toggle */}
          <button
            type="button"
            onClick={() => {
              const next = !launchTracked;
              setLaunchTracked(next);
              persistLaunchTracked(next);
            }}
            className={cn(
              "inline-flex items-center rounded-md px-1.5 py-1 text-[11px] font-medium transition-all",
              launchTracked
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-muted/30 text-muted-fg/60",
            )}
            title={launchTracked ? "Tracked: context collected" : "Untracked: no context"}
          >
            {launchTracked ? "tracked" : "untracked"}
          </button>
        </div>
      </div>

      <TerminalSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        terminalProfiles={terminalProfiles}
        onProfilesSaved={setTerminalProfiles}
        launchTracked={launchTracked}
        onLaunchTrackedChange={(v) => { setLaunchTracked(v); persistLaunchTracked(v); }}
      />
    </>
  );
}
