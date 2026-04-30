import React from "react";
import { ArrowLeft, GitBranch, GitCommit, MagnifyingGlass, Tag } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { BranchPullRequest } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";
import { Button } from "../ui/Button";
import {
  formatRelativeTime,
  matchesQuery,
  parseSearchQuery,
} from "./branchPickerSearch";

const ROW_HEIGHT = 64;

const SEARCH_HINT = "name · pr:open · pr:none · author:me · mine · stale:30d · #812";

const ROW_BASE =
  "group flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors";
const ROW_SELECTED = "bg-accent/[0.12] ring-1 ring-accent/40";
const ROW_DEFAULT = "hover:bg-white/[0.04]";

/** Strip the remote name from `origin/feat/x` so PR lookups match local heads. */
function stripRemotePrefix(branch: LaneBranchOption): string {
  return branch.isRemote ? branch.name.replace(/^[^/]+\//, "") : branch.name;
}

function findPrForBranch(
  branch: LaneBranchOption,
  prByBranch: Map<string, BranchPullRequest>,
): BranchPullRequest | null {
  return prByBranch.get(branch.name) ?? prByBranch.get(stripRemotePrefix(branch)) ?? null;
}

function PrPill({ pr }: { pr: BranchPullRequest }) {
  const isDraft = pr.state === "draft";
  const tone = isDraft
    ? "bg-white/[0.08] text-muted-fg"
    : "bg-emerald-400/15 text-emerald-300";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${tone}`}
      title={pr.title}
    >
      <Tag size={10} weight="fill" />
      #{pr.prNumber}
      {isDraft ? <span className="opacity-70">draft</span> : null}
    </span>
  );
}

function BranchRow({
  branch,
  pr,
  selected,
  onSelect,
  now,
}: {
  branch: LaneBranchOption;
  pr: BranchPullRequest | null;
  selected: boolean;
  onSelect: () => void;
  now: number;
}) {
  const subtitle = [branch.lastCommitAuthor, formatRelativeTime(branch.lastCommitDate, now)]
    .filter(Boolean)
    .join(" · ");

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`${ROW_BASE} ${selected ? ROW_SELECTED : ROW_DEFAULT}`}
      data-branch-name={branch.name}
    >
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.04] text-sky-300">
        <GitBranch size={14} weight="duotone" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">
            {branch.name}
          </span>
          {branch.isCurrent ? (
            <span className="rounded-full bg-emerald-400/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-300">
              current
            </span>
          ) : null}
          {branch.isRemote ? (
            <span className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-fg">
              remote
            </span>
          ) : null}
          {pr ? <PrPill pr={pr} /> : null}
        </span>
        {branch.lastCommitMessage ? (
          <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-fg/80">
            <GitCommit size={11} className="shrink-0" />
            <span className="truncate">{branch.lastCommitMessage}</span>
          </span>
        ) : null}
        {subtitle ? (
          <span className="mt-0.5 block text-[11px] text-muted-fg/60">{subtitle}</span>
        ) : null}
      </span>
    </button>
  );
}

export function BranchPickerView({
  branches,
  pullRequests,
  currentUserName,
  selectedBranch,
  onSelect,
  onConfirm,
  onBack,
  busy,
  loadingBranches,
  loadingPullRequests,
}: {
  branches: LaneBranchOption[];
  pullRequests: BranchPullRequest[];
  currentUserName: string;
  selectedBranch: string;
  onSelect: (name: string) => void;
  onConfirm: () => void;
  onBack: () => void;
  busy?: boolean;
  loadingBranches?: boolean;
  loadingPullRequests?: boolean;
}) {
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const prByBranch = React.useMemo(() => {
    const map = new Map<string, BranchPullRequest>();
    for (const pr of pullRequests) map.set(pr.branch, pr);
    return map;
  }, [pullRequests]);

  const parsed = React.useMemo(() => parseSearchQuery(query), [query]);

  const filtered = React.useMemo(() => {
    if (!query.trim() && !parsed.tokens.length) return branches;
    return branches.filter((branch) => {
      const pr = findPrForBranch(branch, prByBranch);
      return matchesQuery({ branch, pr, currentUserName, now }, parsed);
    });
  }, [branches, query, parsed, prByBranch, currentUserName, now]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && filtered.length > 0) {
      event.preventDefault();
      const first = filtered[0]!;
      onSelect(first.name);
      onConfirm();
    }
  };

  let emptyMessage: string;
  if (loadingBranches) emptyMessage = "Loading branches…";
  else if (branches.length === 0) emptyMessage = "No branches found in this repo.";
  else emptyMessage = "No branches match your search.";

  return (
    <div className="flex flex-col gap-3" data-testid="branch-picker-view">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-md text-muted-fg transition-colors hover:bg-white/[0.05] hover:text-fg"
          aria-label="Back to lane setup"
          disabled={busy}
        >
          <ArrowLeft size={16} weight="bold" />
        </button>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-fg/70">
          Pick branch
        </div>
        <div className="ml-auto text-[11px] text-muted-fg/60">
          {loadingBranches
            ? "Loading…"
            : `${filtered.length} of ${branches.length}`}
          {loadingPullRequests ? " · syncing PRs…" : null}
        </div>
      </div>

      <div className="relative">
        <MagnifyingGlass
          size={14}
          weight="bold"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-fg/60"
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={SEARCH_HINT}
          className="h-10 w-full rounded-lg border border-white/[0.06] bg-white/[0.03] pl-9 pr-3 text-sm text-fg outline-none transition-colors placeholder:text-muted-fg/50 focus:border-accent/40"
          spellCheck={false}
          autoComplete="off"
          disabled={busy}
        />
      </div>

      <div
        ref={listRef}
        className="h-[360px] overflow-y-auto rounded-lg border border-white/[0.06] bg-black/20"
      >
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-fg/60">
            {emptyMessage}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const branch = filtered[row.index]!;
              const pr = findPrForBranch(branch, prByBranch);
              return (
                <div
                  key={branch.name}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${row.start}px)`,
                    padding: "2px 4px",
                  }}
                >
                  <BranchRow
                    branch={branch}
                    pr={pr}
                    selected={branch.name === selectedBranch}
                    onSelect={() => onSelect(branch.name)}
                    now={now}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="text-[11px] text-muted-fg/60">
          {selectedBranch ? (
            <>
              Selected: <span className="text-fg">{selectedBranch}</span>
            </>
          ) : (
            "Select a branch to import"
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={busy} onClick={onBack}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !selectedBranch}
            onClick={onConfirm}
          >
            Use this branch
          </Button>
        </div>
      </div>
    </div>
  );
}
