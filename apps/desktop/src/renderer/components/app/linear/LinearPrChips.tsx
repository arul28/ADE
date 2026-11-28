import React, { useMemo } from "react";
import type { NormalizedLinearIssue } from "../../../../shared/types";
import { useAppStore } from "../../../state/appStore";
import { cachedGitRemoteIdentity, originUrlForBinding } from "../../lanes/laneMachines";
import { HoverCard } from "../../ui/HoverCard";
import { cn } from "../../ui/cn";
import {
  navigateFromLinearPane,
  normalizePrUrl,
  openExternalUrl,
  prRepoNumberKey,
  stopRowActivation,
  type LinearIssueAdeStatus,
  type LinearIssueAdeStatusPr,
} from "./adeStatus";

/**
 * The pull request chip of a Linear issue row, merged from what Linear knows
 * (the issue's PR attachments) and what ADE knows (its PR rows, with checks
 * and review). One PR reads `#2504`; several read `3 PRs` with a list on
 * hover. A PR ADE knows opens in the PRs tab; any other opens on GitHub.
 */

type PrState = "open" | "draft" | "merged" | "closed" | "unknown";

type ChipPr = {
  key: string;
  number: number | null;
  url: string;
  title: string;
  repo: string | null;
  state: PrState;
  checks: LinearIssueAdeStatusPr["checks"] | null;
  review: LinearIssueAdeStatusPr["review"] | null;
  adePath: string | null;
};

const STATE_RANK: Record<PrState, number> = { open: 0, draft: 1, unknown: 2, merged: 3, closed: 4 };

const STATE_COLOR: Record<PrState, string> = {
  open: "var(--color-success)",
  draft: "var(--color-muted-fg)",
  unknown: "var(--color-muted-fg)",
  merged: "var(--ade-lane-merged, #A371F7)",
  closed: "var(--color-error)",
};

const STATE_LABEL: Record<PrState, string> = {
  open: "Open",
  draft: "Draft",
  unknown: "Pull request",
  merged: "Merged",
  closed: "Closed",
};

const CHECKS_COLOR: Record<LinearIssueAdeStatusPr["checks"], string | null> = {
  passing: "var(--color-check-pass, var(--color-success))",
  failing: "var(--color-error)",
  pending: "var(--color-warning)",
  none: null,
};

const CHECKS_LABEL: Record<LinearIssueAdeStatusPr["checks"], string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks running",
  none: "",
};

const REVIEW_LABEL: Record<LinearIssueAdeStatusPr["review"], string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  pending: "Review requested",
  none: "",
};

/** A merged or closed PR cannot go back to open: a terminal state from either side wins. */
function mergedState(linear: PrState, ade: LinearIssueAdeStatusPr["state"] | null): PrState {
  if (!ade) return linear;
  if (linear === "merged" || linear === "closed") return ade === "merged" || ade === "closed" ? ade : linear;
  return ade;
}

function buildChipPrs(issue: NormalizedLinearIssue, status: LinearIssueAdeStatus | null): ChipPr[] {
  const ade = status?.prs ?? [];
  const usedAde = new Set<LinearIssueAdeStatusPr>();
  const findAde = (url: string | null, repo: string | null, number: number | null) => {
    const normalized = normalizePrUrl(url);
    const repoKey = prRepoNumberKey(repo, number);
    return ade.find((pr) => normalizePrUrl(pr.url) === normalized)
      ?? (repoKey ? ade.find((pr) => prRepoNumberKey(pr.repo, pr.number) === repoKey) : undefined)
      ?? null;
  };
  const out: ChipPr[] = [];
  const seenUrls = new Set<string>();
  for (const linear of issue.pullRequests ?? []) {
    const url = normalizePrUrl(linear.url);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    const match = findAde(linear.url, linear.repo, linear.number);
    if (match) usedAde.add(match);
    out.push({
      key: url,
      number: linear.number ?? match?.number ?? null,
      url: linear.url,
      title: match?.title || linear.title || "",
      repo: linear.repo ?? match?.repo ?? null,
      state: mergedState(linear.status, match?.state ?? null),
      checks: match?.checks ?? null,
      review: match?.review ?? null,
      adePath: match?.adePath ?? null,
    });
  }
  // ADE knows PRs for the issue's lanes that Linear has not linked (yet).
  for (const pr of ade) {
    if (usedAde.has(pr)) continue;
    const url = normalizePrUrl(pr.url) ?? `${pr.repo ?? ""}#${pr.number}`;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);
    out.push({
      key: url,
      number: pr.number,
      url: pr.url,
      title: pr.title ?? "",
      repo: pr.repo ?? null,
      state: pr.state,
      checks: pr.checks,
      review: pr.review,
      adePath: pr.adePath ?? null,
    });
  }
  out.sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state] || (b.number ?? 0) - (a.number ?? 0));
  return out;
}

