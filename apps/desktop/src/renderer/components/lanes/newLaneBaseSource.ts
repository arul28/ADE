import type { NewLaneBaseSource, ProjectConfigSnapshot } from "../../../shared/types";
import { remoteLaneBaseCandidate } from "../../../shared/defaultRemoteLaneBase";
import type { LaneBranchOption } from "./laneUtils";

export const DEFAULT_NEW_LANE_BASE_SOURCE: NewLaneBaseSource = "remote";
export const DEFAULT_NEW_LANE_REMOTE_FETCH_TIMEOUT_MS = 4_000;

export type NewLaneBaseOption = {
  ref: string;
  label: string;
  source: NewLaneBaseSource;
  isCurrent?: boolean;
};

export function effectiveNewLaneBaseSource(snapshot: ProjectConfigSnapshot | null | undefined): NewLaneBaseSource {
  const value = snapshot?.local.git?.newLaneBaseSource
    ?? snapshot?.effective.git?.newLaneBaseSource
    ?? DEFAULT_NEW_LANE_BASE_SOURCE;
  return value === "local" ? "local" : "remote";
}

function remoteRefForLocalBranch(
  branch: LaneBranchOption,
  branches: LaneBranchOption[],
): string | null {
  if (branch.isRemote) return branch.name;
  if (branch.upstream?.trim()) return branch.upstream.trim();
  const originRef = `origin/${branch.name}`;
  if (branches.some((candidate) => candidate.isRemote && candidate.name === originRef)) {
    return originRef;
  }
  return null;
}

export function listNewLaneBaseOptions(
  branches: LaneBranchOption[],
  source: NewLaneBaseSource,
): NewLaneBaseOption[] {
  if (source === "local") {
    return branches
      .filter((branch) => !branch.isRemote)
      .map((branch) => ({
        ref: branch.name,
        label: `${branch.name}${branch.isCurrent ? " (current)" : ""}`,
        source,
        isCurrent: branch.isCurrent,
      }));
  }

  const out: NewLaneBaseOption[] = [];
  const seen = new Set<string>();
  const add = (ref: string, label = ref, isCurrent = false): void => {
    const trimmed = ref.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ ref: trimmed, label, source, isCurrent });
  };

  for (const branch of branches.filter((entry) => !entry.isRemote)) {
    const ref = remoteRefForLocalBranch(branch, branches);
    if (ref) add(ref, `${ref}${branch.isCurrent ? " (tracks current)" : ""}`, branch.isCurrent);
  }
  for (const branch of branches.filter((entry) => entry.isRemote)) {
    add(branch.name);
  }
  return out;
}

export function selectDefaultNewLaneBaseRef(args: {
  branches: LaneBranchOption[];
  source: NewLaneBaseSource;
  primaryBaseRef?: string | null;
}): string {
  const baseRef = args.primaryBaseRef?.trim() ?? "";
  const localBranches = args.branches.filter((branch) => !branch.isRemote);
  const preferredBaseLocal = baseRef
    ? localBranches.find((branch) => branch.name === baseRef)
    : null;
  const currentLocal = localBranches.find((branch) => branch.isCurrent) ?? null;
  const fallbackLocal = currentLocal ?? localBranches[0] ?? null;

  if (args.source === "remote") {
    if (preferredBaseLocal) {
      const remoteRef = remoteRefForLocalBranch(preferredBaseLocal, args.branches);
      if (remoteRef) return remoteRef;
    }
    const remoteQualifiedBase = baseRef.startsWith("refs/remotes/")
      ? baseRef.slice("refs/remotes/".length)
      : baseRef;
    if (
      remoteQualifiedBase
      && args.branches.some((branch) => branch.isRemote && branch.name === remoteQualifiedBase)
    ) {
      return remoteQualifiedBase;
    }
    const originBase = remoteNewLaneBaseFallback(baseRef);
    if (originBase && args.branches.some((branch) => branch.isRemote && branch.name === originBase)) {
      return originBase;
    }
    if (fallbackLocal) {
      const remoteRef = remoteRefForLocalBranch(fallbackLocal, args.branches);
      if (remoteRef) return remoteRef;
    }
    return listNewLaneBaseOptions(args.branches, "remote")[0]?.ref ?? "";
  }

  const preferredLocal = preferredBaseLocal ?? fallbackLocal;
  return preferredLocal?.name ?? "";
}

// Canonical implementation lives in shared (also used by the sync command
// layer's lanes.create default-base resolution); exported under the
// renderer's historical name.
export const remoteNewLaneBaseFallback = remoteLaneBaseCandidate;

export async function fetchNewLaneBaseBranches(args: {
  source: NewLaneBaseSource;
  fetchRemoteBranches: () => Promise<unknown>;
  listBranches: () => Promise<LaneBranchOption[]>;
  fetchTimeoutMs?: number;
}): Promise<LaneBranchOption[]> {
  if (args.source === "remote") {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        args.fetchRemoteBranches().catch(() => {}),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, args.fetchTimeoutMs ?? DEFAULT_NEW_LANE_REMOTE_FETCH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  return args.listBranches().catch(() => []);
}
