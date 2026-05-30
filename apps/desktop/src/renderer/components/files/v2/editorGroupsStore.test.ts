import { describe, expect, it } from "vitest";
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  createInitialGroupsState,
  cycleTab,
  type EditorTab,
  type GroupsState,
  moveTabToGroup,
  openInGroup,
  pinTab,
  promoteFromPreview,
  splitGroup,
  splitTabToNewGroup,
} from "./editorGroupsStore";

function tab(path: string, overrides: Partial<EditorTab> = {}): EditorTab {
  return {
    path,
    title: path.split("/").pop() ?? path,
    viewerKind: "code",
    languageId: "typescript",
    preview: false,
    pinned: false,
    ...overrides,
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
    expect(group(state).activeTabId).toBe("b.ts");
  });

  it("reuses a single preview slot instead of growing the strip", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"), { preview: true });
    state = openInGroup(state, g1, tab("b.ts"), { preview: true });

    // The preview tab was replaced, not appended.
    expect(group(state).tabs.map((t) => t.path)).toEqual(["b.ts"]);
    expect(group(state).tabs[0]!.preview).toBe(true);
  });

  it("keeps pinned and non-preview tabs when opening previews", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("keep.ts")); // permanent
    state = openInGroup(state, g1, tab("p1.ts"), { preview: true });
    state = openInGroup(state, g1, tab("p2.ts"), { preview: true });

    expect(group(state).tabs.map((t) => t.path)).toEqual(["keep.ts", "p2.ts"]);
  });

  it("promotes a preview tab to permanent on edit, and pins explicitly", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"), { preview: true });
    state = promoteFromPreview(state, g1, "a.ts");
    expect(group(state).tabs[0]!.preview).toBe(false);

    state = openInGroup(state, g1, tab("b.ts"), { preview: true });
    state = pinTab(state, g1, "b.ts");
    expect(group(state).tabs.find((t) => t.path === "b.ts")).toMatchObject({ pinned: true, preview: false });
  });

  it("re-opening an open file as non-preview clears its preview flag", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"), { preview: true });
    state = openInGroup(state, g1, tab("a.ts"), { preview: false });
    expect(group(state).tabs).toHaveLength(1);
    expect(group(state).tabs[0]!.preview).toBe(false);
  });

  it("falls back to the most-recently-used tab when closing the active one", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = openInGroup(state, g1, tab("b.ts"));
    state = openInGroup(state, g1, tab("c.ts"));
    state = activateTab(state, g1, "a.ts"); // MRU: a, c, b
    state = activateTab(state, g1, "b.ts"); // MRU: b, a, c
    state = closeTab(state, g1, "b.ts");

    expect(group(state).activeTabId).toBe("a.ts");
    expect(group(state).tabs.map((t) => t.path)).toEqual(["a.ts", "c.ts"]);
  });

  it("closeOtherTabs keeps the target and pinned tabs", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = openInGroup(state, g1, tab("b.ts"));
    state = openInGroup(state, g1, tab("c.ts"));
    state = pinTab(state, g1, "a.ts");
    state = closeOtherTabs(state, g1, "c.ts");

    expect(group(state).tabs.map((t) => t.path).sort()).toEqual(["a.ts", "c.ts"]);
    expect(group(state).activeTabId).toBe("c.ts");
  });

  it("splits into a new group seeded with the active tab", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = splitGroup(state, g1);

    expect(state.groupOrder).toHaveLength(2);
    const newId = state.groupOrder[1]!;
    expect(state.activeGroupId).toBe(newId);
    expect(group(state, newId).tabs.map((t) => t.path)).toEqual(["a.ts"]);
    // Original group is untouched.
    expect(group(state, g1).tabs.map((t) => t.path)).toEqual(["a.ts"]);
  });

  it("moves a tab between groups and removes an emptied source group", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = splitGroup(state, g1); // new group with a.ts active
    const g2 = state.groupOrder[1]!;
    state = openInGroup(state, g2, tab("b.ts")); // g2 now has a.ts, b.ts

    // Move b.ts back to g1.
    state = moveTabToGroup(state, g2, g1, "b.ts");
    expect(group(state, g1).tabs.map((t) => t.path)).toEqual(["a.ts", "b.ts"]);
    expect(group(state, g2).tabs.map((t) => t.path)).toEqual(["a.ts"]);
    expect(state.groupOrder).toHaveLength(2);
  });

  it("removes the group when its last tab moves away", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = splitGroup(state, g1);
    const g2 = state.groupOrder[1]!;
    // g2 has only a.ts; move it back to g1 → g2 should be removed.
    state = moveTabToGroup(state, g2, g1, "a.ts");
    expect(state.groupOrder).toEqual([g1]);
    expect(state.groups[g2]).toBeUndefined();
    expect(state.activeGroupId).toBe(g1);
  });

  it("drag-splits a tab into a new group on the requested side", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = openInGroup(state, g1, tab("b.ts"));
    // Drag b.ts out to the right of group-1 → new group to the right.
    state = splitTabToNewGroup(state, g1, "b.ts", g1, "right");

    expect(state.groupOrder).toHaveLength(2);
    const newId = state.groupOrder[1]!;
    expect(state.groupOrder).toEqual([g1, newId]); // new group is to the right
    expect(group(state, g1).tabs.map((t) => t.path)).toEqual(["a.ts"]);
    expect(group(state, newId).tabs.map((t) => t.path)).toEqual(["b.ts"]);
    expect(state.activeGroupId).toBe(newId);
  });

  it("drag-split to the left inserts the new group before the anchor", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = openInGroup(state, g1, tab("b.ts"));
    state = splitTabToNewGroup(state, g1, "b.ts", g1, "left");
    const newId = state.groupOrder[0]!;
    expect(state.groupOrder).toEqual([newId, g1]);
    expect(group(state, newId).tabs.map((t) => t.path)).toEqual(["b.ts"]);
  });

  it("drag-split is a no-op when the source group has a single tab", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("only.ts"));
    const next = splitTabToNewGroup(state, g1, "only.ts", g1, "right");
    expect(next).toBe(state);
    expect(next.groupOrder).toEqual([g1]);
  });

  it("cycles tabs by document order", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = openInGroup(state, g1, tab("b.ts"));
    state = openInGroup(state, g1, tab("c.ts")); // active c
    state = cycleTab(state, g1, 1); // wraps to a
    expect(group(state).activeTabId).toBe("a.ts");
    state = cycleTab(state, g1, -1); // back to c
    expect(group(state).activeTabId).toBe("c.ts");
  });

  it("closing the only tab keeps the sole group present but empty", () => {
    let state = createInitialGroupsState();
    state = openInGroup(state, g1, tab("a.ts"));
    state = closeTab(state, g1, "a.ts");
    expect(state.groupOrder).toEqual([g1]);
    expect(group(state).tabs).toEqual([]);
    expect(group(state).activeTabId).toBeNull();
  });
});
