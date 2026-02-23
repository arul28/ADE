import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../ui/Button";

export function AttachLaneDialog({
  open,
  onOpenChange,
  attachName,
  setAttachName,
  attachPath,
  setAttachPath,
  onSubmit
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attachName: string;
  setAttachName: (v: string) => void;
  attachPath: string;
  setAttachPath: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 rounded bg-bg border border-border/40 p-3 shadow-float focus:outline-none">
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold">Attach lane</Dialog.Title>
            <Dialog.Close asChild><Button variant="ghost" size="sm">Esc</Button></Dialog.Close>
          </div>
          <div className="mt-3 space-y-2">
            <div>
              <div className="mb-1 text-xs text-muted-fg">Lane name</div>
              <input value={attachName} onChange={(e) => setAttachName(e.target.value)} placeholder="e.g. bugfix/from-other-worktree" className="h-10 w-full rounded border border-border/15 bg-surface-recessed shadow-card px-3 text-sm outline-none placeholder:text-muted-fg" autoFocus />
            </div>
            <div>
              <div className="mb-1 text-xs text-muted-fg">Attached path</div>
              <input value={attachPath} onChange={(e) => setAttachPath(e.target.value)} placeholder="/absolute/path/to/existing/worktree" className="h-10 w-full rounded border border-border/15 bg-surface-recessed shadow-card px-3 font-mono text-xs outline-none placeholder:text-muted-fg" />
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => { onOpenChange(false); setAttachName(""); setAttachPath(""); }}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!attachPath.trim().length || !attachName.trim().length}
              onClick={onSubmit}
            >
              Attach
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
