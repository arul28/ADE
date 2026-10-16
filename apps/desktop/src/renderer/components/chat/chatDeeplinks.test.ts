/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import type { DeeplinkTarget } from "../../../shared/deeplinks";
import { ADE_NAVIGATE_TARGET_EVENT, ADE_OPEN_DEEPLINK_EVENT } from "../../lib/openExternal";
import { openChatDeeplinkTarget } from "./chatDeeplinks";

/**
 * A deeplink in a chat has to resolve against the CHAT's lane and machine, not
 * the tab's: a pinned chat's lane is not in the tab's own list, and a link
 * without a lane has nothing to open unless the chat supplies its own.
 */

type Scope = Parameters<typeof openChatDeeplinkTarget>[2];

const REMOTE: Scope = {
  laneId: "lane-9",
  pin: {
    kind: "remote",
    key: "remote:target-1:project-1",
    targetId: "target-1",
    runtimeName: "Remote",
    projectId: "project-1",
    rootPath: "/remote/project",
    displayName: "Project",
  },
};

function captureNavigation(): { targets: unknown[]; stop: () => void } {
  const targets: unknown[] = [];
  const handler = (event: Event) => targets.push((event as CustomEvent<{ target: unknown }>).detail.target);
  window.addEventListener(ADE_NAVIGATE_TARGET_EVENT, handler);
  return { targets, stop: () => window.removeEventListener(ADE_NAVIGATE_TARGET_EVENT, handler) };
}

function captureDeeplink(): { urls: string[]; stop: () => void } {
  const urls: string[] = [];
  const handler = (event: Event) => urls.push((event as CustomEvent<{ url: string }>).detail.url);
  window.addEventListener(ADE_OPEN_DEEPLINK_EVENT, handler);
  return { urls, stop: () => window.removeEventListener(ADE_OPEN_DEEPLINK_EVENT, handler) };
}

describe("openChatDeeplinkTarget", () => {
  it("opens a lane link on the chat's machine and keeps its envelope", () => {
    const { targets, stop } = captureNavigation();
    const target: DeeplinkTarget = { kind: "lane", laneId: "lane-1", envelope: { branch: "feature" } };
    openChatDeeplinkTarget("ade://lane/lane-1?branch=feature", target, REMOTE);
    stop();

    expect(targets).toEqual([
      { kind: "lane", laneId: "lane-1", machineId: "target-1", envelope: { branch: "feature" } },
    ]);
  });

  it("gives a bare commit the chat's own lane and machine", () => {
    const { targets, stop } = captureNavigation();
    openChatDeeplinkTarget("ade://commit/abc123", { kind: "commit", sha: "abc123" }, REMOTE);
    stop();

    expect(targets).toEqual([{ kind: "commit", sha: "abc123", laneId: "lane-9", machineId: "target-1" }]);
  });

  it("does not invent a lane for a commit when the chat has none", () => {
    const { targets, stop } = captureNavigation();
    openChatDeeplinkTarget("ade://commit/abc123", { kind: "commit", sha: "abc123" }, { laneId: null, pin: null });
    stop();

    // Falls through to the generic deeplink route rather than a commit target.
    expect(targets).toEqual([]);
  });

  it("routes a PR with no repo through the in-app PR target", () => {
    const { targets, stop } = captureNavigation();
    openChatDeeplinkTarget("ade://pr/1407", { kind: "pr", prNumber: 1407 }, { laneId: null, pin: null });
    stop();

    expect(targets).toEqual([{ kind: "pr", prNumber: 1407 }]);
  });

  it("passes every other deeplink through verbatim", () => {
    const { urls, stop } = captureDeeplink();
    openChatDeeplinkTarget("ade://artifact/art-1", { kind: "artifact", artifactId: "art-1" }, { laneId: null, pin: null });
    stop();

    expect(urls).toEqual(["ade://artifact/art-1"]);
  });
});
