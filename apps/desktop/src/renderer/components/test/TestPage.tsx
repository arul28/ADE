import React from "react";
import { Flask } from "@phosphor-icons/react";

export function TestPage() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 text-fg">
      <Flask size={48} weight="thin" className="text-muted-fg/50" />
      <div className="text-center">
        <div className="text-base font-semibold">Coming Soon</div>
        <div className="mt-1 text-xs text-muted-fg">This feature is under construction.</div>
      </div>
    </div>
  );
}
