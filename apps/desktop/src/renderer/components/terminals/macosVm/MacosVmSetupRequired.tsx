import { useCallback, useState } from "react";
import { ArrowSquareOut, FloppyDisk, SpinnerGap, Wrench } from "@phosphor-icons/react";

type Props = {
  laneId: string;
  onResumeWizard: () => void;
};

export function MacosVmSetupRequired({ laneId, onResumeWizard }: Props) {
  const [busy, setBusy] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);

  const reopenWindow = useCallback(async () => {
    setBusy(true);
    setReopenError(null);
    try {
      await window.ade.macosVm.focusWindow({ laneId });
    } catch (err) {
      setReopenError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [laneId]);

  return (
    <div
      className="flex h-full min-h-0 items-center justify-center px-6 py-10 text-[12px] text-fg/85"
      data-testid="macos-vm-setup-required"
    >
      <div className="w-full max-w-md rounded-lg border border-sky-400/25 bg-sky-500/[0.07] p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-sky-300/25 bg-sky-500/10">
            <Wrench size={18} weight="fill" className="text-sky-100/85" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-sky-50/95">macOS Setup Assistant is waiting</div>
            <div className="mt-1 text-[12px] leading-5 text-sky-50/75">
              Finish Setup Assistant in the VM window, stop the VM, then save it as a snapshot.
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className="ade-work-new-chat-btn inline-flex items-center gap-1.5 px-3 py-2 text-[12px] font-medium"
                onClick={() => void reopenWindow()}
                disabled={busy}
                aria-label="Reopen VM window"
              >
                {busy ? <SpinnerGap size={13} className="animate-spin" /> : <ArrowSquareOut size={13} />}
                Reopen VM window
              </button>
              <button
                type="button"
                className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-[12px]"
                data-variant="ghost"
                onClick={onResumeWizard}
                disabled={busy}
                aria-label="Resume in wizard"
              >
                <FloppyDisk size={12} />
                Resume in wizard
              </button>
            </div>
            {reopenError ? <p className="mt-2 text-xs text-red-400">{reopenError}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
