import React, { useCallback } from "react";
import { Funnel, X } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { SearchResultItem } from "../../../shared/types/search";
import {
  WORK_SEARCH_FILTER_KEYS,
  type ParsedWorkSearch,
  type WorkSearchFilterKey,
} from "../../../shared/workSearch";
import {
  matchesThreadWorkFacets,
  type ThreadIndexEntry,
  type ThreadMatch,
  type ThreadRowAction,
} from "./commandPaletteThreads";
import type { SessionFilingBucket } from "../../lib/terminalAttention";
import {
  projectStateKeyForBinding,
  type WorkProjectViewState,
} from "../../state/appStore";
import { invalidateSessionListCache } from "../../lib/sessionListCache";
import { isSessionSnoozed } from "../../lib/sessionSnooze";
import {
  canonicalInputFromSummary,
  effectiveSessionFilingBuckets,
  sessionCanonicalUiState,
} from "../../lib/terminalAttention";
import {
  renameSession,
  settleSession,
  snoozeSessionForDuration,
  unsettleSession,
  wakeSessionNow,
} from "../terminals/sessionLifecycleActions";

export type PaletteWorkResult =
  | {
      type: "thread";
      match: ThreadMatch;
      contentHit: SearchResultItem | null;
    }
  | {
      type: "content";
      item: SearchResultItem;
      score: number;
    };

export type WorkFilterMenuKey = WorkSearchFilterKey | "choose";

export const WORK_FILTER_LABELS: Record<WorkSearchFilterKey, string> = {
  lane: "Lane",
  provider: "Provider",
  status: "Status",
  type: "Type",
  machine: "Machine",
};

function workFilterValueLabel(key: WorkSearchFilterKey, value: string): string {
  if (key === "status") {
    const labels: Record<string, string> = {
      "awaiting-input": "Your move",
      running: "Running",
      ended: "Ended",
      settled: "Settled",
      snoozed: "Snoozed",
    };
    return labels[value] ?? value;
  }
  if (key === "type") return value === "chat" ? "Chat" : "Terminal";
  if (key === "provider") {
    return value.length > 0
      ? value.charAt(0).toUpperCase() + value.slice(1)
      : value;
  }
  return value;
}

export function contentResultScore(
  item: SearchResultItem,
  terms: readonly string[],
): number {
  const title = item.title.toLowerCase();
  const titleHit = terms.some((term) => title.includes(term));
  return 40 + Math.min(item.matchRanges.length * 6, 24) + (titleHit ? 18 : 0);
}

