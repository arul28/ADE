import React from "react";
import { Info } from "@phosphor-icons/react";

export function DeetsPage() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 text-fg">
      <Info size={48} weight="thin" className="text-muted-fg/50" />
      <div className="text-center">
        <div className="text-base font-semibold">Coming soon in v2</div>
      </div>
    </div>
  );
}
