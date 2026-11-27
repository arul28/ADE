import type { createPrService } from "../prs/prService";
import type { CtoRemoteMachineWork } from "../ai/tools/ctoCrossMachine";

/** One open PR on the repo as the CTO sees it, with where it came from. */
export type CtoLivePullRequest = {
  number: number;
  title: string;
  isDraft: boolean;
  origin: "this-machine" | "other-machine" | "not-in-ade";
  /** This machine's lane id, for a PR a lane here owns. */
  laneId: string | null;
  /** The lane's name, here or on the other machine. */
  laneName: string | null;
  /** The other machine's name, for `other-machine`. */
  machineName: string | null;
  author: string | null;
  headBranch: string | null;
  /** Known only for a PR a lane here owns. */
  checks: string | null;
  review: string | null;
};

/** A branch name as GitHub and a lane both spell it (branch names are case-sensitive). */
function plainBranch(ref: string | null | undefined): string {
  return (ref ?? "").trim().replace(/^refs\/heads\//, "");
}

/** One PR's identity across repos: a lane may link a same-numbered PR on another repo. */
function prKey(owner: string | null | undefined, name: string | null | undefined, number: number): string {
  return `${(owner ?? "").trim().toLowerCase()}/${(name ?? "").trim().toLowerCase()}#${number}`;
}

/**
 * Every open PR on the repo, labeled by where it came from. Two local reads,
 * no network: the lane-linked PR rows (checks and review are known for those)
 * and the repo's open PR list ADE keeps from GitHub. A PR no lane here owns is
 * matched by branch to another machine's lane, else it was opened outside ADE.
 * Newest first, with this machine's own PRs never pushed out by the others.
 */
export function collectLivePullRequests(
  prService: Pick<ReturnType<typeof createPrService>, "listAll" | "listOpenRepoPullRequests">,
  remoteWork: readonly Pick<CtoRemoteMachineWork, "name" | "lanes">[] | null,
  laneNames: ReadonlyMap<string, string>,
): CtoLivePullRequest[] {
  // A detached row is history: its lane was deleted or moved off the branch.
  const linked = prService.listAll().filter((pr) => !pr.detached && (pr.state === "open" || pr.state === "draft"));
  const linkedByKey = new Map(linked.map((pr) => [prKey(pr.repoOwner, pr.repoName, pr.githubPrNumber), pr]));
  const remoteLaneByBranch = new Map<string, { machine: string; lane: string }>();
  for (const machine of remoteWork ?? []) {
    for (const lane of machine.lanes) {
      const branch = plainBranch(lane.branch);
      if (branch && !remoteLaneByBranch.has(branch)) remoteLaneByBranch.set(branch, { machine: machine.name, lane: lane.name });
    }
  }
  const fromLane = (pr: (typeof linked)[number]): CtoLivePullRequest => ({
    number: pr.githubPrNumber,
    title: pr.title,
    isDraft: pr.state === "draft",
    origin: "this-machine",
    laneId: pr.laneId,
    laneName: laneNames.get(pr.laneId) ?? null,
    machineName: null,
    author: null,
    headBranch: pr.headBranch ?? null,
    checks: pr.checksStatus,
    review: pr.reviewStatus,
  });
  const seen = new Set<string>();
  const rows: Array<{ pr: CtoLivePullRequest; updatedAt: string }> = [];
  for (const repoPr of prService.listOpenRepoPullRequests?.() ?? []) {
    const key = prKey(repoPr.repoOwner, repoPr.repoName, repoPr.number);
    if (seen.has(key)) continue;
    seen.add(key);
    const own = linkedByKey.get(key);
    if (own) {
      rows.push({ pr: { ...fromLane(own), isDraft: repoPr.isDraft || own.state === "draft" }, updatedAt: repoPr.updatedAt });
      continue;
    }
    // A fork's branch can share a name with a lane's; only a same-repo head can be that lane's.
    const sameRepoHead = !repoPr.headRepoOwner || !repoPr.headRepoName
      || prKey(repoPr.headRepoOwner, repoPr.headRepoName, 0) === prKey(repoPr.repoOwner, repoPr.repoName, 0);
    const remote = sameRepoHead ? remoteLaneByBranch.get(plainBranch(repoPr.headBranch)) : undefined;
    rows.push({
      pr: {
        number: repoPr.number,
        title: repoPr.title,
        isDraft: repoPr.isDraft,
        origin: remote ? "other-machine" : "not-in-ade",
        laneId: null,
        laneName: remote?.lane ?? null,
        machineName: remote?.machine ?? null,
        author: repoPr.author,
        headBranch: repoPr.headBranch,
        checks: null,
        review: null,
      },
      updatedAt: repoPr.updatedAt,
    });
  }
  // A lane's PR the repo list has not caught up with yet still counts.
  for (const pr of linked) {
    const key = prKey(pr.repoOwner, pr.repoName, pr.githubPrNumber);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ pr: fromLane(pr), updatedAt: pr.updatedAt });
  }
  const originRank = (pr: CtoLivePullRequest) => (pr.origin === "this-machine" ? 0 : 1);
  return rows
    .sort((a, b) => originRank(a.pr) - originRank(b.pr) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .map((row) => row.pr);
}
