import type {
  AutoRebaseLaneStatus,
  GitCommitSummary,
  LaneSummary,
  OperationRecord,
  PrChecksStatus,
  PrReviewStatus,
  PrState,
  RebaseSuggestion,
} from "../../../../shared/types";

/**
 * Pure derivation for the lane dashboard: the activity strip, PR problems and
 * the activity feed. Everything here is computed from data the app already
 * has. No fetching.
 */

/* ───────────────────────── Actors ───────────────────────── */

export type LaneHistoryActor =
  | { kind: "agent"; provider: string }
  | { kind: "human"; name: string; login?: string | null; avatarUrl?: string | null }
  | { kind: "system" };

const PROVIDER_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  droid: "Droid",
  opencode: "OpenCode",
  copilot: "Copilot",
  gemini: "Gemini",
  pi: "Pi",
  qwen: "Qwen",
  kimi: "Kimi",
  grok: "Grok",
};

export function providerDisplayName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? (provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "Agent");
}

/**
 * Turns a chat provider or a terminal tool type ("claude-chat", "cursor-cli",
 * "codex-orchestrated") into a plain provider key ("claude", "cursor", "codex").
 */
export function normalizeProvider(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value || value === "shell" || value === "other") return null;
  const base = value.replace(/-(chat|cli|orchestrated)$/, "");
  return base || null;
}

/** Match a free-form name or email against the agents ADE knows. */
function providerFromText(text: string): string | null {
  const s = text.toLowerCase();
  if (/claude|anthropic/.test(s)) return "claude";
  if (/codex|openai|chatgpt/.test(s)) return "codex";
  if (/cursor/.test(s)) return "cursor";
  if (/copilot/.test(s)) return "copilot";
  if (/gemini/.test(s)) return "gemini";
  if (/opencode/.test(s)) return "opencode";
  if (/\bdroid\b|factory\.ai|factory-droid/.test(s)) return "droid";
  return null;
}

/**
 * Reads the `Co-Authored-By:` trailers of a commit message and returns the
 * first agent it names, e.g. "Co-Authored-By: Claude <noreply@anthropic.com>"
 * gives "claude". Human co-authors are ignored.
 */
export function parseCoAuthorProvider(message: string | null | undefined): string | null {
  if (!message) return null;
  const pattern = /^\s*co-authored-by:\s*(.+)$/gim;
  for (const match of message.matchAll(pattern)) {
    const provider = providerFromText(match[1] ?? "");
    if (provider) return provider;
  }
  return null;
}

/** Some agents commit under their own git identity ("Claude", "cursoragent"). */
export function providerFromAuthorName(name: string | null | undefined): string | null {
  const value = String(name ?? "").trim();
  if (!value) return null;
  return providerFromText(value);
}

/* ───────────────────────── Inputs ───────────────────────── */

/** One chat or agent CLI session of the lane, reduced to what the feed needs. */
export type LaneHistorySession = {
  sessionId: string;
  kind: "chat" | "cli";
  provider: string | null;
  title: string | null;
  startedAt: string;
  /** When the session stopped doing work. Null while it is still live. */
  endedAt: string | null;
  lastActivityAt: string | null;
};

/** One PR of the lane, merged from the ADE row and the GitHub list item. */
export type LaneHistoryPr = {
  key: string;
  linkedPrId: string | null;
  number: number;
  repoOwner: string;
  repoName: string;
  title: string;
  state: PrState;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergedBy: { login: string; avatarUrl: string | null } | null;
  author: string | null;
  checksStatus: PrChecksStatus | null;
  reviewStatus: PrReviewStatus | null;
  mergeConflicts: boolean | null;
  /** Diff size when known; GitHub-only rows from older snapshots have none. */
  additions?: number | null;
  deletions?: number | null;
};

/* ───────────────────────── Entries ───────────────────────── */

export type LaneHistoryCategory = "commit" | "git" | "pr" | "agent" | "lane";
export type LaneHistoryFilter = "all" | "commits" | "prs" | "agents";
export type LaneHistoryTone = "success" | "danger" | "warning" | null;

