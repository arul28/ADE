import { parsePrsRouteState } from "../prs/prsRouteState";

/**
 * "What is ADE showing right now", as a thing you can attach to a message.
 *
 * A screenshot of ADE's own window tells the CTO what the pixels look like and
 * nothing about what they mean: it cannot read the lane id behind a truncated
 * chip, the PR number behind a scrolled header, or which of four editor tabs is
 * actually focused. So when the captured window is ADE's own, the image travels
 * with this.
 *
 * No single accessor answered this before. The pieces were already there and
 * scattered — `selectActiveProjectStateKey` and `selectWorkViewState` in
 * `appStore`, `readStoredProjectRoute` in `projectRouteStorage`,
 * `parsePrsRouteState` in `prsRouteState`, and `editorGroupsStore` for the open
 * file — and this module is the one place that puts them together. It is
 * deliberately a pure function over an injected snapshot rather than a hook, so
 * the formatting can be tested without mounting the app.
 */

export type CurrentViewState = {
  /** Top-level tab: `work`, `lanes`, `prs`, `files`, `cto`, `settings`, … */
  tab: string | null;
  /** Full in-app route, including query and hash. */
  route: string | null;
  projectName: string | null;
  projectRoot: string | null;
  laneName: string | null;
  laneId: string | null;
  /** The chat/CLI session the Work tab has open, when it is on Work. */
  sessionId: string | null;
  pullRequest: {
    number: number | null;
    repo: string | null;
    detailTab: string | null;
  } | null;
  /** The editor tab in focus in Files, workspace-relative. */
  openFile: string | null;
};

/**
 * Everything the composer needs, gathered by the caller from the live stores.
 *
 * Injected rather than imported so the formatter has no dependency on zustand,
 * react-router or localStorage — the three things that make "what is on screen"
 * hard to test.
 */
export type CurrentViewStateInput = {
  /** `location.pathname + location.search + location.hash` from the router. */
  route: string | null;
  /**
   * The route this project tab was last left on, used only when `route` is
   * absent (no router context). `readStoredProjectRoute(bindingKey)`.
   */
  storedRoute: string | null;
  projectName: string | null;
  projectRoot: string | null;
  selectedLaneId: string | null;
  /** Lane id → display name, from `state.lanes`. */
  laneNamesById: Record<string, string>;
  /** `selectWorkViewState(projectRoot)(state).activeItemId`. */
  activeWorkItemId: string | null;
  /** Focused editor tab path, from `editorGroupsStore`. */
  openFilePath: string | null;
};

/** `"/prs?tab=github#..."` → `"prs"`. Null for the root and for junk. */
export function tabFromRoute(route: string | null): string | null {
  if (!route) return null;
  const pathname = route.split(/[?#]/, 1)[0] ?? "";
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment ?? null;
}

function splitRoute(route: string): { search: string; hash: string } {
  const hashIndex = route.indexOf("#");
  const hash = hashIndex >= 0 ? route.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? route.slice(0, hashIndex) : route;
  const searchIndex = withoutHash.indexOf("?");
  const search = searchIndex >= 0 ? withoutHash.slice(searchIndex) : "";
  return { search, hash };
}

export function composeCurrentViewState(input: CurrentViewStateInput): CurrentViewState {
  const route = input.route ?? input.storedRoute ?? null;
  const tab = tabFromRoute(route);
  const laneId = input.selectedLaneId;

  // Only parse PR coordinates when the user is actually on PRs. `?tab=github`
  // survives in the stored route long after the user moved on, and reporting a
  // PR the screenshot does not show is worse than reporting none.
  let pullRequest: CurrentViewState["pullRequest"] = null;
  if (tab === "prs" && route) {
    const { search, hash } = splitRoute(route);
    const parsed = parsePrsRouteState({ search, hash });
    const repo = parsed.repoOwner && parsed.repoName
      ? `${parsed.repoOwner}/${parsed.repoName}`
      : null;
    if (parsed.prNumber != null || parsed.prId != null || repo) {
      pullRequest = {
        number: parsed.prNumber,
        repo,
        detailTab: parsed.detailTab,
      };
    }
  }

  return {
    tab,
    route,
    projectName: input.projectName,
    projectRoot: input.projectRoot,
    laneId,
    laneName: laneId ? input.laneNamesById[laneId] ?? null : null,
    pullRequest,
    // A session id is meaningful on Work and nowhere else; the Work view state
    // keeps its last selection while the user is on another tab.
    sessionId: tab === "work" ? input.activeWorkItemId : null,
    openFile: tab === "files" ? input.openFilePath : null,
  };
}

/**
 * The attachment body. Markdown rather than JSON because the CTO reads it as
 * prose alongside the image, and a fenced JSON blob would cost tokens to say
 * the same six facts.
 *
 * Returns null when there is nothing worth attaching — a capture of the welcome
 * screen with no project open should not add an attachment that says "ADE".
 */
export function formatCurrentViewState(state: CurrentViewState): string | null {
  const lines: string[] = [];
  if (state.projectName) lines.push(`- Project: ${state.projectName}`);
  if (state.tab) lines.push(`- Tab: ${state.tab}`);
  if (state.laneName ?? state.laneId) {
    lines.push(`- Lane: ${state.laneName ?? state.laneId}`);
  }
  if (state.pullRequest) {
    const number = state.pullRequest.number != null ? `#${state.pullRequest.number}` : "";
    const repo = state.pullRequest.repo ?? "";
    const label = [repo, number].filter(Boolean).join(" ");
    if (label) lines.push(`- Pull request: ${label}`);
    if (state.pullRequest.detailTab) lines.push(`- PR view: ${state.pullRequest.detailTab}`);
  }
  if (state.openFile) lines.push(`- Open file: ${state.openFile}`);
  if (state.sessionId) lines.push(`- Work session: ${state.sessionId}`);
  if (state.route) lines.push(`- Route: ${state.route}`);
  if (lines.length === 0) return null;
  return [
    "# ADE screen context",
    "",
    "Captured alongside the screenshot of ADE's own window.",
    "",
    ...lines,
    "",
  ].join("\n");
}
