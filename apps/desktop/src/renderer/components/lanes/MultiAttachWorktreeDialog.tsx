import { useEffect, useRef, useState } from "react";
import { Link, WarningCircle, CircleNotch, TextAlignLeft, Warning } from "@phosphor-icons/react";
import type { UnregisteredLaneCandidate } from "../../../shared/types/lanes";
import { Button } from "../ui/Button";
import { LaneDialogShell } from "./LaneDialogShell";
import { SECTION_CLASS_NAME } from "./laneDialogTokens";

export function MultiAttachWorktreeDialog({
  open,
  onOpenChange,
  onFallbackToManual,
  onComplete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onFallbackToManual: () => void;
  onComplete: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [worktrees, setWorktrees] = useState<UnregisteredLaneCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const [moveToAde, setMoveToAde] = useState(false);
  const [moveConfirmOpen, setMoveConfirmOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    setSelected(new Set());
    setErrors([]);
    setProgress({ current: 0, total: 0 });
    setMoveToAde(false);
    setMoveConfirmOpen(false);
    window.ade.lanes
      .listUnregisteredWorktrees()
      .then((result) => {
        if (cancelled) return;
        setWorktrees(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const allSelected = selected.size === worktrees.length && worktrees.length > 0;
  const someSelected = selected.size > 0 && selected.size < worktrees.length;

  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected]);

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(worktrees.map((wt) => wt.path)));
  };

  const toggleOne = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleAttach = async () => {
    const toAttach = worktrees.filter((wt) => selected.has(wt.path));
    if (toAttach.length === 0) return;
    setAttaching(true);
    setErrors([]);
    const collectedErrors: string[] = [];
    for (let i = 0; i < toAttach.length; i++) {
      const wt = toAttach[i]!;
      setProgress({ current: i + 1, total: toAttach.length });
      try {
        const name = wt.branch || wt.path.split("/").pop() || "worktree";
        const lane = await window.ade.lanes.attach({ name, attachedPath: wt.path });
        if (moveToAde) {
          await window.ade.lanes.adoptAttached({ laneId: lane.id });
        }
      } catch (err) {
        collectedErrors.push(
          `${wt.branch || wt.path}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    setErrors(collectedErrors);
    setAttaching(false);
    if (collectedErrors.length === 0) {
      onComplete();
      onOpenChange(false);
    } else {
      // Partial success — refresh the list to remove successfully attached items,
      // then pre-select the ones that failed so the user can retry them.
      const failedPaths = new Set(
        toAttach
          .filter((wt) => {
            const prefix = wt.branch || wt.path;
            return collectedErrors.some((e) => e.startsWith(prefix + ":"));
          })
          .map((wt) => wt.path)
      );
      onComplete();
      try {
        const refreshed = await window.ade.lanes.listUnregisteredWorktrees();
        setWorktrees(refreshed);
        setSelected(new Set(refreshed.filter((wt) => failedPaths.has(wt.path)).map((wt) => wt.path)));
      } catch {
        // non-fatal
      }
    }
  };

  const busy = loading || attaching;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Add existing worktrees as lanes"
      description="Select worktrees to track as lanes in this project."
      icon={Link}
      widthClassName="w-[min(760px,calc(100vw-24px))]"
      busy={busy}
    >
      <div className="space-y-4">
        {loading ? (
          <section className={SECTION_CLASS_NAME}>
            <div className="flex items-center gap-3 py-6 justify-center text-sm text-muted-fg">
              <CircleNotch size={16} className="animate-spin" />
              <span>Discovering worktrees...</span>
            </div>
          </section>
        ) : fetchError ? (
          <section className={SECTION_CLASS_NAME}>
            <div className="flex items-start gap-2 text-sm text-red-200">
              <WarningCircle size={16} className="mt-0.5 shrink-0" />
              <span>{fetchError}</span>
            </div>
          </section>
        ) : worktrees.length === 0 ? (
          <section className={SECTION_CLASS_NAME}>
            <div className="py-6 text-center">
              <div className="text-sm text-muted-fg">
                All worktrees are already tracked as lanes.
              </div>
              <button
                type="button"
                className="mt-3 text-xs text-accent hover:text-accent/80 transition-colors"
                onClick={() => {
                  onOpenChange(false);
                  onFallbackToManual();
                }}
              >
                Attach from a custom path instead
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className={SECTION_CLASS_NAME}>
              <div className="flex items-center justify-between mb-3">
                <label className="flex items-center gap-2 text-xs text-muted-fg cursor-pointer select-none">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={attaching}
                  />
                  Select all
                </label>
                <span className="text-xs text-muted-fg/70">
                  {worktrees.length} worktree{worktrees.length !== 1 ? "s" : ""} found
                </span>
              </div>

              <div className="max-h-[320px] overflow-y-auto space-y-1">
                {worktrees.map((wt) => (
                  <label
                    key={wt.path}
                    className="flex items-start gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors hover:bg-white/[0.04]"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.has(wt.path)}
                      onChange={() => toggleOne(wt.path)}
                      disabled={attaching}
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-fg truncate">
                        {wt.branch || "(detached HEAD)"}
                      </div>
                      <div className="text-xs font-mono text-muted-fg/70 truncate">
                        {wt.path}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </section>

            {/* Move to .ade/worktrees option */}
            <section className="rounded-xl border border-red-500/25 bg-red-500/[0.06] px-4 py-3">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-red-500"
                  checked={moveToAde}
                  onChange={() => {
                    if (!moveToAde) {
                      setMoveConfirmOpen(true);
                    } else {
                      setMoveToAde(false);
                    }
                  }}
                  disabled={attaching}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-semibold text-red-300">
                    <Warning size={14} weight="fill" />
                    Move into .ade/worktrees after import
                  </div>
                  <div className="mt-1 text-xs text-red-300/70 leading-relaxed">
                    Relocates each worktree from its current location into <code className="font-mono text-red-300/90">.ade/worktrees/</code> for
                    full ADE lifecycle management. This physically moves files on disk using <code className="font-mono text-red-300/90">git worktree move</code>.
                    Absolute paths, IDE project references, and terminal sessions pointing to the old location will break.
                  </div>
                </div>
              </label>
            </section>

            {attaching ? (
              <div className="flex items-center gap-2 text-xs text-muted-fg">
                <CircleNotch size={14} className="animate-spin" />
                <span>Attaching {progress.current} of {progress.total}{moveToAde ? " (+ moving)" : ""}...</span>
              </div>
            ) : null}
          </>
        )}

        {errors.length > 0 ? (
          <div className="space-y-1">
            {errors.map((err, i) => (
              <div key={i} className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">
                <WarningCircle size={16} className="mt-0.5 shrink-0" />
                <span>{err}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex items-center justify-between">
          <button
            type="button"
            className="text-xs text-muted-fg/70 hover:text-muted-fg transition-colors flex items-center gap-1.5"
            onClick={() => {
              onOpenChange(false);
              onFallbackToManual();
            }}
            disabled={busy}
          >
            <TextAlignLeft size={12} />
            Use manual form
          </button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            {worktrees.length > 0 ? (
              <Button
                variant="primary"
                disabled={selected.size === 0 || busy}
                onClick={handleAttach}
              >
                {attaching
                  ? `Attaching ${progress.current}/${progress.total}...`
                  : `Attach selected (${selected.size})`}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      {/* Confirmation modal for move-to-.ade */}
      {moveConfirmOpen ? (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60">
          <div className="w-[min(480px,100%)] rounded-2xl border border-red-500/30 bg-[#1a1a1a] p-5 shadow-2xl">
            <div className="flex items-center gap-2 text-sm font-bold text-red-400">
              <Warning size={18} weight="fill" />
              Confirm: Move worktrees into .ade
            </div>
            <div className="mt-3 space-y-2 text-xs text-neutral-300 leading-relaxed">
              <p>
                This will <strong className="text-red-300">physically relocate</strong> each selected worktree
                from its current directory into <code className="font-mono text-red-300/90">.ade/worktrees/</code>.
              </p>
              <p>The following may break after the move:</p>
              <ul className="list-disc pl-4 space-y-1 text-neutral-400">
                <li>Absolute paths in build configs, scripts, or CI pipelines</li>
                <li>IDE project files and workspace references</li>
                <li>Running terminal sessions or file watchers in the old path</li>
                <li>Symlinks or external tooling that reference the worktree location</li>
              </ul>
              <p>
                Git branch history and commits are <strong>not affected</strong> — only the on-disk location changes.
              </p>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button
                variant="outline"
                onClick={() => setMoveConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                className="!bg-red-600 hover:!bg-red-700 !border-red-600"
                onClick={() => {
                  setMoveToAde(true);
                  setMoveConfirmOpen(false);
                }}
              >
                I understand, enable move
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </LaneDialogShell>
  );
}
