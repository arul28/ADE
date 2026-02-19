import React, { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../ui/Button";
import { Kbd } from "../ui/Kbd";
import { cn } from "../ui/cn";
import { useAppStore } from "../../state/appStore";

type Command = {
  id: string;
  title: string;
  hint?: string;
  shortcut?: string;
  run: () => void;
};

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const selectLane = useAppStore((s) => s.selectLane);
  const [q, setQ] = useState("");

  const commands: Command[] = useMemo(
    () => [
      { id: "go-project", title: "Go to Run", shortcut: "G 1", run: () => navigate("/project") },
      { id: "go-lanes", title: "Go to Lanes", shortcut: "G L", run: () => navigate("/lanes") },
      { id: "go-files", title: "Go to Files", shortcut: "G F", run: () => navigate("/files") },
      { id: "go-terminals", title: "Go to Terminals", shortcut: "G T", run: () => navigate("/terminals") },
      { id: "go-conflicts", title: "Go to Conflicts", shortcut: "G C", run: () => navigate("/conflicts") },
      { id: "go-prs", title: "Go to PRs", shortcut: "G R", run: () => navigate("/prs") },
      { id: "go-history", title: "Go to History", shortcut: "G H", run: () => navigate("/history") },
      { id: "go-missions", title: "Go to Missions", shortcut: "G M", run: () => navigate("/missions") },
      { id: "go-settings", title: "Go to Settings", shortcut: "G S", run: () => navigate("/settings") },
      {
        id: "lane-next",
        title: "Select Next Lane",
        shortcut: "]",
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

  const runFirst = async () => {
    const cmd = filtered[0];
    if (!cmd) return;
    await Promise.resolve(cmd.run());
    onOpenChange(false);
    setQ("");
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) setQ("");
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className={cn(
            "fixed left-1/2 top-[18%] w-[min(720px,calc(100vw-24px))] -translate-x-1/2 rounded-2xl bg-card/95 p-3 shadow-float backdrop-blur-xl",
            "focus:outline-none"
          )}
        >
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold">Command palette</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="sm">
                Esc
              </Button>
            </Dialog.Close>
          </div>

          <div className="mt-3 flex items-center gap-2 rounded-xl bg-muted/40 px-3">
            <Search className="h-4 w-4 text-muted-fg" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runFirst();
                }
              }}
              placeholder="Type a command..."
              className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-fg"
              autoFocus
            />
            <Kbd className="hidden sm:inline-flex">Enter</Kbd>
          </div>

          <div className="mt-3 max-h-[45vh] overflow-auto rounded-xl bg-muted/20">
            {filtered.length === 0 ? (
              <div className="p-4 text-sm text-muted-fg">No matches.</div>
            ) : (
              <ul className="divide-y divide-border/15">
                {filtered.map((cmd) => (
                  <li key={cmd.id}>
                    <button
                      className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left text-sm hover:bg-muted/40 transition-colors"
                      onClick={() => {
                        Promise.resolve(cmd.run()).finally(() => {
                          onOpenChange(false);
                          setQ("");
                        });
                      }}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium">{cmd.title}</div>
                        {cmd.hint ? <div className="truncate text-xs text-muted-fg">{cmd.hint}</div> : null}
                      </div>
                      <div className="flex items-center gap-2 text-muted-fg">
                        {cmd.shortcut ? <span className="hidden sm:inline text-xs">{cmd.shortcut}</span> : null}
                        <ArrowRight className="h-4 w-4" />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
