import React from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { SmartTooltip } from "../../ui/SmartTooltip";
import { toggleProjectSidebarHidden, useProjectSidebarHidden } from "./projectSidebarPrefs";

/**
 * The top bar's sidebar toggle. It lives in its own component so only this
 * button, not the whole top bar, re-renders while the sidebar is resized.
 */
export function ProjectSidebarToggle({ shortcut }: { shortcut: string | null }) {
  const hidden = useProjectSidebarHidden();
  return (
    <SmartTooltip
      content={{
        label: "Toggle sidebar",
        description: hidden ? "Show the project sidebar." : "Hide the project sidebar.",
        shortcut: shortcut ?? undefined,
      }}
      wrapperStyle={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        type="button"
        className="ade-shell-control inline-flex h-[24px] w-[24px] shrink-0 items-center justify-center"
        data-variant="ghost"
        aria-label="Toggle sidebar"
        aria-pressed={!hidden}
        onClick={toggleProjectSidebarHidden}
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <SidebarSimple size={16} weight="regular" />
      </button>
    </SmartTooltip>
  );
}
