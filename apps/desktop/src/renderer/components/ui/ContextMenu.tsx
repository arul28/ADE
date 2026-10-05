import { useEffect } from "react";
import type { Icon } from "@phosphor-icons/react";

import type { OpenPathInEditorRemote } from "../../../shared/editorTargets";
import type { OpenProjectBinding } from "../../../shared/types/core";
import { useClampedFixedPosition } from "../../hooks/useClampedFixedPosition";
import { OpenLinkInSubmenu } from "./OpenLinkInSubmenu";
import { ViewportOverlayPortal } from "./ViewportOverlayHost";
import {
  DESTRUCTIVE_ITEM_CLASS,
  MENU_ITEM_CLASS,
  MenuRowIcon,
  MenuSectionLabel,
  MenuSeparator,
  MenuSubmenu,
} from "./MenuSubmenu";
import { OpenInSubmenu } from "./OpenInSubmenu";
import { Z_LAYERS } from "./zLayers";

/**
 * One row of a right-click menu. Callers build a list of rows from what their
 * surface can do; this primitive owns the look (the session menu's rows), the
 * placement, the click-away layer and the stacking.
 */
export type ContextMenuEntry =
  | {
      kind: "item";
      key: string;
      label: string;
      icon: Icon;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      /** Quiet trailing text, e.g. how many of a selection the row touches. */
      hint?: string;
      title?: string;
    }
  | {
      kind: "submenu";
      key: string;
      label: string;
      icon: Icon;
      entries: ContextMenuEntry[];
      /** Runs as the submenu opens, for rows that resolve against the clock. */
      onOpen?: () => void;
      testId?: string;
    }
  | { kind: "label"; key: string; label: string }
  | {
      kind: "open-in";
      key: string;
      rootPath: string;
      remote?: OpenPathInEditorRemote | null;
    }
  | {
      /**
       * "Open this URL in ▸", listing ADE's own browser, the system default,
       * and every browser installed on this machine with its real app icon.
       */
      kind: "open-link-in";
      key: string;
      url: string;
      /** The pin of the chat or terminal the link came from, for `localhost`. */
      runtimePin?: OpenProjectBinding | null;
    }
  | { kind: "separator"; key: string };

/** Where the menu opens, in client pixels; null when it is closed. */
export type ContextMenuState = { x: number; y: number } | null;

/**
 * Drops leading, trailing and doubled separators left by hidden rows, and a
 * section label whose rows were all hidden (one that runs into a separator).
 */
function tidyEntries(entries: ContextMenuEntry[]): ContextMenuEntry[] {
  const out: ContextMenuEntry[] = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    if (entry.kind === "separator") {
      if (last?.kind === "label") out.pop();
      if (out.length === 0 || out[out.length - 1]!.kind === "separator") continue;
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
  entries: ContextMenuEntry[];
  onClose: () => void;
}) {
  return (
    <>
      {tidyEntries(entries).map((entry) => {
        switch (entry.kind) {
          case "separator":
            return <MenuSeparator key={entry.key} />;
          case "label":
            return <MenuSectionLabel key={entry.key}>{entry.label}</MenuSectionLabel>;
          case "open-in":
            return (
              <OpenInSubmenu
                key={entry.key}
                rootPath={entry.rootPath}
                remote={entry.remote ?? null}
                onClose={onClose}
              />
            );
          case "open-link-in":
            return (
              <OpenLinkInSubmenu
                key={entry.key}
                url={entry.url}
                runtimePin={entry.runtimePin ?? null}
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
                onOpen={entry.onOpen}
                data-testid={entry.testId}
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
                title={entry.title}
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
                {entry.hint ? (
                  <span className="ml-auto shrink-0 pl-4 text-[10px] text-muted-fg/50">{entry.hint}</span>
                ) : null}
              </button>
            );
          default: {
            const unreachable: never = entry;
            return unreachable;
          }
        }
      })}
    </>
  );
}

export function ContextMenu({
  menu,
  entries,
  onClose,
  label,
  testId,
  portal = false,
}: {
  menu: ContextMenuState;
  entries: ContextMenuEntry[];
  onClose: () => void;
  /** Accessible name for the menu. */
  label: string;
  testId?: string;
  /**
   * Move the menu to a body-level overlay layer.
   *
   * A `position: fixed` menu is only viewport-anchored while no ancestor has a
   * transform. Chat rows animate with `motion`, which puts one there — so a
   * menu opened from inside a transcript row has to leave the row's subtree to
   * land under the pointer. Page-root hosts, which have no such ancestor, keep
   * rendering inline.
   */
  portal?: boolean;
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
  // The overlay host is click-through; the menu's own layers opt back in.
  const pointerEvents = portal ? ("auto" as const) : undefined;
  const content = (
    <>
      <div
        className="fixed inset-0"
        style={{
          WebkitAppRegion: "no-drag",
          zIndex: Z_LAYERS.contextMenu,
          pointerEvents,
        } as React.CSSProperties}
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
        data-testid={testId}
        className="ade-liquid-glass-menu fixed min-w-[200px] py-1"
        style={{
          zIndex: Z_LAYERS.contextMenu,
          left: position?.left ?? menu.x,
          top: position?.top ?? menu.y,
          visibility: position ? "visible" : "hidden",
          WebkitAppRegion: "no-drag",
          pointerEvents,
        } as React.CSSProperties}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <EntryRows entries={entries} onClose={onClose} />
      </div>
    </>
  );
  return portal ? <ViewportOverlayPortal layer="contextMenu">{content}</ViewportOverlayPortal> : content;
}
