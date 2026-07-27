/**
 * Resolving "This Mac" back to *this repository's* local checkout.
 *
 * The machine picker in the composer and in the Chats tab is a dimension of ONE
 * repo's tab: picking a machine is supposed to show you the same repository on
 * a different machine. Both surfaces used to resolve "This Mac" as
 *
 *     openProjectTabRoots[0] ?? localProjectRootPath
 *
 * which is the first local tab in insertion order — an unrelated repository
 * whenever you have more than one open, and (when the tab is bound to another
 * machine) `localProjectRootPath` is that machine's root path, not a local one.
 * Selecting a machine would then silently switch the window to a different
 * repo. This resolves the local counterpart by repo identity instead, and
 * refuses to switch when there isn't one.
 *
 * A local counterpart is accepted only when its recent-project git origin
 * matches the bound remote project's origin. Folder names are display data,
 * never repository identity.
 */

import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
import type { OpenProjectBinding, RecentProjectSummary } from "../../../shared/types";

export type ThisMachineProjectRootResult =
  | { ok: true; rootPath: string }
  /** No local checkout of this repo — the caller must not switch anything. */
  | { ok: false; message: string };

/**
 * Same shape as the create-lane dialog's machine-switch failure: name the
 * machine absolutely and say what to do about it.
 */
export const THIS_MACHINE_PROJECT_MISSING_MESSAGE =
  `Open this repository on ${THIS_MACHINE_NAME} first, then switch back here.`;

export function resolveThisMachineProjectRoot(input: {
  projectBinding: OpenProjectBinding | null;
  /** Local project roots open in this window. */
  openProjectTabRoots: readonly string[];
  /** `project.rootPath` from the store — only a local path when unbound. */
  localProjectRootPath: string | null;
  /** Verified origin reported by the bound remote runtime. */
  boundRepoOriginUrl?: string | null;
  /** Local recent-project rows include host-read git origin metadata. */
  recentProjects?: readonly RecentProjectSummary[];
}): ThisMachineProjectRootResult {
  const {
    projectBinding,
    openProjectTabRoots,
    localProjectRootPath,
    boundRepoOriginUrl,
    recentProjects = [],
  } = input;

  // Already on this Mac: the bound root IS the answer.
  if (projectBinding?.kind === "local") {
    return { ok: true, rootPath: projectBinding.rootPath };
  }
  if (!projectBinding) {
    // No binding at all — the open project, if any, is local by construction.
    return localProjectRootPath
      ? { ok: true, rootPath: localProjectRootPath }
      : { ok: false, message: THIS_MACHINE_PROJECT_MISSING_MESSAGE };
  }

  const boundIdentity = normalizeGitRemoteIdentity(boundRepoOriginUrl);
  if (!boundIdentity) {
    return { ok: false, message: THIS_MACHINE_PROJECT_MISSING_MESSAGE };
  }
  const openRoots = new Set(openProjectTabRoots);
  const matched = recentProjects.find((recent) =>
    recent.kind !== "remote"
    && recent.exists
    && openRoots.has(recent.rootPath)
    && recent.rootPath !== projectBinding.rootPath
    && normalizeGitRemoteIdentity(recent.gitOriginUrl) === boundIdentity);
  return matched
    ? { ok: true, rootPath: matched.rootPath }
    : { ok: false, message: THIS_MACHINE_PROJECT_MISSING_MESSAGE };
}

export async function switchToThisMachineProject(input: {
  projectBinding: OpenProjectBinding | null;
  openProjectTabRoots: readonly string[];
  localProjectRootPath: string | null;
  switchProjectToPath: (rootPath: string) => Promise<unknown>;
}): Promise<string | null> {
  let identityInput: Pick<
    Parameters<typeof resolveThisMachineProjectRoot>[0],
    "boundRepoOriginUrl" | "recentProjects"
  > = {};
  if (input.projectBinding?.kind === "remote") {
    try {
      const [snapshot, recentProjects] = await Promise.all([
        window.ade.remoteRuntime.getConnectionSnapshot(),
        window.ade.project.listRecent(),
      ]);
      const connection = snapshot.connections.find(
        (candidate) => candidate.target.id === input.projectBinding?.targetId,
      );
      const project = connection?.projects.find(
        (candidate) => candidate.projectId === input.projectBinding?.projectId,
      );
      identityInput = {
        boundRepoOriginUrl: project?.gitOriginUrl ?? null,
        recentProjects,
      };
    } catch {
      return THIS_MACHINE_PROJECT_MISSING_MESSAGE;
    }
  }
  const resolved = resolveThisMachineProjectRoot({ ...input, ...identityInput });
  if (!resolved.ok) return resolved.message;
  try {
    await input.switchProjectToPath(resolved.rootPath);
    return null;
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}
