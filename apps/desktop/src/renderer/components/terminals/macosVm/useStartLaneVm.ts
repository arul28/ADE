import { useCallback, useEffect, useRef, useState } from "react";
import type { MacosVmRecord, MacosVmStatus } from "../../../../shared/types";

const RUNNING_STATES = new Set(["running", "starting", "installing", "creating"]);

export type StartLaneVmOptions = {
  laneId: string;
  baseName: string | null;
  cpuCores?: number;
  memory?: string;
  diskSize?: string;
  display?: string;
  openDisplay?: boolean;
};

export type StartLaneVmDialogState = {
  open: boolean;
  pendingCpuCores: number;
  pendingMemoryGb: number;
  runningVms: MacosVmRecord[];
};

export type UseStartLaneVmResult = {
  start: () => Promise<void>;
  starting: boolean;
  error: string | null;
  dialog: StartLaneVmDialogState;
  confirmStart: () => void;
  cancelStart: () => void;
};

function parseGb(value: string | undefined): number {
  if (!value) return 0;
  const match = /([\d.]+)\s*(gb|mb|g|m)?/i.exec(value);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (match[2] ?? "gb").toLowerCase();
  if (unit === "mb" || unit === "m") return n / 1024;
  return n;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps `window.ade.macosVm.start` with the concurrency confirm dialog.
 *
 * Consumer renders <ConcurrencyConfirmDialog open={dialog.open} ... onCancel={cancelStart} onConfirm={confirmStart} />.
 * Calling `start()` checks `getStatus`. If starting this VM would result in 2+ running VMs,
 * the dialog opens; otherwise the start happens immediately. `confirmStart`/`cancelStart`
 * resolve the gated start.
 */
export function useStartLaneVm(options: StartLaneVmOptions): UseStartLaneVmResult {
  const { laneId, baseName } = options;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<StartLaneVmDialogState>({
    open: false,
    pendingCpuCores: 0,
    pendingMemoryGb: 0,
    runningVms: [],
  });
  const pendingResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const startingRef = useRef(false);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pendingResolveRef.current?.(false);
      pendingResolveRef.current = null;
      startingRef.current = false;
    };
  }, []);

  const performStart = useCallback(async () => {
    const opts = optionsRef.current;
    setStarting(true);
    setError(null);
    try {
      await window.ade.macosVm.start({
        laneId: opts.laneId,
        fromBase: true,
        baseName: opts.baseName,
        createIfMissing: true,
        openDisplay: opts.openDisplay ?? true,
        ...(opts.cpuCores ? { cpuCores: opts.cpuCores } : {}),
        ...(opts.memory ? { memory: opts.memory } : {}),
        ...(opts.diskSize ? { diskSize: opts.diskSize } : {}),
        ...(opts.display ? { display: opts.display } : {}),
      });
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err));
      throw err;
    } finally {
      if (mountedRef.current) setStarting(false);
    }
  }, []);

  const start = useCallback(async () => {
    if (startingRef.current || pendingResolveRef.current) return;
    startingRef.current = true;
    setError(null);
    try {
      const status: MacosVmStatus = await window.ade.macosVm.getStatus({ laneId });

      const runningOthers = status.vms.filter(
        (vm) => RUNNING_STATES.has(vm.state) && vm.laneId !== laneId,
      );

      if (runningOthers.length === 0) {
        await performStart();
        return;
      }

      const pendingCpu = optionsRef.current.cpuCores ?? 2;
      const pendingMemoryGb = parseGb(optionsRef.current.memory) || 4;

      const confirmed = await new Promise<boolean>((resolve) => {
        pendingResolveRef.current = resolve;
        setDialog({
          open: true,
          pendingCpuCores: pendingCpu,
          pendingMemoryGb,
          runningVms: runningOthers,
        });
      });

      if (!confirmed) return;
      await performStart();
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err));
      throw err;
    } finally {
      if (mountedRef.current) {
        setDialog((prev) => ({ ...prev, open: false }));
      }
      pendingResolveRef.current = null;
      startingRef.current = false;
    }
  }, [laneId, performStart]);

  const confirmStart = useCallback(() => {
    pendingResolveRef.current?.(true);
  }, []);

  const cancelStart = useCallback(() => {
    pendingResolveRef.current?.(false);
  }, []);

  // baseName is captured in options ref; re-run not needed.
  void baseName;

  return { start, starting, error, dialog, confirmStart, cancelStart };
}