export type LaneHistoryTarget =
  | { kind: "commit"; laneId: string; sha: string }
  | {
      kind: "pr";
      linkedPrId: string | null;
      number: number;
      repoOwner: string;
      repoName: string;
    }
  | { kind: "chat"; laneId: string; sessionId: string };

export type LaneHistoryEntry = {
  id: string;
  at: string;
  ts: number;
  category: LaneHistoryCategory;
  actor: LaneHistoryActor;
  /** Plain lead text, e.g. "Claude committed". */
  text: string;
  /** Emphasized trailing part, e.g. the commit subject or chat title. */
  emphasis: string | null;
  tone: LaneHistoryTone;
  target: LaneHistoryTarget | null;
  /** Hover text: the full sha, the attribution source, and so on. */
  hint: string | null;
};

function toTs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
}

function shortBranch(ref: string | null | undefined): string {
  return String(ref ?? "").replace(/^refs\/heads\//, "").replace(/^origin\//, "").trim();
}

/**
 * `listRecentCommits` is a plain `git log` of HEAD, so it also returns the base
 * branch's history. The lane's own commits are the newest `ahead` rows. On the
 * primary lane the base IS the branch, so every commit belongs to it.
 */
export function selectLaneCommits(
  commits: GitCommitSummary[],
  lane: Pick<LaneSummary, "laneType" | "status">,
): GitCommitSummary[] {
  if (lane.laneType === "primary") return commits;
  const ahead = Math.max(0, lane.status?.ahead ?? 0);
  return commits.slice(0, ahead);
}

const SESSION_WINDOW_GRACE_MS = 2 * 60_000;

/**
 * When a commit carries no trailer, fall back to the agent whose session was
 * running when it was made — but only when exactly one provider was active, so
 * two agents at once never get guessed.
 */
export function providerActiveAt(ts: number, sessions: LaneHistorySession[], nowTs: number): string | null {
  const providers = new Set<string>();
  for (const session of sessions) {
    if (!session.provider) continue;
    const start = toTs(session.startedAt);
    if (start == null || ts < start) continue;
    // A chat that is still open but quiet should not claim commits made long
    // after its last turn, so the window ends at its last activity.
    const end = toTs(session.endedAt) ?? toTs(session.lastActivityAt) ?? nowTs;
    if (ts > end + SESSION_WINDOW_GRACE_MS) continue;
    providers.add(session.provider);
  }
  return providers.size === 1 ? [...providers][0]! : null;
}

function commitEntry(args: {
  commit: GitCommitSummary;
  laneId: string;
  trailerProvider: string | null | undefined;
  sessions: LaneHistorySession[];
  inferFromSessions: boolean;
  nowTs: number;
}): LaneHistoryEntry | null {
  const { commit } = args;
  const ts = toTs(commit.authoredAt);
  if (ts == null) return null;
  let provider = args.trailerProvider ?? providerFromAuthorName(commit.authorName);
  let source: string | null = null;
  if (!provider && args.inferFromSessions) {
    provider = providerActiveAt(ts, args.sessions, args.nowTs);
    if (provider) source = `${providerDisplayName(provider)} chat was running`;
  }
  const author = commit.authorName.trim() || "Someone";
  const actor: LaneHistoryActor = provider
    ? { kind: "agent", provider }
    : { kind: "human", name: author };
  const who = provider ? providerDisplayName(provider) : author;
  const hintParts = [commit.shortSha || commit.sha.slice(0, 7), commit.authorName.trim() || null, source];
  return {
    id: `commit:${commit.sha}`,
    at: commit.authoredAt,
    ts,
    category: "commit",
    actor,
    text: `${who} committed`,
    emphasis: commit.subject.trim() || commit.shortSha,
    tone: null,
    target: { kind: "commit", laneId: args.laneId, sha: commit.sha },
    hint: hintParts.filter(Boolean).join(" · "),
  };
}

function prTarget(pr: LaneHistoryPr): LaneHistoryTarget {
  return {
    kind: "pr",
    linkedPrId: pr.linkedPrId,
    number: pr.number,
    repoOwner: pr.repoOwner,
    repoName: pr.repoName,
  };
}

function prEntries(pr: LaneHistoryPr): LaneHistoryEntry[] {
  const out: LaneHistoryEntry[] = [];
  const target = prTarget(pr);
  const title = pr.title.trim() || null;
  const createdTs = toTs(pr.createdAt);
  if (createdTs != null) {
    out.push({
      id: `pr-opened:${pr.key}`,
      at: pr.createdAt,
      ts: createdTs,
      category: "pr",
      actor: pr.author ? { kind: "human", name: pr.author, login: pr.author } : { kind: "system" },
      text: `PR #${pr.number} opened`,
      emphasis: title,
      tone: null,
      target,
      hint: pr.author ? `Opened by ${pr.author}` : null,
    });
  }

  if (pr.state === "merged") {
    const at = pr.mergedAt ?? pr.updatedAt;
    const ts = toTs(at);
    if (ts != null) {
      out.push({
        id: `pr-merged:${pr.key}`,
        at,
        ts,
        category: "pr",
        actor: pr.mergedBy
          ? { kind: "human", name: pr.mergedBy.login, login: pr.mergedBy.login, avatarUrl: pr.mergedBy.avatarUrl }
          : { kind: "system" },
        text: `PR #${pr.number} merged`,
        emphasis: null,
        tone: "success",
        target,
        hint: pr.mergedBy ? `Merged by ${pr.mergedBy.login}` : null,
      });
    }
    return out;
  }

  if (pr.state === "closed") {
    const ts = toTs(pr.updatedAt);
    if (ts != null) {
      out.push({
        id: `pr-closed:${pr.key}`,
        at: pr.updatedAt,
        ts,
        category: "pr",
        actor: { kind: "system" },
        text: `PR #${pr.number} closed`,
        emphasis: null,
        tone: null,
        target,
        hint: null,
      });
    }
    return out;
  }

  // An open PR adds one line for its latest known check or review state. It is
  // dated at the PR's last update, which is the closest time the app has.
  const updatedTs = toTs(pr.updatedAt);
  if (updatedTs == null || (createdTs != null && updatedTs <= createdTs)) return out;
  const latest = latestPrState(pr);
  if (latest) {
    out.push({
      id: `pr-state:${pr.key}`,
      at: pr.updatedAt,
      ts: updatedTs,
      category: "pr",
      actor: { kind: "system" },
      text: latest.text,
      emphasis: null,
      tone: latest.tone,
      target,
      hint: null,
    });
  }
  return out;
}

function latestPrState(pr: LaneHistoryPr): { text: string; tone: LaneHistoryTone } | null {
  if (pr.checksStatus === "failing") return { text: `Checks failed on #${pr.number}`, tone: "danger" };
  if (pr.reviewStatus === "changes_requested") return { text: `Changes requested on #${pr.number}`, tone: "warning" };
  if (pr.reviewStatus === "approved") return { text: `#${pr.number} approved`, tone: "success" };
  if (pr.checksStatus === "passing") return { text: `Checks passed on #${pr.number}`, tone: "success" };
  return null;
}

function sessionEntry(session: LaneHistorySession, laneId: string): LaneHistoryEntry | null {
  const ts = toTs(session.startedAt);
  if (ts == null) return null;
  const who = session.provider ? providerDisplayName(session.provider) : "Agent";
  const noun = session.kind === "chat" ? "chat" : "CLI";
  return {
    id: `session:${session.sessionId}`,
    at: session.startedAt,
    ts,
    category: "agent",
    actor: session.provider ? { kind: "agent", provider: session.provider } : { kind: "system" },
    text: `${who} ${noun} started`,
    emphasis: session.title?.trim() || null,
    tone: null,
    target: { kind: "chat", laneId, sessionId: session.sessionId },
    hint: null,
  };
}

/** Lane operations worth a line. Fetch, stage, discard and commit are noise here. */
const OPERATION_TEXT: Record<string, { ok: string; failed: string }> = {
  git_push: { ok: "Pushed to remote", failed: "Push failed" },
  git_pull: { ok: "Pulled from remote", failed: "Pull failed" },
  git_sync_merge: { ok: "Synced with remote", failed: "Sync failed" },
  lane_rebase: { ok: "Rebased onto base", failed: "Rebase failed" },
  git_rebase_abort: { ok: "Rebase aborted", failed: "Rebase abort failed" },
  git_merge_abort: { ok: "Merge aborted", failed: "Merge abort failed" },
  git_checkout_branch: { ok: "Switched branch", failed: "Branch switch failed" },
  git_revert: { ok: "Reverted a commit", failed: "Revert failed" },
  git_reset_hard: { ok: "Reset the branch", failed: "Reset failed" },
  git_cherry_pick: { ok: "Cherry-picked a commit", failed: "Cherry-pick failed" },
  lane_reparent: { ok: "Moved to a new parent lane", failed: "Reparent failed" },
};

function operationBranch(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>;
    const value = meta.branchRef ?? meta.branch ?? meta.targetBranch ?? null;
    return typeof value === "string" && value.trim() ? shortBranch(value) : null;
  } catch {
    return null;
  }
}

