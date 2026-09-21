import type { FileTreeNode } from "../../../shared/types/files";
import { APPLE_RECORDINGS_RELATIVE_DIR } from "../../../shared/appleDeviceSettings";

/**
 * Total bytes under `<projectRoot>/.ade/artifacts/apple-recordings/`.
 *
 * `iosSimulator.recordingsTotalBytes()` is the answer: the recorder writes a
 * sidecar per recording and already holds every size, so this is one number
 * over one channel. The directory walk below is the FALLBACK — a recursive
 * tree listing through the files API, kept because a runtime older than this
 * channel (a remote Mac that has not been updated) would otherwise report zero
 * and silently retire the warning. Warn-only either way; nothing here deletes.
 */
export function sumFileTreeBytes(nodes: readonly FileTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.type === "file" && typeof node.size === "number" && Number.isFinite(node.size)) {
      total += Math.max(0, node.size);
    }
    if (node.children?.length) total += sumFileTreeBytes(node.children);
  }
  return total;
}

export async function readAppleRecordingsTotalBytes(projectRoot: string): Promise<number> {
  const root = projectRoot.trim();
  const total = await window.ade?.iosSimulator?.recordingsTotalBytes?.({}).catch(() => null);
  if (typeof total === "number" && Number.isFinite(total) && total >= 0) return total;
  const files = window.ade?.files;
  if (!root || !files?.listWorkspaces || !files.listTree) return 0;
  try {
    const workspaces = await files.listWorkspaces();
    const workspace = workspaces.find((entry) => entry.rootPath === root)
      ?? workspaces.find((entry) => entry.kind === "primary")
      ?? workspaces[0];
    if (!workspace) return 0;
    const nodes = await files.listTree({
      workspaceId: workspace.id,
      parentPath: APPLE_RECORDINGS_RELATIVE_DIR,
      depth: 8,
      includeIgnored: true,
    });
    return sumFileTreeBytes(nodes);
  } catch {
    // Missing directory, older preload, or a tree that will not list `.ade`.
    return 0;
  }
}
