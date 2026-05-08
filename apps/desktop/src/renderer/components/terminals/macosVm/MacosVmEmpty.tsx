import { useEffect, useMemo, useState } from "react";
import { ArrowRight, CaretDown, CaretRight, Desktop, SpinnerGap } from "@phosphor-icons/react";
import type { MacosVmBaseRecord, MacosVmStatus } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { ConcurrencyConfirmDialog } from "./ConcurrencyConfirmDialog";
import { SnapshotPicker } from "./SnapshotPicker";
import { useStartLaneVm } from "./useStartLaneVm";

type Props = {
  status: MacosVmStatus;
  laneId: string;
  laneName?: string;
  bases: MacosVmBaseRecord[];
};

export function MacosVmEmpty({ status, laneId, laneName, bases }: Props) {
  const defaultBaseName = status.defaultBase?.name ?? null;
  const initialBaseName = useMemo(() => {
    if (defaultBaseName && bases.some((b) => b.name === defaultBaseName)) return defaultBaseName;
    return bases[0]?.name ?? "";
  }, [bases, defaultBaseName]);

  const [baseName, setBaseName] = useState(initialBaseName);
  const [showCustomize, setShowCustomize] = useState(false);
  const [cpuCores, setCpuCores] = useState<number | undefined>(undefined);
  const [memory, setMemory] = useState<string | undefined>(undefined);
  const [diskSize, setDiskSize] = useState<string | undefined>(undefined);
  const [display, setDisplay] = useState<string | undefined>(undefined);

  useEffect(() => {
    if ((!baseName && initialBaseName) || (baseName && !bases.some((base) => base.name === baseName))) {
      setBaseName(initialBaseName);
    }
  }, [baseName, bases, initialBaseName]);

  const { start, starting, error, dialog, confirmStart, cancelStart } = useStartLaneVm({
    laneId,
    baseName,
    cpuCores,
    memory,
    diskSize,
    display,
  });

  const noSnapshots = bases.length === 0;

  return (
    <div className="flex h-full min-h-0 items-center justify-center px-6 py-10 text-[12px] text-fg/85">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-emerald-300/20 bg-emerald-400/[0.06]">
          <Desktop size={28} weight="fill" className="text-emerald-200/85" />
        </div>
        <h2 className="mt-4 text-base font-medium text-fg">Spin up a clean macOS for this lane</h2>
        <p className="mt-1 text-[12px] leading-5 text-muted-fg/70">
          Clones from your snapshot in seconds via copy-on-write.
        </p>

        <div className="mt-5 flex flex-col items-center gap-3">
          <div className="flex items-center gap-2 text-[11px] text-muted-fg/65">
            <span>Clone from</span>
            <SnapshotPicker
              bases={bases}
              value={baseName}
              onChange={setBaseName}
              defaultBaseName={defaultBaseName}
              ariaLabel="Choose snapshot to clone"
            />
          </div>

          <button
            type="button"
            className="ade-work-new-chat-btn inline-flex items-center gap-2 px-4 py-2 text-[12px] font-medium"
            onClick={() => void start()}
            disabled={starting || !baseName || noSnapshots}
            aria-label="Start lane VM"
          >
            {starting ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowRight size={13} />}
            Start lane VM <span className="ml-1 text-[11px] font-normal text-muted-fg/70">(≈30 s)</span>
          </button>
          {error ? <div className="text-[11px] text-rose-200/85" role="alert">{error}</div> : null}
        </div>

        <div className="mt-6 text-left">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-fg/70 hover:text-fg/85"
            onClick={() => setShowCustomize((current) => !current)}
            aria-expanded={showCustomize}
          >
            {showCustomize ? <CaretDown size={11} /> : <CaretRight size={11} />}
            Customize CPU, memory, disk max, and display
          </button>
          {showCustomize ? (
            <div className={cn("mt-3 grid grid-cols-2 gap-2 rounded-md border border-white/[0.08] bg-white/[0.02] p-3 text-left")}>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-fg/55">CPU</span>
                <input
                  className="ade-input h-8 rounded-md px-2 text-[12px]"
                  type="number"
                  min={1}
                  max={32}
                  step={1}
                  value={cpuCores ?? ""}
                  placeholder={String(status.defaultBase?.cpuCores ?? 2)}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setCpuCores(Number.isFinite(next) && next >= 1 ? Math.min(32, Math.max(1, next)) : undefined);
                  }}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-fg/55">Memory</span>
                <input
                  className="ade-input h-8 rounded-md px-2 text-[12px]"
                  value={memory ?? ""}
                  placeholder={status.defaultBase?.memory ?? "4GB"}
                  onChange={(event) => setMemory(event.target.value || undefined)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-fg/55">Disk max</span>
                <input
                  className="ade-input h-8 rounded-md px-2 text-[12px]"
                  value={diskSize ?? ""}
                  placeholder={status.defaultBase?.diskSize ?? "64GB"}
                  onChange={(event) => setDiskSize(event.target.value || undefined)}
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-fg/55">Display</span>
                <input
                  className="ade-input h-8 rounded-md px-2 text-[12px]"
                  value={display ?? ""}
                  placeholder={status.defaultBase?.display ?? "1440x900"}
                  onChange={(event) => setDisplay(event.target.value || undefined)}
                />
              </label>
            </div>
          ) : null}
        </div>
      </div>
      <ConcurrencyConfirmDialog
        open={dialog.open}
        laneName={laneName ?? laneId}
        pendingCpuCores={dialog.pendingCpuCores}
        pendingMemoryGb={dialog.pendingMemoryGb}
        runningVms={dialog.runningVms}
        onCancel={cancelStart}
        onConfirm={confirmStart}
      />
    </div>
  );
}
