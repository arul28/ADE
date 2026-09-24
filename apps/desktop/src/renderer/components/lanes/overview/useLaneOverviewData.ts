import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentChatSessionSummary,
  GitCommitSummary,
  GitHubPrListItem,
  GitUpstreamSyncStatus,
  LaneSummary,
  OperationRecord,
  PrCheck,
  PrFile,
  PrReview,
  PrStatus,
  PrSummary,
  TerminalSessionSummary,
} from "../../../../shared/types";
import { getGitHubSnapshotCoalesced, listPrsCoalesced } from "../../../lib/prReadCache";
import { listSessionsCached } from "../../../lib/sessionListCache";
import { selectActiveProjectRoot, useAppStore } from "../../../state/appStore";
import { buildLanePrsByLaneId } from "../../terminals/useLanePrs";
import {
  normalizeProvider,
  parseCoAuthorProvider,
  selectLaneCommits,
  type LaneHistoryPr,
  type LaneHistorySession,
} from "./laneHistoryModel";

/* ───────────────────────── PRs ───────────────────────── */

function prKey(pr: { repoOwner: string; repoName: string; githubPrNumber: number }): string {
  return `${pr.repoOwner.toLowerCase()}/${pr.repoName.toLowerCase()}#${pr.githubPrNumber}`;
}

function toHistoryPr(pr: PrSummary, github: GitHubPrListItem | undefined): LaneHistoryPr {
  return {
    key: prKey(pr),
    linkedPrId: pr.unmapped ? null : pr.id,
    number: pr.githubPrNumber,
    repoOwner: pr.repoOwner,
    repoName: pr.repoName,
    title: pr.title,
    state: pr.state,
    createdAt: github?.createdAt ?? pr.createdAt,
    updatedAt: pr.updatedAt,
    mergedAt: pr.mergedAt ?? github?.mergedAt ?? null,
    mergedBy: pr.mergedBy ?? github?.mergedBy ?? null,
    author: github?.author ?? null,
    // GitHub-only rows carry no check or review data; say so instead of "none".
    checksStatus: pr.unmapped ? null : pr.checksStatus,
    reviewStatus: pr.unmapped ? null : pr.reviewStatus,
    mergeConflicts: pr.mergeConflicts ?? null,
    additions: github?.additions ?? (pr.unmapped ? null : pr.additions),
    deletions: github?.deletions ?? (pr.unmapped ? null : pr.deletions),
  };
}

function githubOnlyHistoryPr(item: GitHubPrListItem): LaneHistoryPr {
  return {
    key: prKey(item),
    linkedPrId: item.linkedPrId,
    number: item.githubPrNumber,
    repoOwner: item.repoOwner,
    repoName: item.repoName,
    title: item.title,
    state: item.isDraft ? "draft" : item.state,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    mergedAt: item.mergedAt ?? null,
    mergedBy: item.mergedBy ?? null,
    author: item.author,
    checksStatus: null,
    reviewStatus: null,
    mergeConflicts: null,
    additions: item.additions ?? null,
    deletions: item.deletions ?? null,
  };
}

/**
 * The lane's PRs from the same coalesced reads the lane badges use.
 * `current` is what the lane shows today (current branch); `all` adds the
 * lane's earlier PRs for the PR card and the activity feed.
 */
export function useLaneOverviewPrs(lane: LaneSummary | null): { current: LaneHistoryPr[]; all: LaneHistoryPr[] } {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const [prs, setPrs] = useState<PrSummary[]>([]);
  const [githubPrs, setGithubPrs] = useState<GitHubPrListItem[]>([]);

  useEffect(() => {
    if (!window.ade?.prs) return;
    let cancelled = false;
    const readSnapshot = () => getGitHubSnapshotCoalesced({}, { projectRoot })
      .then((snapshot) => {
        if (!cancelled) setGithubPrs(snapshot?.repoPullRequests ?? []);
      })
      .catch(() => {});
    void listPrsCoalesced({ projectRoot })
      .then((list) => {
        if (!cancelled) setPrs(list);
      })
      .catch(() => {});
    void readSnapshot();
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type !== "prs-updated") return;
      setPrs(event.prs);
      void readSnapshot();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [projectRoot]);

  return useMemo(() => {
    if (!lane) return { current: [], all: [] };
    const githubByKey = new Map(githubPrs.map((item) => [prKey(item), item] as const));
    const current = (buildLanePrsByLaneId({ lanes: [lane], prs, githubPrs }).get(lane.id) ?? [])
      .map((pr) => toHistoryPr(pr, githubByKey.get(prKey(pr))));
    const byKey = new Map(current.map((pr) => [pr.key, pr] as const));
    for (const pr of prs) {
      if (pr.laneId !== lane.id || pr.detached) continue;
      const key = prKey(pr);
      if (!byKey.has(key)) byKey.set(key, toHistoryPr(pr, githubByKey.get(key)));
    }
    for (const item of githubPrs) {
      if (item.linkedLaneId !== lane.id) continue;
      const key = prKey(item);
      if (!byKey.has(key)) byKey.set(key, githubOnlyHistoryPr(item));
    }
    return { current, all: [...byKey.values()] };
  }, [githubPrs, lane, prs]);
}

