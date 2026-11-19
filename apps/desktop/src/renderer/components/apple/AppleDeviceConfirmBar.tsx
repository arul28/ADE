import type { ReactNode } from "react";

/**
 * The bar along the device pane's bottom edge that asks before a switch
 * (`AppleDevicePane`'s Switch device, the ADE Cloud iPhone's model picker):
 * one sentence, then the answers.
 */
export function AppleDeviceConfirmBar({ sentence, children }: { sentence: ReactNode; children: ReactNode }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex min-w-0 flex-wrap items-center gap-2 border-t border-border bg-surface px-3 py-2 font-sans text-xs text-fg">
      {/* The sentence keeps a real width and the answers stay together: a
          narrow pane puts them on the next line, never one word per line. */}
      <span className="min-w-0 flex-[1_1_16rem]">{sentence}</span>
      <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}