function openChipPr(pr: ChipPr): void {
  if (pr.adePath) navigateFromLinearPane(pr.adePath);
  else if (pr.url) openExternalUrl(pr.url);
}

/** "owner/name" of the open project, to leave the repo off PRs in it. */
function useProjectRepo(): string | null {
  const binding = useAppStore((state) => state.projectBinding);
  return useMemo(() => {
    const identity = cachedGitRemoteIdentity(originUrlForBinding(binding));
    if (!identity) return null;
    const parts = identity.split("/");
    return parts.length >= 3 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : null;
  }, [binding]);
}

/** GitHub-style pull request glyphs: open, draft, merged, closed. */
export function PullRequestStateIcon({ state, size = 14 }: { state: PrState; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: STATE_COLOR[state],
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    className: "shrink-0",
  };
  if (state === "merged") {
    return (
      <svg {...common}>
        <circle cx="4.5" cy="3.5" r="1.75" />
        <circle cx="4.5" cy="12.5" r="1.75" />
        <circle cx="11.75" cy="8.5" r="1.75" />
        <path d="M4.5 5.25v5.5M4.5 5.5c0 1.9 1.6 3 3.6 3H10" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <path d="M4.5 5.25v5.5" />
      <circle cx="11.5" cy="12.5" r="1.75" />
      {state === "draft" ? (
        <>
          <path d="M11.5 8.6v.01M11.5 5.1v.01" strokeWidth={2} />
        </>
      ) : state === "closed" ? (
        <path d="M11.5 10.75V8.5M10 3.25l3 3M13 3.25l-3 3" />
      ) : (
        <path d="M11.5 10.75V6.25a1.75 1.75 0 0 0-1.75-1.75H7.5M9 3l-1.5 1.5L9 6" />
      )}
    </svg>
  );
}

function ChecksDot({ checks }: { checks: ChipPr["checks"] }) {
  const color = checks ? CHECKS_COLOR[checks] : null;
  if (!color || !checks) return null;
  return (
    <span
      aria-label={CHECKS_LABEL[checks]}
      title={CHECKS_LABEL[checks]}
      className={cn("block h-[6px] w-[6px] shrink-0 rounded-full", checks === "pending" && "motion-safe:animate-pulse")}
      style={{ background: color }}
    />
  );
}

function chipTitle(pr: ChipPr, projectRepo: string | null): string {
  const repo = pr.repo && pr.repo.toLowerCase() !== projectRepo?.toLowerCase() ? `${pr.repo} ` : "";
  const parts = [`${repo}#${pr.number ?? "?"}${pr.title ? ` ${pr.title}` : ""}`, STATE_LABEL[pr.state]];
  if (pr.checks && pr.checks !== "none") parts.push(CHECKS_LABEL[pr.checks]);
  if (pr.review && pr.review !== "none") parts.push(REVIEW_LABEL[pr.review]);
  parts.push(pr.adePath ? "Opens in ADE" : "Opens on GitHub");
  return parts.join("\n");
}

const CHIP_CLASS = cn(
  "inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border border-fg/[0.10] px-2 text-[12px] leading-none text-muted-fg/85 outline-none transition-colors",
  "hover:border-fg/[0.16] hover:bg-fg/[0.04] hover:text-fg focus-visible:border-fg/[0.22] focus-visible:text-fg",
);

function PrListRow({ pr, projectRepo }: { pr: ChipPr; projectRepo: string | null }) {
  const otherRepo = pr.repo && pr.repo.toLowerCase() !== projectRepo?.toLowerCase() ? pr.repo : null;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fg/[0.05] focus-visible:bg-fg/[0.05] outline-none"
      title={chipTitle(pr, projectRepo)}
      onClick={(event) => {
        event.stopPropagation();
        openChipPr(pr);
      }}
    >
      <PullRequestStateIcon state={pr.state} size={14} />
      <span className="shrink-0 text-[12px] tabular-nums text-muted-fg/70">
        {otherRepo ? <span className="text-muted-fg/55">{otherRepo} </span> : null}#{pr.number ?? "?"}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg/90">{pr.title || "Untitled pull request"}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        {pr.review === "approved" ? <span className="text-[11px] text-[color:var(--color-success)]">Approved</span> : null}
        {pr.review === "changes_requested" ? <span className="text-[11px] text-[color:var(--color-warning)]">Changes</span> : null}
        <ChecksDot checks={pr.checks} />
      </span>
    </button>
  );
}