/* ───────────────────────── Commits ───────────────────────── */

export const PRIMARY_COMMIT_PAGE = 100;
export const MAX_LANE_COMMITS = 300;
/** How many of the newest commits get their message read for trailers. */
const TRAILER_LOOKUPS = 20;

/**
 * Commits are immutable, so a sha's trailer provider never changes. Kept for
 * the whole renderer session so switching lanes back and forth reads nothing.
 */
const trailerProviderCache = new Map<string, string | null>();

export function clearTrailerProviderCacheForTest(): void {
  trailerProviderCache.clear();
}

/**
 * Loads the lane's recent commits once on mount and again only when the lane's
 * git status says the branch moved (ahead count, tip time, branch). No polling:
 * the lane status in the store is already kept fresh by the page.
 */
export function useLaneCommits(
  lane: LaneSummary | null,
  primaryLimit: number,
): { commits: GitCommitSummary[]; trailerProviderBySha: ReadonlyMap<string, string | null>; loaded: boolean } {
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [trailerVersion, setTrailerVersion] = useState(0);
  const laneId = lane?.id ?? null;
  const isPrimary = lane?.laneType === "primary";
  const ahead = Math.max(0, lane?.status?.ahead ?? 0);
  const limit = isPrimary
    ? Math.min(MAX_LANE_COMMITS, Math.max(PRIMARY_COMMIT_PAGE, primaryLimit))
    : Math.min(MAX_LANE_COMMITS, ahead);
  const branchKey = [
    laneId,
    lane?.branchRef ?? "",
    lane?.status?.headBranchRef ?? "",
    lane?.status?.lastCommitAt ?? lane?.lastCommitAt ?? "",
    ahead,
    limit,
  ].join("|");

  // Declared first so a lane switch clears the old rows before the new read.
  useEffect(() => {
    setLoaded(false);
    setCommits([]);
  }, [laneId]);

  useEffect(() => {
    if (!laneId) return;
    if (limit <= 0) {
      setCommits([]);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    void window.ade.git.listRecentCommits({ laneId, limit })
      .then((rows) => {
        if (cancelled) return;
        setCommits(rows);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setCommits([]);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
    // branchKey carries every lane field this read depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchKey]);

  // Read the full message of only the newest few commits, one at a time, to
  // find Co-Authored-By trailers. Older commits fall back to other signals.
  useEffect(() => {
    if (!laneId || !lane) return;
    const pending = selectLaneCommits(commits, lane)
      .slice(0, TRAILER_LOOKUPS)
      .filter((commit) => !trailerProviderCache.has(commit.sha));
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const commit of pending) {
        if (cancelled) return;
        const message = await window.ade.git
          .getCommitMessage({ laneId, commitSha: commit.sha })
          .catch(() => null);
        if (message == null) continue;
        trailerProviderCache.set(commit.sha, parseCoAuthorProvider(message));
      }
      if (!cancelled) setTrailerVersion((value) => value + 1);
    })();
    return () => {
      cancelled = true;
    };
    // `lane` is read only for its type and ahead count, both part of `commits`' key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commits, laneId]);

  const trailerProviderBySha = useMemo(() => {
    void trailerVersion;
    const map = new Map<string, string | null>();
    for (const commit of commits) {
      if (trailerProviderCache.has(commit.sha)) map.set(commit.sha, trailerProviderCache.get(commit.sha) ?? null);
    }
    return map;
  }, [commits, trailerVersion]);

  return { commits, trailerProviderBySha, loaded };
}

/* ───────────────────────── Sessions ───────────────────────── */

const SESSION_HISTORY_LIMIT = 200;

/** CLI titles often start with the tool's spinner glyph ("◐ Fix lanes"); drop it. */
function cleanTerminalTitle(title: string | null | undefined): string {
  return String(title ?? "").replace(/^[^\p{L}\p{N}"'#([]+/u, "").trim();
}

/** The lane's sessions reduced to what the activity feed needs. */
export function laneHistorySessionsFrom(
  laneId: string,
  chats: AgentChatSessionSummary[],
  terminals: TerminalSessionSummary[],
): LaneHistorySession[] {
  const out: LaneHistorySession[] = [];
  const seen = new Set<string>();
  for (const chat of chats) {
    if (chat.laneId !== laneId || seen.has(chat.sessionId)) continue;
    seen.add(chat.sessionId);
    out.push({
      sessionId: chat.sessionId,
      kind: "chat",
      provider: normalizeProvider(chat.provider),
      title: chat.title?.trim() || chat.goal?.trim() || null,
      startedAt: chat.startedAt,
      endedAt: chat.endedAt ?? null,
      lastActivityAt: chat.lastActivityAt ?? null,
    });
  }
  for (const session of terminals) {
    if (session.laneId !== laneId || seen.has(session.id)) continue;
    // Plain shells are not agents, and a chat's own terminals belong to the chat.
    if (!session.toolType || session.toolType === "shell" || session.chatSessionId) continue;
    seen.add(session.id);
    const chatTool = session.toolType.endsWith("-chat");
    out.push({
      sessionId: session.id,
      kind: chatTool ? "chat" : "cli",
      provider: normalizeProvider(session.toolType),
      title: cleanTerminalTitle(session.title) || session.goal?.trim() || null,
      startedAt: session.startedAt,
      endedAt: session.endedAt ?? null,
      lastActivityAt: session.endedAt ?? null,
    });
  }
  return out;
}

/**
 * The lane's chats and agent CLI sessions, as the chat summaries and the
 * terminal rows the Work tab reads its status from. Re-read when `refreshKey`
 * changes; the caller builds it from the lane's live agent roster, which
 * already listens to chat and session events, so this adds no listener.
 */
export function useLaneSessions(
  laneId: string | null,
  refreshKey: string,
): { chats: AgentChatSessionSummary[]; terminals: TerminalSessionSummary[]; loaded: boolean } {
  const [state, setState] = useState<{
    laneId: string | null;
    chats: AgentChatSessionSummary[];
    terminals: TerminalSessionSummary[];
  }>({ laneId: null, chats: [], terminals: [] });
  const requestRef = useRef(0);

  useEffect(() => {
    if (!laneId) return;
    const requestId = ++requestRef.current;
    void Promise.all([
      window.ade.agentChat.list({ laneId, includeArchived: true }).catch(() => []),
      listSessionsCached({ laneId, limit: SESSION_HISTORY_LIMIT }).catch(() => []),
    ]).then(([chats, terminals]) => {
      if (requestId !== requestRef.current) return;
      setState({ laneId, chats, terminals });
    });
  }, [laneId, refreshKey]);

  // Rows of the lane shown before are never shown for the next one.
  if (state.laneId !== laneId) return { chats: [], terminals: [], loaded: false };
  return { chats: state.chats, terminals: state.terminals, loaded: true };
}

/* ───────────────────────── Upstream ───────────────────────── */

/**
 * Reads the lane's upstream state once per lane, and again after its git
 * status moves, so the status line can say what is waiting to push and pull.
 * The Git pane keeps its own, richer reads; this is a single cheap one.
 */
export function useLaneUpstream(lane: LaneSummary | null, active: boolean): GitUpstreamSyncStatus | null {
  const [state, setState] = useState<{ laneId: string | null; status: GitUpstreamSyncStatus | null }>({ laneId: null, status: null });
  const laneId = lane?.id ?? null;
  const statusKey = lane
    ? `${lane.id}:${lane.branchRef}:${lane.status.ahead}:${lane.status.behind}:${lane.status.remoteBehind}:${lane.status.dirty}:${lane.status.lastCommitAt ?? ""}`
    : "";

  useEffect(() => {
    if (!active || !laneId) return;
    let cancelled = false;
    window.ade.git.getSyncStatus({ laneId })
      .then((next) => { if (!cancelled) setState({ laneId, status: next }); })
      .catch(() => { if (!cancelled) setState({ laneId, status: null }); });
    return () => { cancelled = true; };
    // `statusKey` re-reads after a commit, pull or push changed the lane.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, laneId, statusKey]);

  return state.laneId === laneId ? state.status : null;
}

/* ───────────────────────── PR detail ───────────────────────── */

export type LanePrDetail = {
  status: PrStatus | null;
  checks: PrCheck[];
  reviews: PrReview[];
  files: PrFile[];
};

type PrDetailCacheEntry = LanePrDetail & { token: string; at: number };

/** A PR's detail stays fresh this long when nothing about it changed. */
const PR_DETAIL_FRESH_MS = 60_000;
const MAX_PR_DETAIL_CACHE = 24;
const prDetailCache = new Map<string, PrDetailCacheEntry>();

export function clearLanePrDetailCacheForTest(): void {
  prDetailCache.clear();
}

function prDetailKey(pr: LaneHistoryPr): string {
  return pr.linkedPrId ?? pr.key;
}

/** Changes whenever the PR list says something about this PR moved. */
function prDetailToken(pr: LaneHistoryPr): string {
  return [pr.updatedAt, pr.state, pr.checksStatus ?? "", pr.reviewStatus ?? "", String(pr.mergeConflicts)].join("|");
}

function rememberPrDetail(key: string, entry: PrDetailCacheEntry): void {
  prDetailCache.delete(key);
  prDetailCache.set(key, entry);
  while (prDetailCache.size > MAX_PR_DETAIL_CACHE) {
    const oldest = prDetailCache.keys().next().value;
    if (!oldest) break;
    prDetailCache.delete(oldest);
  }
}

async function readPrDetail(pr: LaneHistoryPr, previous: LanePrDetail | null): Promise<LanePrDetail> {
  const api = window.ade.prs;
  const coords = { repoOwner: pr.repoOwner, repoName: pr.repoName, githubPrNumber: pr.number };
  const id = pr.linkedPrId;
  const [status, checks, reviews, files] = await Promise.allSettled([
    id ? api.getStatus(id) : api.getStatusByGithub(coords),
    id ? api.getChecks(id) : api.getChecksByGithub(coords),
    id ? api.getReviews(id) : api.getReviewsByGithub(coords),
    id ? api.getFiles(id) : api.getFilesByGithub(coords),
  ]);
  // A read that failed keeps what was already on screen.
  return {
    status: status.status === "fulfilled" ? status.value ?? null : previous?.status ?? null,
    checks: checks.status === "fulfilled" ? checks.value ?? [] : previous?.checks ?? [],
    reviews: reviews.status === "fulfilled" ? reviews.value ?? [] : previous?.reviews ?? [],
    files: files.status === "fulfilled" ? files.value ?? [] : previous?.files ?? [],
  };
}

/**
 * Status, checks, reviews and changed files of the lane's open PR. Read once
 * when the lane is shown, and again only when the PR list reports the PR
 * changed. No polling: the PR list is already kept fresh by the PR service.
 * Switching back to a lane within a minute reuses the last read.
 */
export function useLanePrDetail(pr: LaneHistoryPr | null, active: boolean): { detail: LanePrDetail | null; loaded: boolean } {
  const key = pr ? prDetailKey(pr) : null;
  const token = pr ? prDetailToken(pr) : "";
  const [state, setState] = useState<{ key: string | null; detail: LanePrDetail | null; loaded: boolean }>(() => {
    const cached = key ? prDetailCache.get(key) ?? null : null;
    return { key, detail: cached, loaded: cached != null };
  });
  const prRef = useRef(pr);
  prRef.current = pr;

  useEffect(() => {
    if (!key || !active || !window.ade?.prs) return;
    const current = prRef.current;
    if (!current) return;
    const cached = prDetailCache.get(key) ?? null;
    if (cached) setState({ key, detail: cached, loaded: true });
    if (cached && cached.token === token && Date.now() - cached.at < PR_DETAIL_FRESH_MS) return;
    let cancelled = false;
    void readPrDetail(current, cached).then((detail) => {
      rememberPrDetail(key, { ...detail, token, at: Date.now() });
      if (!cancelled) setState({ key, detail, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, [active, key, token]);

  if (state.key !== key) {
    const cached = key ? prDetailCache.get(key) ?? null : null;
    return { detail: cached, loaded: cached != null };
  }
  return { detail: state.detail, loaded: state.loaded };
}

/* ───────────────────────── Operations ───────────────────────── */

const OPERATION_LIMIT = 200;

/** Push, pull, rebase and similar records for the lane, re-read when the branch moves. */
export function useLaneOperations(laneId: string | null, refreshKey: string): OperationRecord[] {
  const [operations, setOperations] = useState<OperationRecord[]>([]);
  useEffect(() => {
    if (!laneId || !window.ade?.history?.listOperations) {
      setOperations([]);
      return;
    }
    let cancelled = false;
    void window.ade.history.listOperations({ laneId, limit: OPERATION_LIMIT })
      .then((rows) => {
        if (!cancelled) setOperations(rows);
      })
      .catch(() => {
        if (!cancelled) setOperations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [laneId, refreshKey]);
  return operations;
}
