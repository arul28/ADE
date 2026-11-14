import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
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
  type MenuIconTone,
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
      /** Tints the icon only; see `MenuIconTone`. */
      tone?: MenuIconTone;
      /** Quiet trailing text, e.g. how many of a selection the row touches. */
      hint?: string;
      title?: string;
    }
  | {
      kind: "submenu";
      key: string;
      label: string;
      icon: Icon;
      tone?: MenuIconTone;
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
      /** The machine the folder is on (see `OpenInSubmenu`). */
      pin?: OpenProjectBinding | null;
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

/**
 * The rows of a menu without its frame, for a surface that hosts them itself
 * (a chip's hover card shows its actions under the card's facts).
 */
export function ContextMenuRows(props: { entries: ContextMenuEntry[]; onClose: () => void }) {
  return <EntryRows {...props} />;
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
                pin={entry.pin ?? null}
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
                icon={<MenuRowIcon icon={entry.icon} tone={entry.tone} />}
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
                data-ph-unmask=""
                className={
                  (entry.danger ? DESTRUCTIVE_ITEM_CLASS : MENU_ITEM_CLASS)
                  + (entry.disabled ? " pointer-events-none opacity-40" : "")
                }
                onClick={() => {
                  onClose();
                  entry.onSelect();
                }}
              >
                <MenuRowIcon icon={entry.icon} danger={entry.danger} tone={entry.tone} />
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
  return (
    <ContextMenuSurface
      menuRef={ref}
      left={position?.left ?? menu.x}
      top={position?.top ?? menu.y}
      positioned={Boolean(position)}
      onClose={onClose}
      label={label}
      testId={testId}
      portal={portal}
      role="menu"
      className="min-w-[200px]"
    >
      <EntryRows entries={entries} onClose={onClose} />
    </ContextMenuSurface>
  );
}

/** Arrow keys, Home and End move focus between the menu's enabled rows. */
function moveMenuFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key) || event.defaultPrevented) return;
  // A field inside the menu (rename, tag) keeps its own caret keys.
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  // An open submenu moves its own focus; its keys bubble here but are not ours.
  const panel = event.currentTarget;
  const ownMenu = panel.getAttribute("role") === "menu" ? panel : null;
  if (event.target instanceof Element && event.target.closest("[role='menu']") !== ownMenu) return;
  const rows = Array.from(
    panel.querySelectorAll<HTMLElement>("button:not([disabled]), [role='menuitem']:not([disabled]):not([aria-disabled='true'])"),
  ).filter((row) => row.offsetParent !== null && row.closest("[role='menu']") === ownMenu);
  if (rows.length === 0) return;
  event.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? rows.length - 1
      : event.key === "ArrowDown"
        ? (at + 1) % rows.length
        : at <= 0 ? rows.length - 1 : at - 1;
  rows[next]?.focus();
}

/**
 * The context-menu overlay itself: a click-away backdrop and the glass panel
 * at a clamped position, on the context-menu layer. `ContextMenu` builds its
 * rows from entries; a menu with bespoke content (inline rename, tag input)
 * passes children instead and still gets the shared layer.
 */
export function ContextMenuSurface({
  menuRef,
  left,
  top,
  positioned,
  onClose,
  label,
  testId,
  portal = false,
  role,
  className,
  children,
}: {
  menuRef: React.Ref<HTMLDivElement>;
  /** `menu` when the rows are menu items (entry-built menus); omit otherwise. */
  role?: "menu";
  left: number;
  top: number;
  /** False until the clamp has measured the panel; it stays hidden until then. */
  positioned: boolean;
  onClose: () => void;
  label?: string;
  testId?: string;
  portal?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  // The overlay host is click-through; the menu's own layers opt back in.
  const pointerEvents = portal ? ("auto" as const) : undefined;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const setPanelRef = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (typeof menuRef === "function") menuRef(node);
    else if (menuRef) (menuRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, [menuRef]);
  // The menu takes focus when it opens, so the keyboard can reach its rows
  // (arrow keys, Home, End, Enter), and gives it back when it closes. A row
  // that already took focus (an inline rename field) keeps it. Focus that
  // moved on (an action opened a chat) is left where it went.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      const active = document.activeElement;
      const focusStayedInMenu = !active || active === document.body || Boolean(panel?.contains(active));
      if (focusStayedInMenu && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  // A hidden panel cannot take focus, so this waits for the clamp to place it.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!positioned || !panel || panel.contains(document.activeElement)) return;
    panel.focus({ preventScroll: true });
  }, [positioned]);
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
        ref={setPanelRef}
        role={role}
        aria-label={label}
        data-testid={testId}
        className={`ade-liquid-glass-menu fixed py-1 outline-none ${className ?? ""}`}
        style={{
          zIndex: Z_LAYERS.contextMenu,
          left,
          top,
          visibility: positioned ? "visible" : "hidden",
          WebkitAppRegion: "no-drag",
          pointerEvents,
        } as React.CSSProperties}
        tabIndex={-1}
        onPointerDown={(event) => event.stopPropagation()}
        onKeyDown={moveMenuFocus}
      >
        {children}
      </div>
    </>
  );
  return portal ? <ViewportOverlayPortal layer="contextMenu">{content}</ViewportOverlayPortal> : content;
}
