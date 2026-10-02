import type { GitBranchSummary, GitCommitSummary, LaneSummary, PrState, PrSummary } from "../../../shared/types";
import { providerFromAuthorName } from "../lanes/overview/laneHistoryModel";
import { COLORS } from "../lanes/laneDesignTokens";
import { MERGED_COLOR } from "../lanes/overview/sectionUi";

/** PR state → badge/icon colour, shared by the ref badges and the detail pane. */
export const PR_STATE_COLOR: Record<PrState, string> = {
  open: COLORS.success,
  draft: COLORS.textMuted,
  merged: MERGED_COLOR,
  closed: COLORS.danger,
};

/** One ref drawn on a commit row. Local + remote at the same sha fold into one. */
export type CommitRefBadge = {
  key: string;
  /** The branch name as git knows it ("main", "origin/feature"). */
  branch: string;
  kind: "local" | "remote";
  /** The local branch's remote twin points at the same commit. */
  synced: boolean;
  isCurrent: boolean;
  lane: Pick<LaneSummary, "id" | "name" | "color" | "laneType"> | null;
  pr: PrSummary | null;
};

export function normalizeBranchName(ref: string | null | undefined): string {
  return String(ref ?? "").trim().replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");
}

function remoteLocalName(remoteBranch: string): string {
  const slash = remoteBranch.indexOf("/");
  return slash >= 0 ? remoteBranch.slice(slash + 1) : remoteBranch;
}

/**
 * Ref badges per commit sha. Lane-owned branches come first (the focused
 * lane's before others), then other local branches, then remote-only refs.
 */
export function buildRefBadges(args: {
  branches: readonly GitBranchSummary[];
  lanesByBranch: ReadonlyMap<string, Pick<LaneSummary, "id" | "name" | "color" | "laneType">>;
  prsByLaneId: ReadonlyMap<string, PrSummary>;
  focusLaneId: string | null;
}): Map<string, CommitRefBadge[]> {
  const localTips = new Map<string, string>();
  for (const branch of args.branches) {
    if (!branch.isRemote && branch.lastCommitSha) localTips.set(branch.name, branch.lastCommitSha);
  }
  const bySha = new Map<string, CommitRefBadge[]>();
  const push = (sha: string, badge: CommitRefBadge) => {
    const list = bySha.get(sha) ?? [];
    list.push(badge);
    bySha.set(sha, list);
  };
  for (const branch of args.branches) {
    const sha = branch.lastCommitSha?.trim();
    if (!sha) continue;
    if (branch.isRemote) {
      // A remote twin at the same commit is shown as the local badge's cloud.
      if (localTips.get(remoteLocalName(branch.name)) === sha) continue;
      push(sha, {
        key: `remote:${branch.name}`,
        branch: branch.name,
        kind: "remote",
        synced: false,
        isCurrent: false,
        lane: null,
        pr: null,
      });
      continue;
    }
    const lane = args.lanesByBranch.get(branch.name) ?? null;
    const upstreamSha = branch.upstream
      ? args.branches.find((candidate) => candidate.isRemote && candidate.name === branch.upstream)?.lastCommitSha
      : null;
    push(sha, {
      key: `local:${branch.name}`,
      branch: branch.name,
      kind: "local",
      synced: upstreamSha === sha,
      isCurrent: branch.isCurrent,
      lane,
      pr: lane ? args.prsByLaneId.get(lane.id) ?? null : null,
    });
  }
  const rank = (badge: CommitRefBadge): number => {
    if (badge.lane?.id && badge.lane.id === args.focusLaneId) return 0;
    if (badge.isCurrent) return 1;
    if (badge.lane) return 2;
    if (badge.kind === "local") return 3;
    return 4;
  };
  for (const list of bySha.values()) list.sort((a, b) => rank(a) - rank(b) || a.branch.localeCompare(b.branch));
  return bySha;
}