export function WorkFilterBar({
  query,
  parsed,
  options,
  filterMenuKey,
  matchCount,
  onMenuKeyChange,
  onAdd,
  onRemove,
  onClear,
}: {
  query: string;
  parsed: ParsedWorkSearch;
  options: Record<WorkSearchFilterKey, string[]>;
  filterMenuKey: WorkFilterMenuKey | null;
  matchCount: number;
  onMenuKeyChange: (key: WorkFilterMenuKey | null) => void;
  onAdd: (key: WorkSearchFilterKey, value: string) => void;
  onRemove: (token: ParsedWorkSearch["filterTokens"][number]) => void;
  onClear: () => void;
}) {
  const activeTokens = parsed.filterTokens.filter(
    (token, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.key === token.key && candidate.value === token.value,
      ) === index,
  );
  const hasFilters = activeTokens.length > 0;

  return (
    <div
      className="relative flex min-h-10 shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[11px]"
      style={{ borderColor: "var(--color-border)" }}
    >
      <span className="shrink-0 font-medium text-[var(--color-muted-fg)]">
        Work
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {activeTokens.map((token) => (
          <button
            key={`${token.key}:${token.value}`}
            type="button"
            className="inline-flex max-w-[170px] items-center gap-1 rounded-full border border-[var(--color-accent)]/35 bg-[var(--color-accent-muted)] px-2 py-0.5 text-[var(--color-fg)] hover:border-[var(--color-accent)]"
            aria-label={`Remove ${token.key} filter ${token.value}`}
            onClick={() => onRemove(token)}
          >
            <span className="text-[var(--color-muted-fg)]">
              {WORK_FILTER_LABELS[token.key]}:
            </span>
            <span className="truncate">
              {workFilterValueLabel(token.key, token.value)}
            </span>
            <X size={10} weight="bold" aria-hidden />
          </button>
        ))}
        {hasFilters ? (
          <button
            type="button"
            className="shrink-0 px-1 text-[var(--color-muted-fg)] underline decoration-[var(--color-border)] underline-offset-2 hover:text-[var(--color-fg)]"
            onClick={onClear}
          >
            Clear
          </button>
        ) : (
          <span className="truncate text-[var(--color-muted-fg)]">
            Any lane, provider, status, type, or machine
          </span>
        )}
      </div>
      <span className="shrink-0 tabular-nums text-[var(--color-muted-fg)]">
        {matchCount} {matchCount === 1 ? "match" : "matches"}
      </span>
      <button
        type="button"
        className={
          filterMenuKey
            ? "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent-muted)] px-2 text-[11px] text-[var(--color-fg)] transition-colors"
            : "inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] px-2 text-[11px] text-[var(--color-muted-fg)] transition-colors hover:bg-[var(--color-muted)] hover:text-[var(--color-fg)]"
        }
        aria-label="Add Work filter"
        aria-expanded={filterMenuKey !== null}
        onClick={() => onMenuKeyChange(filterMenuKey ? null : "choose")}
      >
        <Funnel size={12} aria-hidden />
        Filter
      </button>
      {filterMenuKey ? (
        <div
          role="menu"
          aria-label={
            filterMenuKey === "choose"
              ? "Work filter facets"
              : `${WORK_FILTER_LABELS[filterMenuKey]} filter values`
          }
          className="absolute right-4 top-full z-20 mt-1 max-h-64 min-w-44 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-popup-bg)] p-1 shadow-xl"
        >
          {filterMenuKey === "choose" ? (
            <>
              <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--color-muted-fg)]">
                <span>Add Work filter</span>
                <button
                  type="button"
                  className="text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
                  onClick={() => onMenuKeyChange(null)}
                >
                  Done
                </button>
              </div>
              {WORK_SEARCH_FILTER_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-muted)]"
                  onClick={() => onMenuKeyChange(key)}
                >
                  <span>{WORK_FILTER_LABELS[key]}</span>
                  <span className="ml-2 text-[10px] text-[var(--color-muted-fg)]">
                    {options[key].length}
                  </span>
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between px-2 py-1 text-[10px] uppercase tracking-wide text-[var(--color-muted-fg)]">
                <button
                  type="button"
                  className="text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
                  onClick={() => onMenuKeyChange("choose")}
                >
                  All filters
                </button>
                <button
                  type="button"
                  className="text-[var(--color-muted-fg)] hover:text-[var(--color-fg)]"
                  onClick={() => onMenuKeyChange(null)}
                >
                  Done
                </button>
              </div>
              {options[filterMenuKey].length > 0 ? (
                options[filterMenuKey].map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-muted)]"
                    onClick={() => onAdd(filterMenuKey, value)}
                  >
                    <span className="truncate">
                      {workFilterValueLabel(filterMenuKey, value)}
                    </span>
                    {parsed.filters[filterMenuKey].includes(value) ? (
                      <span className="ml-2 text-[var(--color-accent)]">✓</span>
                    ) : null}
                  </button>
                ))
              ) : (
                <div className="px-2 py-2 text-xs text-[var(--color-muted-fg)]">
                  No values yet.
                </div>
              )}
              <div className="mt-1 border-t border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-muted-fg)]">
                Choose more than one value to match either.
              </div>
            </>
          )}
        </div>
      ) : null}
      <span className="sr-only">Search: {query}</span>
    </div>
  );
}

export function buildWorkResults({
  parsedWorkQuery,
  sessionResults,
  threadIndex,
  threadMatches,
  effectiveFilingBuckets,
}: {
  parsedWorkQuery: ParsedWorkSearch;
  sessionResults: readonly SearchResultItem[];
  threadIndex: readonly ThreadIndexEntry[];
  threadMatches: readonly ThreadMatch[];
  effectiveFilingBuckets?: ReadonlyMap<string, SessionFilingBucket>;
}): PaletteWorkResult[] {
  const contentBySessionId = new Map<string, SearchResultItem>();
  for (const item of sessionResults) {
    if (item.sessionId && !contentBySessionId.has(item.sessionId)) {
      contentBySessionId.set(item.sessionId, item);
    }
  }

  const localEntriesById = new Map(
    threadIndex.map((entry) => [entry.session.id, entry] as const),
  );
  const filingBuckets = effectiveFilingBuckets
    ?? effectiveSessionFilingBuckets(threadIndex.map((entry) => entry.session));
  const matchedSessionIds = new Set<string>();
  const merged: PaletteWorkResult[] = threadMatches.map((match) => {
    const sessionId = match.entry.session.id;
    matchedSessionIds.add(sessionId);
    const contentHit = contentBySessionId.get(sessionId) ?? null;
    if (contentHit && !match.matchFields.includes("content")) {
      match = {
        ...match,
        score: match.score + 8,
        matchFields: [...match.matchFields, "content"],
      };
    }
    return { type: "thread", match, contentHit };
  });

  const contentIds = new Set<string>();
  for (const item of sessionResults) {
    if (item.sessionId && matchedSessionIds.has(item.sessionId)) continue;
    if (item.sessionId) {
      const localEntry = localEntriesById.get(item.sessionId);
      if (localEntry) {
        if (!matchesThreadWorkFacets(localEntry, parsedWorkQuery, filingBuckets)) continue;
        matchedSessionIds.add(item.sessionId);
        merged.push({
          type: "thread",
          match: {
            entry: localEntry,
            score: contentResultScore(item, parsedWorkQuery.terms),
            matchFields: ["content"],
          },
          contentHit: item,
        });
        continue;
      }
      // Local-only facets cannot be evaluated safely for an unindexed session.
      if (
        parsedWorkQuery.filterTokens.length > 0 ||
        parsedWorkQuery.tracked !== null
      ) continue;
    }
    // A content result without an owning session cannot prove provider,
    // status, type, or machine facets. Do not let it bypass a local facet just
    // because the backend omitted sessionId.
    if (
      !item.sessionId &&
      (parsedWorkQuery.filterTokens.length > 0 ||
        parsedWorkQuery.tracked !== null)
    ) continue;
    if (contentIds.has(item.id)) continue;
    contentIds.add(item.id);
    merged.push({
      type: "content",
      item,
      score: contentResultScore(item, parsedWorkQuery.terms),
    });
  }

  merged.sort((left, right) => {
    const scoreLeft = left.type === "thread" ? left.match.score : left.score;
    const scoreRight = right.type === "thread" ? right.match.score : right.score;
    if (scoreLeft !== scoreRight) return scoreRight - scoreLeft;
    const timeLeft = left.type === "thread"
      ? left.match.entry.recencyMs
      : new Date(left.item.updatedAt).getTime();
    const timeRight = right.type === "thread"
      ? right.match.entry.recencyMs
      : new Date(right.item.updatedAt).getTime();
    return timeRight - timeLeft;
  });
  return merged;
}

