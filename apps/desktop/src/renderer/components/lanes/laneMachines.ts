/**
 * Machine options for lane creation.
 *
 * A lane owns its machine: `lanes.worktree_path` is an absolute path on exactly
 * one machine, and chats inherit their machine through `laneId`. Lane creation
 * is therefore the only place a machine is chosen, and this module derives the
 * list of choices.
 *
 * Everything here is a pure derivation over the remote-runtime connection
 * snapshot the renderer already receives — no polling, no IPC round trip. When
 * a machine doesn't report free-disk headroom we render the row without a size
 * rather than fetching one.
 *
 * Naming rule: machines are named absolutely ("This Mac", "MacBook Pro (97)").
 * The word "remote" is never user-visible here — inside the create-lane dialog
 * it already means the git base-branch source ("Use fetched upstream").
 */

import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import type { RemoteRuntimeConnectionStatus } from "../../../shared/types";

/** Stable id for the machine ADE itself is running on. */
export const THIS_MACHINE_ID = "this-mac";
/** Absolute display name for the machine ADE itself is running on. */
export const THIS_MACHINE_NAME = "This Mac";

/**
 * Free-disk headroom below which a machine row reads as a warning. Matches the
 * `warningBytes` threshold the main-process disk-pressure monitor uses.
 */
export const LANE_MACHINE_LOW_DISK_BYTES = 12 * 1024 ** 3;

/**
 * Whether a machine holds a checkout of the repo lanes are being created for.
 * `unknown` means we could not prove it either way from in-memory state; such
 * machines stay selectable because absence of proof is not proof of absence.
 */
export type LaneMachineRepoMatch = "matched" | "missing" | "unknown";

export type LaneMachineProjectRef = {
  /** Project id on the owning machine; null for local projects. */
  projectId: string | null;
  rootPath: string;
  displayName: string;
};

export type LaneMachineOption = {
  /** `THIS_MACHINE_ID`, or the remote-runtime target id. */
  id: string;
  /** Absolute machine name, e.g. "This Mac" or "MacBook Pro (97)". */
  name: string;
  /** Remote-runtime target id; null for the machine ADE runs on. */
  targetId: string | null;
  hostname: string | null;
  /** ADE version reported by the machine, when known. */
  version: string | null;
  /** Free disk headroom, when the snapshot already carries it. Never fetched. */
  freeBytes: number | null;
  repoMatch: LaneMachineRepoMatch;
  /** The machine's checkout of this repo, when we could resolve it. */
  project: LaneMachineProjectRef | null;
  /** True for the machine the active project is currently bound to. */
  isBound: boolean;
};

export type LaneMachineDerivationInput = {
  /** Connections from the remote-runtime snapshot; only `connected` are listed. */
  connections: readonly RemoteRuntimeConnectionStatus[];
  /** Target id of the machine the active project is bound to; null = this Mac. */
  boundTargetId: string | null;
  /** The bound machine's checkout of this repo, from the active project binding. */
  boundProject?: LaneMachineProjectRef | null;
  /** `origin` URL of the repo lanes are created for, when known. */
  repoOriginUrl?: string | null;
  /** Repo folder name — the fallback identity when no origin URL is known. */
  repoDisplayName?: string | null;
  /** Local project roots already open in this window (in-memory state only). */
  localProjectRoots?: readonly string[];
  /** Free disk headroom on this Mac, when a caller already has it. */
  thisMachineFreeBytes?: number | null;
};

/**
 * `normalizeGitRemoteIdentity` is a URL/regex parse; machine lists re-derive on
 * every snapshot tick, so results are cached by raw URL.
 */
const IDENTITY_CACHE_LIMIT = 256;
const identityCache = new Map<string, string | null>();

export function cachedGitRemoteIdentity(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  const cached = identityCache.get(url);
  if (cached !== undefined) return cached;
  const identity = normalizeGitRemoteIdentity(url);
  // Bounded cache: a renderer session sees a handful of origins, and clearing
  // wholesale keeps this a plain Map without LRU bookkeeping.
  if (identityCache.size >= IDENTITY_CACHE_LIMIT) identityCache.clear();
  identityCache.set(url, identity);
  return identity;
}

/** Test seam — the identity cache is module state. */
export function resetGitRemoteIdentityCache(): void {
  identityCache.clear();
}

