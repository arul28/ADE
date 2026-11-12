import type { CSSProperties } from "react";
import { FolderSimple, WifiSlash, X } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { cn } from "../ui/cn";

/**
 * The tabs of repositories with no copy open in this window (S4): no computer
 * that holds the repository is online. They look like every project tab; the
 * slashed signal says why the tab shows no work. A click brings the tab to the
 * front, where `ProjectWelcomeNoMachine` lists the copies.
 */
export function NoMachineRepositoryTabs({
  activeSurfaceHidden,
  onSelect,
}: {
  /** True while a machine, account or hub page is in front: no project tab reads as active then. */
  activeSurfaceHidden: boolean;
  onSelect?: () => void;
}) {
  const tabs = useAppStore((state) => state.noMachineTabs);
  const activeId = useAppStore((state) => state.activeNoMachineTabId);
  if (tabs.length === 0) return null;
  return (
    <>
      {tabs.map((tab) => {
        const active = !activeSurfaceHidden && tab.id === activeId;
        const select = () => {
          onSelect?.();
          useAppStore.getState().showNoMachineTab(tab);
        };
        return (
          <div
            key={tab.id}
            role="button"
            tabIndex={0}
            data-state={active ? "active" : undefined}
            data-no-machine="true"
            aria-current={active ? "true" : undefined}
            className={cn(
              "ade-shell-project-tab group inline-flex w-auto min-w-[104px] max-w-[220px] items-center gap-1.5 px-2.5",
              "cursor-pointer transition-[background-color,color,border-color,box-shadow,opacity] duration-150",
              active && "font-semibold",
            )}
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            title={`${tab.displayName}: no computer with this project is online`}
            onClick={select}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                select();
              }
            }}
          >
            {tab.iconDataUrl ? (
              <img src={tab.iconDataUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm opacity-60" />
            ) : (
              <FolderSimple size={13} weight="regular" aria-hidden className="shrink-0 opacity-60" />
            )}
            <span className="min-w-0 flex-1 truncate text-center text-[12px] opacity-75">{tab.displayName}</span>
            <WifiSlash size={11} weight="regular" aria-label="No computer online" className="shrink-0 opacity-60" />
            <button
              type="button"
              className={cn(
                "ade-shell-control inline-flex h-4 w-4 shrink-0 items-center justify-center text-current",
                "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100",
              )}
              data-variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                useAppStore.getState().closeNoMachineTab(tab.id);
              }}
              title="Close project"
            >
              <X size={13} weight="regular" />
            </button>
          </div>
        );
      })}
    </>
  );
}