function operationEntry(op: OperationRecord): LaneHistoryEntry | null {
  const copy = OPERATION_TEXT[op.kind];
  if (!copy) return null;
  if (op.status === "running" || op.status === "canceled") return null;
  const at = op.endedAt ?? op.startedAt;
  const ts = toTs(at);
  if (ts == null) return null;
  const failed = op.status === "failed";
  return {
    id: `op:${op.id}`,
    at,
    ts,
    category: "git",
    actor: { kind: "system" },
    text: failed ? copy.failed : copy.ok,
    emphasis: op.kind === "git_checkout_branch" ? operationBranch(op.metadataJson) : null,
    tone: failed ? "danger" : null,
    target: null,
    hint: op.postHeadSha ? op.postHeadSha.slice(0, 7) : null,
  };
}

function laneCreatedEntry(lane: Pick<LaneSummary, "id" | "createdAt" | "baseRef" | "laneType">): LaneHistoryEntry | null {
  const ts = toTs(lane.createdAt);
  if (ts == null) return null;
  const base = shortBranch(lane.baseRef);
  return {
    id: `lane-created:${lane.id}`,
    at: lane.createdAt,
    ts,
    category: "lane",
    actor: { kind: "system" },
    text: "Lane created",
    emphasis: lane.laneType !== "primary" && base ? `from ${base}` : null,
    tone: null,
    target: null,
    hint: null,
  };
}

