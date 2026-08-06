import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubPrListItem, LaneSummary, PrSummary } from "../../../shared/types";
import { getGitHubSnapshotCoalesced, listPrsCoalesced } from "../../lib/prReadCache";
import { selectActiveProjectRoot, useAppStore, useRootAppStore } from "../../state/appStore";
import { THIS_MACHINE_ID } from "../../../shared/machineIdentity";
import {
  selectGithubLanePrTags,
  selectLanePrs,
} from "../lanes/lanePageModel";

function githubItemToLanePr(item: GitHubPrListItem, laneId: string): PrSummary {
  return {
    id: item.linkedPrId ?? `gh:${item.repoOwner}/${item.repoName}#${item.githubPrNumber}`,
    laneId,
    projectId: "github-projection",
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    githubPrNumber: item.githubPrNumber,
    githubUrl: item.githubUrl,
    githubNodeId: null,
    title: item.title,
    state: item.isDraft ? "draft" : item.state,
    baseBranch: item.baseBranch ?? "",
    headBranch: item.headBranch ?? "",
    // "none", not "not_run": the GitHub list endpoint carries no check data at
    // all, so we have observed nothing rather than observed an absence. Only a
    // rollup that actually looked at the commit may claim "not_run" (ADE-135).
    checksStatus: "none",
    reviewStatus: "none",
    additions: 0,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    stack: item.stack ?? null,
    unmapped: item.linkedPrId == null ? true : undefined,
  };
}

/**
 * Key vocabulary for the lane→PR map.
 *
 * The invariant behind all three: lane ids are NOT unique across machines —
 * cross-machine handoff copies a lane, id included — so "which machine" is part
 * of the identity of a PR lookup. Every key is namespaced, so a key can only
 * ever mean one thing and no precedence rule has to be remembered. Nothing is
 * ever filed under a bare lane id; when the bare id doubled as "the bound
 * machine's answer", a foreign machine's PR could fill an id the bound machine
 * had not claimed and render on a bound-machine row, whose badge deep-links
 * into a PRs tab that cannot resolve it.
 */
export function lanePrCompositeKey(machineId: string, laneId: string): string {
  return `${machineId}:${laneId}`;
}

/** Alias for the bound machine, so purely-local render paths need no machine id. */
export function laneBoundMachineKey(laneId: string): string {
  return `bound:${laneId}`;
}

/** The union across every machine. */
export function laneAnyMachineKey(laneId: string): string {
  return `any:${laneId}`;
}

export function buildLanePrsByLaneId(args: {
  lanes: LaneSummary[];
  prs: PrSummary[];
  githubPrs: GitHubPrListItem[];
}): Map<string, PrSummary[]> {
  const byLane = new Map<string, PrSummary[]>();
  for (const lane of args.lanes) {
    const githubPrs = selectGithubLanePrTags(lane, args.githubPrs);
    const mapped = selectLanePrs(lane, args.prs)
      .map((pr) => ({
        ...pr,
        stack: githubPrs.find((githubPr) => githubPr.githubPrNumber === pr.githubPrNumber)?.stack
          ?? pr.stack
          ?? null,
      }));
    const mappedIds = new Set(mapped.map((pr) => pr.id));
    const mappedRepoPrKeys = new Set(mapped.map((pr) => (
      `${pr.repoOwner.toLowerCase()}/${pr.repoName.toLowerCase()}#${pr.githubPrNumber}`
    )));
    const unmappedGithubPrs = githubPrs.filter((githubPr) => {
      const repoPrKey = `${githubPr.repoOwner.toLowerCase()}/${githubPr.repoName.toLowerCase()}#${githubPr.githubPrNumber}`;
      return !mappedIds.has(githubPr.linkedPrId ?? "") && !mappedRepoPrKeys.has(repoPrKey);
    });
    const combined = [
      ...mapped,
      ...unmappedGithubPrs.map((githubPr) => githubItemToLanePr(githubPr, lane.id)),
    ];
    if (combined.length > 0) byLane.set(lane.id, combined);
  }
  return byLane;
}

/** The only lookup that may ignore machine identity — the "has PR" filter chip. */
export function laneHasAnyPr(
  byLane: Map<string, PrSummary[]>,
  laneId: string,
): boolean {
  return (byLane.get(laneAnyMachineKey(laneId))?.length ?? 0) > 0;
}

/** What every row on the tab's own machine renders. */
export function boundMachineLanePrs(
  byLane: Map<string, PrSummary[]>,
  laneId: string,
): PrSummary[] {
  return byLane.get(laneBoundMachineKey(laneId)) ?? [];
}

/** What a foreign row renders — its own machine's answer, never another's. */
export function lanePrsForMachine(
  byLane: Map<string, PrSummary[]>,
  machineId: string,
  laneId: string,
): PrSummary[] {
  return byLane.get(lanePrCompositeKey(machineId, laneId)) ?? [];
}

