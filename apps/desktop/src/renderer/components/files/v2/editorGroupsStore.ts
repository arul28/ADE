import { create } from "zustand";

/**
 * Editor-groups state for the v2 Files workbench.
 *
 * The store owns group *membership* (which tabs live in which group, which is
 * active, preview/pin flags). It does NOT own the split layout tree — that is
 * persisted per-lane by PaneTilingLayout via `window.ade.tilingTree`, keeping a
 * single source of truth for geometry. Tab *content* is not stored here either;
 * it lives in the Monaco model registry / is streamed on demand.
 *
 * All mutation logic is expressed as pure reducer functions (exported for unit
 * tests); the Zustand store is a thin wrapper that applies them per project-level
 * `sessionKey`, so open tabs persist across lane switches.
 */

export type ViewerKind =
  | "code"
  | "image"
  | "markdown"
  | "csv"
  | "pdf"
  | "audio"
  | "video"
  | "document"
  | "largeText"
  | "binary"
  | "diff"
  | "conflict";

export type EditorTab = {
  /** Composite identity: `${workspaceId}::${path}`. */
  id: string;
  workspaceId: string;
  laneId: string | null;
  /** Workspace-relative path. */
  path: string;
  title: string;
  viewerKind: ViewerKind;
  languageId: string;
  /** Reused single-click "preview" slot (italic); at most one per group. */
  preview: boolean;
  /** Explicitly pinned (survives preview reuse / close-others). */
  pinned: boolean;
};

export function editorTabId(workspaceId: string, path: string): string {
  return `${workspaceId}::${path}`;
}

export type EditorGroup = {
  id: string;
  tabs: EditorTab[];
  /** Active tab id, or null when the group is empty. */
  activeTabId: string | null;
  /** Most-recently-active tab ids (front = most recent) for Ctrl+Tab + close fallback. */
  recentTabIds: string[];
};

export type GroupsState = {
  groups: Record<string, EditorGroup>;
  groupOrder: string[];
  activeGroupId: string;
};

const FIRST_GROUP_ID = "group-1";

export function createInitialGroupsState(): GroupsState {
  return {
    groups: { [FIRST_GROUP_ID]: { id: FIRST_GROUP_ID, tabs: [], activeTabId: null, recentTabIds: [] } },
    groupOrder: [FIRST_GROUP_ID],
    activeGroupId: FIRST_GROUP_ID,
  };
}

function nextGroupId(state: GroupsState): string {
  let n = state.groupOrder.length + 1;
  while (state.groups[`group-${n}`]) n += 1;
  return `group-${n}`;
}

function touchRecent(recent: string[], tabId: string): string[] {
  return [tabId, ...recent.filter((id) => id !== tabId)];
}

function withGroup(state: GroupsState, groupId: string, update: (g: EditorGroup) => EditorGroup): GroupsState {
  const group = state.groups[groupId];
  if (!group) return state;
  return { ...state, groups: { ...state.groups, [groupId]: update(group) } };
}

/** Recompute a sensible active tab after the current one is removed. */
function pickActiveAfterRemoval(group: EditorGroup, removedTabId: string): string | null {
  const recentCandidate = group.recentTabIds.find(
    (id) => id !== removedTabId && group.tabs.some((t) => t.id === id),
  );
  if (recentCandidate) return recentCandidate;
  const remaining = group.tabs.filter((t) => t.id !== removedTabId);
  return remaining[remaining.length - 1]?.id ?? null;
}

export function openInGroup(
  state: GroupsState,
  groupId: string,
  tab: EditorTab,
  opts: { preview?: boolean } = {},
): GroupsState {
  const group = state.groups[groupId];
  if (!group) return state;
  const preview = opts.preview ?? false;
  const existing = group.tabs.find((t) => t.id === tab.id);

  let nextTabs: EditorTab[];
  if (existing) {
    // Already open: opening non-preview promotes it out of the preview slot.
    nextTabs = group.tabs.map((t) =>
      t.id === tab.id ? { ...t, preview: preview ? t.preview : false } : t,
    );
  } else if (preview) {
    // Replace the existing preview slot (if any) rather than growing the strip.
    const previewIdx = group.tabs.findIndex((t) => t.preview && !t.pinned);
    const newTab: EditorTab = { ...tab, preview: true, pinned: false };
    if (previewIdx >= 0) {
      nextTabs = group.tabs.map((t, i) => (i === previewIdx ? newTab : t));
    } else {
      nextTabs = [...group.tabs, newTab];
    }
  } else {
    nextTabs = [...group.tabs, { ...tab, preview: false }];
  }

  return {
    ...withGroup(state, groupId, (g) => ({
      ...g,
      tabs: nextTabs,
      activeTabId: tab.id,
      recentTabIds: touchRecent(g.recentTabIds, tab.id),
    })),
    activeGroupId: groupId,
  };
}

