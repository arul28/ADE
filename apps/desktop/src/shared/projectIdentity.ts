import { normalizeGitRemoteIdentity } from "./crossMachineHandoff";
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

const comparableRootPath = (rootPath: string | null | undefined): string | null =>
  rootPath?.trim().replace(/[\\/]+$/, "") || null;

/**
 * The project a machine lists for a reference to it: by id, then by folder.
 * The folder finds a project that the reference names by an id the machine
 * never had, such as the project database id that saved chats carried before
 * they carried the machine's own id.
 */
export function findMachineProject<T extends { projectId: string; rootPath: string }>(
  projects: readonly T[] | null | undefined,
  ref: { projectId?: string | null; rootPath?: string | null },
): T | null {
  if (!projects?.length) return null;
  const byId = ref.projectId ? projects.find((project) => project.projectId === ref.projectId) : undefined;
  if (byId) return byId;
  const rootPath = comparableRootPath(ref.rootPath);
  if (!rootPath) return null;
  return projects.find((project) => comparableRootPath(project.rootPath) === rootPath) ?? null;
}

/** Which project on a machine: by id, then folder, then the account's project id, then the repository's origin (`pickMachineProject`). */
export type MachineProjectRef = {
  projectId?: string | null;
  rootPath?: string | null;
  originUrl?: string | null;
  accountProjectId?: string | null;
};

/**
 * The project a machine lists for a reference to it, of those still there:
 * by id, then by folder (`findMachineProject`), then by the account's project
 * id (the ADE Cloud tab's pin names the account's project, not the
 * machine's), then by the repository's origin. Main and ADE Web find a chat's
 * project on its machine with this one rule.
 */
export function pickMachineProject<T extends {
  projectId: string;
  rootPath: string;
  exists?: boolean;
  accountProjectId?: string | null;
  gitOriginUrl?: string | null;
}>(
  projects: readonly T[] | null | undefined,
  ref: MachineProjectRef,
): T | null {
  const present = (projects ?? []).filter((project) => project.exists !== false);
  const found = findMachineProject(present, ref);
  if (found) return found;
  const accountProjectId = ref.accountProjectId?.trim();
  const byAccount = accountProjectId ? present.find((project) => project.accountProjectId === accountProjectId) : undefined;
  if (byAccount) return byAccount;
  const origin = normalizeGitRemoteIdentity(ref.originUrl ?? null);
  if (!origin) return null;
  return present.find((project) => normalizeGitRemoteIdentity(project.gitOriginUrl) === origin) ?? null;
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
