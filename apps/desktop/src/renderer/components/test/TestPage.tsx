import React from "react";
import { Flask } from "@phosphor-icons/react";

export function TestPage() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 bg-bg text-fg">
      <div className="flex flex-col items-center gap-4 rounded-xl bg-white/[0.03] backdrop-blur-xl border border-white/[0.06] px-12 py-10">
        <Flask size={48} weight="thin" className="text-[#A78BFA]/50" />
        <div className="text-center">
          <div className="font-sans text-base font-semibold">Coming Soon</div>
          <div className="mt-1 text-xs text-muted-fg/70">This feature is under construction.</div>
        </div>
      </div>
    </div>
  );
}
