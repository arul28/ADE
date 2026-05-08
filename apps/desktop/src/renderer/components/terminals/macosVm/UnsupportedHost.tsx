import { ArrowSquareOut, Desktop } from "@phosphor-icons/react";
import type { MacosVmStatus } from "../../../../shared/types";

type Props = {
  status: MacosVmStatus;
};

export function UnsupportedHost({ status }: Props) {
  const detail = status.activeProvider.detail || "Apple Virtualization is not supported on this host.";
  const docsUrl = status.activeProvider.docsUrl || status.docs.appleVirtualization;
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-6 py-10 text-[12px] text-fg/85">
      <div className="w-full max-w-md rounded-lg border border-amber-400/20 bg-amber-500/[0.06] p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-amber-300/25 bg-amber-500/10">
            <Desktop size={18} weight="fill" className="text-amber-100/85" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-amber-50/95">macOS VM not supported on this host</div>
            <div className="mt-1 text-[12px] leading-5 text-amber-50/75">
              ADE needs an Apple silicon Mac running macOS 13 or later to host lane VMs.
            </div>
            <div className="mt-3 rounded-md border border-white/[0.05] bg-black/15 px-3 py-2 text-[11px] leading-5 text-muted-fg/75">
              <div className="text-muted-fg/55">Detected</div>
              <div className="mt-0.5 text-fg/85">
                {status.platform} · {status.arch}
              </div>
              <div className="mt-2 text-muted-fg/70">{detail}</div>
            </div>
            {docsUrl ? (
              <button
                type="button"
                className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-amber-200/25 px-2.5 py-1.5 text-[11px] text-amber-50/95"
                aria-label="Open Apple Virtualization documentation"
                onClick={() => {
                  void window.ade.app.openExternal(docsUrl).catch((error) => {
                    console.warn("Failed to open macOS VM documentation", error);
                  });
                }}
              >
                <ArrowSquareOut size={12} />
                Apple Virtualization docs
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
