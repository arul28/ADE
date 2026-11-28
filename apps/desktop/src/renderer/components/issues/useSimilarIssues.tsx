import React, { useEffect, useMemo, useRef, useState } from "react";
import type { NormalizedLinearIssue, OpenProjectBinding } from "../../../shared/types";
import { openIssueRef } from "../../lib/issueNavigation";
import { cachedLinearBrowserIssues } from "../app/LinearIssueBrowser";
import { GitHubIssueStateIcon } from "../lanes/githubBrand";
import { LinearStateIcon } from "../lanes/linearBrand";
import { cachedGitHubIssues, type GitHubRepo } from "./githubIssueStore";
import { cachedLinearIssues } from "./linearIssueStore";

/**
 * Issues whose titles share most words with the title being typed, so a
 * duplicate is caught before it is filed.
 *
 * Two sources, merged: issues ADE has already read (instant, no request), and
 * for Linear a server search once the title says enough (three meaningful
 * words), debounced so typing never sends one request per key. A reply for an
 * older title never replaces a newer one, and a title searched once in this
 * session is answered from memory.
 */

const LOCAL_DELAY_MS = 300;
const SEARCH_DELAY_MS = 400;
const SEARCH_MIN_WORDS = 3;
const SEARCH_FIRST = 6;
const MAX_SHOWN = 4;
const CLOSED_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const MATCH_SCORE = 0.6;
const VERY_CLOSE_SCORE = 0.85;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "when", "that", "this", "not", "are", "was", "but", "can", "does",
  "should", "after", "before", "about", "have", "has", "its", "our", "your", "all", "any", "add", "new", "use",
]);

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3));
}

function meaningfulWordCount(value: string): number {
  let count = 0;
  for (const word of words(value)) if (!STOP_WORDS.has(word)) count += 1;
  return count;
}

function normalizedTitle(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

/** 2 = same title, 1.5 = one title contains the other, else the shared-word share. */
function titleScore(typed: string, typedWords: Set<string>, candidate: string): number {
  const a = normalizedTitle(typed);
  const b = normalizedTitle(candidate);
  if (a && a === b) return 2;
  if (a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a))) return 1.5;
  return similarity(typedWords, words(candidate));
}

export type SimilarIssue = { key: string; label: string; title: string; open: () => void; icon: React.ReactNode; closed?: boolean };

type Candidate = SimilarIssue & { closedAtMs: number | null };

function closedAtMs(issue: NormalizedLinearIssue): number | null {
  if (issue.stateType !== "completed" && issue.stateType !== "canceled") return null;
  const when = Date.parse(issue.completedAt ?? issue.canceledAt ?? issue.updatedAt ?? "");
  return Number.isFinite(when) ? when : 0;
}

function linearCandidate(issue: NormalizedLinearIssue): Candidate {
  const closedAt = closedAtMs(issue);
  return {
    key: issue.id,
    label: issue.identifier,
    title: issue.title,
    icon: <LinearStateIcon stateType={issue.stateType} size={11} />,
    closed: closedAt != null,
    closedAtMs: closedAt,
    open: () => openIssueRef({ ref: { provider: "linear", identifier: issue.identifier, url: issue.url }, source: "issue-viewer" }),
  };
}

function localLinearIssues(): NormalizedLinearIssue[] {
  const pool = new Map<string, NormalizedLinearIssue>();
  for (const issue of [...cachedLinearIssues(), ...cachedLinearBrowserIssues()]) pool.set(issue.id, issue);
  return [...pool.values()];
}

function githubCandidates(repo: GitHubRepo): Candidate[] {
  return cachedGitHubIssues(repo.owner, repo.name)
    .filter((issue) => issue.state === "open")
    .map((issue) => ({
      key: String(issue.number),
      label: `#${issue.number}`,
      title: issue.title,
      closedAtMs: null,
      icon: <GitHubIssueStateIcon state={issue.state} stateReason={issue.stateReason} size={11} />,
      open: () => openIssueRef({ ref: { provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url }, source: "issue-viewer" }),
    }));
}

