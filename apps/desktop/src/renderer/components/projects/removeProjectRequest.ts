/**
 * Asks the top bar to open the remove dialog (S13c) from a surface that does
 * not own the tabs: the Location page and the page of a tab with no computer
 * online. The top bar owns the dialog, so the tab closes and the recents
 * update the same way as from the tab's own menu.
 */
export const REQUEST_REMOVE_PROJECT_EVENT = "ade:request-remove-project";

export type RemoveProjectRequest =
  /** One copy: "From this computer" acts on it. */
  | { kind: "copy"; bindingKey: string }
  /** A tab with no computer online, by its account project id. */
  | { kind: "no-machine"; id: string; displayName: string };

export function requestRemoveProject(request: RemoveProjectRequest): void {
  window.dispatchEvent(new CustomEvent<RemoveProjectRequest>(REQUEST_REMOVE_PROJECT_EVENT, { detail: request }));
}
