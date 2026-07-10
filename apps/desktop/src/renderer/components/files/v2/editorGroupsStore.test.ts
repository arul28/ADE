import { describe, expect, it } from "vitest";
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  createInitialGroupsState,
  cycleTab,
  editorTabId,
  type EditorTab,
  type GroupsState,
  isTabOpenInGroups,
  mergeLegacyLaneSessions,
  moveTabToGroup,
  openInGroup,
  pinTab,
  promoteFromPreview,
  splitGroup,
  splitTabToNewGroup,
  upgradeLegacySession,
  useEditorGroupsStore,
} from "./editorGroupsStore";

const WS_A = "workspace-a";
const WS_B = "workspace-b";
const LANE_A = "lane-a";
const LANE_B = "lane-b";

function tab(
  path: string,
  overrides: Partial<EditorTab> & { workspaceId?: string; laneId?: string | null } = {},
): EditorTab {
  const workspaceId = overrides.workspaceId ?? WS_A;
  const laneId = overrides.laneId !== undefined ? overrides.laneId : LANE_A;
  const { workspaceId: _ws, laneId: _lane, ...rest } = overrides;
  return {
    id: editorTabId(workspaceId, path),
    workspaceId,
    laneId,
    path,
    title: path.split("/").pop() ?? path,
    viewerKind: "code",
    languageId: "typescript",
    preview: false,
    pinned: false,
    ...rest,
  };
}

const g1 = "group-1";
function group(state: GroupsState, id = g1) {
  return state.groups[id]!;
}

