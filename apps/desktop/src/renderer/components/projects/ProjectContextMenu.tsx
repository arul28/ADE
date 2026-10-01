import { Fragment, useEffect } from "react";
import type { Icon } from "@phosphor-icons/react";

import type { OpenPathInEditorRemote } from "../../../shared/editorTargets";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import {
  DESTRUCTIVE_ITEM_CLASS,
  MENU_ITEM_CLASS,
  MenuRowIcon,
  MenuSeparator,
  MenuSubmenu,
} from "../ui/MenuSubmenu";
import { OpenInSubmenu } from "../ui/OpenInSubmenu";
import { Z_LAYERS } from "../ui/zLayers";

/**
 * One row of a project's right-click menu. The project tab and the start page
 * build their own lists from what each surface can do, and both render them
 * here, so the two menus share one look and one set of behaviors.
 */
export type ProjectMenuEntry =
  | {
      kind: "item";
      key: string;
      label: string;
      icon: Icon;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
    }
  | {
      kind: "submenu";
      key: string;
      label: string;
      icon: Icon;
      entries: ProjectMenuEntry[];
    }
  | {
      kind: "open-in";
      key: string;
      rootPath: string;
      remote?: OpenPathInEditorRemote | null;
    }
  | { kind: "separator"; key: string };

export type ProjectContextMenuState = { x: number; y: number } | null;

/** Drops leading, trailing and doubled separators left by hidden rows. */
function tidyEntries(entries: ProjectMenuEntry[]): ProjectMenuEntry[] {
  const out: ProjectMenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "separator" && (out.length === 0 || out[out.length - 1]!.kind === "separator")) {
      continue;
    }
    out.push(entry);
  }
  while (out.length > 0 && out[out.length - 1]!.kind === "separator") out.pop();
  return out;
}

function EntryRows({
  entries,
  onClose,
}: {
  entries: ProjectMenuEntry[];
  onClose: () => void;
}) {
  return (
    <>
      {tidyEntries(entries).map((entry) => {
        switch (entry.kind) {
          case "separator":
            return <MenuSeparator key={entry.key} />;
          case "open-in":
            return (
              <OpenInSubmenu
                key={entry.key}
                rootPath={entry.rootPath}
                remote={entry.remote ?? null}
                onClose={onClose}
              />
            );
          case "submenu":
            return (
              <MenuSubmenu
                key={entry.key}
                label={entry.label}
                icon={<MenuRowIcon icon={entry.icon} />}
                className={MENU_ITEM_CLASS}
                role="menuitem"
              >
                <EntryRows entries={entry.entries} onClose={onClose} />
              </MenuSubmenu>
            );
          case "item":
            return (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                disabled={entry.disabled}
                className={
                  (entry.danger ? DESTRUCTIVE_ITEM_CLASS : MENU_ITEM_CLASS)
                  + (entry.disabled ? " pointer-events-none opacity-40" : "")
                }
                onClick={() => {
                  onClose();
                  entry.onSelect();
                }}
              >
                <MenuRowIcon icon={entry.icon} danger={entry.danger} />
                {entry.label}
              </button>
            );
          default:
            return <Fragment key={(entry as { key: string }).key} />;
        }
      })}
    </>
  );
}

export function ProjectContextMenu({
  menu,
  entries,
  onClose,
  label,
}: {
  menu: ProjectContextMenuState;
  entries: ProjectMenuEntry[];
  onClose: () => void;
  /** Accessible name for the menu, normally the project name. */
  label: string;
}) {
  const { ref, position } = useClampedFixedPosition(menu);
  useEffect(() => {
    if (!menu) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menu, onClose]);
  if (!menu) return null;
  return (
    <>
      <div
        className="fixed inset-0"
        style={{ WebkitAppRegion: "no-drag", zIndex: Z_LAYERS.popover } as React.CSSProperties}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label={label}
        className="ade-liquid-glass-menu fixed min-w-[200px] py-1"
        style={{
          zIndex: Z_LAYERS.popover,
          left: position?.left ?? menu.x,
          top: position?.top ?? menu.y,
          visibility: position ? "visible" : "hidden",
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <EntryRows entries={entries} onClose={onClose} />
      </div>
    </>
  );
}
