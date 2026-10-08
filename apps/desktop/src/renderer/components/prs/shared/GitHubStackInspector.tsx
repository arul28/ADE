import React from "react";
import {
  ArrowsClockwise,
  CaretDown,
  CheckCircle,
  Circle,
  DotsThree,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GithubLogo,
  Stack,
  Warning,
  XCircle,
} from "@phosphor-icons/react";
import type { GitHubPrListItem, GitHubPrStack, GitHubPrStackEntry, PrSummary } from "../../../../shared/types";
import { confirmDialog } from "../../ui/dialog/confirm";
import "./GitHubStackInspector.css";

/** GitHub's own PR state colours (see docs/design/visual-language.md). */
const GITHUB_OPEN = "#3fb950";
const GITHUB_MERGED = "#a371f7";
const GITHUB_CLOSED = "#f85149";

const EXPANDED_KEY = "ade:prs:stackStrip:expanded:v1";

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeExpanded(value: boolean): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, value ? "1" : "0");
  } catch {
    // Storage is optional; the strip just starts collapsed next time.
  }
}

function parsePullRequests(value: string): number[] | null {
  const values = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part));
  if (
    values.length === 0
    || values.some((part) => !Number.isInteger(part) || part <= 0)
    || new Set(values).size !== values.length
  ) {
    return null;
  }
  return values;
}

type LayerState = "open" | "draft" | "merged" | "closed";

function layerState(entry: GitHubPrStackEntry): LayerState {
  if (entry.mergedAt) return "merged";
  if (entry.state === "closed") return "closed";
  return entry.isDraft ? "draft" : "open";
}

const LAYER_STATE_LABEL: Record<LayerState, string> = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
};

function LayerStateIcon({ state, size = 13 }: { state: LayerState; size?: number }) {
  switch (state) {
    case "merged":
      return <GitMerge size={size} weight="bold" style={{ color: GITHUB_MERGED }} aria-hidden />;
    case "closed":
      return <XCircle size={size} weight="fill" style={{ color: GITHUB_CLOSED }} aria-hidden />;
    case "draft":
      return <Circle size={size} weight="bold" style={{ color: "var(--kit-text-3)" }} aria-hidden />;
    default:
      return <GitPullRequest size={size} weight="bold" style={{ color: GITHUB_OPEN }} aria-hidden />;
  }
}

/**
 * What stands between an open layer and its merge, from the ADE row GitHub
 * last reported. Null when nothing does, or when ADE has no row for the PR.
 */
type LayerBlocker = { reason: string; tone: "crit" | "warn" };

function layerBlocker(state: LayerState, pr: PrSummary | null): LayerBlocker | null {
  if (state === "draft") return { reason: "still a draft", tone: "warn" };
  if (state !== "open" || !pr) return null;
  if (pr.mergeConflicts) return { reason: "has conflicts", tone: "crit" };
  if (pr.checksStatus === "failing") return { reason: "checks failing", tone: "crit" };
  if (pr.reviewStatus === "changes_requested") return { reason: "changes requested", tone: "crit" };
  if (pr.checksStatus === "pending") return { reason: "checks running", tone: "warn" };
  if (pr.reviewStatus === "requested") return { reason: "waiting for review", tone: "warn" };
  return null;
}

function ciDotState(pr: PrSummary | null): "ok" | "warn" | "crit" | null {
  switch (pr?.checksStatus) {
    case "passing": return "ok";
    case "failing": return "crit";
    case "pending": return "warn";
    default: return null;
  }
}

function ciLabel(pr: PrSummary | null): string | null {
  switch (pr?.checksStatus) {
    case "passing": return "Checks pass";
    case "failing": return "Checks failing";
    case "pending": return "Checks running";
    case "not_run": return "No checks ran";
    default: return null;
  }
}

function reviewLabel(pr: PrSummary | null): string | null {
  switch (pr?.reviewStatus) {
    case "approved": return "Approved";
    case "changes_requested": return "Changes requested";
    case "requested": return "Review requested";
    default: return null;
  }
}