export function activateTab(state: GroupsState, groupId: string, tabId: string): GroupsState {
  return {
    ...withGroup(state, groupId, (g) =>
      g.tabs.some((t) => t.id === tabId)
        ? { ...g, activeTabId: tabId, recentTabIds: touchRecent(g.recentTabIds, tabId) }
        : g,
    ),
    activeGroupId: state.groups[groupId] ? groupId : state.activeGroupId,
  };
}

export function pinTab(state: GroupsState, groupId: string, tabId: string): GroupsState {
  return withGroup(state, groupId, (g) => ({
    ...g,
    tabs: g.tabs.map((t) => (t.id === tabId ? { ...t, pinned: true, preview: false } : t)),
  }));
}

/** First edit promotes a preview tab to a permanent (non-preview) tab. */
export function promoteFromPreview(state: GroupsState, groupId: string, tabId: string): GroupsState {
  return withGroup(state, groupId, (g) => ({
    ...g,
    tabs: g.tabs.map((t) => (t.id === tabId && t.preview ? { ...t, preview: false } : t)),
  }));
}

export function closeTab(state: GroupsState, groupId: string, tabId: string): GroupsState {
  const group = state.groups[groupId];
  if (!group || !group.tabs.some((t) => t.id === tabId)) return state;

  const nextTabs = group.tabs.filter((t) => t.id !== tabId);
  const nextActive = group.activeTabId === tabId ? pickActiveAfterRemoval(group, tabId) : group.activeTabId;
  const updatedGroup: EditorGroup = {
    ...group,
    tabs: nextTabs,
    activeTabId: nextActive,
    recentTabIds: group.recentTabIds.filter((id) => id !== tabId),
  };

  // Remove an emptied group unless it is the only one.
  if (nextTabs.length === 0 && state.groupOrder.length > 1) {
    const nextOrder = state.groupOrder.filter((id) => id !== groupId);
    const nextGroups = { ...state.groups };
    delete nextGroups[groupId];
    const nextActiveGroup = state.activeGroupId === groupId ? nextOrder[nextOrder.length - 1]! : state.activeGroupId;
    return { groups: nextGroups, groupOrder: nextOrder, activeGroupId: nextActiveGroup };
  }

  return { ...state, groups: { ...state.groups, [groupId]: updatedGroup } };
}

export function closeOtherTabs(state: GroupsState, groupId: string, keepTabId: string): GroupsState {
  return withGroup(state, groupId, (g) => {
    const kept = g.tabs.filter((t) => t.id === keepTabId || t.pinned);
    return {
      ...g,
      tabs: kept,
      activeTabId: kept.some((t) => t.id === keepTabId) ? keepTabId : kept[kept.length - 1]?.id ?? null,
      recentTabIds: g.recentTabIds.filter((id) => kept.some((t) => t.id === id)),
    };
  });
}

export function isTabOpenInGroups(state: GroupsState, tabId: string): boolean {
  return Object.values(state.groups).some((group) => group.tabs.some((tab) => tab.id === tabId));
}

/** Split: create a new group to the side seeded with the source group's active tab. */
export function splitGroup(state: GroupsState, fromGroupId: string): GroupsState {
  const from = state.groups[fromGroupId];
  if (!from || !from.activeTabId) return state;
  const seedTab = from.tabs.find((t) => t.id === from.activeTabId);
  if (!seedTab) return state;

  const newId = nextGroupId(state);
  const newGroup: EditorGroup = {
    id: newId,
    tabs: [{ ...seedTab, preview: false }],
    activeTabId: seedTab.id,
    recentTabIds: [seedTab.id],
  };
  const fromIdx = state.groupOrder.indexOf(fromGroupId);
  const nextOrder = [...state.groupOrder];
  nextOrder.splice(fromIdx + 1, 0, newId);
  return {
    groups: { ...state.groups, [newId]: newGroup },
    groupOrder: nextOrder,
    activeGroupId: newId,
  };
}