export function buildLaneHistory(args: {
  lane: Pick<LaneSummary, "id" | "createdAt" | "baseRef" | "laneType" | "status">;
  commits: GitCommitSummary[];
  /** Provider read from each commit's trailers; undefined when not fetched. */
  trailerProviderBySha?: ReadonlyMap<string, string | null>;
  prs: LaneHistoryPr[];
  sessions: LaneHistorySession[];
  operations?: OperationRecord[];
  now?: number;
}): LaneHistoryEntry[] {
  const nowTs = args.now ?? Date.now();
  const laneId = args.lane.id;
  const entries: LaneHistoryEntry[] = [];
  // On the primary lane a human often commits while a chat idles, so a
  // time-window guess would be wrong more often than right there.
  const inferFromSessions = args.lane.laneType !== "primary";

  for (const commit of selectLaneCommits(args.commits, args.lane)) {
    const entry = commitEntry({
      commit,
      laneId,
      trailerProvider: args.trailerProviderBySha?.get(commit.sha),
      sessions: args.sessions,
      inferFromSessions,
      nowTs,
    });
    if (entry) entries.push(entry);
  }

  for (const pr of args.prs) entries.push(...prEntries(pr));

  for (const session of args.sessions) {
    const entry = sessionEntry(session, laneId);
    if (entry) entries.push(entry);
  }

  for (const op of args.operations ?? []) {
    if (op.laneId && op.laneId !== laneId) continue;
    const entry = operationEntry(op);
    if (entry) entries.push(entry);
  }

  const created = laneCreatedEntry(args.lane);
  if (created) entries.push(created);

  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .sort((a, b) => (b.ts - a.ts) || a.id.localeCompare(b.id));
}

