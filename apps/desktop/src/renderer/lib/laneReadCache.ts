import type {
  KeybindingsSnapshot,
  LaneListSnapshot,
  LaneSummary,
  ListLanesArgs,
} from "../../shared/types";

type InFlightEntry<T> = {
  promise: Promise<T>;
  generation: number;
};

const laneListInFlight = new Map<string, InFlightEntry<LaneSummary[]>>();
const laneSnapshotInFlight = new Map<string, InFlightEntry<LaneListSnapshot[]>>();
const keybindingsInFlight = new Map<string, InFlightEntry<KeybindingsSnapshot>>();
let laneReadGeneration = 0;

function projectKey(projectRoot: string | null | undefined): string {
  return projectRoot?.trim() || "active";
}

function normalizeLaneArgs(args: ListLanesArgs): Required<Pick<ListLanesArgs, "includeArchived" | "includeStatus" | "includeConflictStatus" | "includeRebaseSuggestions" | "includeAutoRebaseStatus">> {
  return {
    includeArchived: args.includeArchived === true,
    includeStatus: args.includeStatus === true,
    includeConflictStatus: args.includeConflictStatus === true,
    includeRebaseSuggestions: args.includeRebaseSuggestions === true,
    includeAutoRebaseStatus: args.includeAutoRebaseStatus === true,
  };
}

function keyFor(projectRoot: string | null | undefined, args: ListLanesArgs): string {
  return JSON.stringify({
    projectRoot: projectKey(projectRoot),
    args: normalizeLaneArgs(args),
  });
}

function coalesceInFlight<T>(
  cache: Map<string, InFlightEntry<T>>,
  key: string,
  load: () => Promise<T>,
  generation = 0,
): Promise<T> {
  const existing = cache.get(key);
  if (existing && existing.generation === generation) return existing.promise;

  let promise: Promise<T>;
  promise = load().finally(() => {
    if (cache.get(key)?.promise === promise) {
      cache.delete(key);
    }
  });
  cache.set(key, { promise, generation });
  return promise;
}

export function listLanesCoalesced(
  args: ListLanesArgs,
  options?: { projectRoot?: string | null },
): Promise<LaneSummary[]> {
  return coalesceInFlight(
    laneListInFlight,
    keyFor(options?.projectRoot, args),
    () => window.ade.lanes.list(args),
    laneReadGeneration,
  );
}

export function listLaneSnapshotsCoalesced(
  args: ListLanesArgs,
  options?: { projectRoot?: string | null },
): Promise<LaneListSnapshot[]> {
  return coalesceInFlight(
    laneSnapshotInFlight,
    keyFor(options?.projectRoot, args),
    () => window.ade.lanes.listSnapshots(args),
    laneReadGeneration,
  );
}

export function getKeybindingsCoalesced(
  options?: { projectRoot?: string | null },
): Promise<KeybindingsSnapshot> {
  return coalesceInFlight(
    keybindingsInFlight,
    projectKey(options?.projectRoot),
    () => window.ade.keybindings.get(),
  );
}

export function clearLaneReadInFlightForTest(): void {
  keybindingsInFlight.clear();
  invalidateLaneReadCache();
}

export function invalidateLaneReadCache(): void {
  laneListInFlight.clear();
  laneSnapshotInFlight.clear();
  laneReadGeneration += 1;
}
