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
 * Naming rule: machines are named absolutely ("This computer", "MacBook Pro (97)").
 * The word "remote" is never user-visible here — inside the create-lane dialog
 * it already means the git base-branch source ("Use fetched upstream").
 */

import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { remoteProjectBindingKey } from "../../../shared/projectIdentity";
import type {
  OpenProjectBinding,
  RecentProjectSummary,
  RemoteRuntimeConnectionStatus,
} from "../../../shared/types";

// Machine identity is shared, not per-module: five copies of these constants
// with two different id values is what made the divergence guard able to warn
// that This computer diverged from itself. Re-exported here for existing callers.
import { THIS_MACHINE_ID, THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
export { THIS_MACHINE_ID, THIS_MACHINE_NAME };

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
  /**
   * How this checkout was tied to the current repo. `"origin"` is proof;
   * `"name"` is a guess from the folder name and must not, on its own, drive an
   * action that rebinds the app to this project.
   */
  matchedBy: "origin" | "name";
};

export type LaneMachineOption = {
  /** `THIS_MACHINE_ID`, or the remote-runtime target id. */
  id: string;
  /** Absolute machine name, e.g. "This computer" or "MacBook Pro (97)". */
  name: string;
  /** Remote-runtime target id; null for the machine ADE runs on. */
  targetId: string | null;
  hostname: string | null;
  /** Remote transport; legacy target records default to SSH. */
  transport?: "ssh" | "paired";
  /** ADE version reported by the machine, when known. */
  version: string | null;
  /** Free disk headroom, when the snapshot already carries it. Never fetched. */
  freeBytes: number | null;
  /**
   * Lanes already running on this machine, when the caller already has them.
   * Null means "not counted": it adds no load in the placement comparison and
   * is never read as proof the machine is idle.
   */
  activeLaneCount: number | null;
  repoMatch: LaneMachineRepoMatch;
  /** The machine's checkout of this repo, when we could resolve it. */
  project: LaneMachineProjectRef | null;
  /** True for the machine the active project is currently bound to. */
  isBound: boolean;
};

