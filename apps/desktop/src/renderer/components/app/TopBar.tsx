import React, { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Link2, Moon, Play, Plus, Search, Sun } from "lucide-react";
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
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const navigate = useNavigate();

  const [createOpen, setCreateOpen] = useState(false);
  const [laneName, setLaneName] = useState("");
  const [parentLaneId, setParentLaneId] = useState<string>("");
  const [attachOpen, setAttachOpen] = useState(false);
  const [attachName, setAttachName] = useState("");
  const [attachPath, setAttachPath] = useState("");

  const canCreateLane = Boolean(project?.rootPath);
  const canStartTerminal = Boolean(selectedLaneId);

  const selectedLaneName = useMemo(
    () => lanes.find((l) => l.id === selectedLaneId)?.name ?? null,
    [lanes, selectedLaneId]
  );
  const selectableParentLanes = useMemo(() => lanes, [lanes]);

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
        <Button variant="ghost" onClick={toggleTheme} title="Toggle theme">
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          <span className="hidden sm:inline">{theme === "dark" ? "Light" : "Dark"}</span>
        </Button>
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
                <div className="space-y-1">
                  <div className="text-xs text-muted-fg">Parent lane (optional)</div>
                  <select
                    value={parentLaneId}
                    onChange={(event) => setParentLaneId(event.target.value)}
                    className="h-10 w-full rounded-lg border border-border bg-card/70 px-3 text-sm outline-none"
                  >
                    <option value="">None (base: {baseRef ?? "main"})</option>
                    {selectableParentLanes.map((lane) => (
                      <option key={lane.id} value={lane.id}>
                        {lane.name} ({lane.branchRef})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setCreateOpen(false);
                    setLaneName("");
                    setParentLaneId("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!laneName.trim().length}
                  onClick={() => {
                    const name = laneName.trim();
                    const selectedParentLaneId = parentLaneId || null;
                    const createPromise = selectedParentLaneId
                      ? window.ade.lanes.createChild({ name, parentLaneId: selectedParentLaneId })
                      : window.ade.lanes.create({ name });
                    createPromise
                      .then(async (lane) => {
                        await refreshLanes();
                        setCreateOpen(false);
                        setLaneName("");
                        setParentLaneId("");
                        navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
                      })
                      .catch(() => {
                        // Non-fatal; lane creation can fail if git/worktree commands fail.
                      });
                  }}
                >
                  {parentLaneId ? "Create child lane" : "Create"}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <Dialog.Root open={attachOpen} onOpenChange={setAttachOpen}>
          <Dialog.Trigger asChild>
            <Button variant="outline" disabled={!canCreateLane} title={canCreateLane ? "Attach existing lane" : "Open a repo first"}>
              <Link2 className="h-4 w-4" />
              <span className="hidden sm:inline">Attach</span>
            </Button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm" />
            <Dialog.Content
              className={cn(
                "fixed left-1/2 top-[18%] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 rounded-xl border border-border bg-card/90 p-3 shadow-2xl backdrop-blur",
                "focus:outline-none"
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <Dialog.Title className="text-sm font-semibold">Attach lane</Dialog.Title>
                <Dialog.Close asChild>
                  <Button variant="ghost" size="sm">
                    Esc
                  </Button>
                </Dialog.Close>
              </div>

              <div className="mt-3 space-y-2">
                <div>
                  <div className="mb-1 text-xs text-muted-fg">Lane name</div>
                  <input
                    value={attachName}
                    onChange={(e) => setAttachName(e.target.value)}
                    placeholder="e.g. bugfix/from-other-worktree"
                    className="h-10 w-full rounded-lg border border-border bg-card/70 px-3 text-sm outline-none placeholder:text-muted-fg"
                    autoFocus
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-fg">Attached path</div>
                  <input
                    value={attachPath}
                    onChange={(e) => setAttachPath(e.target.value)}
                    placeholder="/absolute/path/to/existing/worktree"
                    className="h-10 w-full rounded-lg border border-border bg-card/70 px-3 font-mono text-xs outline-none placeholder:text-muted-fg"
                  />
                </div>
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setAttachOpen(false);
                    setAttachName("");
                    setAttachPath("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={!attachPath.trim().length || !attachName.trim().length}
                  onClick={() => {
                    const name = attachName.trim();
                    const attachedPath = attachPath.trim();
                    window.ade.lanes
                      .attach({ name, attachedPath })
                      .then(async (lane) => {
                        await refreshLanes();
                        setAttachOpen(false);
                        setAttachName("");
                        setAttachPath("");
                        navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}`);
                      })
                      .catch(() => {
                        // lane attach can fail due to invalid path/repo mismatch
                      });
                  }}
                >
                  Attach
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
        <Button
          variant="outline"
          disabled={!canStartTerminal}
          title={canStartTerminal ? `Start untracked terminal in ${selectedLaneName ?? "lane"}` : "Select a lane first"}
          onClick={() => {
            if (!selectedLaneId) return;
            window.ade.pty
              .create({ laneId: selectedLaneId, cols: 100, rows: 30, title: "Untracked Shell", tracked: false })
              .then(({ sessionId }) => {
                focusSession(sessionId);
                navigate(`/lanes?laneId=${encodeURIComponent(selectedLaneId)}&sessionId=${encodeURIComponent(sessionId)}`);
              })
              .catch(() => {});
          }}
        >
          <span className="hidden sm:inline">Untracked</span>
        </Button>
      </div>
    </header>
  );
}