export function moveTabToGroup(
  state: GroupsState,
  fromGroupId: string,
  toGroupId: string,
  tabId: string,
): GroupsState {
  if (fromGroupId === toGroupId) return activateTab(state, toGroupId, tabId);
  const from = state.groups[fromGroupId];
  const to = state.groups[toGroupId];
  if (!from || !to) return state;
  const tab = from.tabs.find((t) => t.id === tabId);
  if (!tab) return state;

  // Remove from source (closeTab handles emptied-group removal + active fallback).
  let next = closeTab(state, fromGroupId, tabId);
  // Source group may have been removed; only re-add if target still exists.
  if (!next.groups[toGroupId]) return next;
  next = openInGroup(next, toGroupId, { ...tab, preview: false }, { preview: false });
  return next;
}

/**
 * Drag-a-tab-to-split: move a tab out of its group into a NEW group placed to the
 * `side` of `anchorGroupId`. No-op when the source has a single tab (there's
 * nothing left to keep, so it isn't a split). The dragged tab is removed from the
 * source (which may itself collapse if it empties and isn't the only group).
 */
export function splitTabToNewGroup(
  state: GroupsState,
  fromGroupId: string,
  tabId: string,
  anchorGroupId: string,
  side: "left" | "right",
): GroupsState {
  const from = state.groups[fromGroupId];
  if (!from) return state;
  const tab = from.tabs.find((t) => t.id === tabId);
  if (!tab) return state;
  if (from.tabs.length <= 1 && fromGroupId === anchorGroupId) return state; // nothing to split off

  const newId = nextGroupId(state);
  const newGroup: EditorGroup = {
    id: newId,
    tabs: [{ ...tab, preview: false }],
    activeTabId: tab.id,
    recentTabIds: [tab.id],
  };

  // Remove the tab from its source (collapses an emptied, non-sole group).
  const afterClose = closeTab(state, fromGroupId, tabId);
  const order = [...afterClose.groupOrder];
  const anchorIdx = order.indexOf(anchorGroupId);
  const insertAt = anchorIdx < 0 ? order.length : side === "left" ? anchorIdx : anchorIdx + 1;
  order.splice(insertAt, 0, newId);

  return {
    groups: { ...afterClose.groups, [newId]: newGroup },
    groupOrder: order,
    activeGroupId: newId,
  };
}

export function focusGroup(state: GroupsState, groupId: string): GroupsState {
  return state.groups[groupId] ? { ...state, activeGroupId: groupId } : state;
}

/** Ctrl+Tab style cycle through a group's tabs by MRU order. */
export function cycleTab(state: GroupsState, groupId: string, direction: 1 | -1): GroupsState {
  const group = state.groups[groupId];
  if (!group || group.tabs.length < 2) return state;
  const order = group.tabs.map((t) => t.id);
  const currentIdx = group.activeTabId ? order.indexOf(group.activeTabId) : 0;
  const nextIdx = (currentIdx + direction + order.length) % order.length;
  return activateTab(state, groupId, order[nextIdx]!);
}

/** Upgrade tabs from legacy per-lane sessions that only stored `path`. */
export function upgradeLegacySession(
  session: GroupsState,
  workspaceId: string,
  laneId: string | null,
): GroupsState {
  let next = session;
  for (const groupId of session.groupOrder) {
    const group = session.groups[groupId];
    if (!group) continue;
    const upgradedTabs = group.tabs.map((raw) => {
      const partial = raw as Partial<EditorTab> & { path: string };
      const id = partial.id ?? editorTabId(workspaceId, partial.path);
      return {
        id,
        workspaceId: partial.workspaceId ?? workspaceId,
        laneId: partial.laneId !== undefined ? partial.laneId : laneId,
        path: partial.path,
        title: partial.title ?? partial.path.split("/").pop() ?? partial.path,
        viewerKind: partial.viewerKind ?? "code",
        languageId: partial.languageId ?? "plaintext",
        preview: partial.preview ?? false,
        pinned: partial.pinned ?? false,
      } satisfies EditorTab;
    });
    const pathToId = new Map(upgradedTabs.map((t) => [t.path, t.id]));
    const activeTabId = group.activeTabId
      ? (pathToId.get(group.activeTabId) ?? group.activeTabId)
      : null;
    const recentTabIds = group.recentTabIds.map((entry) => pathToId.get(entry) ?? entry);
    next = withGroup(next, groupId, () => ({
      ...group,
      tabs: upgradedTabs,
      activeTabId,
      recentTabIds,
    }));
  }
  return next;
}

