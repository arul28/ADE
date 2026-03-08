import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "../ui/Button";
import type { LaneSummary, LaneEnvInitProgress } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";
import { LaneEnvInitProgressPanel } from "./LaneEnvInitProgress";

export function CreateLaneDialog({
  open,
  onOpenChange,
  createLaneName,
  setCreateLaneName,
  createAsChild,
  setCreateAsChild,
  createParentLaneId,
  setCreateParentLaneId,
  createBaseBranch,
  setCreateBaseBranch,
  createBranches,
  lanes,
  onSubmit,
  busy,
  error,
  envInitProgress
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  createLaneName: string;
  setCreateLaneName: (v: string) => void;
  createAsChild: boolean;
  setCreateAsChild: (v: boolean) => void;
  createParentLaneId: string;
  setCreateParentLaneId: (v: string) => void;
  createBaseBranch: string;
  setCreateBaseBranch: (v: string) => void;
  createBranches: LaneBranchOption[];
  lanes: LaneSummary[];
  onSubmit: () => void;
  busy?: boolean;
  error?: string | null;
  envInitProgress?: LaneEnvInitProgress | null;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/5 backdrop-blur-md" />
        <Dialog.Content className="fixed left-1/2 top-[18%] z-50 w-[min(560px,calc(100vw-24px))] -translate-x-1/2 rounded bg-bg border border-border/40 p-3 shadow-float focus:outline-none">
          <div className="flex items-center justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold">Create lane</Dialog.Title>
            <Dialog.Close asChild><Button variant="ghost" size="sm" disabled={busy}>Esc</Button></Dialog.Close>
          </div>
          <div className="mt-3 space-y-3">
            <div>
              <div className="text-xs text-muted-fg">Name</div>
              <input
                value={createLaneName}
                onChange={(e) => setCreateLaneName(e.target.value)}
                placeholder="e.g. feature/auth-refresh"
                className="mt-1 h-10 w-full rounded border border-border/15 bg-surface-recessed shadow-card px-3 text-sm outline-none placeholder:text-muted-fg"
                autoFocus
                disabled={busy}
              />
            </div>
            <label className="flex items-center gap-2 rounded border border-border/10 bg-card/60 px-3 py-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={createAsChild}
                onChange={(e) => {
                  setCreateAsChild(e.target.checked);
                  if (!e.target.checked) setCreateParentLaneId("");
                }}
                disabled={busy}
              />
              <span className="text-muted-fg">Create as child of another lane</span>
            </label>
            {createAsChild ? (
              <div className="space-y-1">
                <div className="text-xs text-muted-fg">Parent lane</div>
                <select
                  value={createParentLaneId}
                  onChange={(event) => setCreateParentLaneId(event.target.value)}
                  className="h-10 w-full rounded border border-border/15 bg-surface-recessed shadow-card px-3 text-sm outline-none"
                  disabled={busy}
                >
                  <option value="">Select a parent lane...</option>
                  {lanes.map((lane) => (
                    <option key={lane.id} value={lane.id}>{lane.name} ({lane.branchRef})</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-1">
                <div className="text-xs text-muted-fg">Base branch on primary</div>
                <select
                  value={createBaseBranch}
                  onChange={(event) => setCreateBaseBranch(event.target.value)}
                  className="h-10 w-full rounded border border-border/15 bg-surface-recessed shadow-card px-3 text-sm outline-none"
                  disabled={busy}
                >
                  {createBranches.filter((b) => !b.isRemote).map((branch) => (
                    <option key={branch.name} value={branch.name}>
                      {branch.name}{branch.isCurrent ? " (current)" : ""}
                    </option>
                  ))}
                </select>
                <div className="text-[11px] text-muted-fg/70 px-1">
                  Lane will be created from primary/{createBaseBranch || "..."}
                </div>
              </div>
            )}
          </div>
          {error && (
            <div className="mt-3 rounded border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => { onOpenChange(false); setCreateLaneName(""); setCreateParentLaneId(""); setCreateAsChild(false); setCreateBaseBranch(""); }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy || !createLaneName.trim().length || (createAsChild && !createParentLaneId)}
              onClick={onSubmit}
            >
              {busy
                ? "Setting up lane..."
                : createAsChild && createParentLaneId
                  ? "Create child lane"
                  : `Create from ${createBaseBranch || "primary"}`}
            </Button>
          </div>
          {envInitProgress && <LaneEnvInitProgressPanel progress={envInitProgress} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
