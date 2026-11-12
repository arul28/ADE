import type {
  KeybindingsSnapshot,
  LaneListSnapshot,
  LaneSummary,
  ListLanesArgs,
  OpenProjectBinding,
} from "../../shared/types";

/**
 * Where a lane read goes. `pin` names the copy (machine) whose lanes are read;
 * the in-flight key carries it, so two machines never share a read. A read
 * with no pin keeps the old route (the tab's copy) and notes the tripwire.
 */
export type LaneReadOptions = { projectRoot?: string | null; pin?: OpenProjectBinding | null };

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

function normalizeLaneArgs(args: ListLanesArgs): Required<Pick<ListLanesArgs, "includeArchived" | "includeStatus" | "includeConflictStatus">> {
  return {
    includeArchived: args.includeArchived === true,
    includeStatus: args.includeStatus === true,
    includeConflictStatus: args.includeConflictStatus === true,
  };
}

function keyFor(options: LaneReadOptions | undefined, args: ListLanesArgs): string {
  return JSON.stringify({
    projectRoot: projectKey(options?.projectRoot),
    pin: options?.pin?.key ?? null,
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
  options?: LaneReadOptions,
): Promise<LaneSummary[]> {
  const pin = options?.pin ?? null;
  return coalesceInFlight(
    laneListInFlight,
    keyFor(options, args),
    () => window.ade.lanes.list(args, pin),
    laneReadGeneration,
  );
}

export function listLaneSnapshotsCoalesced(
  args: ListLanesArgs,
  options?: LaneReadOptions,
): Promise<LaneListSnapshot[]> {
  const pin = options?.pin ?? null;
  return coalesceInFlight(
    laneSnapshotInFlight,
    keyFor(options, args),
    () => window.ade.lanes.listSnapshots(args, pin),
    laneReadGeneration,
  );
}

export function getKeybindingsCoalesced(
  options?: LaneReadOptions,
): Promise<KeybindingsSnapshot> {
  const pin = options?.pin ?? null;
  return coalesceInFlight(
    keybindingsInFlight,
    `${projectKey(options?.projectRoot)}\n${pin?.key ?? ""}`,
    () => window.ade.keybindings.get(pin),
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