/** Merge tabs from legacy per-lane sessions into a single project-level state. */
export function mergeLegacyLaneSessions(sessions: GroupsState[]): GroupsState {
  if (sessions.length === 0) return createInitialGroupsState();
  if (sessions.length === 1) return sessions[0]!;

  let merged = createInitialGroupsState();
  const ensureTargetGroup = (state: GroupsState, useSharedGroup: boolean): { state: GroupsState; groupId: string } => {
    if (useSharedGroup) return { state, groupId: FIRST_GROUP_ID };
    const firstGroup = state.groups[FIRST_GROUP_ID];
    if (state.groupOrder.length === 1 && firstGroup && firstGroup.tabs.length === 0) {
      return { state, groupId: FIRST_GROUP_ID };
    }
    const groupId = nextGroupId(state);
    return {
      state: {
        ...state,
        groups: {
          ...state.groups,
          [groupId]: { id: groupId, tabs: [], activeTabId: null, recentTabIds: [] },
        },
        groupOrder: [...state.groupOrder, groupId],
      },
      groupId,
    };
  };

  const restoreGroupSelection = (state: GroupsState, groupId: string, sourceGroup: EditorGroup): GroupsState => {
    const targetGroup = state.groups[groupId];
    if (!targetGroup) return state;
    const tabIds = new Set(targetGroup.tabs.map((tab) => tab.id));
    const sourceRecent = sourceGroup.recentTabIds.filter((tabId) => tabIds.has(tabId));
    const generatedRecent = targetGroup.recentTabIds.filter((tabId) => tabIds.has(tabId) && !sourceRecent.includes(tabId));
    const activeTabId = sourceGroup.activeTabId && tabIds.has(sourceGroup.activeTabId)
      ? sourceGroup.activeTabId
      : targetGroup.activeTabId;
    return {
      ...state,
      activeGroupId: activeTabId ? groupId : state.activeGroupId,
      groups: {
        ...state.groups,
        [groupId]: {
          ...targetGroup,
          activeTabId,
          recentTabIds: [...sourceRecent, ...generatedRecent],
        },
      },
    };
  };

  for (const session of sessions) {
    const sourceGroups = session.groupOrder
      .map((groupId) => session.groups[groupId])
      .filter((group): group is EditorGroup => Boolean(group && group.tabs.length > 0));
    const preserveSourceGroups = sourceGroups.length > 1;
    for (const group of sourceGroups) {
      const target = ensureTargetGroup(merged, !preserveSourceGroups);
      merged = target.state;
      for (const tab of group.tabs) {
        merged = openInGroup(merged, target.groupId, tab, { preview: false });
      }
      merged = restoreGroupSelection(merged, target.groupId, group);
    }
  }
  return merged;
}

/* ---- Zustand store: one GroupsState per sessionKey ---- */

type EditorGroupsStore = {
  sessions: Record<string, GroupsState>;
  ensureSession: (sessionKey: string) => GroupsState;
  getSession: (sessionKey: string) => GroupsState | undefined;
  apply: (sessionKey: string, reducer: (state: GroupsState) => GroupsState) => void;
  resetSession: (sessionKey: string) => void;
};

export const useEditorGroupsStore = create<EditorGroupsStore>((set, get) => ({
  sessions: {},
  ensureSession: (sessionKey) => {
    const existing = get().sessions[sessionKey];
    if (existing) return existing;
    const created = createInitialGroupsState();
    set((s) => ({ sessions: { ...s.sessions, [sessionKey]: created } }));
    return created;
  },
  getSession: (sessionKey) => get().sessions[sessionKey],
  apply: (sessionKey, reducer) =>
    set((s) => {
      const current = s.sessions[sessionKey] ?? createInitialGroupsState();
      return { sessions: { ...s.sessions, [sessionKey]: reducer(current) } };
    }),
  resetSession: (sessionKey) =>
    set((s) => ({ sessions: { ...s.sessions, [sessionKey]: createInitialGroupsState() } })),
}));