export function useWorkSessionActions({
  navigate,
  onOpenChange,
  projectRoot,
  projectBinding,
  setWorkViewState,
  switchProjectToPath,
  switchRemoteProject,
}: {
  navigate: (path: string) => void;
  onOpenChange: (open: boolean) => void;
  projectRoot: string | null;
  projectBinding: OpenProjectBinding | null;
  setWorkViewState: (
    projectRoot: string | null | undefined,
    next:
      | Partial<WorkProjectViewState>
      | ((prev: WorkProjectViewState) => WorkProjectViewState),
  ) => void;
  switchProjectToPath: (rootPath: string) => Promise<void>;
  switchRemoteProject: (
    targetId: string,
    projectId: string,
  ) => Promise<OpenProjectBinding>;
}) {
  return useCallback(
    async (entry: ThreadIndexEntry, action: ThreadRowAction) => {
      const { session, binding } = entry;
      if (action === "new-chat") {
        // Persist the draft before navigation. Work can be unmounted while the
        // palette is open, so an ephemeral window event would be lost before
        // the destination page gets a chance to consume it.
        const destinationProjectKey = projectStateKeyForBinding(
          binding,
          projectRoot,
        );
        const currentProjectKey = projectStateKeyForBinding(
          projectBinding,
          projectRoot,
        );
        const switching =
          !binding || destinationProjectKey === currentProjectKey
            ? Promise.resolve()
            : binding.kind === "remote"
              ? switchRemoteProject(binding.targetId, binding.projectId)
              : switchProjectToPath(binding.rootPath);
        try {
          await switching;
          setWorkViewState(destinationProjectKey, (previous) => ({
            ...previous,
            draftKind: "chat",
            draftLaneId: session.laneId || null,
            draftMachineId: binding?.kind === "remote" ? binding.targetId : null,
            orchestratorEnabled: false,
            activeItemId: null,
            selectedItemId: null,
          }));
          navigate("/work");
          onOpenChange(false);
        } catch (error) {
          console.error("[CommandPalette] new chat target switch failed", {
            error,
            sessionId: session.id,
          });
        }
        return;
      }

      if (action === "rename") {
        const nextTitle = window.prompt("Rename session", session.title ?? "")?.trim();
        if (!nextTitle) return;
        try {
          await renameSession(session, nextTitle, binding);
          invalidateSessionListCache();
        } catch (error) {
          console.error("[CommandPalette] rename session failed", {
            sessionId: session.id,
            error,
          });
        }
        onOpenChange(false);
        return;
      }

      if (action === "settle") {
        const isSettled =
          sessionCanonicalUiState(canonicalInputFromSummary(session)).phase ===
          "settled";
        if (isSettled) await unsettleSession(session, binding);
        else await settleSession(session, binding);
        onOpenChange(false);
        return;
      }

      if (isSessionSnoozed(session)) {
        await wakeSessionNow(session, binding);
      } else {
        await snoozeSessionForDuration(session, "hour", Date.now(), binding);
      }
      onOpenChange(false);
    },
    [
      navigate,
      onOpenChange,
      projectBinding,
      projectRoot,
      setWorkViewState,
      switchProjectToPath,
      switchRemoteProject,
    ],
  );
}
