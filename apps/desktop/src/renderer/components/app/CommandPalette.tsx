import React, { useCallback, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { MagnifyingGlass, ArrowRight } from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import { useNavigate } from "react-router-dom";
import { cn } from "../ui/cn";
import { useAppStore } from "../../state/appStore";
import { fadeScale } from "../../lib/motion";

type Command = {
  id: string;
  title: string;
  hint?: string;
  shortcut?: string;
  group?: string;
  run: () => void;
};

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const selectLane = useAppStore((s) => s.selectLane);
  const [q, setQ] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const commands: Command[] = useMemo(
    () => [
      { id: "go-project", title: "Go to Run", shortcut: "G 1", group: "Navigation", run: () => navigate("/project") },
      { id: "go-lanes", title: "Go to Lanes", shortcut: "G L", group: "Navigation", run: () => navigate("/lanes") },
      { id: "go-files", title: "Go to Files", shortcut: "G F", group: "Navigation", run: () => navigate("/files") },
      { id: "go-work", title: "Go to Work", shortcut: "G T", group: "Navigation", run: () => navigate("/work") },
      { id: "go-conflicts", title: "Go to Conflicts", shortcut: "G C", group: "Navigation", run: () => navigate("/conflicts") },
      { id: "go-prs", title: "Go to PRs", shortcut: "G R", group: "Navigation", run: () => navigate("/prs") },
      { id: "go-history", title: "Go to History", shortcut: "G H", group: "Navigation", run: () => navigate("/history") },
      { id: "go-missions", title: "Go to Missions", shortcut: "G M", group: "Navigation", run: () => navigate("/missions") },
      { id: "go-agents", title: "Go to Agents", hint: "Automation and agent workflows", group: "Navigation", run: () => navigate("/agents") },
      { id: "go-settings", title: "Go to Settings", shortcut: "G S", group: "Navigation", run: () => navigate("/settings") },
      { id: "go-settings-general", title: "Go to General Settings", hint: "Provider, model, theme", group: "Settings", run: () => navigate("/settings") },
      { id: "go-settings-github", title: "Go to GitHub Settings", hint: "Token, repos, PRs", group: "Settings", run: () => navigate("/settings") },
      { id: "go-settings-context", title: "Go to Context & Docs", hint: "Context files, docs generation", group: "Settings", run: () => navigate("/settings") },
      { id: "go-settings-usage", title: "Go to Usage", hint: "Token usage, cost breakdown", group: "Settings", run: () => navigate("/settings") },
      {
        id: "action-create-lane",
        title: "Create Lane",
        hint: "Create a new development lane",
        group: "Actions",
        run: () => navigate("/lanes")
      },
      {
        id: "action-open-terminal",
        title: "Open Terminal",
        hint: "Switch to work / terminals view",
        group: "Actions",
        run: () => navigate("/work")
      },
      {
        id: "action-refresh-packs",
        title: "Refresh Packs",
        hint: "Refresh AI context packs",
        group: "Actions",
        run: () => {
          // Navigate to lanes where packs can be refreshed
          navigate("/lanes");
        }
      },
      {
        id: "action-open-graph",
        title: "Open Workspace Graph",
        hint: "Visual dependency graph",
        group: "Actions",
        run: () => navigate("/graph")
      },
      {
        id: "action-automations",
        title: "Go to Agents",
        hint: "CI/CD and automation rules",
        group: "Actions",
        run: () => navigate("/agents")
      },
      {
        id: "lane-next",
        title: "Select Next Lane",
        shortcut: "]",
        group: "Lanes",
        run: () => {
          if (!lanes.length) return;
          const currentIdx = lanes.findIndex((lane) => lane.id === selectedLaneId);
          const next = lanes[(currentIdx + 1 + lanes.length) % lanes.length];
          if (!next) return;
          selectLane(next.id);
          navigate(`/lanes?laneId=${encodeURIComponent(next.id)}`);
        }
      },
      {
        id: "lane-prev",
        title: "Select Previous Lane",
        shortcut: "[",
        group: "Lanes",
        run: () => {
          if (!lanes.length) return;
          const currentIdx = lanes.findIndex((lane) => lane.id === selectedLaneId);
          const next = lanes[(currentIdx - 1 + lanes.length) % lanes.length];
          if (!next) return;
          selectLane(next.id);
          navigate(`/lanes?laneId=${encodeURIComponent(next.id)}`);
        }
      },
      {
        id: "lane-filter",
        title: "Focus Lane Filter",
        shortcut: "/",
        group: "Lanes",
        run: () => {
          navigate("/lanes");
          setTimeout(() => {
            const input = document.getElementById("lanes-filter-input");
            if (input instanceof HTMLInputElement) {
              input.focus();
              input.select();
            }
          }, 30);
        }
      },
      {
        id: "ping",
        title: "Ping preload bridge",
        hint: "Expect \"pong\"",
        group: "Debug",
        run: async () => {
          const pong = await window.ade.app.ping();
          // eslint-disable-next-line no-console
          console.log("ade.app.ping ->", pong);
        }
      }
    ],
    [lanes, navigate, selectLane, selectedLaneId]
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) => c.title.toLowerCase().includes(needle) || (c.hint ?? "").toLowerCase().includes(needle));
  }, [commands, q]);

  // Group filtered results by their group label
  const grouped = useMemo(() => {
    const groups: { label: string; items: Command[] }[] = [];
    const seen = new Map<string, number>();
    for (const cmd of filtered) {
      const label = cmd.group ?? "Other";
      if (seen.has(label)) {
        groups[seen.get(label)!]!.items.push(cmd);
      } else {
        seen.set(label, groups.length);
        groups.push({ label, items: [cmd] });
      }
    }
    return groups;
  }, [filtered]);

  const runCommand = useCallback(
    (cmd: Command) => {
      Promise.resolve(cmd.run()).finally(() => {
        onOpenChange(false);
        setQ("");
        setSelectedIdx(0);
      });
    },
    [onOpenChange]
  );

  const runSelected = useCallback(() => {
    const cmd = filtered[selectedIdx];
    if (!cmd) return;
    runCommand(cmd);
  }, [filtered, selectedIdx, runCommand]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((prev) => (prev + 1) % filtered.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((prev) => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        runSelected();
      }
    },
    [filtered.length, runSelected]
  );

  // Scroll selected item into view
  const scrollToSelected = useCallback((idx: number) => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-cmd-item]");
    items[idx]?.scrollIntoView({ block: "nearest" });
  }, []);

  // Keep selected in bounds when filter changes
  React.useEffect(() => {
    if (selectedIdx >= filtered.length) {
      setSelectedIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIdx]);

  React.useEffect(() => {
    scrollToSelected(selectedIdx);
  }, [selectedIdx, scrollToSelected]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) {
          setQ("");
          setSelectedIdx(0);
        }
      }}
    >
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild>
              <motion.div
                className="fixed inset-0 bg-black/50 backdrop-blur-xl"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
              />
            </Dialog.Overlay>
            <Dialog.Content asChild onOpenAutoFocus={(e) => e.preventDefault()}>
              <motion.div
                className={cn(
                  "fixed left-1/2 top-[18%] -translate-x-1/2",
                  "w-[560px] max-w-[90vw] max-h-[400px]",
                  "bg-[#13101A]",
                  "border border-[#1E1B26]",
                  "shadow-[0_24px_48px_-12px_rgba(0,0,0,0.5)]",
                  "flex flex-col overflow-hidden",
                  "focus:outline-none"
                )}
                variants={fadeScale}
                initial="initial"
                animate="animate"
                exit="exit"
              >
                {/* Hidden accessible title */}
                <Dialog.Title className="sr-only">Command palette</Dialog.Title>

                {/* Search input */}
                <div
                  className="flex items-center gap-3 px-4 border-b border-[#1E1B26]"
                  style={{ background: "#0C0A10" }}
                >
                  <MagnifyingGlass size={18} weight="regular" className="shrink-0 text-[#71717A]" />
                  <input
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setSelectedIdx(0);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Search commands..."
                    className="h-12 w-full bg-transparent text-lg text-[#FAFAFA] outline-none placeholder:text-[#71717A] font-mono"
                    autoFocus
                  />
                  <span
                    className={cn(
                      "hidden sm:inline-flex shrink-0 items-center",
                      "font-mono text-[10px] text-[#71717A]",
                      "px-1.5 py-0.5",
                      "border border-[#27272A] bg-[#13101A]"
                    )}
                  >
                    ESC
                  </span>
                </div>

                {/* Results */}
                <div className="flex-1 overflow-auto">
                  {filtered.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-[#71717A] font-mono">No matches.</div>
                  ) : (
                    <ul ref={listRef} className="py-1">
                      {(() => {
                        let flatIdx = 0;
                        return grouped.map((group) => (
                          <li key={group.label}>
                            <div
                              className="font-mono font-medium px-3 py-1.5"
                              style={{
                                fontSize: 10,
                                textTransform: "uppercase",
                                letterSpacing: "1px",
                                color: "#71717A",
                              }}
                            >
                              {group.label}
                            </div>
                            <ul>
                              {group.items.map((cmd) => {
                                const idx = flatIdx++;
                                const isSelected = idx === selectedIdx;
                                return (
                                  <li key={cmd.id} data-cmd-item>
                                    <button
                                      className={cn(
                                        "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm font-mono transition-colors",
                                        isSelected
                                          ? "bg-[#A78BFA18] text-[#FAFAFA] border-l-[3px] border-l-[#A78BFA]"
                                          : "border-l-[3px] border-l-transparent hover:bg-[#A78BFA08]"
                                      )}
                                      style={isSelected ? { paddingLeft: 9 } : { paddingLeft: 9 }}
                                      onMouseEnter={() => setSelectedIdx(idx)}
                                      onClick={() => runCommand(cmd)}
                                    >
                                      <div className="min-w-0">
                                        <div className="truncate font-medium text-[#FAFAFA]">{cmd.title}</div>
                                        {cmd.hint ? <div className="truncate text-xs text-[#71717A] mt-0.5">{cmd.hint}</div> : null}
                                      </div>
                                      <div className="flex items-center gap-2">
                                        {cmd.shortcut ? (
                                          <span
                                            className={cn(
                                              "hidden sm:inline-flex items-center font-mono text-[10px] text-[#71717A]",
                                              "px-1.5 py-0.5",
                                              "border border-[#27272A] bg-[#0C0A10]"
                                            )}
                                          >
                                            {cmd.shortcut}
                                          </span>
                                        ) : null}
                                        <ArrowRight size={14} weight="regular" className="text-[#71717A]" />
                                      </div>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </li>
                        ));
                      })()}
                    </ul>
                  )}
                </div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