export function LinearPrChips({ issue, status }: { issue: NormalizedLinearIssue; status: LinearIssueAdeStatus | null }): JSX.Element | null {
  const prs = useMemo(() => buildChipPrs(issue, status), [issue, status]);
  const knownProjectRepo = useProjectRepo();
  // Project origin not known yet: name repos only when the list spans several.
  const projectRepo = useMemo(() => {
    if (knownProjectRepo) return knownProjectRepo;
    const repos = new Set(prs.map((pr) => pr.repo?.toLowerCase() ?? ""));
    return repos.size === 1 ? prs[0]?.repo ?? null : null;
  }, [knownProjectRepo, prs]);
  if (prs.length === 0) return null;

  if (prs.length === 1) {
    const pr = prs[0]!;
    return (
      <button
        type="button"
        className={CHIP_CLASS}
        title={chipTitle(pr, projectRepo)}
        aria-label={`Pull request ${pr.number ?? ""}, ${STATE_LABEL[pr.state]}`}
        data-linear-pr-chip=""
        onClick={(event) => {
          event.stopPropagation();
          openChipPr(pr);
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={stopRowActivation}
      >
        <PullRequestStateIcon state={pr.state} size={13} />
        <span className="tabular-nums">#{pr.number ?? "?"}</span>
        <ChecksDot checks={pr.checks} />
      </button>
    );
  }

  const lead = prs[0]!;
  const failing = prs.some((pr) => pr.state !== "merged" && pr.state !== "closed" && pr.checks === "failing");
  const pending = prs.some((pr) => pr.state !== "merged" && pr.state !== "closed" && pr.checks === "pending");
  const passing = prs.some((pr) => pr.state !== "merged" && pr.state !== "closed" && pr.checks === "passing");
  const aggregate: ChipPr["checks"] = failing ? "failing" : pending ? "pending" : passing ? "passing" : null;
  const label = `${prs.length} pull requests`;
  return (
    <HoverCard
      className="inline-flex shrink-0"
      label={label}
      width={340}
      content={(
        <div className="overflow-hidden rounded-lg border border-fg/[0.10] bg-[color:var(--color-popup-bg)] p-1 shadow-[var(--shadow-popup)]">
          {prs.map((pr) => <PrListRow key={pr.key} pr={pr} projectRepo={projectRepo} />)}
        </div>
      )}
    >
      <button
        type="button"
        className={CHIP_CLASS}
        aria-label={label}
        aria-haspopup="dialog"
        data-linear-pr-chip=""
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={stopRowActivation}
      >
        <PullRequestStateIcon state={lead.state} size={13} />
        <span className="tabular-nums">{prs.length} PRs</span>
        <ChecksDot checks={aggregate} />
      </button>
    </HoverCard>
  );
}
