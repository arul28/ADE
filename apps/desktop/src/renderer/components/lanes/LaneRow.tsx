import React, { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Archive, ExternalLink, GitBranch, Pencil, TerminalSquare } from "lucide-react";
import type { LaneSummary } from "../../../shared/types";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import { useNavigate } from "react-router-dom";
import { useAppStore } from "../../state/appStore";

export function LaneRow({
  lane,
  selected,
  onSelect
}: {
  lane: LaneSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const navigate = useNavigate();
  const focusSession = useAppStore((s) => s.focusSession);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const [renameOpen, setRenameOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [draftName, setDraftName] = useState(lane.name);

  return (
    <div
      className={cn(
        "group relative flex flex-col gap-1 rounded-sm border border-border bg-card p-3 transition-all hover:border-muted-fg/40",
        selected && "border-accent ring-1 ring-accent bg-accent/5"
      )}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect();
      }}
    >
      {/* Header: Title + Primary Actions */}
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <GitBranch className={cn("h-3.5 w-3.5", selected ? "text-accent" : "text-muted-fg")} />
            <span className="font-serif text-base font-semibold tracking-tight text-fg truncate">
              {lane.name}
            </span>
          </div>
          {lane.description && (
            <div className="mt-0.5 pl-6 text-xs text-muted-fg truncate font-mono opacity-80">
              {lane.description}
            </div>
          )}
        </div>

        {/* Actions - Visible on Hover/Select */}
        <div className={cn("flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100", selected && "opacity-100")}>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:text-accent"
            title="New terminal"
            onClick={(e) => {
              e.stopPropagation();
              window.ade.pty
                .create({ laneId: lane.id, cols: 100, rows: 30, title: "Shell" })
                .then(({ sessionId }) => {
                  focusSession(sessionId);
                  navigate(`/lanes?laneId=${encodeURIComponent(lane.id)}&sessionId=${encodeURIComponent(sessionId)}`);
                })
                .catch(() => { });
            }}
          >
            <TerminalSquare className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:text-accent"
            title="Open folder"
            onClick={(e) => {
              e.stopPropagation();
              window.ade.lanes.openFolder({ laneId: lane.id }).catch(() => { });
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>

          <Dialog.Root
            open={renameOpen}
            onOpenChange={(v) => {
              setRenameOpen(v);
              if (v) setDraftName(lane.name);
            }}
          >
            <Dialog.Trigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 hover:text-accent"
                title="Rename lane"
                onClick={(e) => e.stopPropagation()}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </Dialog.Trigger>
            {/* ... Modal content omitted for brevity, logic remains same ... */}
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" />
              <Dialog.Content className="fixed z-50 left-1/2 top-[22%] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-none border border-fg bg-bg p-4 shadow-2xl focus:outline-none">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <Dialog.Title className="text-lg font-serif font-bold">Rename Lane</Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="sm">Esc</Button>
                  </Dialog.Close>
                </div>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-mono uppercase text-muted-fg mb-1">Name</label>
                    <input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      className="block w-full border-b border-border bg-transparent py-1 text-lg font-serif focus:border-accent focus:outline-none"
                      autoFocus
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="outline" onClick={() => setRenameOpen(false)}>Cancel</Button>
                    <Button
                      variant="primary"
                      disabled={!draftName.trim().length || draftName.trim() === lane.name}
                      onClick={() => {
                        window.ade.lanes
                          .rename({ laneId: lane.id, name: draftName.trim() })
                          .then(async () => {
                            await refreshLanes();
                            setRenameOpen(false);
                          })
                          .catch(() => { });
                      }}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          <Dialog.Root open={archiveOpen} onOpenChange={setArchiveOpen}>
            <Dialog.Trigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 hover:text-accent"
                title="Archive lane"
                onClick={(e) => e.stopPropagation()}
              >
                <Archive className="h-3.5 w-3.5" />
              </Button>
            </Dialog.Trigger>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50" />
              <Dialog.Content className="fixed z-50 left-1/2 top-[22%] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded-none border border-fg bg-bg p-4 shadow-2xl focus:outline-none">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <Dialog.Title className="text-lg font-serif font-bold">Archive Lane</Dialog.Title>
                  <Dialog.Close asChild>
                    <Button variant="ghost" size="sm">Esc</Button>
                  </Dialog.Close>
                </div>
                <div className="mb-6 font-mono text-sm text-muted-fg">
                  Are you sure? This will hide the lane from the list.
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={() => setArchiveOpen(false)}>Cancel</Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      window.ade.lanes
                        .archive({ laneId: lane.id })
                        .then(async () => {
                          await refreshLanes();
                          setArchiveOpen(false);
                        })
                        .catch(() => { });
                    }}
                  >
                    Confirm Archive
                  </Button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </div>
      </div>

      {/* Footer: High Density Status Stats */}
      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border pt-2 text-[10px] font-mono uppercase tracking-wider text-muted-fg">
        <div className="flex flex-col">
          <span className="opacity-50">Sync</span>
          <span className={cn("font-bold", (lane.status.ahead > 0 || lane.status.behind > 0) ? "text-accent" : "text-fg")}>
            {lane.status.ahead}↑ {lane.status.behind}↓
          </span>
        </div>
        <div className="flex flex-col border-l border-border pl-2">
          <span className="opacity-50">State</span>
          <span className={cn("font-bold", lane.status.dirty ? "text-accent" : "text-fg")}>
            {lane.status.dirty ? "DIRTY" : "CLEAN"}
          </span>
        </div>
        <div className="flex flex-col border-l border-border pl-2">
          <span className="opacity-50">Last Active</span>
          <span className="text-fg">Just now</span>
        </div>
      </div>
    </div>
  );
}