describe("editorGroupsStore reducers", () => {
  it("opens tabs and tracks the active tab", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = openInGroup(state, g1, tab("b.ts"));

    expect(group(state).tabs.map((t) => t.path)).toEqual(["a.ts", "b.ts"]);
    expect(group(state).activeTabId).toBe(editorTabId(WS_A, "b.ts"));
  });

  it("allows the same path in different workspaces", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("shared.ts", { workspaceId: WS_A, laneId: LANE_A }));
    state = openInGroup(state, g1, tab("shared.ts", { workspaceId: WS_B, laneId: LANE_B }));

    expect(group(state).tabs).toHaveLength(2);
    expect(group(state).tabs.map((t) => t.id)).toEqual([
      editorTabId(WS_A, "shared.ts"),
      editorTabId(WS_B, "shared.ts"),
    ]);
  });

  it("reuses a single preview slot instead of growing the strip", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"), { preview: true });
    state = openInGroup(state, g1, tab("b.ts"), { preview: true });

    expect(group(state).tabs.map((t) => t.path)).toEqual(["b.ts"]);
    expect(group(state).tabs[0]!.preview).toBe(true);
  });

  it("keeps pinned and non-preview tabs when opening previews", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("keep.ts"));
    state = openInGroup(state, g1, tab("p1.ts"), { preview: true });
    state = openInGroup(state, g1, tab("p2.ts"), { preview: true });

    expect(group(state).tabs.map((t) => t.path)).toEqual(["keep.ts", "p2.ts"]);
  });

  it("promotes a preview tab to permanent on edit, and pins explicitly", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts", { preview: true });
    state = openInGroup(state, g1, a, { preview: true });
    state = promoteFromPreview(state, g1, a.id);
    expect(group(state).tabs[0]!.preview).toBe(false);

    const b = tab("b.ts", { preview: true });
    state = openInGroup(state, g1, b, { preview: true });
    state = pinTab(state, g1, b.id);
    expect(group(state).tabs.find((t) => t.path === "b.ts")).toMatchObject({ pinned: true, preview: false });
  });

  it("re-opening an open file as non-preview clears its preview flag", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    state = openInGroup(state, g1, a, { preview: true });
    state = openInGroup(state, g1, a, { preview: false });
    expect(group(state).tabs).toHaveLength(1);
    expect(group(state).tabs[0]!.preview).toBe(false);
  });

  it("falls back to the most-recently-used tab when closing the active one", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    const b = tab("b.ts");
    const c = tab("c.ts");
    state = openInGroup(state, g1, a);
    state = openInGroup(state, g1, b);
    state = openInGroup(state, g1, c);
    state = activateTab(state, g1, a.id);
    state = activateTab(state, g1, b.id);
    state = closeTab(state, g1, b.id);

    expect(group(state).activeTabId).toBe(a.id);
    expect(group(state).tabs.map((t) => t.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("closeOtherTabs keeps the target and pinned tabs", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    const b = tab("b.ts");
    const c = tab("c.ts");
    state = openInGroup(state, g1, a);
    state = openInGroup(state, g1, b);
    state = openInGroup(state, g1, c);
    state = pinTab(state, g1, a.id);
    state = closeOtherTabs(state, g1, c.id);

    expect(group(state).tabs.map((t) => t.path).sort()).toEqual(["a.ts", "c.ts"]);
    expect(group(state).activeTabId).toBe(c.id);
  });

  it("splits into a new group seeded with the active tab", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    state = openInGroup(state, g1, a);
    state = splitGroup(state, g1);

    expect(state.groupOrder).toHaveLength(2);
    const newId = state.groupOrder[1]!;
    expect(state.activeGroupId).toBe(newId);
    expect(group(state, newId).tabs.map((t) => t.path)).toEqual(["a.ts"]);
    expect(group(state, g1).tabs.map((t) => t.path)).toEqual(["a.ts"]);
  });

  it("moves a tab between groups and removes an emptied source group", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    const b = tab("b.ts");
    state = openInGroup(state, g1, a);
    state = splitGroup(state, g1);
    const g2 = state.groupOrder[1]!;
    state = openInGroup(state, g2, b);

    state = moveTabToGroup(state, g2, g1, b.id);
    expect(group(state, g1).tabs.map((t) => t.path)).toEqual(["a.ts", "b.ts"]);
    expect(group(state, g2).tabs.map((t) => t.path)).toEqual(["a.ts"]);
    expect(state.groupOrder).toHaveLength(2);
  });

  it("removes the group when its last tab moves away", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    state = openInGroup(state, g1, a);
    state = splitGroup(state, g1);
    const g2 = state.groupOrder[1]!;
    state = moveTabToGroup(state, g2, g1, a.id);
    expect(state.groupOrder).toEqual([g1]);
    expect(state.groups[g2]).toBeUndefined();
    expect(state.activeGroupId).toBe(g1);
  });

  it("drag-splits a tab into a new group on the requested side", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    const b = tab("b.ts");
    state = openInGroup(state, g1, a);
    state = openInGroup(state, g1, b);
    state = splitTabToNewGroup(state, g1, b.id, g1, "right");

    expect(state.groupOrder).toHaveLength(2);
    const newId = state.groupOrder[1]!;
    expect(state.groupOrder).toEqual([g1, newId]);
    expect(group(state, g1).tabs.map((t) => t.path)).toEqual(["a.ts"]);
    expect(group(state, newId).tabs.map((t) => t.path)).toEqual(["b.ts"]);
    expect(state.activeGroupId).toBe(newId);
  });

  it("drag-split to the left inserts the new group before the anchor", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    const b = tab("b.ts");
    state = openInGroup(state, g1, a);
    state = openInGroup(state, g1, b);
    state = splitTabToNewGroup(state, g1, b.id, g1, "left");
    const newId = state.groupOrder[0]!;
    expect(state.groupOrder).toEqual([newId, g1]);
    expect(group(state, newId).tabs.map((t) => t.path)).toEqual(["b.ts"]);
  });

  it("drag-split is a no-op when the source group has a single tab", () => {
    let state = createInitialGroupsState();
    const only = tab("only.ts");
    state = openInGroup(state, g1, only);
    const next = splitTabToNewGroup(state, g1, only.id, g1, "right");
    expect(next).toBe(state);
    expect(next.groupOrder).toEqual([g1]);
  });

  it("cycles tabs by document order", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    const b = tab("b.ts");
    const c = tab("c.ts");
    state = openInGroup(state, g1, a);
    state = openInGroup(state, g1, b);
    state = openInGroup(state, g1, c);
    state = cycleTab(state, g1, 1);
    expect(group(state).activeTabId).toBe(a.id);
    state = cycleTab(state, g1, -1);
    expect(group(state).activeTabId).toBe(c.id);
  });

  it("closing the only tab keeps the sole group present but empty", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    state = openInGroup(state, g1, a);
    state = closeTab(state, g1, a.id);
    expect(state.groupOrder).toEqual([g1]);
    expect(group(state).tabs).toEqual([]);
    expect(group(state).activeTabId).toBeNull();
  });

  it("remaps stale workspace ids, dedupes collisions, and preserves the active tab", () => {
    const sessionKey = "project-session";
    const stale = tab("same.ts", { workspaceId: "stale-workspace", laneId: LANE_B });
    const authoritative = tab("same.ts", { workspaceId: WS_B, laneId: LANE_B });
    const external = tab("outside.ts", {
      id: "preserved-external-tab-id",
      workspaceId: "external-local:outside",
      laneId: null,
    });
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, stale);
    state = openInGroup(state, g1, authoritative);
    state = openInGroup(state, g1, external);
    state = activateTab(state, g1, stale.id);
    useEditorGroupsStore.setState({ sessions: { [sessionKey]: state } });

    const mappedWorkspaceIds: string[] = [];
    const tabIdChanges = useEditorGroupsStore.getState().remapTabWorkspaces(sessionKey, (candidate) => {
      mappedWorkspaceIds.push(candidate.workspaceId);
      return candidate.workspaceId === stale.workspaceId ? WS_B : candidate.workspaceId;
    });
    const remapped = useEditorGroupsStore.getState().getSession(sessionKey)!;

    expect(group(remapped).tabs).toEqual([authoritative, external]);
    expect(group(remapped).activeTabId).toBe(authoritative.id);
    expect(group(remapped).recentTabIds).toEqual([authoritative.id, external.id]);
    expect(tabIdChanges.get(stale.id)).toBe(authoritative.id);
    expect(mappedWorkspaceIds).not.toContain(external.workspaceId);

    useEditorGroupsStore.setState({ sessions: {} });
  });

  it("merges simple legacy per-lane sessions into one tab strip", () => {
    const sessionA = openInGroup(createInitialGroupsState(), g1, tab("a.ts", { workspaceId: WS_A }));
    const sessionB = openInGroup(createInitialGroupsState(), g1, tab("b.ts", { workspaceId: WS_B }));
    const merged = mergeLegacyLaneSessions([sessionA, sessionB]);
    expect(merged.groups[g1]!.tabs.map((t) => t.path).sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("preserves duplicate split panes during legacy session merge", () => {
    const existing = openInGroup(createInitialGroupsState(), g1, tab("existing.ts", { workspaceId: WS_B }));
    let splitSession = openInGroup(createInitialGroupsState(), g1, tab("split.ts", { workspaceId: WS_A }));
    splitSession = splitGroup(splitSession, g1);

    const merged = mergeLegacyLaneSessions([existing, splitSession]);
    const splitTabId = editorTabId(WS_A, "split.ts");
    const groupsWithSplitTab = Object.values(merged.groups).filter((entry) =>
      entry.tabs.some((entryTab) => entryTab.id === splitTabId),
    );

    expect(groupsWithSplitTab).toHaveLength(2);
    expect(groupsWithSplitTab.every((entry) => entry.activeTabId === splitTabId)).toBe(true);
  });

  it("upgrades legacy path-based session fields to tab ids", () => {
    const legacy = createInitialGroupsState();
    legacy.groups[g1] = {
      id: g1,
      tabs: [
        {
          path: "src/legacy.ts",
          title: "legacy.ts",
          viewerKind: "code",
          languageId: "typescript",
          preview: false,
          pinned: false,
        } as EditorTab,
      ],
      activeTabId: "src/legacy.ts",
      recentTabIds: ["src/legacy.ts"],
    };

    const upgraded = upgradeLegacySession(legacy, WS_B, LANE_B);
    const upgradedTabId = editorTabId(WS_B, "src/legacy.ts");

    expect(group(upgraded).tabs[0]).toMatchObject({
      id: upgradedTabId,
      workspaceId: WS_B,
      laneId: LANE_B,
      path: "src/legacy.ts",
    });
    expect(group(upgraded).activeTabId).toBe(upgradedTabId);
    expect(group(upgraded).recentTabIds).toEqual([upgradedTabId]);
  });

  it("isTabOpenInGroups detects duplicate split panes", () => {
    let state = createInitialGroupsState();
    const a = tab("a.ts");
    state = openInGroup(state, g1, a);
    state = splitGroup(state, g1);
    expect(isTabOpenInGroups(state, a.id)).toBe(true);
    state = closeTab(state, state.groupOrder[1]!, a.id);
    expect(isTabOpenInGroups(state, a.id)).toBe(true);
    state = closeTab(state, g1, a.id);
    expect(isTabOpenInGroups(state, a.id)).toBe(false);
  });
});
