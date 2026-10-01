/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RemoteOpenProjectBinding } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { insertIndexAtClientX } from "./useProjectTabDrag";
import { useProjectTabLifecycle } from "./useProjectTabLifecycle";
import type { ProjectTabGroup } from "./projectTabGrouping";

vi.mock("../ui/dialog/confirm", () => ({
  confirmDialog: vi.fn(async () => true),
}));

function group(bindingKey: string, displayName = bindingKey): ProjectTabGroup {
  return {
    id: bindingKey,
    displayName,
    machines: [
      {
        bindingKey,
        machineId: "local",
        machineName: "This machine",
        isLocal: true,
        rootPath: bindingKey,
        displayName,
        exists: true,
      },
    ],
    activeBindingKey: null,
  };
}

function renderLifecycle(groups: ProjectTabGroup[]) {
  const tabGroupsRef = { current: groups };
  const openProjectTabRootsRef = { current: groups.map((entry) => entry.machines[0]!.bindingKey) };
  const openRemoteProjectTabsRef = { current: [] as RemoteOpenProjectBinding[] };
  const setTabOrder = vi.fn();
  const checkForActiveWorkloads = vi.fn(async () => true);
  const view = renderHook(() =>
    useProjectTabLifecycle({
      tabGroupsRef,
      openProjectTabRootsRef,
      openRemoteProjectTabsRef,
      setTabOrder,
      checkForActiveWorkloads,
      isProjectBusy: false,
    }),
  );
  return { ...view, tabGroupsRef, openProjectTabRootsRef, setTabOrder, checkForActiveWorkloads };
}

async function close(
  lifecycle: { result: { current: ReturnType<typeof useProjectTabLifecycle> } },
  ids: string[],
  opts: { confirm?: boolean; checkWorkloads?: boolean; forgetState?: boolean } = {},
) {
  let result = false;
  await act(async () => {
    result = await lifecycle.result.current.closeTabGroups(ids, {
      confirm: opts.confirm ?? false,
      checkWorkloads: opts.checkWorkloads ?? false,
      forgetState: opts.forgetState ?? false,
    });
  });
  return result;
}

function setActive(root: string, roots: string[]) {
  useAppStore.setState({
    project: { rootPath: root, displayName: root } as never,
    projectBinding: {
      kind: "local",
      key: `local:${root}`,
      rootPath: root,
      displayName: root,
    } as never,
    openProjectTabRoots: roots,
    openRemoteProjectTabs: [],
  } as never);
}

describe("useProjectTabLifecycle.closeTabGroups", () => {
  beforeEach(() => {
    useAppStore.setState({
      project: { rootPath: "/a", displayName: "A" } as never,
      projectBinding: {
        kind: "local",
        key: "local:/a",
        rootPath: "/a",
        displayName: "A",
      } as never,
      openProjectTabRoots: [],
      openRemoteProjectTabs: [],
      switchProjectToPath: vi.fn(async () => undefined),
      switchRemoteProject: vi.fn(async () => ({}) as never),
      closeProject: vi.fn(async () => undefined),
      evictProjectState: vi.fn(),
    } as never);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("activates the nearest tab to the right when the active tab closes", async () => {
    setActive("/b", ["/a", "/b", "/c"]);
    const lifecycle = renderLifecycle([group("/a"), group("/b"), group("/c")]);

    const closed = await close(lifecycle, ["/b"]);

    expect(closed).toBe(true);
    expect(useAppStore.getState().switchProjectToPath).toHaveBeenCalledWith("/c");
    expect(useAppStore.getState().openProjectTabRoots).toEqual(["/a", "/c"]);
  });

  it("falls back to the nearest tab to the left when nothing is to the right", async () => {
    setActive("/b", ["/a", "/b"]);
    const lifecycle = renderLifecycle([group("/a"), group("/b")]);

    await close(lifecycle, ["/b"]);

    expect(useAppStore.getState().switchProjectToPath).toHaveBeenCalledWith("/a");
    expect(useAppStore.getState().openProjectTabRoots).toEqual(["/a"]);
  });

  it("closes the project when the last tab is removed", async () => {
    setActive("/a", ["/a"]);
    const lifecycle = renderLifecycle([group("/a")]);

    await close(lifecycle, ["/a"]);

    expect(useAppStore.getState().closeProject).toHaveBeenCalled();
    expect(useAppStore.getState().switchProjectToPath).not.toHaveBeenCalled();
    expect(useAppStore.getState().openProjectTabRoots).toEqual([]);
  });

  it("keeps the tabs when switching to the survivor fails", async () => {
    setActive("/b", ["/a", "/b", "/c"]);
    (useAppStore.getState().switchProjectToPath as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("switch failed"),
    );
    const lifecycle = renderLifecycle([group("/a"), group("/b"), group("/c")]);

    const closed = await close(lifecycle, ["/b"]);

    expect(closed).toBe(false);
    expect(useAppStore.getState().openProjectTabRoots).toEqual(["/a", "/b", "/c"]);
  });

  it("removes closed tabs that do not include the active tab without switching", async () => {
    setActive("/a", ["/a", "/b", "/c"]);
    const lifecycle = renderLifecycle([group("/a"), group("/b"), group("/c")]);

    const closed = await close(lifecycle, ["/b", "/c"]);

    expect(closed).toBe(true);
    expect(useAppStore.getState().switchProjectToPath).not.toHaveBeenCalled();
    expect(useAppStore.getState().openProjectTabRoots).toEqual(["/a"]);
  });
});

describe("insertIndexAtClientX", () => {
  function strip(entries: Array<{ key: string; left: number; width: number }>) {
    const container = document.createElement("div");
    for (const entry of entries) {
      const tab = document.createElement("div");
      tab.setAttribute("data-project-tab-key", entry.key);
      tab.getBoundingClientRect = () =>
        ({
          left: entry.left,
          right: entry.left + entry.width,
          width: entry.width,
          top: 0,
          bottom: 0,
          height: 0,
          x: entry.left,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      container.appendChild(tab);
    }
    return container;
  }

  it("returns the index of the first tab whose midpoint is right of the drop", () => {
    const container = strip([
      { key: "a", left: 0, width: 100 },
      { key: "b", left: 100, width: 100 },
      { key: "c", left: 200, width: 100 },
    ]);

    expect(insertIndexAtClientX(container, 90, "z")).toBe(1);
    expect(insertIndexAtClientX(container, 260, "z")).toBe(3);
    // Excluding the dragged tab removes it from the count, not just its slot.
    expect(insertIndexAtClientX(container, 260, "c")).toBe(2);
  });
});
