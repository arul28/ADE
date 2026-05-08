import { SpinnerGap, Stop } from "@phosphor-icons/react";

type Props = {
  variant: "starting" | "stopping";
  laneId: string;
  onCancel?: () => Promise<void> | void;
  cancelling?: boolean;
};

export function MacosVmTransient({ variant, laneId, onCancel, cancelling }: Props) {
  const isStart = variant === "starting";
  const headline = isStart ? "Starting VM" : "Stopping VM";
  const copy = isStart
    ? "The macOS VM window will open shortly."
    : "Shutting down — the VM window will close when finished.";
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-6 py-10 text-[12px] text-fg/85">
      <div className="w-full max-w-md rounded-lg border border-white/[0.08] bg-white/[0.025] p-6 text-center">
        <SpinnerGap size={28} className="mx-auto animate-spin text-amber-200/85" />
        <div className="mt-4 text-sm font-medium text-fg">{headline}</div>
        <div className="mt-1 text-[12px] leading-5 text-muted-fg/75">{copy}</div>
        <div className="mt-3 text-[10px] uppercase tracking-wide text-muted-fg/45">Lane {laneId}</div>
        {onCancel ? (
          <button
            type="button"
            className="ade-shell-control mt-5 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px]"
            data-variant="ghost"
            onClick={() => {
              void Promise.resolve(onCancel()).catch((err) => {
                console.error("Failed to cancel macOS VM operation", err);
              });
            }}
            disabled={Boolean(cancelling)}
            aria-label={isStart ? "Cancel start" : "Cancel stop"}
          >
            {cancelling ? <SpinnerGap size={12} className="animate-spin" /> : <Stop size={12} />}
            Cancel
          </button>
        ) : null}
      </div>
    </div>
  );
}