function pathBaseName(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function sameRepoName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Free-disk headroom as reported by the connection snapshot. Hosts that don't
 * report storage simply render without a size — we never fetch one, and this
 * lights up automatically once the transport carries it.
 */
type ConnectionStorageLike = { freeBytes?: number | null } | null | undefined;

function connectionFreeBytes(connection: RemoteRuntimeConnectionStatus): number | null {
  const storage = (connection as RemoteRuntimeConnectionStatus & { storage?: ConnectionStorageLike })
    .storage;
  const value = storage?.freeBytes;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveProjectMatch(
  projects: ReadonlyArray<{
    projectId: string;
    rootPath: string;
    displayName: string;
    gitOriginUrl: string | null;
  }>,
  repoIdentity: string | null,
  repoDisplayName: string | null,
): LaneMachineProjectRef | null {
  if (repoIdentity) {
    const byOrigin = projects.find(
      (project) => cachedGitRemoteIdentity(project.gitOriginUrl) === repoIdentity,
    );
    if (byOrigin) {
      return {
        projectId: byOrigin.projectId,
        rootPath: byOrigin.rootPath,
        displayName: byOrigin.displayName,
      };
    }
  }
  const byName = projects.find(
    (project) =>
      sameRepoName(project.displayName, repoDisplayName)
      || sameRepoName(pathBaseName(project.rootPath), repoDisplayName),
  );
  if (!byName) return null;
  return {
    projectId: byName.projectId,
    rootPath: byName.rootPath,
    displayName: byName.displayName,
  };
}

function repoMatchFor(
  project: LaneMachineProjectRef | null,
  canProveAbsence: boolean,
): LaneMachineRepoMatch {
  if (project) return "matched";
  return canProveAbsence ? "missing" : "unknown";
}

/**
 * This Mac. Its checkout can't be matched by git origin — local projects aren't
 * in the connection snapshot — so it matches on the repo folder name against
 * the project tabs already open in this window.
 */
function thisMachineOption(input: LaneMachineDerivationInput): LaneMachineOption {
  const isBound = input.boundTargetId === null;
  const repoDisplayName = input.repoDisplayName ?? null;
  const localRoots = input.localProjectRoots ?? [];
  let project: LaneMachineProjectRef | null = isBound ? (input.boundProject ?? null) : null;
  if (!project) {
    const matchedRoot = localRoots.find((rootPath) =>
      sameRepoName(pathBaseName(rootPath), repoDisplayName),
    );
    if (matchedRoot) {
      project = {
        projectId: null,
        rootPath: matchedRoot,
        displayName: pathBaseName(matchedRoot),
      };
    }
  }
  // We can only claim the repo is absent from this Mac when we know what we're
  // looking for and have the local project list to look in.
  const canProveAbsence = !isBound && !!repoDisplayName && localRoots.length > 0;
  const freeBytes = input.thisMachineFreeBytes;
  return {
    id: THIS_MACHINE_ID,
    name: THIS_MACHINE_NAME,
    targetId: null,
    hostname: null,
    version: null,
    freeBytes:
      typeof freeBytes === "number" && Number.isFinite(freeBytes) && freeBytes >= 0
        ? freeBytes
        : null,
    repoMatch: isBound ? "matched" : repoMatchFor(project, canProveAbsence),
    project,
    isBound,
  };
}

/**
 * Connected machines a lane can be created on, this Mac first. Machines that
 * are pairing, erroring, or idle are omitted entirely — you can only create a
 * lane on a machine ADE is talking to right now.
 */
export function deriveLaneMachineOptions(
  input: LaneMachineDerivationInput,
): LaneMachineOption[] {
  const repoIdentity = cachedGitRemoteIdentity(input.repoOriginUrl);
  const repoDisplayName = input.repoDisplayName ?? null;
  const options: LaneMachineOption[] = [thisMachineOption(input)];

  for (const connection of input.connections) {
    if (connection.state !== "connected") continue;
    const isBound = input.boundTargetId === connection.target.id;
    const matched = resolveProjectMatch(connection.projects ?? [], repoIdentity, repoDisplayName);
    const project = isBound ? (input.boundProject ?? matched) : matched;
    options.push({
      id: connection.target.id,
      name: connection.target.name,
      targetId: connection.target.id,
      hostname: connection.target.hostname ?? null,
      version: connection.version ?? null,
      freeBytes: connectionFreeBytes(connection),
      repoMatch: isBound
        ? "matched"
        : repoMatchFor(project, !!repoIdentity || !!repoDisplayName),
      project,
      isBound,
    });
  }

  return options;
}

/** The machine a freshly opened create-lane dialog should start on. */
export function defaultLaneMachineId(options: readonly LaneMachineOption[]): string {
  return (options.find((option) => option.isBound) ?? options[0])?.id ?? THIS_MACHINE_ID;
}

/** A machine can host a new lane unless we know the repo isn't there. */
export function canCreateLaneOnMachine(option: LaneMachineOption): boolean {
  return option.repoMatch !== "missing";
}

/** True when the machine's free-disk headroom should read as a warning. */
export function isLowLaneMachineDisk(freeBytes: number | null): boolean {
  return typeof freeBytes === "number" && freeBytes <= LANE_MACHINE_LOW_DISK_BYTES;
}