export type LaneMachineDerivationInput = {
  /** Connections from the remote-runtime snapshot; only `connected` are listed. */
  connections: readonly RemoteRuntimeConnectionStatus[];
  /** Target id of the machine the active project is bound to; null = this computer. */
  boundTargetId: string | null;
  /** The bound machine's checkout of this repo, from the active project binding. */
  boundProject?: LaneMachineProjectRef | null;
  /** `origin` URL of the repo lanes are created for, when known. */
  repoOriginUrl?: string | null;
  /** Repo folder name — the fallback identity when no origin URL is known. */
  repoDisplayName?: string | null;
  /** Local project roots already open in this window (in-memory state only). */
  localProjectRoots?: readonly string[];
  /**
   * Known local projects, including unopened recents. Their git origins let a
   * remote-bound tab address the matching checkout on This computer without forcing
   * the user to open it once just to establish identity.
   */
  localProjects?: readonly RecentProjectSummary[];
  /** Free disk headroom on this computer, when a caller already has it. */
  thisMachineFreeBytes?: number | null;
  /**
   * Lanes already in flight per machine id, when the caller has the
   * cross-machine lane union in hand. Optional: with no counts the placement
   * falls back to free-disk headroom alone, and never treats a missing count
   * as zero.
   */
  machineActiveLaneCounts?: Readonly<Record<string, number | null>> | null;
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

const originByLocalRoot = new Map<string, string>();
const originByRemoteKey = new Map<string, string>();

/**
 * Recents and connection snapshots are the union's origin source. Local tab
 * bindings do not carry `gitOriginUrl`, so Work retain has to look here.
 *
 * `replace: true` is a complete snapshot (`listRecent` / `forgetRecent`):
 * omitted checkouts leave, and a blank origin deletes that key. Incremental
 * connection.projects merges: a proven origin is kept when a snapshot later
 * arrives blank, because a machine that has not reported origin yet is not
 * proof the checkout has none.
 */
export function rememberProjectOriginSummaries(
  projects: readonly Pick<RecentProjectSummary, "rootPath" | "kind" | "remote" | "gitOriginUrl">[],
  options?: { replace?: boolean },
): void {
  if (options?.replace) {
    originByLocalRoot.clear();
    originByRemoteKey.clear();
  }
  for (const project of projects) {
    const origin = (project.gitOriginUrl ?? project.remote?.gitOriginUrl ?? "").trim();
    const remote = project.kind === "remote" ? project.remote : undefined;
    if (remote) {
      const key = remoteProjectBindingKey(remote.targetId, remote.projectId);
      if (origin) originByRemoteKey.set(key, origin);
      else if (options?.replace) originByRemoteKey.delete(key);
      continue;
    }
    if (origin) originByLocalRoot.set(project.rootPath, origin);
    else if (options?.replace) originByLocalRoot.delete(project.rootPath);
  }
}

/** Origin stamped on the binding, else the recents/snapshot identity for that checkout. */
export function originUrlForBinding(
  binding: OpenProjectBinding | null | undefined,
): string | null {
  if (!binding) return null;
  const stamped = typeof binding.gitOriginUrl === "string" ? binding.gitOriginUrl.trim() : "";
  if (stamped) return stamped;
  if (binding.kind === "local") return originByLocalRoot.get(binding.rootPath) ?? null;
  return originByRemoteKey.get(binding.key) ?? null;
}

/** Test seam — origin memory is module state. */
export function resetProjectOriginMemory(): void {
  originByLocalRoot.clear();
  originByRemoteKey.clear();
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
        matchedBy: "origin",
      };
    }
  }
  const byName = projects.find((project) => {
    const nameMatches =
      sameRepoName(project.displayName, repoDisplayName)
      || sameRepoName(pathBaseName(project.rootPath), repoDisplayName);
    if (!nameMatches) return false;
    // A folder name is not an identity. When both sides have a known origin and
    // those origins disagree, matching names are proof the repos are DIFFERENT
    // — `~/src/api` for two unrelated `api` checkouts is common. Selecting such
    // a machine rebinds the whole app tab to the wrong repository, so a
    // contradicted candidate must never be offered as a match.
    const candidateIdentity = cachedGitRemoteIdentity(project.gitOriginUrl);
    if (repoIdentity && candidateIdentity && candidateIdentity !== repoIdentity) return false;
    return true;
  });
  if (!byName) return null;
  return {
    projectId: byName.projectId,
    rootPath: byName.rootPath,
    displayName: byName.displayName,
    // Records that identity was never proven — only the folder name lined up.
    // Callers that mutate global state on selection must not act on this alone.
    matchedBy: "name",
  };
}

function repoMatchFor(
  project: LaneMachineProjectRef | null,
  canProveAbsence: boolean,
): LaneMachineRepoMatch {
  // Only a matching git origin proves two checkouts are the same repository.
  // A folder-name hit is reported as `unknown` — it may well be right, but it
  // is not evidence, and callers that rebind the app on selection must be able
  // to tell the difference.
  if (project) return project.matchedBy === "origin" ? "matched" : "unknown";
  return canProveAbsence ? "missing" : "unknown";
}

/**
 * This computer. Its checkout can't be matched by git origin — local projects aren't
 * in the connection snapshot — so it matches on the repo folder name against
 * the project tabs already open in this window.
 */
function thisMachineOption(input: LaneMachineDerivationInput): LaneMachineOption {
  const isBound = input.boundTargetId === null;
  const repoIdentity = cachedGitRemoteIdentity(input.repoOriginUrl);
  const repoDisplayName = input.repoDisplayName ?? null;
  const localRoots = input.localProjectRoots ?? [];
  let project: LaneMachineProjectRef | null = isBound ? (input.boundProject ?? null) : null;
  if (!project && repoIdentity) {
    const matched = input.localProjects?.find((candidate) =>
      candidate.kind !== "remote"
      && candidate.exists !== false
      && cachedGitRemoteIdentity(candidate.gitOriginUrl) === repoIdentity);
    if (matched) {
      project = {
        projectId: null,
        rootPath: matched.rootPath,
        displayName: matched.displayName,
        matchedBy: "origin",
      };
    }
  }
  // Once the caller supplied an exact repository identity and a catalog of
  // local checkouts, that catalog is authoritative. Falling back to a
  // same-named open folder after it disproved the origin match can route a
  // launch into an unrelated repository.
  const hasAuthoritativeOriginCatalog = Boolean(
    repoIdentity && input.localProjects !== undefined,
  );
  if (!project && !hasAuthoritativeOriginCatalog) {
    const matchedRoot = localRoots.find((rootPath) =>
      sameRepoName(pathBaseName(rootPath), repoDisplayName),
    );
    if (matchedRoot) {
      project = {
        projectId: null,
        rootPath: matchedRoot,
        displayName: pathBaseName(matchedRoot),
        matchedBy: "name",
      };
    }
  }
  // We can only claim the repo is absent from this computer when we know what we're
  // looking for and have the local project list to look in.
  const canProveAbsence = !isBound && (
    repoIdentity
      ? input.localProjects !== undefined
      : !!repoDisplayName && localRoots.length > 0
  );
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
    activeLaneCount: activeLaneCountFor(input, THIS_MACHINE_ID),
    repoMatch: isBound ? "matched" : repoMatchFor(project, canProveAbsence),
    project,
    isBound,
  };
}

