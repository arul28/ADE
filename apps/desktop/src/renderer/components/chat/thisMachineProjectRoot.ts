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
 * The matching itself is `deriveLaneMachineOptions`' "This Mac" rule, reused
 * rather than re-implemented: the bound checkout is the repo by definition, and
 * a local root only counts when its folder name lines up with it.
 */

import {
  deriveLaneMachineOptions,
  THIS_MACHINE_ID,
  THIS_MACHINE_NAME,
  type LaneMachineProjectRef,
} from "../lanes/laneMachines";
import type { OpenProjectBinding } from "../../../shared/types";

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
}): ThisMachineProjectRootResult {
  const { projectBinding, openProjectTabRoots, localProjectRootPath } = input;

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

  const boundProject: LaneMachineProjectRef = {
    // The active binding is this repo by definition — nothing is inferred.
    matchedBy: "origin",
    projectId: projectBinding.projectId,
    rootPath: projectBinding.rootPath,
    displayName: projectBinding.displayName,
  };
  // The bound machine's root path can appear in the local tab roots; it is not
  // a path on this Mac, so it can never be the local counterpart.
  const localRoots = openProjectTabRoots.filter(
    (rootPath) => rootPath !== projectBinding.rootPath,
  );
  const thisMachine = deriveLaneMachineOptions({
    connections: [],
    boundTargetId: projectBinding.targetId,
    boundProject,
    repoDisplayName: projectBinding.displayName,
    localProjectRoots: localRoots,
  }).find((option) => option.id === THIS_MACHINE_ID);

  const rootPath = thisMachine?.project?.rootPath ?? null;
  return rootPath && thisMachine?.project?.matchedBy === "origin"
    ? { ok: true, rootPath }
    : { ok: false, message: THIS_MACHINE_PROJECT_MISSING_MESSAGE };
}

export async function switchToThisMachineProject(input: {
  projectBinding: OpenProjectBinding | null;
  openProjectTabRoots: readonly string[];
  localProjectRootPath: string | null;
  switchProjectToPath: (rootPath: string) => Promise<unknown>;
}): Promise<string | null> {
  const resolved = resolveThisMachineProjectRoot(input);
  if (!resolved.ok) return resolved.message;
  try {
    await input.switchProjectToPath(resolved.rootPath);
    return null;
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
}
