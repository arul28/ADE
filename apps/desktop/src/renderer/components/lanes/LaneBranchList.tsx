import React from "react";
import { Check, GitBranch, MagnifyingGlass } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { BranchPullRequest } from "../../../shared/types";
import type { LaneBranchOption } from "./laneUtils";
import { formatRelativeTime, matchesQuery, parseSearchQuery } from "./branchPickerSearch";

/**
 * The one picker list in the new-lane dialog: a search field, then a
 * virtualized list where every row shows the branch, its last commit, author,
 * age and PR. Every branch or lane choice in the dialog uses it: the base of a
 * new branch, the existing branch to open, a child lane's parent and its base.
 */

export type LaneBranchListItem = {
  /** The ref the caller stores, e.g. `origin/main`. */
  ref: string;
  /** The git branch behind the ref, when known; carries the commit details. */
  branch: LaneBranchOption | null;
  /** A short tag after the name ("default"). */
  tag?: string;
  /** Rows marked pinned always sort first, search permitting. */
  pinned?: boolean;
  /** Shown instead of the ref (a lane's name). Searched as well. */
  label?: string;
  /** Replaces the commit line (a lane's branch). */
  sub?: string;
  /** A lane colour, shown in place of the branch icon. */
  swatch?: string | null;
};

const ROW_HEIGHT = 50;
const SEARCH_HINT = "Search · pr:open · mine · stale:30d · #812";

function stripRemotePrefix(name: string): string {
  return name.replace(/^[^/]+\//, "");
}

export function LaneBranchList({
  items,
  pullRequests,
  currentUserName,
  selectedRef,
  onSelect,
  headerExtra,
  loading,
  emptyLabel,
  ariaLabel,
}: {
  items: LaneBranchListItem[];
  pullRequests?: BranchPullRequest[];
  currentUserName?: string;
  selectedRef: string;
  onSelect: (ref: string) => void;
  /** Rendered beside the search field (the Remote/Local switch). */
  headerExtra?: React.ReactNode;
  loading?: boolean;
  emptyLabel: string;
  ariaLabel: string;
}) {
  const [query, setQuery] = React.useState("");
  const listRef = React.useRef<HTMLDivElement>(null);
  // Ages are read once per open; the list lives only while its popover does.
  const [now] = React.useState(() => Date.now());

  const prByBranch = React.useMemo(() => {
    const map = new Map<string, BranchPullRequest>();
    for (const pr of pullRequests ?? []) map.set(pr.branch, pr);
    return map;
  }, [pullRequests]);
  const prFor = React.useCallback(
    (item: LaneBranchListItem) => prByBranch.get(item.ref) ?? prByBranch.get(stripRemotePrefix(item.ref)) ?? null,
    [prByBranch],
  );

  const parsed = React.useMemo(() => parseSearchQuery(query), [query]);
  const visible = React.useMemo(() => {
    const searching = Boolean(query.trim());
    const matches = searching
      ? items.filter((item) => {
        if (item.label && parsed.tokens.length === 0 && item.label.toLowerCase().includes(parsed.freeText.toLowerCase())) return true;
        const branch: LaneBranchOption = item.branch ?? { name: item.ref, isCurrent: false, isRemote: false, upstream: null };
        return matchesQuery({ branch, pr: prFor(item), currentUserName: currentUserName ?? "", now }, parsed);
      })
      : items;
    return [...matches.filter((item) => item.pinned), ...matches.filter((item) => !item.pinned)];
  }, [currentUserName, items, now, parsed, prFor, query]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  let empty: string;
  if (loading) empty = "Loading branches…";
  else if (items.length === 0) empty = emptyLabel;
  else empty = "No branch matches.";

  return (
    <div className="cl-branches">
      <div className="cl-pop-head">
        <label className="cl-search">
          <MagnifyingGlass size={12} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && visible[0]) {
                event.preventDefault();
                onSelect(visible[0].ref);
              }
            }}
            placeholder={SEARCH_HINT}
            aria-label={`Search ${ariaLabel.toLowerCase()}`}
            autoFocus
            spellCheck={false}
          />
        </label>
        {headerExtra}
      </div>
      {visible.length === 0 ? (
        <div className="cl-pop-empty">{empty}</div>
      ) : (
        <div ref={listRef} className="cl-pop-list" data-size="tall" role="menu" aria-label={ariaLabel}>
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((row) => {
              const item = visible[row.index]!;
              return (
                <div
                  key={item.ref || "__default"}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${row.start}px)` }}
                >
                  <BranchRow
                    item={item}
                    pr={prFor(item)}
                    selected={item.ref === selectedRef}
                    now={now}
                    onSelect={() => onSelect(item.ref)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function BranchRow({
  item,
  pr,
  selected,
  now,
  onSelect,
}: {
  item: LaneBranchListItem;
  pr: BranchPullRequest | null;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const { branch } = item;
  const age = formatRelativeTime(branch?.lastCommitDate, now);
  const detail = item.sub ?? [branch?.lastCommitMessage, branch?.lastCommitAuthor].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className="cl-item cl-branch-row"
      title={[item.label ?? item.ref, branch?.lastCommitMessage].filter(Boolean).join("\n")}
      onClick={onSelect}
    >
      {item.swatch !== undefined ? (
        <span className="cl-tile" data-tone="muted">
          <span className="cl-swatch" style={{ margin: 0, background: item.swatch ?? "color-mix(in srgb, var(--color-fg) 30%, transparent)" }} />
        </span>
      ) : (
        <span className="cl-tile" data-tone={item.pinned ? "mode" : "muted"}><GitBranch size={12} /></span>
      )}
      <span className="cl-item-text">
        <span className="cl-branch-line">
          <span className="cl-item-title">{item.label ?? item.ref}</span>
          {item.tag ? <span className="cl-tag" data-tone="mode">{item.tag}</span> : null}
          {branch?.isCurrent ? <span className="cl-tag" data-tone="ok">current</span> : null}
          {pr ? (
            <span className="cl-tag" data-tone={pr.state === "draft" ? undefined : "ok"} title={pr.title}>
              #{pr.prNumber}{pr.state === "draft" ? " draft" : ""}
            </span>
          ) : null}
          {age ? <span className="cl-branch-age">{age}</span> : null}
        </span>
        {detail ? <span className="cl-item-sub">{detail}</span> : null}
      </span>
      {selected ? <Check size={13} weight="bold" className="cl-item-check" /> : null}
    </button>
  );
}