/** A count the caller supplied for a machine id, or null when uncounted. */
function activeLaneCountFor(input: LaneMachineDerivationInput, machineId: string): number | null {
  const counts = input.machineActiveLaneCounts;
  if (!counts) return null;
  const value = counts[machineId];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Connected machines a lane can be created on, this computer first. Machines that
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
      transport: connection.target.transport ?? "ssh",
      version: connection.version ?? null,
      freeBytes: connectionFreeBytes(connection),
      activeLaneCount: activeLaneCountFor(input, connection.target.id),
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

/**
 * The machine a load-balanced new lane should land on.
 *
 * Order of judgement: a machine with healthy disk headroom beats one below the
 * warning threshold; fewer already-running lanes beats more; more free disk
 * beats less; and the machine the tab is already bound to wins a true tie, so
 * balance never moves work off the current machine for no reason.
 *
 * Degrades to `defaultLaneMachineId` whenever balancing cannot help: fewer than
 * two machines can host this repo (the one-machine and repo-only-on-one cases),
 * or the option list is empty. Offline machines are already absent — only
 * `connected` connections become options.
 */
export function chooseLaneMachineByLoad(options: readonly LaneMachineOption[]): string {
  const eligible = options.filter(canCreateLaneOnMachine);
  // One machine (or none) is nothing to balance. The single eligible machine is
  // the answer even when it is not the first option — a repo-missing machine
  // must never be chosen just because it sorts first.
  if (eligible.length === 0) return defaultLaneMachineId(options);
  if (eligible.length === 1) return eligible[0]!.id;
  const best = [...eligible].sort(compareLaneMachineLoad)[0];
  return best?.id ?? defaultLaneMachineId(options);
}

function compareLaneMachineLoad(a: LaneMachineOption, b: LaneMachineOption): number {
  const lowDiskDelta = Number(isLowLaneMachineDisk(a.freeBytes)) - Number(isLowLaneMachineDisk(b.freeBytes));
  if (lowDiskDelta !== 0) return lowDiskDelta;
  // A missing count is not a count of zero. Only compare load when BOTH
  // machines report one; otherwise an uncounted machine would sort as idle and
  // win the tie, which the input contract forbids. Fall through to disk.
  if (a.activeLaneCount !== null && b.activeLaneCount !== null) {
    const loadDelta = a.activeLaneCount - b.activeLaneCount;
    if (loadDelta !== 0) return loadDelta;
  }
  const freeDelta = (typeof b.freeBytes === "number" ? b.freeBytes : 0)
    - (typeof a.freeBytes === "number" ? a.freeBytes : 0);
  if (freeDelta !== 0) return freeDelta;
  if (a.isBound !== b.isBound) return a.isBound ? -1 : 1;
  return 0;
}

/** A machine can host a new lane unless we know the repo isn't there. */
export function canCreateLaneOnMachine(option: LaneMachineOption): boolean {
  return option.repoMatch !== "missing";
}

/** True when the machine's free-disk headroom should read as a warning. */
export function isLowLaneMachineDisk(freeBytes: number | null): boolean {
  return typeof freeBytes === "number" && freeBytes <= LANE_MACHINE_LOW_DISK_BYTES;
}
