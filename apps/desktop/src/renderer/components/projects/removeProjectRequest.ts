/**
 * Asks the top bar to open the remove dialog (S13c) from a surface that does
 * not own the tabs: the Location page and the page of a tab with no computer
 * online, and Home's rows. The top bar owns the dialog, so the tab closes and the recents
 * update the same way as from the tab's own menu.
 */
export const REQUEST_REMOVE_PROJECT_EVENT = "ade:request-remove-project";

import type { RemovalCopy, RemoveProjectTarget } from "./RemoveProjectDialog";

export type RemoveProjectRequest =
  /**
   * One copy: "From this computer" acts on it. `copy` describes it for a
   * folder the tab's copies menu does not list (a second folder of the
   * repository on one computer).
   */
  | { kind: "copy"; bindingKey: string; copy?: RemovalCopy }
  /** A tab with no computer online, by its account project id. */
  | { kind: "no-machine"; id: string; displayName: string }
  /**
   * A Home row of an account project: its copies from the account list, and
   * "From this list" first. `groupId` is the account project id (the tab group's id).
   */
  | { kind: "target"; groupId: string; recordScope: string | null; target: RemoveProjectTarget };

export function requestRemoveProject(request: RemoveProjectRequest): void {
  window.dispatchEvent(new CustomEvent<RemoveProjectRequest>(REQUEST_REMOVE_PROJECT_EVENT, { detail: request }));
}

/**
 * Sent after a removal changed this computer's project list. Surfaces that
 * read the list once (the Location copies) read it again; the focus refresh
 * does not run, because the window kept its focus.
 */
export const PROJECT_COPIES_CHANGED_EVENT = "ade:project-copies-changed";

export function notifyProjectCopiesChanged(): void {
  window.dispatchEvent(new Event(PROJECT_COPIES_CHANGED_EVENT));
}

/**
 * Asks the top bar to open the copies menu of the tab in front, at a point
 * (the computers tag on the project page). The top bar owns the menu.
 */
export const REQUEST_COPIES_MENU_EVENT = "ade:request-copies-menu";

/** Where the copies menu opens, and for which project: an account project id (Home), else the tab in front. */
export type CopiesMenuRequest = { x: number; y: number; projectId?: string | null };

export function requestCopiesMenu(request: CopiesMenuRequest): void {
  window.dispatchEvent(new CustomEvent<CopiesMenuRequest>(REQUEST_COPIES_MENU_EVENT, { detail: request }));
}
