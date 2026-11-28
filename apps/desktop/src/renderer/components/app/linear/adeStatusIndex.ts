import type {
  LaneSummary,
  LinearIssuePullRequest,
  NormalizedLinearIssue,
  OpenProjectBinding,
  PrSummary,
  TerminalSessionSummary,
} from "../../../../shared/types";
import { ADE_CLOUD_NAME } from "../../../../shared/adeCloudMachine";
import { laneDisplayName } from "../../../../shared/laneDisplayName";
import { normalizeLinearPrUrl } from "../../../../shared/linearIssueNormalize";
import { isTrackedAgentCliToolType } from "../../../../shared/types/sessions";
import type { CrossMachineLaneRow } from "../../../state/crossMachineLanes";
import { rowShowsConnected } from "../../../state/cloudRestingRows";
import { lanePrDeepLinkPath } from "../../../lib/lanePrBadge";
import { isChatToolType } from "../../../lib/sessions";
import { canonicalInputFromSummary, sessionIsMidFlight, sessionNeedsYou } from "../../../lib/terminalAttention";
import { selectLanePrs } from "../../lanes/lanePageModel";

/**
 * What ADE knows about a Linear issue: the lanes working on it (on any
 * connected machine), the chats and CLIs running there right now, and ADE's
 * own view of the issue's pull requests (checks, review), joined with
 * Linear's PR attachments into the one chip list the row draws.
 *
 * Pure: built from data the renderer already holds (the hook in
 * `adeStatus.tsx` gathers it). Nothing is fetched per row.
 */
export type LinearIssueAdeStatusLane = {
  laneId: string;
  laneName: string;
  /** The machine's name when the lane is not on this computer ("ADE Cloud" for a cloud lane). */
  machineLabel: string | null;
  /** The address of the lane's copy (its machine's binding key). */
  pinKey: string | null;
  /** The union slot id to open the lane by (`openLaneOnMachinePath`); null = the tab's own copy. */
  machineId: string | null;
  /** False while the lane's machine is unreachable (a resting cloud computer counts as reachable). */
  online: boolean;
  /** An ADE Cloud lane: opening it reads the account and never wakes its computer. */
  cloud: boolean;
};

export type LinearIssueAdeStatusChat = {
  sessionId: string;
  laneId: string;
  title: string;
  kind: "chat" | "cli";
  state: "working" | "needs_you";
  machineId: string | null;
  online: boolean;
};

export type LinearIssueAdeStatusPr = {
  number: number;
  url: string;
  state: "open" | "draft" | "merged" | "closed";
  checks: "passing" | "failing" | "pending" | "none";
  review: "approved" | "changes_requested" | "pending" | "none";
  title: string;
  /** "owner/name". */
  repo: string | null;
  /** In-app route to the PR in the PRs tab; null when only GitHub can open it (another machine's PR). */
  adePath: string | null;
};

export type LinearPrChipState = LinearIssueAdeStatusPr["state"] | "unknown";

/** One pull request chip: Linear's attachment joined to ADE's PR row when ADE has one. */
export type LinearPrChip = {
  key: string;
  number: number | null;
  url: string;
  title: string;
  repo: string | null;
  state: LinearPrChipState;
  checks: LinearIssueAdeStatusPr["checks"] | null;
  review: LinearIssueAdeStatusPr["review"] | null;
  adePath: string | null;
};

export type LinearIssueAdeStatus = {
  lanes: LinearIssueAdeStatusLane[];
  /** Chats/CLIs working right now on those lanes. */
  runningChats: number;
  /** A chat on those lanes waits for the person. */
  needsInput: boolean;
  /** ADE's own PR rows for the issue (its lanes' PRs and the ones Linear links). */
  prs: LinearIssueAdeStatusPr[];
  /** The live chats behind `runningChats`, needs-you first. */
  chats: LinearIssueAdeStatusChat[];
  /** The PR chips to draw: Linear's PRs merged with `prs`, open first. */
  pullRequests: LinearPrChip[];
};

// ── PR helpers ───────────────────────────────────────────────────────────────

function prRepoNumberKey(repo: string | null | undefined, number: number | null | undefined): string | null {
  if (!repo || !number) return null;
  return `${repo.toLowerCase()}#${number}`;
}