export function filterLaneHistory(entries: LaneHistoryEntry[], filter: LaneHistoryFilter): LaneHistoryEntry[] {
  switch (filter) {
    case "commits": return entries.filter((e) => e.category === "commit" || e.category === "git");
    case "prs": return entries.filter((e) => e.category === "pr");
    case "agents": return entries.filter((e) => e.category === "agent" || (e.category === "commit" && e.actor.kind === "agent"));
    default: return entries;
  }
}

/* ───────────────────────── Day groups ───────────────────────── */

export type LaneHistoryDay = { key: string; label: string; entries: LaneHistoryEntry[] };

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "Today", "Yesterday", or "Mon 21 Sep" (with the year when it is not this year). */
export function dayLabel(ts: number, nowTs: number): string {
  const date = new Date(ts);
  const now = new Date(nowTs);
  if (dayKey(date) === dayKey(now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(date) === dayKey(yesterday)) return "Yesterday";
  const weekday = date.toLocaleDateString(undefined, { weekday: "short" });
  const month = date.toLocaleDateString(undefined, { month: "short" });
  const label = `${weekday} ${date.getDate()} ${month}`;
  return date.getFullYear() === now.getFullYear() ? label : `${label} ${date.getFullYear()}`;
}

/** Entries must already be sorted newest first. */
export function groupLaneHistoryByDay(entries: LaneHistoryEntry[], nowTs: number = Date.now()): LaneHistoryDay[] {
  const days: LaneHistoryDay[] = [];
  for (const entry of entries) {
    const key = dayKey(new Date(entry.ts));
    const last = days[days.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
    } else {
      days.push({ key, label: dayLabel(entry.ts, nowTs), entries: [entry] });
    }
  }
  return days;
}

export function formatEntryTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/* ───────────────────────── Rebase ───────────────────────── */

export type LaneNoticeTone = "danger" | "warning" | "muted";

/** Where a rebase line came from, so the notice knows what Dismiss clears. */
export type LaneRebaseSource = "in-progress" | "auto-rebase" | "suggestion" | "behind";

/** The one line about rebasing, or null when the lane is up to date. */
export function laneRebaseNeed(args: {
  lane: Pick<LaneSummary, "laneType" | "baseRef" | "branchRef" | "status">;
  rebaseSuggestion: RebaseSuggestion | null | undefined;
  autoRebaseStatus: AutoRebaseLaneStatus | null | undefined;
  parentName?: string | null;
}): { label: string; tone: LaneNoticeTone; source: LaneRebaseSource } | null {
  const { lane } = args;
  if (lane.status?.rebaseInProgress) return { label: "Rebase in progress", tone: "danger", source: "in-progress" };
  const auto = args.autoRebaseStatus;
  if (auto?.state === "rebaseConflict") {
    return { label: "Auto-rebase stopped on conflicts", tone: "danger", source: "auto-rebase" };
  }
  if (auto?.state === "rebaseFailed") return { label: "Auto-rebase failed", tone: "danger", source: "auto-rebase" };
  if (auto?.state === "rebasePending") {
    return { label: auto.message?.trim() || "Auto-rebase is waiting on a manual rebase", tone: "warning", source: "auto-rebase" };
  }
  const base = args.rebaseSuggestion?.baseLabel?.trim() || args.parentName?.trim() || shortBranch(lane.baseRef) || "base";
  const suggestion = args.rebaseSuggestion;
  if (suggestion && !suggestion.dismissedAt && suggestion.behindCount > 0) {
    const n = suggestion.behindCount;
    return { label: `${n} commit${n === 1 ? "" : "s"} behind ${base} · rebase needed`, tone: "warning", source: "suggestion" };
  }
  // The primary lane has no base of its own to fall behind.
  if (lane.laneType === "primary") return null;
  const behind = lane.status?.behind ?? 0;
  if (behind > 0) return { label: `${behind} commit${behind === 1 ? "" : "s"} behind ${base}`, tone: "muted", source: "behind" };
  return null;
}
