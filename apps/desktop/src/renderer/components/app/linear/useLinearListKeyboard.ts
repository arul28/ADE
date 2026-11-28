import { useEffect, useRef, type RefObject } from "react";
import type { BrowserIssue } from "../linearIssueBrowserModel";
import type { LinearListIssueRow, LinearListRow } from "./linearListModel";

export type LinearListKeyState = {
  listRows: LinearListRow[];
  /** Row indices of issue rows, top to bottom. */
  navigable: number[];
  cursorRowKey: string | null;
  selectedIssue: BrowserIssue | null;
  checkedCount: number;
  multiSelectEnabled: boolean;
  resolvedSelectedIssues: BrowserIssue[];
};

export type LinearListKeyActions = {
  /** Moves the selection and the keyboard cursor to an issue row. */
  goToRow: (row: LinearListIssueRow, index: number) => void;
  toggleChecked: (issueId: string, rowKey: string | null, shiftKey: boolean) => void;
  toggleCollapsed: (key: string, force?: boolean) => void;
  clearChecked: () => void;
  /** Present when the host launches issues (Enter launches the checked set or the selection). */
  launch: ((issues: BrowserIssue[]) => void) | null;
  runPrimaryAction: (issue: BrowserIssue) => void;
};

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * The issue list's keyboard: j/k or arrows move, left/right fold a parent or a
 * group, x checks, Enter runs the primary action, "/" focuses search, Escape
 * clears the checked set. Keys typed into a field are left alone, and a dialog
 * or popover opened on top of the pane keeps its keys. State and actions are
 * read through refs, so the listeners are added once.
 */
export function useLinearListKeyboard({
  rootRef,
  searchInputRef,
  state,
  actions,
}: {
  rootRef: RefObject<HTMLElement | null>;
  searchInputRef: RefObject<HTMLInputElement | null>;
  state: LinearListKeyState;
  actions: LinearListKeyActions;
}): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const ownsKeyboard = (event: KeyboardEvent): boolean => {
      const root = rootRef.current;
      if (!root || !root.isConnected) return false;
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (isTypingTarget(event.target)) return false;
      if (event.target instanceof Element && event.target.closest("[data-linear-popover]")) return false;
      const active = document.activeElement;
      if (active instanceof Element && active.closest("[data-linear-popover]")) return false;
      if (!active || active === document.body || root.contains(active)) return true;
      const hostDialog = root.closest('[role="dialog"]');
      return Boolean(hostDialog && hostDialog.contains(active));
    };
    const currentRowIndex = (): number => {
      const current = stateRef.current;
      const rows = current.listRows;
      if (current.cursorRowKey) {
        const byKey = current.navigable.find((index) => rows[index]?.key === current.cursorRowKey);
        const row = byKey != null ? rows[byKey] : null;
        if (byKey != null && row?.kind === "issue" && row.issue.id === current.selectedIssue?.id) return byKey;
      }
      const selectedId = current.selectedIssue?.id;
      if (!selectedId) return -1;
      return current.navigable.find((index) => {
        const row = rows[index];
        return row?.kind === "issue" && row.issue.id === selectedId;
      }) ?? -1;
    };
    const focusRow = (rowKey: string) => {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(rowKey) : rowKey.replace(/["\\]/g, "\\$&");
      const element = rootRef.current?.querySelector<HTMLElement>(`[data-linear-row-key="${escaped}"]`);
      if (element && rootRef.current?.contains(document.activeElement)) element.focus({ preventScroll: true });
    };
    const goToRow = (index: number) => {
      const row = stateRef.current.listRows[index];
      if (!row || row.kind !== "issue") return;
      actionsRef.current.goToRow(row, index);
      // The row may mount a frame later when it scrolls into the window.
      window.requestAnimationFrame(() => focusRow(row.key));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !ownsKeyboard(event)) return;
      const current = stateRef.current;
      const act = actionsRef.current;
      const move = (delta: number) => {
        const list = current.navigable;
        if (list.length === 0) return;
        const index = currentRowIndex();
        const position = index < 0 ? -1 : list.indexOf(index);
        const nextPosition = position < 0 ? 0 : Math.min(list.length - 1, Math.max(0, position + delta));
        goToRow(list[nextPosition]!);
      };
      const headerPath = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-linear-group-header]")?.dataset.linearGroupHeader ?? null
        : null;
      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          move(1);
          return;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          move(-1);
          return;
        case "ArrowLeft":
        case "ArrowRight": {
          const collapse = event.key === "ArrowLeft";
          if (headerPath) {
            event.preventDefault();
            act.toggleCollapsed(`g:${headerPath}`, collapse);
            return;
          }
          const index = currentRowIndex();
          const row = index >= 0 ? current.listRows[index] : null;
          if (!row || row.kind !== "issue") return;
          event.preventDefault();
          if (collapse && row.childCount > 0 && !row.childrenCollapsed) {
            act.toggleCollapsed(`p:${row.issue.id}`, true);
          } else if (collapse && row.depth > 0) {
            // Already folded (or a leaf): step up to the parent row.
            for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
              const candidate = current.listRows[cursor];
              if (!candidate || candidate.kind === "group") break;
              if (candidate.kind === "issue" && candidate.depth < row.depth) { goToRow(cursor); break; }
              if (candidate.kind === "context") break;
            }
          } else if (!collapse && row.childCount > 0 && row.childrenCollapsed) {
            act.toggleCollapsed(`p:${row.issue.id}`, false);
          }
          return;
        }
        case "x": {
          if (!current.multiSelectEnabled || !current.selectedIssue) return;
          event.preventDefault();
          const index = currentRowIndex();
          act.toggleChecked(current.selectedIssue.id, index >= 0 ? current.listRows[index]?.key ?? null : null, event.shiftKey);
          return;
        }
        case "/":
          event.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
          return;
        case "Enter": {
          if (event.target instanceof HTMLButtonElement) return;
          const checked = current.multiSelectEnabled ? current.resolvedSelectedIssues : [];
          if (act.launch) {
            const targets = checked.length > 1 ? checked : current.selectedIssue ? [current.selectedIssue] : [];
            if (targets.length === 0) return;
            event.preventDefault();
            act.launch(targets);
          } else if (current.selectedIssue) {
            event.preventDefault();
            act.runPrimaryAction(current.selectedIssue);
          }
          return;
        }
        default:
      }
    };
    // Capture, so Escape can clear a checked set before the host dialog's own
    // Escape (Radix listens on the document in capture) closes the pane.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ownsKeyboard(event)) return;
      if (!stateRef.current.multiSelectEnabled || stateRef.current.checkedCount === 0) return;
      event.preventDefault();
      event.stopPropagation();
      actionsRef.current.clearChecked();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [rootRef, searchInputRef]);
}
