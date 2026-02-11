import React, { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Play, Plus, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { ProjectSelector } from "./ProjectSelector";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";

export function TopBar({
  onOpenCommandPalette,
  commandHint
}: {
  onOpenCommandPalette: () => void;
  commandHint: React.ReactNode;
}) {
  const baseRef = useAppStore((s) => s.project?.baseRef);
  const project = useAppStore((s) => s.project);
  const lanes = useAppStore((s) => s.lanes);
  const selectedLaneId = useAppStore((s) => s.selectedLaneId);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const focusSession = useAppStore((s) => s.focusSession);
  const navigate = useNavigate();

  const [createOpen, setCreateOpen] = useState(false);
  const [laneName, setLaneName] = useState("");

  const canCreateLane = Boolean(project?.rootPath);
  const canStartTerminal = Boolean(selectedLaneId);

  const selectedLaneName = useMemo(
    () => lanes.find((l) => l.id === selectedLaneId)?.name ?? null,
    [lanes, selectedLaneId]
  );

  return (
    <header className="flex h-[52px] items-center justify-between border-b border-border bg-card/60 px-3 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex items-baseline gap-2">
          <div className="text-sm font-semibold tracking-tight">ADE</div>
          <div className="text-xs text-muted-fg">MVP scaffold</div>
        </div>

        <div className="h-5 w-px bg-border" />

        <ProjectSelector />

        <Chip className="hidden sm:inline-flex">base: {baseRef ?? "?"}</Chip>
        <Chip className="hidden md:inline-flex">sync: idle</Chip>
        <Chip className="hidden md:inline-flex">jobs: 0</Chip>
        <Chip className="hidden md:inline-flex">procs: 0</Chip>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={onOpenCommandPalette} title="Command palette">
          <Search className="h-4 w-4" />
          <span className="hidden sm:inline">Commands</span>
          <span className="hidden md:inline text-xs text-muted-fg">{commandHint}</span>
        </Button>
        <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
          <Dialog.Trigger asChild>
            <Button variant="outline" disabled={!canCreateLane} title={canCreateLane ? "Create lane" : "Open a repo first"}>
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">Lane</span>
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
            <Dialog.Content
              className={cn(
                "fixed left-1/2 top-[18%] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-xl border border-border bg-card/90 p-3 shadow-2xl backdrop-blur",
                "focus:outline-none"
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <Dialog.Title className="text-sm font-semibold">Create lane</Dialog.Title>
                <Dialog.Close asChild>
                  <Button variant="ghost" size="sm">
                    Esc
                  </Button>
                </Dialog.Close>
              </div>

              <div className="mt-3 space-y-2">
                <div className="text-xs text-muted-fg">Name</div>
                <input
                  value={laneName}
                  onChange={(e) => setLaneName(e.target.value)}
                  placeholder="e.g. feature/auth-refresh"
                  className="h-10 w-full rounded-lg border border-border bg-card/70 px-3 text-sm outline-none placeholder:text-muted-fg"
                  autoFocus
                />
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreateOpen(false);
                    setLaneName("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!laneName.trim().length}
                  onClick={() => {
                    const name = laneName.trim();
                    window.ade.lanes
                      .create({ name })
                      .then(async (lane) => {
                        await refreshLanes();
                        setCreateOpen(false);
                        setLaneName("");
                        navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
                      })
                      .catch(() => {
                        // Non-fatal; lane creation can fail if git/worktree commands fail.
                      });
                  }}
                >
                  Create
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <Button
          variant="primary"
          disabled={!canStartTerminal}
          title={canStartTerminal ? `Start terminal in ${selectedLaneName ?? "lane"}` : "Select a lane first"}
          onClick={() => {
            if (!selectedLaneId) return;
            window.ade.pty
              .create({ laneId: selectedLaneId, cols: 100, rows: 30, title: "Shell" })
              .then(({ sessionId }) => {
                focusSession(sessionId);
                navigate(`/lanes?laneId=${encodeURIComponent(selectedLaneId)}&sessionId=${encodeURIComponent(sessionId)}`);
              })
              .catch(() => {
                // Non-fatal; PTY creation can fail if native module isn't available.
              });
          }}
        >
          <Play className="h-4 w-4" />
          <span className="hidden sm:inline">Terminal</span>
        </Button>
      </div>
    </header>
  );
}
