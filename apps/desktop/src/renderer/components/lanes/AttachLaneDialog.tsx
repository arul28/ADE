import { Link, WarningCircle } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { LaneDialogShell } from "./LaneDialogShell";
import { SECTION_CLASS_NAME, LABEL_CLASS_NAME, INPUT_CLASS_NAME } from "./laneDialogTokens";

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
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Add existing worktree as lane"
      description="Link an existing git worktree into ADE without moving files. The path must point at a worktree root from this repository."
      icon={Link}
      widthClassName="w-[min(760px,calc(100vw-24px))]"
      busy={busy}
    >
      <div className="space-y-4">
        <section className={SECTION_CLASS_NAME}>
          <div className="text-sm text-muted-fg">
            ADE will keep the existing files where they are and start tracking the worktree as a lane in this project.
          </div>
        </section>

        <section className={SECTION_CLASS_NAME}>
          <label className="block">
            <span className={LABEL_CLASS_NAME}>Lane name</span>
            <input
              value={attachName}
              onChange={(event) => setAttachName(event.target.value)}
              placeholder="e.g. bugfix/from-other-worktree"
              className={INPUT_CLASS_NAME}
              autoFocus
              disabled={busy}
            />
          </label>
        </section>

        <section className={SECTION_CLASS_NAME}>
          <label className="block">
            <span className={LABEL_CLASS_NAME}>Worktree path</span>
            <input
              value={attachPath}
              onChange={(event) => setAttachPath(event.target.value)}
              placeholder="/absolute/path/to/existing/worktree"
              className={`${INPUT_CLASS_NAME} font-mono text-xs`}
              disabled={busy}
            />
          </label>
          <p className="text-xs text-white/40 mt-1">
            Enter the absolute path to an existing Git worktree directory.
          </p>
          <div className="mt-1.5 text-xs text-muted-fg/80">
            Example: <span className="font-mono text-fg/80">/Users/you/repo-worktrees/feature-auth</span>
          </div>
        </section>

        {error ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
            <WarningCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              setAttachName("");
              setAttachPath("");
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!attachPath.trim() || !attachName.trim() || busy}
            onClick={onSubmit}
          >
            {busy ? "Attaching..." : "Attach lane"}
          </Button>
        </div>
      </div>
    </LaneDialogShell>
  );
}
