import React, { useEffect, useState } from "react";
import type { NormalizedLinearIssue } from "../../../shared/types";
import { openIssueRef } from "../../lib/issueNavigation";
import { cachedLinearBrowserIssues } from "../app/LinearIssueBrowser";
import { GitHubIssueStateIcon } from "../lanes/githubBrand";
import { LinearStateIcon } from "../lanes/linearBrand";
import { cachedGitHubIssues, type GitHubRepo } from "./githubIssueStore";
import { cachedLinearIssues } from "./linearIssueStore";

/**
 * Open issues ADE has already read whose titles share most words with the
 * title being typed. Nothing is requested for this: a duplicate is caught from
 * what the panes and viewers already hold.
 */

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3));
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

export type SimilarIssue = { key: string; label: string; title: string; open: () => void; icon: React.ReactNode };

type Candidate = Omit<SimilarIssue, "key"> & { key: string; open: () => void };

function linearCandidates(): Candidate[] {
  const pool = new Map<string, NormalizedLinearIssue>();
  for (const issue of [...cachedLinearIssues(), ...cachedLinearBrowserIssues()]) pool.set(issue.id, issue);
  return [...pool.values()]
    .filter((issue) => issue.stateType !== "completed" && issue.stateType !== "canceled")
    .map((issue) => ({
      key: issue.id,
      label: issue.identifier,
      title: issue.title,
      icon: <LinearStateIcon stateType={issue.stateType} size={11} />,
      open: () => openIssueRef({ ref: { provider: "linear", identifier: issue.identifier, url: issue.url }, source: "issue-viewer" }),
    }));
}

function githubCandidates(repo: GitHubRepo): Candidate[] {
  return cachedGitHubIssues(repo.owner, repo.name)
    .filter((issue) => issue.state === "open")
    .map((issue) => ({
      key: String(issue.number),
      label: `#${issue.number}`,
      title: issue.title,
      icon: <GitHubIssueStateIcon state={issue.state} stateReason={issue.stateReason} size={11} />,
      open: () => openIssueRef({ ref: { provider: "github", owner: issue.owner, repo: issue.repo, number: issue.number, url: issue.url }, source: "issue-viewer" }),
    }));
}

export function useSimilarIssues(provider: "linear" | "github", repo: GitHubRepo | null, title: string): SimilarIssue[] {
  const [similar, setSimilar] = useState<SimilarIssue[]>([]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const mine = words(title);
      const candidates = mine.size < 2 ? [] : provider === "linear" ? linearCandidates() : repo ? githubCandidates(repo) : [];
      setSimilar(candidates
        .map((candidate) => ({ candidate, score: similarity(mine, words(candidate.title)) }))
        .filter((entry) => entry.score >= 0.6)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ candidate }) => candidate));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [provider, repo, title]);
  return similar;
}