/** One line for the whole stack: what merges next, and what stops it. */
function stackSummary(
  entries: GitHubPrStackEntry[],
  prFor: (entry: GitHubPrStackEntry) => PrSummary | null,
): { text: string; tone: "ok" | "warn" | "crit" | null } {
  const open = entries.filter((entry) => {
    const state = layerState(entry);
    return state === "open" || state === "draft";
  });
  const merged = entries.filter((entry) => layerState(entry) === "merged").length;
  if (open.length === 0) {
    return merged > 0
      ? { text: `All ${merged} merged.`, tone: "ok" }
      : { text: "No open pull requests left in this stack.", tone: null };
  }
  const mergedNote = merged > 0 ? ` ${merged} already merged.` : "";
  for (const entry of open) {
    const blocker = layerBlocker(layerState(entry), prFor(entry));
    if (blocker) {
      return { text: `Blocked at #${entry.githubPrNumber}: ${blocker.reason}.${mergedNote}`, tone: blocker.tone };
    }
  }
  const unknown = open.some((entry) => !prFor(entry));
  if (unknown) return { text: `${open.length} open.${mergedNote}`, tone: null };
  return {
    text: open.length > 1 ? `All ${open.length} open PRs are ready to merge.${mergedNote}` : `Ready to merge.${mergedNote}`,
    tone: "ok",
  };
}

/**
 * The GitHub stack a selected PR belongs to: a rail of its layers from the base
 * up, a line saying what blocks the merge, and on demand the full layer list
 * and the stack's management actions. Merging happens in the Merge card.
 */