const PR_SUFFIX = /\s*\(#(\d+)\)\s*$/;

/** "fix: thing (#1234)" → { text: "fix: thing", pr: 1234 }. */
export function splitPrSuffix(subject: string): { text: string; pr: number | null } {
  const match = PR_SUFFIX.exec(subject);
  if (!match) return { text: subject, pr: null };
  return { text: subject.slice(0, match.index), pr: Number(match[1]) };
}

/** The agent named by a commit's co-author trailers or its author, if any. */
export function commitAgentProvider(commit: Pick<GitCommitSummary, "authorName" | "coAuthors">): {
  provider: string;
  name: string;
} | null {
  for (const coAuthor of commit.coAuthors ?? []) {
    const provider = providerFromAuthorName(coAuthor);
    if (provider) return { provider, name: coAuthor.replace(/\s*<[^>]*>\s*$/, "").trim() || coAuthor };
  }
  const provider = providerFromAuthorName(commit.authorName);
  return provider ? { provider, name: commit.authorName } : null;
}

const GITHUB_NOREPLY = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i;

/** GitHub avatar for a noreply author email; null for everything else. */
export function githubAvatarForEmail(email: string | null | undefined, size = 40): string | null {
  const match = GITHUB_NOREPLY.exec(String(email ?? "").trim());
  return match ? `https://avatars.githubusercontent.com/${encodeURIComponent(match[1]!)}?s=${size}` : null;
}

/** "3m", "5h", "2d", "4w", "Mar 3" — short enough for a 56px column. */
export function shortWhen(iso: string, now = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "";
  const mins = Math.max(0, Math.floor((now - ts) / 60_000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" });
}

/** "owner/name" from a GitHub remote URL. */
export function githubRepoFromRemote(remoteUrl: string | null | undefined): { owner: string; name: string } | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(
    String(remoteUrl ?? "").trim(),
  );
  return match ? { owner: match[1]!, name: match[2]! } : null;
}

/** One chat or agent CLI session, as `laneHistorySessionsFrom` gives it. */
export type CommitSessionCandidate = {
  sessionId: string;
  kind: "chat" | "cli";
  provider: string | null;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string | null;
};

const SESSION_GRACE_MS = 2 * 60_000;

/**
 * The session of the commit's agent that was running when the commit was
 * made: same provider, started before it, and not idle or ended for more than
 * two minutes before it. The latest such session wins. Null when nothing fits,
 * so a guess is never shown for a commit no agent made.
 */
export function findCommitSession<T extends CommitSessionCandidate>(
  sessions: readonly T[],
  commit: { authoredAt: string },
  provider: string | null,
  now = Date.now(),
): T | null {
  if (!provider) return null;
  const ts = Date.parse(commit.authoredAt);
  if (Number.isNaN(ts)) return null;
  let best: T | null = null;
  let bestStart = -Infinity;
  for (const session of sessions) {
    if (session.provider !== provider) continue;
    const start = Date.parse(session.startedAt);
    if (Number.isNaN(start) || start > ts) continue;
    const endRaw = session.endedAt ?? session.lastActivityAt;
    const end = endRaw ? Date.parse(endRaw) : now;
    if (!Number.isNaN(end) && ts > end + SESSION_GRACE_MS) continue;
    if (start > bestStart) {
      best = session;
      bestStart = start;
    }
  }
  return best;
}

const LIST_ITEM = /^\s*(?:[-*•+]|\d+[.)])\s+/;

/**
 * Undo the 72-column hard wraps of a commit body: lines of one paragraph or
 * one list item join with a space; blank lines and list items keep their
 * breaks.
 */
export function reflowCommitBody(body: string): string {
  const out: string[] = [];
  let prevBlank = true;
  for (const raw of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (!prevBlank) out.push("");
      prevBlank = true;
      continue;
    }
    if (prevBlank || LIST_ITEM.test(line) || out.length === 0) {
      out.push(line.trim());
    } else {
      out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
    }
    prevBlank = false;
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}
