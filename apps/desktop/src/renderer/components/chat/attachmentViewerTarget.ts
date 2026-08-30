import type { FilesWorkspace } from "../../../shared/types";
import { normalizePathForComparison } from "../../lib/pathUtils";

export type AttachmentViewerTarget = {
  workspaceId: string;
  /** Absolute workspace root, for "open externally" actions in the viewers. */
  rootPath: string;
  /** Workspace-relative, forward-slash path the Files APIs expect. */
  relativePath: string;
};

/** Split on both separators so a Windows attachment path resolves too. */
function segments(value: string): string[] {
  return value.split(/[\\/]+/).filter((part) => part.length > 0);
}

/**
 * Does the attachment path start with this root, segment for segment?
 *
 * The comparison itself is delegated to `normalizePathForComparison`, the same
 * helper every other Files-side path equality check in the renderer uses, so a
 * Windows root is folded and a POSIX one is not — matching how the two
 * filesystems actually behave. The segment split stays because the caller needs
 * the relative tail, and because comparing joined segments is what makes
 * `/a/ADE-backup` fail against `/a/ADE` instead of passing a string prefix.
 */
function isPathPrefix(rootSegments: string[], pathSegments: string[]): boolean {
  if (rootSegments.length > pathSegments.length) return false;
  return normalizePathForComparison(rootSegments.join("/"))
    === normalizePathForComparison(pathSegments.slice(0, rootSegments.length).join("/"));
}

/**
 * Locate a chat attachment inside a Files workspace so the Files-tab viewers
 * can open it.
 *
 * Attachments live at `<projectRoot>/.ade/attachments/<uuid><ext>`, which is
 * inside the primary workspace — so this is a containment question, not a new
 * capability. Resolving it on the client (rather than through
 * `files.openExternalPath`) keeps the whole lookup pin-aware: every Files call
 * that follows takes the same machine binding, so an attachment staged on a
 * paired host is read from THAT host rather than silently resolving against a
 * same-named path on this one.
 *
 * The longest matching root wins, so an attachment inside a lane worktree
 * resolves to the lane's workspace instead of the project that contains it.
 */
export function resolveAttachmentWorkspaceTarget(
  attachmentPath: string,
  workspaces: readonly FilesWorkspace[],
): AttachmentViewerTarget | null {
  const pathSegments = segments(attachmentPath);
  if (!pathSegments.length) return null;

  let best: AttachmentViewerTarget | null = null;
  let bestDepth = -1;
  for (const workspace of workspaces) {
    const rootSegments = segments(workspace.rootPath ?? "");
    if (!rootSegments.length) continue;
    if (rootSegments.length >= pathSegments.length) continue;
    if (!isPathPrefix(rootSegments, pathSegments)) continue;
    if (rootSegments.length <= bestDepth) continue;
    bestDepth = rootSegments.length;
    best = {
      workspaceId: workspace.id,
      rootPath: workspace.rootPath,
      relativePath: pathSegments.slice(rootSegments.length).join("/"),
    };
  }
  return best;
}