/**
 * Canonical current-branch PRs grouped by lane id. A coalesced mapped-PR read
 * and GitHub snapshot read cover both ADE-linked and GitHub-only PRs without
 * per-lane requests. The `prs-updated` push keeps both caches fresh.
 *
 * Extracted from SessionListPane so the Work session hook can answer the
 * "Has PR" chip filter from the same data the lane-header badge renders. The
 * underlying read is coalesced and the event subscription is idempotent, so
 * more than one caller costs a listener and nothing else.
 *
 * Cross-machine: a mapped PR row lives in the `.ade` database of the machine
 * that owns the lane, so the active binding's `listAll` can only ever answer for
 * its own machine — which is why a session on another machine used to show no PR
 * until the project tab was rebound to it. Each machine's rows arrive with its
 * union slice and are folded in here under `lanePrCompositeKey`. The GitHub
 * snapshot is deliberately NOT re-read per machine: it describes the repo, not a
 * machine, so the same snapshot joins correctly against every machine's lanes.
 */
export function useLanePrsByLaneId(): Map<string, PrSummary[]> {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const lanes = useAppStore((state) => state.lanes);
  const machines = useRootAppStore((state) => state.crossMachineLanesByMachineId);
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [githubPrs, setGithubPrs] = useState<GitHubPrListItem[]>([]);
  useEffect(() => {
    // `window.ade.prs` is absent in some renders (e.g. tests with a partial
    // `window.ade` mock); no-op gracefully so the badge just doesn't render.
    if (!window.ade?.prs) return;
    let cancelled = false;
    const refresh = () => Promise.all([
      listPrsCoalesced({ projectRoot }),
      getGitHubSnapshotCoalesced({}, { projectRoot }),
    ])
      .then(([list, snapshot]) => {
        if (cancelled) return;
        setPrs(list);
        setGithubPrs(snapshot?.repoPullRequests ?? []);
      })
      .catch(() => {});
    void refresh();
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type !== "prs-updated") return;
      setPrs(event.prs);
      void getGitHubSnapshotCoalesced({}, { projectRoot })
        .then((snapshot) => {
          if (!cancelled) setGithubPrs(snapshot?.repoPullRequests ?? []);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectRoot]);
  // Derived, not searched. `isEligibleMachineOption` excludes the tab's own
  // machine from the union, so looking it up in `machines` would always miss and
  // the composite key would never be filled — leaving correctness resting on
  // every bound-machine render path happening to use the alias. Deriving it
  // enforces the intent instead of relying on it.
  const boundMachineId = useAppStore((state) => (
    state.projectBinding?.kind === "remote"
      ? state.projectBinding.targetId
      : THIS_MACHINE_ID
  ));
  // The tab's own machine is answered by the read above, which is event-driven
  // and therefore fresher than the 30s union slice. It is never double-read:
  // `readMachine` is never called for this machine at all — `isEligibleMachineOption`
  // excludes it from the union. Memoized separately so chat churn (a new
  // `machines` identity every ~10s) does not rebuild it.
  const boundBuilt = useMemo(
    () => buildLanePrsByLaneId({ lanes, prs, githubPrs }),
    [githubPrs, lanes, prs],
  );
  // Per-machine memo. `mergeCrossMachineLanes` keeps `lanes`/`prs` reference-
  // stable across ticks that do not change them, so a machine whose CHATS
  // churned re-uses its built map instead of paying the rebuild. Without this
  // the whole union rebuilds on chat churn, on a hook two Work hot-path
  // consumers share.
  const perMachineCache = useRef(new Map<string, {
    lanes: LaneSummary[];
    prs: PrSummary[];
    githubPrs: GitHubPrListItem[];
    built: Map<string, PrSummary[]>;
  }>());
  return useMemo(() => {
    const byLane = new Map<string, PrSummary[]>();
    const file = (
      built: Map<string, PrSummary[]>,
      machineId: string,
      alias = false,
    ) => {
      for (const [laneId, list] of built) {
        byLane.set(lanePrCompositeKey(machineId, laneId), list);
        // The bound machine is filed twice: under its real id, and under a fixed
        // alias so purely-local render paths need no machine id at all.
        if (alias) byLane.set(laneBoundMachineKey(laneId), list);
        // First machine to answer a lane id owns the union key. Which one that
        // is does not matter — its only consumer is the "has a PR at all"
        // filter chip, and every rendering path reads a machine-scoped key.
        const anyKey = laneAnyMachineKey(laneId);
        if (!byLane.has(anyKey)) byLane.set(anyKey, list);
      }
    };

    file(boundBuilt, boundMachineId, true);

    const cache = perMachineCache.current;
    for (const machine of Object.values(machines)) {
      if (!machine.lanes.length) continue;
      const cached = cache.get(machine.machineId);
      const built = cached
        && cached.lanes === machine.lanes
        && cached.prs === machine.prs
        && cached.githubPrs === githubPrs
        ? cached.built
        : buildLanePrsByLaneId({ lanes: machine.lanes, prs: machine.prs, githubPrs });
      cache.set(machine.machineId, {
        lanes: machine.lanes,
        prs: machine.prs,
        githubPrs,
        built,
      });
      file(built, machine.machineId);
    }
    for (const machineId of [...cache.keys()]) {
      if (!machines[machineId]) cache.delete(machineId);
    }
    return byLane;
  }, [boundBuilt, boundMachineId, githubPrs, machines]);
}
