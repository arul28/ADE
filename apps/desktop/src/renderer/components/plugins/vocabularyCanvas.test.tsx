/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { VocabCanvas } from "./vocabularyCanvas";
import type { VocabRenderContext } from "./vocabularyComponents";
import type { PluginCollectionRow } from "../../lib/pluginRuntimeBridge";
import {
  VOCAB_LIMITS,
  bindingKey,
  type VocabCanvasNode,
  type VocabListNode,
} from "../../../shared/plugins/vocabulary";
import { PLUGIN_BUILTIN_SURFACE_OWNER_IDS } from "../../../shared/plugins/builtinSurfaceRegistry";
import { useAppStore } from "../../state/appStore";
import type { OpenProjectBinding, ProjectInfo } from "../../../shared/types";

const LOCAL_PROJECT: ProjectInfo = {
  rootPath: "/repo",
  displayName: "repo",
  baseRef: "main",
};

/**
 * The four promises a canvas makes that its engines cannot make for themselves.
 *
 * 1. A press goes through the SAME runner every other control uses, so a
 *    `confirm` is asked and a refused dispatch becomes a line, not an unhandled
 *    rejection.
 * 2. A compiled host page is drawn only for the plugin that owns it.
 * 3. A compiled host page does not stream while its tab is hidden.
 * 4. Rows are paged, and the canvas says so — the same contract a `list` keeps.
 */

vi.mock("../graph/WorkspaceGraphPage", () => ({
  WorkspaceGraphPage: ({ active }: { active?: boolean }) =>
    React.createElement("div", { "data-testid": "workspace-graph-page" }, String(active)),
}));

vi.mock("../chat/ChatAppControlPanel", () => ({
  ChatAppControlPanel: (props: { runtimePin?: unknown; projectRoot?: string | null }) =>
    React.createElement(
      "div",
      {
        "data-testid": "chat-app-control-panel",
        "data-runtime-pin": props.runtimePin ? String((props.runtimePin as { key: string }).key) : "none",
        "data-project-root": props.projectRoot ?? "none",
      },
      "electron control",
    ),
}));

vi.mock("../chat/ChatIosSimulatorPanel", () => ({
  ChatIosSimulatorPanel: (props: { runtimePin?: unknown; projectRoot?: string | null }) =>
    React.createElement(
      "div",
      {
        "data-testid": "chat-ios-simulator-panel",
        "data-runtime-pin": props.runtimePin ? String((props.runtimePin as { key: string }).key) : "none",
        "data-project-root": props.projectRoot ?? "none",
      },
      "simulator",
    ),
}));

const LOCAL_BINDING: OpenProjectBinding = {
  kind: "local",
  key: "local:/repo",
  rootPath: "/repo",
  displayName: "repo",
};

const REMOTE_BINDING: OpenProjectBinding = {
  kind: "remote",
  key: "remote:mac-mini:/srv/repo",
  targetId: "mac-mini",
  runtimeName: "Mac mini",
  projectId: "p1",
  rootPath: "/srv/repo",
  displayName: "repo",
};

function makeContext(overrides: Partial<VocabRenderContext> = {}): VocabRenderContext {
  return {
    pluginId: "test-plugin",
    rowsByBinding: new Map<string, PluginCollectionRow[]>(),
    dispatch: vi.fn(async () => {}),
    active: true,
    state: {},
    setStateValue: vi.fn(),
    declarations: [],
    selection: {},
    selectionDeclarations: [],
    toggleRow: vi.fn(),
    clearSelection: vi.fn(),
    groupOpen: (node) => node.defaultOpen ?? true,
    toggleGroup: vi.fn(),
    listPage: () => 1,
    showMoreListRows: vi.fn(),
    ...overrides,
  };
}

function commitRows(count: number): Map<string, PluginCollectionRow[]> {
  const rows: PluginCollectionRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const sha = `sha${String(index).padStart(6, "0")}`;
    rows.push({
      key: sha,
      value: {
        title: `Commit ${index}`,
        sha,
        shortSha: sha.slice(0, 7),
        parents: [],
        authorName: "Ada",
        authoredAt: "2026-09-01T00:00:00Z",
      },
    } as PluginCollectionRow);
  }
  return new Map([[bindingKey({ collection: "commits" }), rows]]);
}

