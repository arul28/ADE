import { useCallback, useState } from "react";
import { ArrowClockwise, ArrowSquareOut, Desktop, SpinnerGap } from "@phosphor-icons/react";
import type { MacosVmStatus } from "../../../../shared/types";

type Props = {
  status: MacosVmStatus;
  onRecheck: () => Promise<void> | void;
};

export function ProviderUnavailable({ status, onRecheck }: Props) {
  const [busy, setBusy] = useState(false);
  const detail = status.activeProvider.detail || "Apple Virtualization helper is not running.";
  const docsUrl = status.activeProvider.docsUrl || status.docs.appleVirtualization;
  const safeDocsUrl = isSafeExternalUrl(docsUrl) ? docsUrl : null;

  const recheck = useCallback(async () => {
    setBusy(true);
    try {
      await onRecheck();
    } finally {
      setBusy(false);
    }
  }, [onRecheck]);

  return (
    <div className="flex h-full min-h-0 items-center justify-center px-6 py-10 text-[12px] text-fg/85">
      <div className="w-full max-w-md rounded-lg border border-amber-400/20 bg-amber-500/[0.06] p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-amber-300/25 bg-amber-500/10">
            <Desktop size={18} weight="fill" className="text-amber-100/85" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-amber-50/95">Apple Virtualization helper unavailable</div>
            <div className="mt-1 text-[12px] leading-5 text-amber-50/75">
              ADE drives macOS VMs through a small native helper process. We couldn't reach it.
            </div>
            <div className="mt-3 rounded-md border border-white/[0.05] bg-black/15 px-3 py-2 text-[11px] leading-5 text-muted-fg/75">
              <div className="text-muted-fg/55">Helper status</div>
              <div className="mt-0.5 text-fg/85">{detail}</div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
                data-variant="default"
                onClick={() => void recheck()}
                disabled={busy}
                aria-label="Re-check helper availability"
              >
                {busy ? <SpinnerGap size={12} className="animate-spin" /> : <ArrowClockwise size={12} />}
                Re-check
              </button>
              {safeDocsUrl ? (
                <button
                  type="button"
                  className="ade-shell-control inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px]"
                  data-variant="ghost"
                  aria-label="Open setup documentation"
                  onClick={() => void window.ade.app.openExternal(safeDocsUrl)}
                >
                  <ArrowSquareOut size={12} />
                  Setup docs
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function isSafeExternalUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
