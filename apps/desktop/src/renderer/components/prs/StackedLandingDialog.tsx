import React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle as CheckCircle2, XCircle, SpinnerGap as Loader2 } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";
import type { LandResult, MergeMethod } from "../../../shared/types";

type LandMode = "sequential" | "all-at-once";

export function StackedLandingDialog({
  open,
  onOpenChange,
  rootLaneId,
  rootLaneName,
  onRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rootLaneId: string;
  rootLaneName: string;
  onRefresh?: () => void;
}) {
  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>("squash");
  const [landMode, setLandMode] = React.useState<LandMode>("sequential");
  const [running, setRunning] = React.useState(false);
  const [results, setResults] = React.useState<LandResult[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Reset on close
  React.useEffect(() => {
    if (open) return;
    const id = setTimeout(() => {
      setRunning(false);
      setResults(null);
      setError(null);
    }, 200);
    return () => clearTimeout(id);
  }, [open]);

  const handleLand = async () => {
    setRunning(true);
    setResults(null);
    setError(null);
    try {
      if (landMode === "sequential") {
        const landResults = await window.ade.prs.landStack({ rootLaneId, method: mergeMethod });
        setResults(landResults);
      } else {
        const landResults = await window.ade.prs.landStackEnhanced({
          rootLaneId,
          method: mergeMethod,
          mode: "all-at-once",
        });
        setResults(landResults);
      }
      onRefresh?.();
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setRunning(false);
    }
  };

  const successCount = results?.filter((r) => r.success).length ?? 0;
  const failCount = results?.filter((r) => !r.success).length ?? 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/4 z-50 w-[min(480px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/4 rounded bg-card border border-border/40 p-3 shadow-float focus:outline-none">
          <Dialog.Title className="text-sm font-semibold text-fg">
            Land Stack: {rootLaneName}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-muted-fg">
            Merge all PRs in this stack into their base branches.
          </Dialog.Description>

          <div className="mt-4 space-y-4">
            {/* Merge method */}
            <div>
              <label className="mb-1 block text-xs font-medium text-fg">Merge Method</label>
              <div className="flex gap-2">
                {(["squash", "merge", "rebase"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMergeMethod(m)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                      mergeMethod === m
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border bg-card text-fg hover:bg-muted/50"
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* Landing mode */}
            <div>
              <label className="mb-1 block text-xs font-medium text-fg">Landing Mode</label>
              <div className="flex gap-2">
                {([
                  { id: "sequential" as const, label: "Sequential", desc: "Land PRs one by one, bottom to top" },
                  { id: "all-at-once" as const, label: "All at once", desc: "Land all PRs in parallel" },
                ]).map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setLandMode(opt.id)}
                    className={cn(
                      "flex-1 rounded-lg border px-3 py-2 text-left text-xs transition-colors",
                      landMode === opt.id
                        ? "border-accent bg-accent/10 ring-1 ring-accent/30"
                        : "border-border bg-card/50 hover:bg-card/70"
                    )}
                  >
                    <div className="font-medium text-fg">{opt.label}</div>
                    <div className="mt-0.5 text-[11px] text-muted-fg">{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Results */}
            {results && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs">
                  {successCount > 0 && (
                    <span className="flex items-center gap-1 text-emerald-600">
                      <CheckCircle2 size={14} weight="regular" />
                      {successCount} landed
                    </span>
                  )}
                  {failCount > 0 && (
                    <span className="flex items-center gap-1 text-red-600">
                      <XCircle size={14} weight="regular" />
                      {failCount} failed
                    </span>
                  )}
                </div>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-card/50 p-2 space-y-1">
                  {results.map((r, i) => (
                    <div
                      key={i}
                      className={cn(
                        "flex items-center gap-2 rounded px-2 py-1 text-xs",
                        r.success ? "text-emerald-600" : "text-red-600"
                      )}
                    >
                      {r.success ? <CheckCircle2 size={12} weight="regular" /> : <XCircle size={12} weight="regular" />}
                      <span className="truncate">#{r.prNumber}</span>
                      {r.error && <span className="ml-auto text-[11px] text-red-500">{r.error}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <div className="rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-700">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Dialog.Close asChild>
                <Button size="sm" variant="outline">{results ? "Close" : "Cancel"}</Button>
              </Dialog.Close>
              {!results && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={running}
                  onClick={() => void handleLand()}
                >
                  {running ? (
                    <span className="flex items-center gap-2">
                      <Loader2 size={14} weight="regular" className="animate-spin" />
                      Landing...
                    </span>
                  ) : (
                    "Land Stack"
                  )}
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