function prChecks(status: PrSummary["checksStatus"]): LinearIssueAdeStatusPr["checks"] {
  if (status === "passing" || status === "failing" || status === "pending") return status;
  return "none";
}

function prReview(status: PrSummary["reviewStatus"]): LinearIssueAdeStatusPr["review"] {
  if (status === "approved" || status === "changes_requested") return status;
  if (status === "requested") return "pending";
  return "none";
}

function toStatusPr(pr: PrSummary, openInAde: boolean): LinearIssueAdeStatusPr {
  return {
    number: pr.githubPrNumber,
    url: pr.githubUrl,
    state: pr.state,
    checks: prChecks(pr.checksStatus),
    review: prReview(pr.reviewStatus),
    title: pr.title ?? "",
    repo: pr.repoOwner && pr.repoName ? `${pr.repoOwner}/${pr.repoName}` : null,
    // The PRs tab reads the tab's machine; another machine's PR id would land
    // on an empty tab, so that one opens on GitHub (`openLanePr`'s rule).
    adePath: openInAde ? lanePrDeepLinkPath(pr) : null,
  };
}

const CHIP_STATE_RANK: Record<LinearPrChipState, number> = { open: 0, draft: 1, unknown: 2, merged: 3, closed: 4 };

/** A merged or closed PR cannot go back to open: a terminal state from either side wins. */
function mergedChipState(linear: LinearPrChipState, ade: LinearIssueAdeStatusPr["state"] | null): LinearPrChipState {
  if (!ade) return linear;
  if (linear === "merged" || linear === "closed") return ade === "merged" || ade === "closed" ? ade : linear;
  return ade;
}

/**
 * The chip list: each Linear PR (one per url) with its ADE row when there is
 * one, then the ADE PRs Linear has not linked (yet). `findAde` is the join.
 */
