import type { BranchPullRequest } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";

/**
 * Tokens that can be ANDed together in the search bar.
 *
 *   pr:open    — only branches with an open PR
 *   pr:none    — only branches with no PR
 *   pr:draft   — only branches whose PR is draft
 *   author:NAME — last-commit author matches NAME (case-insensitive substring)
 *   author:me  — last-commit author matches the current git user
 *   mine       — alias for author:me
 *   stale:Nd   — last commit older than N days
 *   #N         — exact PR number
 *
 * Anything left over is fuzzy matched across name, PR title, and author.
 */
export type SearchToken =
  | { kind: "pr"; value: "open" | "none" | "draft" }
  | { kind: "author"; value: string; isMe: boolean }
  | { kind: "mine" }
  | { kind: "stale"; days: number }
  | { kind: "prNumber"; value: number };

export type ParsedSearchQuery = {
  tokens: SearchToken[];
  freeText: string;
};

const KNOWN_PR_VALUES = new Set(["open", "none", "draft"]);

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const tokens: SearchToken[] = [];
  const leftover: string[] = [];
  const parts = input.trim().split(/\s+/).filter(Boolean);

  for (const raw of parts) {
    const lower = raw.toLowerCase();

    if (lower === "mine") {
      tokens.push({ kind: "mine" });
      continue;
    }

    if (lower.startsWith("pr:")) {
      const value = lower.slice(3);
      if (KNOWN_PR_VALUES.has(value)) {
        tokens.push({ kind: "pr", value: value as "open" | "none" | "draft" });
        continue;
      }
    }

    if (lower.startsWith("author:")) {
      const rest = raw.slice(7);
      const isMe = rest.toLowerCase() === "me";
      tokens.push({ kind: "author", value: rest, isMe });
      continue;
    }

    if (lower.startsWith("stale:")) {
      const match = lower.slice(6).match(/^(\d+)d?$/);
      if (match) {
        const days = Number(match[1]);
        if (Number.isFinite(days) && days > 0) {
          tokens.push({ kind: "stale", days });
          continue;
        }
      }
    }

    if (lower.startsWith("#")) {
      const num = Number(lower.slice(1));
      if (Number.isInteger(num) && num > 0) {
        tokens.push({ kind: "prNumber", value: num });
        continue;
      }
    }

    leftover.push(raw);
  }

  return { tokens, freeText: leftover.join(" ").trim() };
}

export type BranchMatchContext = {
  branch: LaneBranchOption;
  pr: BranchPullRequest | null;
  /** Lowercased current user — for `author:me` / `mine`. */
  currentUserName: string;
  /** Reference time for stale comparisons, defaults to Date.now(). */
  now?: number;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fuzzyContains(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function matchesQuery(ctx: BranchMatchContext, query: ParsedSearchQuery): boolean {
  const { branch, pr, currentUserName } = ctx;
  const me = currentUserName.toLowerCase();
  const now = ctx.now ?? Date.now();

  for (const token of query.tokens) {
    switch (token.kind) {
      case "pr": {
        if (token.value === "none" && pr) return false;
        if (token.value === "open" && (!pr || pr.state !== "open")) return false;
        if (token.value === "draft" && (!pr || pr.state !== "draft")) return false;
        break;
      }
      case "prNumber": {
        if (!pr || pr.prNumber !== token.value) return false;
        break;
      }
      case "author": {
        const target = token.isMe ? me : token.value.toLowerCase();
        if (!target) return false;
        if (!fuzzyContains(branch.lastCommitAuthor, target)) return false;
        break;
      }
      case "mine": {
        if (!me || !fuzzyContains(branch.lastCommitAuthor, me)) return false;
        break;
      }
      case "stale": {
        const ts = branch.lastCommitDate ? Date.parse(branch.lastCommitDate) : Number.NaN;
        if (!Number.isFinite(ts)) return false;
        const ageDays = (now - ts) / MS_PER_DAY;
        if (ageDays < token.days) return false;
        break;
      }
    }
  }

  if (query.freeText) {
    const text = query.freeText.toLowerCase();
    const hits =
      fuzzyContains(branch.name, text) ||
      fuzzyContains(branch.lastCommitMessage, text) ||
      fuzzyContains(branch.lastCommitAuthor, text) ||
      fuzzyContains(pr?.title ?? null, text) ||
      fuzzyContains(pr?.author ?? null, text) ||
      (pr ? `#${pr.prNumber}`.includes(text) : false);
    if (!hits) return false;
  }

  return true;
}

export function formatRelativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffMs = now - ts;
  if (diffMs < 0) return "now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  const years = Math.floor(days / 365);
  return `${years}y`;
}