export function GitHubStackInspector({
  stack,
  items,
  prsById,
  selectedPrNumber,
  syncing,
  onSelectPr,
  onOpenGitHub,
  onSync,
  onAddPullRequests,
  onUnstack,
}: {
  stack: GitHubPrStack;
  items: GitHubPrListItem[];
  /** ADE's PR rows, for each layer's checks and review state. */
  prsById?: ReadonlyMap<string, PrSummary>;
  selectedPrNumber: number;
  syncing: boolean;
  onSelectPr: (item: GitHubPrListItem) => void;
  onOpenGitHub: () => void;
  onSync: () => void;
  onAddPullRequests: (pullRequests: number[]) => Promise<void>;
  onUnstack: () => Promise<void>;
}): React.ReactElement {
  const [expanded, setExpandedState] = React.useState(readExpanded);
  const [manageOpen, setManageOpen] = React.useState(false);
  const [pullInput, setPullInput] = React.useState("");
  const [busyAction, setBusyAction] = React.useState<"add" | "unstack" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const setExpanded = (value: boolean) => {
    setExpandedState(value);
    writeExpanded(value);
  };

  const itemByPr = React.useMemo(
    () => new Map(items.map((item) => [item.githubPrNumber, item] as const)),
    [items],
  );
  // The list filter can hide a layer (a merged one under Open), so ADE's own
  // rows are also found by number within the stack's repository.
  const prByNumber = React.useMemo(() => {
    const owner = stack.repoOwner.toLowerCase();
    const name = stack.repoName.toLowerCase();
    const byNumber = new Map<number, PrSummary>();
    for (const pr of prsById?.values() ?? []) {
      if (pr.repoOwner.toLowerCase() === owner && pr.repoName.toLowerCase() === name) {
        byNumber.set(pr.githubPrNumber, pr);
      }
    }
    return byNumber;
  }, [prsById, stack.repoName, stack.repoOwner]);
  const prFor = React.useCallback((entry: GitHubPrStackEntry): PrSummary | null => {
    const linkedPrId = itemByPr.get(entry.githubPrNumber)?.linkedPrId;
    return (linkedPrId ? prsById?.get(linkedPrId) : null) ?? prByNumber.get(entry.githubPrNumber) ?? null;
  }, [itemByPr, prByNumber, prsById]);
  const bottomUp = React.useMemo(
    () => [...stack.entries].sort((a, b) => a.position - b.position),
    [stack.entries],
  );
  const summary = stackSummary(bottomUp, prFor);
  const completed = !stack.open;

  const addPullRequests = async () => {
    const pullRequests = parsePullRequests(pullInput);
    if (!pullRequests) {
      setError("Enter one or more pull request numbers separated by commas.");
      return;
    }
    setBusyAction("add");
    setError(null);
    try {
      await onAddPullRequests(pullRequests);
      setPullInput("");
      setManageOpen(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "GitHub could not add those pull requests.");
    } finally {
      setBusyAction(null);
    }
  };

  const unstack = async () => {
    const confirmed = await confirmDialog({
      title: `Unstack Stack #${stack.number}?`,
      message: "GitHub removes the pull requests it can from this stack. They stay open, each with its current base branch.",
      confirmLabel: "Unstack",
      tone: "warning",
    });
    if (!confirmed) return;
    setBusyAction("unstack");
    setError(null);
    try {
      await onUnstack();
      setManageOpen(false);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "GitHub could not update this stack.");
    } finally {
      setBusyAction(null);
    }
  };

  const selectEntry = (entry: GitHubPrStackEntry) => {
    const item = itemByPr.get(entry.githubPrNumber);
    if (item) onSelectPr(item);
  };

  return (
    <section className="ade-stack-strip" aria-label={`GitHub Stack #${stack.number}`} data-testid="github-stack-strip">
      <div className="ade-stack-strip-row">
        <span className="ade-stack-strip-title">
          <Stack size={14} weight="fill" aria-hidden />
          Stack #{stack.number}
          <span className="ade-stack-strip-count kit-num" style={{ color: "var(--kit-text-3)", fontWeight: 400 }}>
            {stack.entries.length} PRs
          </span>
        </span>
        <ol className="ade-stack-rail" aria-label="Pull requests in this stack, from the base up">
          <li className="ade-stack-rail-base" title={`Base branch: ${stack.baseBranch}`}>
            <GitBranch size={11} aria-hidden />
            {stack.baseBranch}
          </li>
          {bottomUp.map((entry) => {
            const state = layerState(entry);
            const pr = prFor(entry);
            const ci = ciDotState(pr);
            const item = itemByPr.get(entry.githubPrNumber);
            const selected = entry.githubPrNumber === selectedPrNumber;
            const title = item?.title ?? pr?.title ?? entry.headBranch;
            return (
              <li key={entry.githubPrNumber}>
                <button
                  type="button"
                  className="ade-stack-chip"
                  data-selected={selected || undefined}
                  data-terminal={state === "merged" || state === "closed" || undefined}
                  disabled={!item}
                  aria-current={selected ? "true" : undefined}
                  onClick={() => selectEntry(entry)}
                  title={`#${entry.githubPrNumber} · ${LAYER_STATE_LABEL[state]}${ciLabel(pr) ? ` · ${ciLabel(pr)}` : ""} · ${title}`}
                >
                  <LayerStateIcon state={state} size={11} />
                  #{entry.githubPrNumber}
                  {ci && state === "open" ? <span className="kit-dot" data-state={ci} aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="ade-stack-strip-actions">
          <button
            type="button"
            className="kit-icon-btn"
            onClick={onSync}
            disabled={syncing}
            title="Refresh this stack from GitHub"
            aria-label="Refresh GitHub stack"
          >
            <ArrowsClockwise size={13} className={syncing ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            className="kit-icon-btn"
            onClick={onOpenGitHub}
            title="Review on GitHub"
            aria-label="Review on GitHub"
          >
            <GithubLogo size={13} />
          </button>
          {completed ? null : (
            <button
              type="button"
              className="kit-icon-btn"
              onClick={() => {
                setManageOpen((value) => !value);
                setError(null);
              }}
              aria-expanded={manageOpen}
              title="Manage stack"
              aria-label="Manage stack"
            >
              <DotsThree size={15} weight="bold" />
            </button>
          )}
          <button
            type="button"
            className="kit-icon-btn"
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            title={expanded ? "Hide the layers" : "Show the layers"}
            aria-label={expanded ? "Hide the stack's layers" : "Show the stack's layers"}
          >
            <CaretDown
              size={12}
              weight="bold"
              style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 120ms ease" }}
            />
          </button>
        </div>
      </div>

      <div className="ade-stack-strip-summary" data-testid="github-stack-summary">
        {summary.tone ? <span className="kit-dot" data-state={summary.tone} aria-hidden /> : <span className="kit-dot" aria-hidden />}
        <span>{summary.text}</span>
      </div>

      {stack.lastError ? (
        <div className="ade-stack-strip-note">
          <Warning size={13} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
          <span>Showing the last saved stack. {stack.lastError}</span>
        </div>
      ) : null}

      {expanded ? (
        <div className="ade-stack-layers">
          {[...bottomUp].reverse().map((entry) => {
            const state = layerState(entry);
            const pr = prFor(entry);
            const item = itemByPr.get(entry.githubPrNumber);
            const selected = entry.githubPrNumber === selectedPrNumber;
            const blocker = layerBlocker(state, pr);
            const ci = ciLabel(pr);
            const review = reviewLabel(pr);
            const statusText = state === "open"
              ? [ci, review].filter(Boolean).join(" · ") || LAYER_STATE_LABEL[state]
              : LAYER_STATE_LABEL[state];
            return (
              <button
                key={entry.githubPrNumber}
                type="button"
                className="ade-stack-layer"
                data-selected={selected || undefined}
                disabled={!item}
                onClick={() => selectEntry(entry)}
              >
                <span className="ade-stack-layer-position">{entry.position}</span>
                <LayerStateIcon state={state} />
                <span className="ade-stack-layer-text">
                  <span className="ade-stack-layer-title">{item?.title ?? pr?.title ?? entry.headBranch}</span>
                  <span className="ade-stack-layer-meta">
                    <span className="kit-num">#{entry.githubPrNumber}</span>
                    {item?.linkedLaneName ? <span className="ade-stack-layer-lane"> · {item.linkedLaneName}</span> : null}
                    {!item?.linkedLaneName && entry.headBranch ? <span className="ade-stack-layer-lane"> · {entry.headBranch}</span> : null}
                  </span>
                </span>
                <span className="ade-stack-layer-status">
                  {blocker ? <span className="kit-dot" data-state={blocker.tone} aria-hidden /> : null}
                  {!blocker && state === "open" && pr?.checksStatus === "passing" ? (
                    <CheckCircle size={12} weight="fill" style={{ color: "var(--kit-ok)" }} aria-hidden />
                  ) : null}
                  {statusText}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {manageOpen && !completed ? (
        <div className="ade-stack-manage">
          <span className="ade-stack-manage-label">Add pull requests above the top of the stack</span>
          <div className="ade-stack-manage-row">
            <input
              className="ade-stack-manage-input"
              value={pullInput}
              onChange={(event) => setPullInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void addPullRequests();
              }}
              placeholder="PR numbers, e.g. 971, 972"
              aria-label="Pull request numbers to add"
            />
            <button
              type="button"
              className="kit-btn kit-btn-primary"
              disabled={busyAction != null || !pullInput.trim()}
              onClick={() => { void addPullRequests(); }}
            >
              {busyAction === "add" ? "Adding…" : "Add"}
            </button>
          </div>
          <div className="ade-stack-manage-row">
            <span className="ade-stack-manage-hint">GitHub keeps the stack rebased. Merge it from the Merge card.</span>
            <button
              type="button"
              className="kit-btn"
              disabled={busyAction != null}
              onClick={() => { void unstack(); }}
            >
              {busyAction === "unstack" ? "Unstacking…" : "Unstack…"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="ade-stack-strip-error">{error}</div>
      ) : null}
    </section>
  );
}
