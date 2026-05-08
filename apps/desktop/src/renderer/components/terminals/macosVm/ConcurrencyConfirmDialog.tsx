import { motion, AnimatePresence } from "motion/react";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { WarningCircle, X } from "@phosphor-icons/react";
import type { MacosVmRecord } from "../../../../shared/types";

const RUNNING_STATES = new Set(["running", "starting", "installing", "creating"]);

export type ConcurrencyConfirmDialogProps = {
  open: boolean;
  laneName: string;
  pendingCpuCores: number;
  pendingMemoryGb: number;
  runningVms: MacosVmRecord[];
  onCancel: () => void;
  onConfirm: () => void;
};

function parseGb(value: string | null | undefined): number {
  if (!value) return 0;
  const match = /([\d.]+)\s*(gb|mb|g|m)?/i.exec(value);
  if (!match) return 0;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = (match[2] ?? "gb").toLowerCase();
  if (unit === "mb" || unit === "m") return n / 1024;
  return n;
}

export function summariseRunningResources(vms: MacosVmRecord[]): {
  count: number;
  cpuCores: number;
  memoryGb: number;
} {
  const running = vms.filter((vm) => RUNNING_STATES.has(vm.state));
  const cpuCores = running.reduce((sum, vm) => sum + (vm.cpuCores || 0), 0);
  const memoryGb = running.reduce((sum, vm) => sum + parseGb(vm.memory), 0);
  return { count: running.length, cpuCores, memoryGb };
}

export function ConcurrencyConfirmDialog({
  open,
  laneName,
  pendingCpuCores,
  pendingMemoryGb,
  runningVms,
  onCancel,
  onConfirm,
}: ConcurrencyConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const summary = summariseRunningResources(runningVms);
  const totalAfter = summary.count + 1;
  const totalCpu = summary.cpuCores + pendingCpuCores;
  const totalMemoryGb = summary.memoryGb + pendingMemoryGb;
  const severe = totalAfter >= 4;

  const headline = severe
    ? "Your Mac will struggle"
    : "Another macOS VM is already running";
  const description = severe
    ? `You're about to have ${totalAfter} macOS VMs running at once. Expect heavy fan use, slow input, and possible lockups while every guest competes for CPU and memory.`
    : `You already have ${summary.count} macOS VM${summary.count === 1 ? "" : "s"} running. Starting one for "${laneName}" will share this Mac's CPU and memory across all of them.`;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = getFocusableElements(dialogRef.current);
    focusables[0]?.focus();
    return () => previous?.focus();
  }, [open]);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = getFocusableElements(dialogRef.current);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50"
            style={{ background: "rgba(2, 6, 23, 0.55)", backdropFilter: "blur(6px)" }}
            aria-hidden="true"
            onClick={onCancel}
            data-testid="concurrency-confirm-backdrop"
          />
          <motion.div
            ref={dialogRef}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed left-1/2 top-[18%] z-[60] w-[min(480px,calc(100vw-24px))] -translate-x-1/2 rounded-lg border border-white/[0.08] bg-surface/95 p-4 shadow-[0_16px_48px_rgba(0,0,0,0.45)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="concurrency-confirm-title"
            aria-describedby="concurrency-confirm-description"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={handleDialogKeyDown}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                <WarningCircle
                  size={18}
                  weight="fill"
                  className={severe ? "mt-0.5 shrink-0 text-rose-300" : "mt-0.5 shrink-0 text-amber-300"}
                />
                <div className="min-w-0">
                  <div
                    id="concurrency-confirm-title"
                    className="text-sm font-semibold text-fg"
                  >
                    {headline}
                  </div>
                  <p id="concurrency-confirm-description" className="mt-1 text-[12px] leading-5 text-muted-fg">
                    {description}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="ade-shell-control inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                data-variant="ghost"
                onClick={onCancel}
                aria-label="Cancel start"
              >
                <X size={12} />
              </button>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 rounded-md border border-white/[0.06] bg-white/[0.025] p-3 text-[11px]">
              <div>
                <div className="text-muted-fg/70">VMs after start</div>
                <div className="mt-0.5 font-mono text-fg">{totalAfter}</div>
              </div>
              <div>
                <div className="text-muted-fg/70">Total vCPU</div>
                <div className="mt-0.5 font-mono text-fg">{totalCpu}</div>
              </div>
              <div>
                <div className="text-muted-fg/70">Total memory</div>
                <div className="mt-0.5 font-mono text-fg">
                  {totalMemoryGb.toFixed(totalMemoryGb >= 10 ? 0 : 1)} GB
                </div>
              </div>
            </div>

            {summary.count > 0 ? (
              <ul className="mt-3 space-y-1 text-[11px] text-muted-fg/85">
                {runningVms
                  .filter((vm) => RUNNING_STATES.has(vm.state))
                  .map((vm) => (
                    <li key={vm.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        <span className="text-muted-fg/60">lane </span>
                        {vm.laneName || vm.laneId}
                      </span>
                      <span className="shrink-0 font-mono text-muted-fg/60">
                        {vm.cpuCores ?? "?"} vCPU{vm.memory ? ` · ${vm.memory}` : ""}
                      </span>
                    </li>
                  ))}
              </ul>
            ) : null}

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="ade-shell-control inline-flex h-7 items-center rounded-md px-3 text-[12px]"
                data-variant="ghost"
                onClick={onCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className={
                  severe
                    ? "inline-flex h-7 items-center rounded-md border border-rose-400/35 bg-rose-500/15 px-3 text-[12px] font-medium text-rose-100 transition-colors hover:bg-rose-500/25"
                    : "inline-flex h-7 items-center rounded-md border border-amber-400/35 bg-amber-500/15 px-3 text-[12px] font-medium text-amber-100 transition-colors hover:bg-amber-500/25"
                }
                onClick={onConfirm}
              >
                Start anyway
              </button>
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}

function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.hasAttribute("aria-hidden"));
}