/** Rank, dedupe and trim: exact and close titles first; old closed issues only when very close. */
function rankCandidates(title: string, candidates: Candidate[], nowMs: number): SimilarIssue[] {
  const mine = words(title);
  if (mine.size < 2) return [];
  const byKey = new Map<string, { candidate: Candidate; score: number }>();
  for (const candidate of candidates) {
    const score = titleScore(title, mine, candidate.title);
    if (score < MATCH_SCORE) continue;
    if (candidate.closedAtMs != null && nowMs - candidate.closedAtMs > CLOSED_MAX_AGE_MS && score < VERY_CLOSE_SCORE) continue;
    const current = byKey.get(candidate.key);
    if (!current || current.score < score) byKey.set(candidate.key, { candidate, score });
  }
  return [...byKey.values()]
    // Open issues outrank closed ones at the same score: those are the real duplicates.
    .sort((a, b) => b.score - a.score || Number(a.candidate.closed === true) - Number(b.candidate.closed === true))
    .slice(0, MAX_SHOWN)
    .map(({ candidate }) => {
      const { closedAtMs: _closedAt, ...issue } = candidate;
      return issue;
    });
}

// Titles searched this session, so retyping or reopening the dialog asks nothing.
const searchMemory = new Map<string, NormalizedLinearIssue[]>();
const SEARCH_MEMORY_LIMIT = 40;

function rememberSearch(key: string, issues: NormalizedLinearIssue[]): void {
  if (searchMemory.size >= SEARCH_MEMORY_LIMIT) {
    const oldest = searchMemory.keys().next().value;
    if (oldest !== undefined) searchMemory.delete(oldest);
  }
  searchMemory.set(key, issues);
}

export function useSimilarIssues(
  provider: "linear" | "github",
  repo: GitHubRepo | null,
  title: string,
  options: {
    /** The Linear reader machine (`useActiveRepositoryReader`); null: nothing is asked. */
    pin?: OpenProjectBinding | null;
    /** Linear answered for this project (its picker catalog loaded). */
    linearConnected?: boolean;
  } = {},
): SimilarIssue[] {
  const [localTitle, setLocalTitle] = useState(title);
  const [server, setServer] = useState<NormalizedLinearIssue[]>([]);
  const pinRef = useRef(options.pin ?? null);
  pinRef.current = options.pin ?? null;
  const pinKey = options.pin?.key ?? null;
  const requestRef = useRef(0);

  // Local matches follow the title after a short pause.
  useEffect(() => {
    const timer = window.setTimeout(() => setLocalTitle(title), LOCAL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [title]);

  // The server search: debounced, only with enough words, only when Linear is connected.
  const query = title.trim().replace(/\s+/g, " ");
  const searchable = provider === "linear"
    && options.linearConnected === true
    && pinKey != null
    && meaningfulWordCount(query) >= SEARCH_MIN_WORDS;
  useEffect(() => {
    const request = ++requestRef.current;
    if (!searchable) return undefined;
    const memoryKey = `${pinKey}\n${query.toLowerCase()}`;
    const remembered = searchMemory.get(memoryKey);
    if (remembered) {
      setServer(remembered);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      const search = window.ade?.cto?.searchLinearIssues;
      const readPin = pinRef.current;
      if (typeof search !== "function" || !readPin) return;
      void search({ query, first: SEARCH_FIRST }, readPin)
        .then((result) => {
          const issues = result?.issues ?? [];
          rememberSearch(memoryKey, issues);
          if (requestRef.current === request) setServer(issues);
        })
        .catch(() => {
          // A failed search leaves the local matches; no error under a title field.
        });
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pinKey, query, searchable]);

  // A different project or tracker starts from nothing.
  useEffect(() => {
    setServer([]);
  }, [pinKey, provider]);

  return useMemo(() => {
    const nowMs = Date.now();
    if (provider === "github") return repo ? rankCandidates(localTitle, githubCandidates(repo), nowMs) : [];
    const pool = new Map<string, NormalizedLinearIssue>();
    for (const issue of localLinearIssues()) pool.set(issue.id, issue);
    // Server results are scored against the title as it is now, so a reply to
    // an older title only shows the issues that still match.
    for (const issue of server) pool.set(issue.id, issue);
    return rankCandidates(localTitle, [...pool.values()].map(linearCandidate), nowMs);
  }, [localTitle, provider, repo, server]);
}
