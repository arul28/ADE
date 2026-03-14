import * as Dialog from "@radix-ui/react-dialog";
import { Link, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../ui/Button";

export function AttachLaneDialog({
  open,
  onOpenChange,
  attachName,
  setAttachName,
  attachPath,
  setAttachPath,
  busy,
  error,
  onSubmit
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attachName: string;
  setAttachName: (v: string) => void;
  attachPath: string;
  setAttachPath: (v: string) => void;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[14%] z-50 w-[min(700px,calc(100vw-24px))] -translate-x-1/2 rounded border border-border/40 bg-card p-4 shadow-float focus:outline-none">
          <div className="mb-3 flex items-center justify-between gap-3">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold">
              <Link size={16} />
              Attach Existing Worktree
            </Dialog.Title>
            <Dialog.Close asChild><Button variant="ghost" size="sm" disabled={busy}>Esc</Button></Dialog.Close>
          </div>
          <p className="text-xs text-muted-fg">
            Link an existing git worktree into ADE without moving files. The path must be the root of a worktree from this repository.
          </p>
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted-fg">Lane Name</label>
              <input
                value={attachName}
                onChange={(e) => setAttachName(e.target.value)}
                placeholder="e.g. bugfix/from-other-worktree"
                className="h-10 w-full rounded border border-border/20 bg-surface-recessed shadow-card px-3 text-sm outline-none placeholder:text-muted-fg"
                autoFocus
                disabled={busy}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold text-muted-fg">Worktree Path</label>
              <input
                value={attachPath}
                onChange={(e) => setAttachPath(e.target.value)}
                placeholder="/absolute/path/to/existing/worktree"
                className="h-10 w-full rounded border border-border/20 bg-surface-recessed px-3 font-mono text-xs outline-none placeholder:text-muted-fg"
                disabled={busy}
              />
              <p className="mt-1 text-[11px] text-muted-fg">
                Example: <span className="font-mono">/Users/you/repo-worktrees/feature-auth</span>
              </p>
            </div>
          </div>
          {error ? (
            <div className="mt-3 flex items-start gap-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              <WarningCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => { onOpenChange(false); setAttachName(""); setAttachPath(""); }}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!attachPath.trim().length || !attachName.trim().length || busy}
              onClick={onSubmit}
            >
              {busy ? "Attaching..." : "Attach Lane"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
