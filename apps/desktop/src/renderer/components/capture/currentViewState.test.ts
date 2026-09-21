import { describe, expect, it } from "vitest";
import {
  composeCurrentViewState,
  formatCurrentViewState,
  tabFromRoute,
  type CurrentViewStateInput,
} from "./currentViewState";

const base: CurrentViewStateInput = {
  route: null,
  storedRoute: null,
  projectName: "ADE",
  projectRoot: "/repo",
  selectedLaneId: null,
  laneNamesById: {},
  activeWorkItemId: null,
  openFilePath: null,
};

describe("tabFromRoute", () => {
  it("takes the first path segment and ignores query and hash", () => {
    expect(tabFromRoute("/prs?tab=github#detail=files")).toBe("prs");
    expect(tabFromRoute("/work")).toBe("work");
    expect(tabFromRoute("/settings?tab=general#capture-gesture")).toBe("settings");
    expect(tabFromRoute("/")).toBeNull();
    expect(tabFromRoute(null)).toBeNull();
  });
});

describe("composeCurrentViewState", () => {
  it("falls back to the stored project route when there is no live route", () => {
    const state = composeCurrentViewState({ ...base, route: null, storedRoute: "/lanes" });
    expect(state.tab).toBe("lanes");
    expect(state.route).toBe("/lanes");
  });

  it("prefers the live route over the stored one", () => {
    const state = composeCurrentViewState({ ...base, route: "/files", storedRoute: "/lanes" });
    expect(state.tab).toBe("files");
  });

  it("resolves the lane name from the id", () => {
    const state = composeCurrentViewState({
      ...base,
      route: "/work",
      selectedLaneId: "lane-1",
      laneNamesById: { "lane-1": "cto-live-voice" },
    });
    expect(state.laneName).toBe("cto-live-voice");
    expect(state.laneId).toBe("lane-1");
  });

  it("reports the lane id when the lane list has no name for it yet", () => {
    const state = composeCurrentViewState({ ...base, route: "/work", selectedLaneId: "lane-9" });
    expect(state.laneName).toBeNull();
    expect(formatCurrentViewState(state)).toContain("Lane: lane-9");
  });

  it("reads PR coordinates out of the PRs route", () => {
    const state = composeCurrentViewState({
      ...base,
      route: "/prs?tab=github&pr=1237&repoOwner=arul28&repoName=ADE&detailTab=checks",
    });
    expect(state.pullRequest).toEqual({ number: 1237, repo: "arul28/ADE", detailTab: "checks" });
  });

  it("does not report a PR while the user is looking at another tab", () => {
    // The stored PRs route survives a tab switch, and naming a PR the
    // screenshot does not show is worse than naming none.
    const state = composeCurrentViewState({
      ...base,
      route: "/work",
      storedRoute: "/prs?tab=github&pr=1237&repoOwner=arul28&repoName=ADE",
    });
    expect(state.pullRequest).toBeNull();
  });

  it("scopes the session id to Work and the open file to Files", () => {
    const onWork = composeCurrentViewState({
      ...base,
      route: "/work",
      activeWorkItemId: "session-7",
      openFilePath: "src/main.ts",
    });
    expect(onWork.sessionId).toBe("session-7");
    expect(onWork.openFile).toBeNull();

    const onFiles = composeCurrentViewState({
      ...base,
      route: "/files",
      activeWorkItemId: "session-7",
      openFilePath: "src/main.ts",
    });
    expect(onFiles.sessionId).toBeNull();
    expect(onFiles.openFile).toBe("src/main.ts");
  });
});

describe("formatCurrentViewState", () => {
  it("renders only the facts it has", () => {
    const markdown = formatCurrentViewState(composeCurrentViewState({
      ...base,
      route: "/prs?tab=github&pr=1237&repoOwner=arul28&repoName=ADE",
      selectedLaneId: "lane-1",
      laneNamesById: { "lane-1": "cto-live-voice" },
    }));
    expect(markdown).toContain("- Project: ADE");
    expect(markdown).toContain("- Tab: prs");
    expect(markdown).toContain("- Lane: cto-live-voice");
    expect(markdown).toContain("- Pull request: arul28/ADE #1237");
    expect(markdown).not.toContain("- Open file");
    expect(markdown).not.toContain("- Work session");
  });

  it("returns null when there is nothing worth attaching", () => {
    expect(formatCurrentViewState(composeCurrentViewState({
      ...base,
      projectName: null,
      projectRoot: null,
    }))).toBeNull();
  });
});
