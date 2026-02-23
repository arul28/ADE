import React, { useCallback, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { MagnifyingGlass, ArrowRight } from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import { useNavigate } from "react-router-dom";
import { Kbd } from "../ui/Kbd";
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
      { id: "go-settings", title: "Go to Settings", shortcut: "G S", group: "Navigation", run: () => navigate("/settings") },
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
                  "bg-[--color-surface-overlay]",
                  "border border-white/[0.06]",
                  "shadow-[0_24px_48px_-12px_rgba(0,0,0,0.5)]",
                  "rounded-xl",
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
                <div className="flex items-center gap-3 px-4 border-b border-border/30">
                  <MagnifyingGlass size={18} weight="regular" className="shrink-0 text-muted-fg" />
                  <input
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setSelectedIdx(0);
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Search commands..."
                    className="h-12 w-full bg-transparent text-lg outline-none placeholder:text-muted-fg"
                    autoFocus
                  />
                  <Kbd className="hidden sm:inline-flex shrink-0">Esc</Kbd>
                </div>

                {/* Results */}
                <div className="flex-1 overflow-auto">
                  {filtered.length === 0 ? (
                    <div className="px-4 py-6 text-sm text-muted-fg">No matches.</div>
                  ) : (
                    <ul ref={listRef} className="py-1">
                      {(() => {
                        let flatIdx = 0;
                        return grouped.map((group) => (
                          <li key={group.label}>
                            <div className="text-[10px] uppercase tracking-widest text-muted-fg font-medium px-3 py-1.5">
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
                                        "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm transition-colors",
                                        isSelected
                                          ? "bg-[--color-accent-muted] text-fg"
                                          : "hover:bg-accent/8"
                                      )}
                                      onMouseEnter={() => setSelectedIdx(idx)}
                                      onClick={() => runCommand(cmd)}
                                    >
                                      <div className="min-w-0">
                                        <div className="truncate font-medium">{cmd.title}</div>
                                        {cmd.hint ? <div className="truncate text-xs text-muted-fg mt-0.5">{cmd.hint}</div> : null}
                                      </div>
                                      <div className="flex items-center gap-2">
                                        {cmd.shortcut ? (
                                          <span className="hidden sm:inline font-mono text-[10px] text-muted-fg">{cmd.shortcut}</span>
                                        ) : null}
                                        <ArrowRight size={14} weight="regular" className="text-muted-fg" />
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