const GIT_DAG: VocabCanvasNode = {
  component: "canvas",
  engine: "git-dag",
  bind: { collection: "commits" },
  onSelect: { action: "openCommit" },
};

beforeEach(() => {
  useAppStore.setState({ projectBinding: LOCAL_BINDING, project: LOCAL_PROJECT });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({ projectBinding: null, project: null });
});

describe("a canvas row presses through the one action runner", () => {
  it("asks a bound row's confirmation before dispatching, and drops the action when refused", async () => {
    const dispatch = vi.fn(async () => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <VocabCanvas
        node={{
          ...GIT_DAG,
          onSelect: { action: "openCommit", confirm: "Really open it?" },
        }}
        context={makeContext({ dispatch, rowsByBinding: commitRows(1) })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Commit 0/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("Really open it?"));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("dispatches once the reader confirms", async () => {
    const dispatch = vi.fn(async () => {});
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <VocabCanvas
        node={{
          ...GIT_DAG,
          onSelect: { action: "openCommit", confirm: "Really open it?" },
        }}
        context={makeContext({ dispatch, rowsByBinding: commitRows(1) })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Commit 0/ }));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "openCommit", args: expect.objectContaining({ id: "sha000000" }) }),
    );
  });

  /**
   * The canvas used to drop the returned promise, so the host's refusal reached
   * the reader as an unhandled rejection in the console and as nothing at all
   * on screen.
   */
  it("shows the host's own words when the dispatch is refused", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("That action is not allowed here.");
    });
    render(
      <VocabCanvas
        node={GIT_DAG}
        context={makeContext({ dispatch, rowsByBinding: commitRows(1) })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Commit 0/ }));
    expect(await screen.findByText("That action is not allowed here.")).toBeTruthy();
  });
});

describe("only the owner plugin mounts a compiled host page", () => {
  it("draws the bound rows as a list when a stranger names `simulator`", () => {
    const rowsByBinding = new Map<string, PluginCollectionRow[]>([
      [bindingKey({ collection: "status" }), [
        { key: "s1", value: { title: "Booted: iPhone 17" } } as PluginCollectionRow,
      ]],
    ]);
    render(
      <VocabCanvas
        node={{ component: "canvas", engine: "simulator", bind: { collection: "status" } }}
        context={makeContext({ pluginId: "ade-log-viewer", rowsByBinding })}
      />,
    );

    expect(screen.queryByTestId("chat-ios-simulator-panel")).toBeNull();
    expect(document.querySelector('[data-vocab-canvas="simulator"]')).toBeNull();
    // The honest fallback is the same picture the phone and the terminal draw.
    expect(screen.getByText("Booted: iPhone 17")).toBeTruthy();
  });

  it("mounts the pane for the registered owner", async () => {
    render(
      <VocabCanvas
        node={{ component: "canvas", engine: "simulator", bind: { collection: "status" } }}
        context={makeContext({ pluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.ios })}
      />,
    );
    expect(await screen.findByTestId("chat-ios-simulator-panel")).toBeTruthy();
  });

  it("refuses `workspace` and `electron-control` to a stranger too", () => {
    const { unmount } = render(
      <VocabCanvas
        node={{ component: "canvas", engine: "workspace", bind: { collection: "lanes" } }}
        context={makeContext({ pluginId: "ade-ios-sim" })}
      />,
    );
    expect(screen.queryByTestId("workspace-graph-page")).toBeNull();
    unmount();

    render(
      <VocabCanvas
        node={{ component: "canvas", engine: "electron-control", bind: { collection: "status" } }}
        context={makeContext({ pluginId: "ade-graph" })}
      />,
    );
    expect(screen.queryByTestId("chat-app-control-panel")).toBeNull();
  });

  it("keeps the drawing engines open to every plugin", () => {
    render(
      <VocabCanvas
        node={GIT_DAG}
        context={makeContext({ pluginId: "ade-log-viewer", rowsByBinding: commitRows(1) })}
      />,
    );
    expect(document.querySelector('[data-vocab-canvas="git-dag"]')).toBeTruthy();
  });
});

