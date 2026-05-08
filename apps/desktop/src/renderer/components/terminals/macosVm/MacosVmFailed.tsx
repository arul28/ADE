import { useCallback, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, FolderOpen, SpinnerGap, Trash, WarningCircle } from "@phosphor-icons/react";
import type { MacosVmRecord } from "../../../../shared/types";

type Props = {
  vm: MacosVmRecord;
  onRetryStart: () => Promise<void>;
  onResetToSnapshot: () => Promise<void>;
  onDelete: () => Promise<void>;
};

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

export function MacosVmFailed({ vm, onRetryStart, onResetToSnapshot, onDelete }: Props) {
  const [busy, setBusy] = useState<"retry" | "reset" | "delete" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const exec = useCallback(
    async (kind: Exclude<typeof busy, null>, fn: () => Promise<void>) => {
      setBusy(kind);
      setActionError(null);
      try {
        await fn();
      } catch (err) {
        console.error(`macOS VM ${kind} failed`, err);
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const helperExit = typeof vm.metadata.helperExitCode === "number" ? vm.metadata.helperExitCode : null;
  const bundlePath = typeof vm.metadata.bundlePath === "string" ? vm.metadata.bundlePath : null;
  const lastEventAt = typeof vm.metadata.lastEventAt === "string" ? vm.metadata.lastEventAt : vm.updatedAt;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-1 text-[12px] text-fg/85">
      <div className="rounded-lg border border-rose-400/25 bg-rose-500/[0.06] p-4">
        <div className="flex items-start gap-3">
          <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-rose-200/90" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-rose-50/95">VM failed to start</div>
            <div className="mt-1 break-words text-[12px] leading-5 text-rose-50/80">
              {vm.lastError || "The VM helper exited unexpectedly."}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-md border border-white/[0.08] bg-white/[0.025] p-3">
        <div className="text-[11px] font-medium text-fg/85">Diagnostics</div>
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-[11px] text-muted-fg/70">
          <div>
            <div className="text-muted-fg/45">Helper exit</div>
            <div className="text-fg/85">{helperExit ?? "—"}</div>
          </div>
          <div>
            <div className="text-muted-fg/45">Last event</div>
            <div className="text-fg/85">{formatTime(lastEventAt)}</div>
          </div>
          <div className="col-span-2">
            <div className="text-muted-fg/45">Bundle</div>
            <div className="truncate font-mono text-[10px] text-fg/85">{bundlePath ?? "—"}</div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px]"
          data-variant="default"
          onClick={() => void exec("retry", onRetryStart)}
          disabled={busy !== null}
          aria-label="Retry start"
        >
          {busy === "retry" ? <SpinnerGap size={12} className="animate-spin" /> : <ArrowClockwise size={12} />}
          Retry start
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px]"
          data-variant="ghost"
          onClick={() => {
            if (bundlePath) void window.ade.app.openPath(bundlePath);
          }}
          disabled={!bundlePath || busy !== null}
          aria-label="Open VM bundle in Finder"
        >
          <FolderOpen size={12} />
          Open bundle in Finder
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px]"
          data-variant="ghost"
          onClick={() => void exec("reset", onResetToSnapshot)}
          disabled={busy !== null}
          aria-label="Reset VM to snapshot"
        >
          {busy === "reset" ? <SpinnerGap size={12} className="animate-spin" /> : <ArrowSquareOut size={12} />}
          Reset to snapshot
        </button>
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px] text-rose-100/85"
          data-variant="ghost"
          onClick={() => {
            if (!window.confirm("Delete this lane's VM? Lane files are not removed.")) return;
            void exec("delete", onDelete);
          }}
          disabled={busy !== null}
          aria-label="Delete VM"
        >
          {busy === "delete" ? <SpinnerGap size={12} className="animate-spin" /> : <Trash size={12} />}
          Delete VM
        </button>
      </div>
      {actionError ? <div className="text-[11px] text-rose-200/85" role="alert">{actionError}</div> : null}
    </div>
  );
}
