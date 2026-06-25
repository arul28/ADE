/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";

import { getProjectConfigCached, invalidateProjectConfigCache } from "./projectConfigCache";

const pinA = {
  kind: "remote",
  key: "remote:target-a:project-a",
  targetId: "target-a",
  runtimeName: "Remote A",
  projectId: "project-a",
  rootPath: "/same/root",
  displayName: "Project A",
} as const;

const pinB = {
  kind: "remote",
  key: "remote:target-b:project-b",
  targetId: "target-b",
  runtimeName: "Remote B",
  projectId: "project-b",
  rootPath: "/same/root",
  displayName: "Project B",
} as const;

function snapshot(name: string) {
  return { name } as any;
}

describe("projectConfigCache", () => {
  afterEach(() => {
    invalidateProjectConfigCache();
    vi.restoreAllMocks();
    delete (window as any).ade;
  });

  it("keeps pinned reads separate from unpinned reads for the same root", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(snapshot("pinned-a"))
      .mockResolvedValueOnce(snapshot("unpinned"));
    (window as any).ade = { projectConfig: { get } };

    await expect(getProjectConfigCached({ projectRoot: "/same/root", pin: pinA })).resolves.toEqual(snapshot("pinned-a"));
    await expect(getProjectConfigCached({ projectRoot: "/same/root" })).resolves.toEqual(snapshot("unpinned"));
    await expect(getProjectConfigCached({ projectRoot: "/same/root", pin: pinA })).resolves.toEqual(snapshot("pinned-a"));
    await expect(getProjectConfigCached({ projectRoot: "/same/root" })).resolves.toEqual(snapshot("unpinned"));

    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, pinA);
    expect(get).toHaveBeenNthCalledWith(2, undefined);
  });

  it("keys pinned reads by binding when remote roots match", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(snapshot("pinned-a"))
      .mockResolvedValueOnce(snapshot("pinned-b"));
    (window as any).ade = { projectConfig: { get } };

    await expect(getProjectConfigCached({ projectRoot: "/same/root", pin: pinA })).resolves.toEqual(snapshot("pinned-a"));
    await expect(getProjectConfigCached({ projectRoot: "/same/root", pin: pinB })).resolves.toEqual(snapshot("pinned-b"));
    await expect(getProjectConfigCached({ projectRoot: "/same/root", pin: pinA })).resolves.toEqual(snapshot("pinned-a"));

    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, pinA);
    expect(get).toHaveBeenNthCalledWith(2, pinB);
  });
});