describe("a hidden tab does not stream", () => {
  it("leaves the Simulator pane unmounted while the panel is inactive", () => {
    render(
      <VocabCanvas
        node={{ component: "canvas", engine: "simulator", bind: { collection: "status" } }}
        context={makeContext({ pluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.ios, active: false })}
      />,
    );
    expect(screen.queryByTestId("chat-ios-simulator-panel")).toBeNull();
    expect(document.querySelector('[data-vocab-canvas="simulator"]')).toBeTruthy();
  });

  it("leaves the Control pane unmounted while the panel is inactive", () => {
    render(
      <VocabCanvas
        node={{ component: "canvas", engine: "electron-control", bind: { collection: "status" } }}
        context={makeContext({ pluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS["app-control"], active: false })}
      />,
    );
    expect(screen.queryByTestId("chat-app-control-panel")).toBeNull();
  });
});

describe("the pane binds the machine the project is on", () => {
  it("hands the remote binding to the pane instead of silently using this host", async () => {
    useAppStore.setState({ projectBinding: REMOTE_BINDING });
    render(
      <VocabCanvas
        node={{ component: "canvas", engine: "electron-control", bind: { collection: "status" } }}
        context={makeContext({ pluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS["app-control"] })}
      />,
    );
    const panel = await screen.findByTestId("chat-app-control-panel");
    expect(panel.getAttribute("data-runtime-pin")).toBe(REMOTE_BINDING.key);
    expect(panel.getAttribute("data-project-root")).toBe("/srv/repo");
  });

  it("needs no pin for a local checkout, and passes the project root", async () => {
    render(
      <VocabCanvas
        node={{ component: "canvas", engine: "electron-control", bind: { collection: "status" } }}
        context={makeContext({ pluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS["app-control"] })}
      />,
    );
    const panel = await screen.findByTestId("chat-app-control-panel");
    expect(panel.getAttribute("data-runtime-pin")).toBe("none");
    expect(panel.getAttribute("data-project-root")).toBe("/repo");
  });

  it("says which machine it cannot find rather than mounting against the local one", () => {
    useAppStore.setState({ projectBinding: null });
    render(
      <VocabCanvas
        node={{ component: "canvas", engine: "simulator", bind: { collection: "status" } }}
        context={makeContext({ pluginId: PLUGIN_BUILTIN_SURFACE_OWNER_IDS.ios })}
      />,
    );
    expect(screen.queryByTestId("chat-ios-simulator-panel")).toBeNull();
    expect(screen.getByText(/cannot tell which machine/)).toBeTruthy();
  });
});

describe("canvas rows are paged, like list rows", () => {
  const overCount = VOCAB_LIMITS.listPageSize + 20;

  it("draws one page and says how many of how many", () => {
    render(
      <VocabCanvas
        node={GIT_DAG}
        context={makeContext({ rowsByBinding: commitRows(overCount) })}
      />,
    );
    expect(screen.getAllByRole("button", { name: /Commit/ })).toHaveLength(VOCAB_LIMITS.listPageSize);
    expect(screen.getByText(`Showing ${VOCAB_LIMITS.listPageSize} of ${overCount}`)).toBeTruthy();
  });

  it("asks the host for another page under the same key the list uses", () => {
    const showMoreListRows = vi.fn();
    render(
      <VocabCanvas
        node={GIT_DAG}
        context={makeContext({ rowsByBinding: commitRows(overCount), showMoreListRows })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(showMoreListRows).toHaveBeenCalledTimes(1);
    const [node, total] = showMoreListRows.mock.calls[0] as [VocabListNode, number];
    // Keyed on the binding, so paging a canvas and paging the list it falls
    // back to are the same reader on the same rows.
    expect(node.bind).toEqual(GIT_DAG.bind);
    expect(total).toBe(overCount);
  });

  it("draws the second page when the host says the reader asked for one", () => {
    render(
      <VocabCanvas
        node={GIT_DAG}
        context={makeContext({ rowsByBinding: commitRows(overCount), listPage: () => 2 })}
      />,
    );
    expect(screen.getAllByRole("button", { name: /Commit/ })).toHaveLength(overCount);
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("says nothing when everything held is already drawn", () => {
    render(
      <VocabCanvas
        node={GIT_DAG}
        context={makeContext({ rowsByBinding: commitRows(3) })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.queryByText(/Showing/)).toBeNull();
  });
});