function buildPrChips(
  linearPrs: readonly LinearIssuePullRequest[],
  findAde: (linear: LinearIssuePullRequest) => LinearIssueAdeStatusPr | undefined,
  adePrs: readonly LinearIssueAdeStatusPr[],
): LinearPrChip[] {
  const out: LinearPrChip[] = [];
  const seen = new Set<string>();
  const usedAde = new Set<LinearIssueAdeStatusPr>();
  for (const linear of linearPrs) {
    const url = normalizeLinearPrUrl(linear.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const match = findAde(linear);
    if (match) usedAde.add(match);
    out.push({
      key: url,
      number: linear.number ?? match?.number ?? null,
      url: linear.url,
      title: match?.title || linear.title || "",
      repo: linear.repo ?? match?.repo ?? null,
      state: mergedChipState(linear.status, match?.state ?? null),
      checks: match?.checks ?? null,
      review: match?.review ?? null,
      adePath: match?.adePath ?? null,
    });
  }
  for (const pr of adePrs) {
    if (usedAde.has(pr)) continue;
    const key = normalizeLinearPrUrl(pr.url) ?? `${pr.repo ?? ""}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      repo: pr.repo,
      state: pr.state,
      checks: pr.checks,
      review: pr.review,
      adePath: pr.adePath,
    });
  }
  out.sort((a, b) => CHIP_STATE_RANK[a.state] - CHIP_STATE_RANK[b.state] || (b.number ?? 0) - (a.number ?? 0));
  return out;
}

/** The chips of an issue ADE knows nothing about: Linear's own PRs. */
export function linearOnlyPrChips(issue: NormalizedLinearIssue): LinearPrChip[] {
  return buildPrChips(issue.pullRequests ?? [], () => undefined, []);
}

// ── The index ────────────────────────────────────────────────────────────────

/**
 * What a link claims on a lane: "lane" = the whole lane (its live chats and
 * its PRs); a set = only those chats. An empty set lists the lane and claims
 * nothing on it (a Linear lane card without a chat).
 */
type LaneLinkScope = "lane" | Set<string>;

type IndexedLane = {
  row: CrossMachineLaneRow;
  ref: LinearIssueAdeStatusLane;
  /** Machine-scoped key: lane ids are unique per machine, not globally. */
  key: string;
};

function claimLane(map: Map<string, LaneLinkScope>, laneKey: string): void {
  map.set(laneKey, "lane");
}

function claimChat(map: Map<string, LaneLinkScope>, laneKey: string, sessionId: string): void {
  const current = map.get(laneKey);
  if (current === "lane") return;
  if (current) current.add(sessionId);
  else map.set(laneKey, new Set([sessionId]));
}

function listLane(map: Map<string, LaneLinkScope>, laneKey: string): void {
  if (!map.has(laneKey)) map.set(laneKey, new Set());
}

function isAgentSession(session: TerminalSessionSummary): boolean {
  return isChatToolType(session.toolType) || isTrackedAgentCliToolType(session.toolType);
}

function liveState(session: TerminalSessionSummary): "working" | "needs_you" | null {
  if (session.archivedAt || !isAgentSession(session)) return null;
  const input = canonicalInputFromSummary(session);
  if (sessionNeedsYou(input)) return "needs_you";
  if (sessionIsMidFlight(input)) return "working";
  return null;
}

export type LinearAdeStatusIndex = {
  lanes: IndexedLane[];
  /** Linear issue id / identifier → lane key → link scope. */
  linksByIssue: Map<string, Map<string, LaneLinkScope>>;
  /** Bare lane id → lane keys (for Linear's own ADE attachments). */
  laneKeysById: Map<string, string[]>;
  lanesByKey: Map<string, IndexedLane>;
  sessionsByLaneKey: Map<string, TerminalSessionSummary[]>;
  prsByLaneKey: Map<string, LinearIssueAdeStatusPr[]>;
  prsByUrl: Map<string, LinearIssueAdeStatusPr>;
  prsByRepoNumber: Map<string, LinearIssueAdeStatusPr>;
};

export function buildLinearAdeStatusIndex(input: {
  rows: CrossMachineLaneRow[];
  localSessions: readonly TerminalSessionSummary[] | null;
  tabPrs: readonly PrSummary[] | null;
  foreignPrsByMachineId: Map<string, readonly PrSummary[]>;
  projectBinding: OpenProjectBinding | null;
  labelFor: (row: CrossMachineLaneRow) => string;
}): LinearAdeStatusIndex {
  const lanes: IndexedLane[] = [];
  const lanesByKey = new Map<string, IndexedLane>();
  const laneKeysById = new Map<string, string[]>();
  const linksByIssue = new Map<string, Map<string, LaneLinkScope>>();
  const link = (issueKey: string | null | undefined, laneKey: string, sessionId: string | null) => {
    const key = issueKey?.trim();
    if (!key) return;
    let map = linksByIssue.get(key);
    if (!map) {
      map = new Map();
      linksByIssue.set(key, map);
    }
    if (sessionId) claimChat(map, laneKey, sessionId);
    else claimLane(map, laneKey);
  };

  for (const row of input.rows) {
    const lane: LaneSummary = row.lane;
    if (lane.archivedAt) continue;
    const key = `${row.isActiveBinding ? "tab" : row.machineId}:${lane.id}`;
    if (lanesByKey.has(key)) continue;
    const label = row.isThisMachine ? null : input.labelFor(row);
    const indexed: IndexedLane = {
      row,
      key,
      ref: {
        laneId: lane.id,
        laneName: laneDisplayName(lane),
        machineLabel: label,
        pinKey: row.binding?.key ?? (row.isActiveBinding ? input.projectBinding?.key ?? null : null),
        machineId: row.isActiveBinding ? null : row.machineId,
        online: rowShowsConnected(row),
        cloud: label === ADE_CLOUD_NAME,
      },
    };
    lanes.push(indexed);
    lanesByKey.set(key, indexed);
    const sameId = laneKeysById.get(lane.id);
    if (sameId) sameId.push(key);
    else laneKeysById.set(lane.id, [key]);

    const primary = lane.linearIssue;
    if (primary) {
      link(primary.id, key, null);
      link(primary.identifier?.toUpperCase(), key, null);
    }
    for (const entry of lane.linearIssueLinks ?? []) {
      if (!entry.issue) continue;
      // A chat attachment ties the issue to that chat, not to every chat on the
      // lane (the main checkout hosts many unrelated chats).
      const sessionId = entry.source === "chat_attach" ? entry.evidence?.chatSessionId ?? null : null;
      link(entry.issue.id, key, sessionId);
      link(entry.issue.identifier?.toUpperCase(), key, sessionId);
    }
  }

  // Sessions: the tab's own roster first, then each machine's slice. One
  // session counts once even when two sources report it.
  const sessionsByLaneKey = new Map<string, TerminalSessionSummary[]>();
  const seen = new Set<string>();
  const fileSession = (laneKey: string, session: TerminalSessionSummary) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    const list = sessionsByLaneKey.get(laneKey);
    if (list) list.push(session);
    else sessionsByLaneKey.set(laneKey, [session]);
  };
  for (const session of input.localSessions ?? []) {
    if (session.laneId) fileSession(`tab:${session.laneId}`, session);
  }
  for (const indexed of lanes) {
    for (const session of indexed.row.sessions) fileSession(indexed.key, session);
  }

  // PRs: the tab copy's rows open in the PRs tab; another machine's open on GitHub.
  const prsByUrl = new Map<string, LinearIssueAdeStatusPr>();
  const prsByRepoNumber = new Map<string, LinearIssueAdeStatusPr>();
  const mappedCache = new Map<PrSummary, LinearIssueAdeStatusPr>();
  const mapPr = (pr: PrSummary, openInAde: boolean) => {
    let mapped = mappedCache.get(pr);
    if (!mapped) {
      mapped = toStatusPr(pr, openInAde);
      mappedCache.set(pr, mapped);
      const url = normalizeLinearPrUrl(pr.githubUrl);
      if (url && !prsByUrl.has(url)) prsByUrl.set(url, mapped);
      const repoKey = prRepoNumberKey(mapped.repo, pr.githubPrNumber);
      if (repoKey && !prsByRepoNumber.has(repoKey)) prsByRepoNumber.set(repoKey, mapped);
    }
    return mapped;
  };
  const groupByLane = (prs: readonly PrSummary[]) => {
    const byLane = new Map<string, PrSummary[]>();
    for (const pr of prs) {
      if (!pr.laneId) continue;
      const list = byLane.get(pr.laneId);
      if (list) list.push(pr);
      else byLane.set(pr.laneId, [pr]);
    }
    return byLane;
  };
  for (const pr of input.tabPrs ?? []) mapPr(pr, true);
  for (const prs of input.foreignPrsByMachineId.values()) for (const pr of prs) mapPr(pr, false);

  const prsByLaneKey = new Map<string, LinearIssueAdeStatusPr[]>();
  const tabByLane = groupByLane(input.tabPrs ?? []);
  const foreignByLane = new Map<string, Map<string, PrSummary[]>>();
  for (const [machineId, prs] of input.foreignPrsByMachineId) foreignByLane.set(machineId, groupByLane(prs));
  for (const indexed of lanes) {
    const candidates = indexed.row.isActiveBinding
      ? tabByLane.get(indexed.ref.laneId)
      : foreignByLane.get(indexed.row.machineId)?.get(indexed.ref.laneId);
    if (!candidates?.length) continue;
    // The lane's current-branch PRs, the same selector every lane badge uses
    // (a main checkout parked on its base branch has none).
    const selected = selectLanePrs(indexed.row.lane, candidates);
    if (selected.length) prsByLaneKey.set(indexed.key, selected.map((pr) => mapPr(pr, indexed.row.isActiveBinding)));
  }

  return { lanes, linksByIssue, laneKeysById, lanesByKey, sessionsByLaneKey, prsByLaneKey, prsByUrl, prsByRepoNumber };
}

/**
 * The lane a Linear ADE attachment names. Lane ids are unique per machine
 * only, so a bare id applies when one lane has it, or when exactly one of the
 * lanes with it holds the session the attachment also names. Ambiguous: none.
 */
function laneKeyForAdeLink(index: LinearAdeStatusIndex, laneId: string, sessionId: string | null): string | null {
  const candidates = index.laneKeysById.get(laneId) ?? [];
  if (candidates.length === 1) return candidates[0]!;
  if (!sessionId || candidates.length === 0) return null;
  const holding = candidates.filter((laneKey) => (
    index.sessionsByLaneKey.get(laneKey)?.some((session) => session.id === sessionId) ?? false
  ));
  return holding.length === 1 ? holding[0]! : null;
}

const PR_STATE_RANK: Record<LinearIssueAdeStatusPr["state"], number> = { open: 0, draft: 1, merged: 2, closed: 3 };

export function computeLinearIssueAdeStatus(index: LinearAdeStatusIndex, issue: NormalizedLinearIssue): LinearIssueAdeStatus | null {
  const scopes = new Map<string, LaneLinkScope>();
  const merge = (map: Map<string, LaneLinkScope> | undefined) => {
    if (!map) return;
    for (const [laneKey, scope] of map) {
      if (scope === "lane") claimLane(scopes, laneKey);
      else if (scope.size === 0) listLane(scopes, laneKey);
      else for (const sessionId of scope) claimChat(scopes, laneKey, sessionId);
    }
  };
  merge(index.linksByIssue.get(issue.id));
  if (issue.identifier) merge(index.linksByIssue.get(issue.identifier.toUpperCase()));
  // Linear's own ADE links (attachments ADE wrote with the lane id). A lane
  // card without a chat lists the lane and claims none of its chats or PRs; a
  // card with a chat adds that chat. Neither widens a chat-only scope.
  for (const entry of issue.adeLinks ?? []) {
    const laneId = entry.laneId?.trim();
    if (!laneId) continue;
    const sessionId = entry.sessionId?.trim() || null;
    const laneKey = laneKeyForAdeLink(index, laneId, sessionId);
    if (!laneKey) continue;
    if (sessionId) claimChat(scopes, laneKey, sessionId);
    else listLane(scopes, laneKey);
  }

  const lanes: LinearIssueAdeStatusLane[] = [];
  const chats: LinearIssueAdeStatusChat[] = [];
  const prs: LinearIssueAdeStatusPr[] = [];
  const prSeen = new Set<LinearIssueAdeStatusPr>();
  const addPr = (pr: LinearIssueAdeStatusPr | undefined) => {
    if (!pr || prSeen.has(pr)) return;
    prSeen.add(pr);
    prs.push(pr);
  };

  for (const [laneKey, scope] of scopes) {
    const indexed = index.lanesByKey.get(laneKey);
    if (!indexed) continue;
    lanes.push(indexed.ref);
    for (const session of index.sessionsByLaneKey.get(laneKey) ?? []) {
      if (scope !== "lane" && !scope.has(session.id)) continue;
      const state = liveState(session);
      if (!state) continue;
      chats.push({
        sessionId: session.id,
        laneId: indexed.ref.laneId,
        title: session.title?.trim() || session.goal?.trim() || (isChatToolType(session.toolType) ? "Chat" : "CLI session"),
        kind: isChatToolType(session.toolType) ? "chat" : "cli",
        state,
        machineId: indexed.ref.machineId,
        online: indexed.ref.online,
      });
    }
    // A chat-scoped link (main checkout) does not claim the lane's PRs.
    if (scope === "lane") for (const pr of index.prsByLaneKey.get(laneKey) ?? []) addPr(pr);
  }
  const findAde = (linear: LinearIssuePullRequest) => {
    const url = normalizeLinearPrUrl(linear.url);
    return (url ? index.prsByUrl.get(url) : undefined) ?? index.prsByRepoNumber.get(prRepoNumberKey(linear.repo, linear.number) ?? "");
  };
  for (const linearPr of issue.pullRequests ?? []) addPr(findAde(linearPr));

  if (lanes.length === 0 && prs.length === 0) return null;
  // This computer first, then reachable machines; names after.
  lanes.sort((a, b) => {
    const rank = (lane: LinearIssueAdeStatusLane) => (lane.machineLabel == null ? 0 : lane.online ? 1 : 2);
    return rank(a) - rank(b) || a.laneName.localeCompare(b.laneName);
  });
  chats.sort((a, b) => (a.state === b.state ? a.title.localeCompare(b.title) : a.state === "needs_you" ? -1 : 1));
  prs.sort((a, b) => PR_STATE_RANK[a.state] - PR_STATE_RANK[b.state] || b.number - a.number);
  return {
    lanes,
    runningChats: chats.length,
    needsInput: chats.some((chat) => chat.state === "needs_you"),
    prs,
    chats,
    pullRequests: buildPrChips(issue.pullRequests ?? [], findAde, prs),
  };
}
