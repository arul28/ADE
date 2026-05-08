import { useCallback, useState } from "react";
import { ArrowsClockwise, Copy, Cpu, SpinnerGap, Stop } from "@phosphor-icons/react";
import type { MacosVmRecord } from "../../../../shared/types";

type Props = {
  vm: MacosVmRecord;
  onCancel: () => Promise<void>;
};

function formatPercent(progress: number | null | undefined): string {
  if (progress == null) return "";
  const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
  return `${pct}%`;
}

function clampWidth(progress: number | null | undefined): string {
  if (progress == null) return "8%";
  const pct = Math.max(2, Math.min(100, progress * 100));
  return `${pct}%`;
}

export function MacosVmProvisioning({ vm, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const stage = vm.state === "installing" ? "Installing macOS VM" : "Creating VM";
  const message = typeof vm.metadata.provisionMessage === "string" ? vm.metadata.provisionMessage : null;
  const progress = typeof vm.metadata.provisionProgress === "number" ? vm.metadata.provisionProgress : null;
  const eta = typeof vm.metadata.provisionEta === "string" ? vm.metadata.provisionEta : null;
  const sourcePath = typeof vm.metadata.provisionSource === "string" ? vm.metadata.provisionSource : null;
  const targetPath = typeof vm.metadata.bundlePath === "string" ? vm.metadata.bundlePath : null;

  const cancel = useCallback(async () => {
    if (!window.confirm("Cancel provisioning? The partial VM will be deleted.")) return;
    setCancelError(null);
    setBusy(true);
    try {
      await onCancel();
    } catch (err) {
      console.error("Failed to cancel macOS VM provisioning", err);
      const message = err instanceof Error ? err.message : String(err);
      setCancelError(`Failed to cancel macOS VM provisioning: ${message}`);
    } finally {
      setBusy(false);
    }
  }, [onCancel]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 text-[12px] text-fg/85">
      <div className="rounded-lg border border-amber-400/25 bg-amber-500/[0.06] p-4">
        <div className="flex items-center gap-3">
          <ArrowsClockwise size={20} className="shrink-0 animate-spin text-amber-200/90" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-amber-50/95">{stage}</div>
            <div className="mt-0.5 truncate text-[11px] text-amber-50/80">
              {message ?? "Preparing the bundle. This can take a few minutes on first install."}
            </div>
          </div>
          {progress != null ? (
            <div className="ml-auto shrink-0 text-right">
              <div className="text-sm font-medium tabular-nums text-amber-50/95">{formatPercent(progress)}</div>
              {eta ? <div className="text-[10px] uppercase tracking-wide text-amber-50/65">{eta}</div> : null}
            </div>
          ) : null}
        </div>

        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-black/30">
          <div
            className="h-full rounded-full bg-amber-300/85 transition-[width] duration-500"
            style={{ width: clampWidth(progress) }}
            role="progressbar"
            aria-valuenow={progress != null ? Math.round(progress * 100) : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Provisioning progress"
          />
        </div>
      </div>

      <div className="rounded-md border border-white/[0.08] bg-white/[0.025] p-3 text-[11px] text-muted-fg/70">
        <div className="flex items-center gap-2 text-fg/85">
          <Cpu size={13} />
          <span className="font-medium">Resources</span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-2">
          <div>
            <div className="text-muted-fg/45">CPU</div>
            <div className="text-fg/85">{vm.cpuCores}</div>
          </div>
          <div>
            <div className="text-muted-fg/45">Memory</div>
            <div className="text-fg/85">{vm.memory}</div>
          </div>
          <div>
            <div className="text-muted-fg/45">Disk max</div>
            <div className="text-fg/85">{vm.diskSize}</div>
          </div>
        </div>
      </div>

      {sourcePath || targetPath ? (
        <div className="rounded-md border border-white/[0.08] bg-white/[0.025] p-3 text-[11px] text-muted-fg/70">
          <div className="flex items-center gap-2 text-fg/85">
            <Copy size={13} />
            <span className="font-medium">Cloning bundle</span>
            <span className="ml-auto rounded-full border border-emerald-300/20 bg-emerald-400/[0.06] px-2 py-0.5 text-[10px] text-emerald-100/85">
              copy-on-write
            </span>
          </div>
          {sourcePath ? (
            <div className="mt-2">
              <div className="text-muted-fg/45">From</div>
              <div className="truncate font-mono text-[10px] text-fg/85">{sourcePath}</div>
            </div>
          ) : null}
          {targetPath ? (
            <div className="mt-2">
              <div className="text-muted-fg/45">To</div>
              <div className="truncate font-mono text-[10px] text-fg/85">{targetPath}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {cancelError ? (
        <div className="rounded-md border border-red-400/25 bg-red-500/[0.06] px-3 py-2 text-[11px] text-red-100/90" role="alert">
          {cancelError}
        </div>
      ) : null}

      <div>
        <button
          type="button"
          className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px]"
          data-variant="ghost"
          onClick={() => void cancel()}
          disabled={busy}
          aria-label="Cancel provisioning"
        >
          {busy ? <SpinnerGap size={12} className="animate-spin" /> : <Stop size={12} />}
          Cancel
        </button>
      </div>
    </div>
  );
}
