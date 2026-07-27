import type { OpenProjectBinding, RecentProjectSummary } from "./types/core";

/**
 * The renderer namespaces every piece of per-project state (lane caches, lane
 * selection, work view, session caches) by a *binding key*, not by filesystem
 * path — a local checkout and a remote checkout of the same repo are distinct
 * surfaces and must not share cached lanes.
 *
 * This module is the single definition of that key. It previously existed in
 * three places (`globalState.recentProjectKey`, the remote binding constructed
 * in `runtimeBridge`, and `RunPage`'s local `recentKey`), and the copies were
 * free to drift — which is exactly how the warm lane cache ended up being
 * written under one key and read under another.
 */

/** Namespace for a remote project surface. Must match `OpenProjectBinding.key`. */
export function remoteProjectBindingKey(targetId: string, projectId: string): string {
  return `remote:${targetId}:${projectId}`;
}

/** State key for an open project binding. Local projects key by root path. */
export function projectBindingKey(binding: OpenProjectBinding): string {
  return binding.kind === "remote"
    ? remoteProjectBindingKey(binding.targetId, binding.projectId)
    : binding.rootPath;
}

/**
 * State key for anything shaped like a project reference — a recents row, a
 * persisted `RecentProject`, or any other `{ rootPath, remote? }` record. Local
 * projects key by absolute root path, so a remote path string can never collide
 * with a local one.
 */
export function projectRefStateKey(
  proj: { rootPath: string; remote?: { targetId: string; projectId: string } | null },
): string {
  return proj.remote
    ? remoteProjectBindingKey(proj.remote.targetId, proj.remote.projectId)
    : proj.rootPath;
}

/**
 * State key for a recents row. Remote recents must resolve to the same key their
 * open binding would, otherwise cache retention silently drops them: retention
 * protects open remote tabs by binding key while recents contributed only
 * `rootPath`, so a *closed* remote project still in recents lost its warm lane
 * cache on the next project switch.
 */
export function recentProjectStateKey(row: RecentProjectSummary): string {
  return projectRefStateKey(row.kind === "remote" ? row : { rootPath: row.rootPath });
}
