import type { GroupsState } from "./editorGroupsStore";
import type { MonacoModelRegistry } from "../monacoModelRegistry";

/** Collect workspace-relative paths for every open tab across editor groups. */
export function collectOpenTabPaths(groupsState: GroupsState): string[] {
  const paths = new Set<string>();
  for (const groupId of groupsState.groupOrder) {
    const group = groupsState.groups[groupId];
    if (!group) continue;
    for (const tab of group.tabs) paths.add(tab.path);
  }
  return [...paths];
}

/** Build the tab snapshot consumed by `replaceDirtyBuffersForWorkspace`. */
export function buildDirtyBufferTabs(
  openPaths: readonly string[],
  registry: Pick<MonacoModelRegistry, "getValue" | "getSavedValue">,
): ReadonlyArray<{ path: string; content: string; savedContent: string }> {
  return openPaths.map((path) => {
    const content = registry.getValue(path) ?? "";
    const savedContent = registry.getSavedValue(path) ?? content;
    return { path, content, savedContent };
  });
}
