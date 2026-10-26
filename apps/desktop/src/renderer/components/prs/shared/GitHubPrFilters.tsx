import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { Check, CircleNotch, FunnelSimple, MagnifyingGlass, Prohibit, UserCircle, X } from "@phosphor-icons/react";

import type {
  GitHubPrFilterKind,
  GitHubPrFilterOption,
  GitHubPrListFilters,
} from "../../../../shared/types";
import {
  GITHUB_PR_FILTER_ME,
  GITHUB_PR_FILTER_NO_ASSIGNEE,
  hasGitHubPrListFilters,
  normalizeGitHubLogin,
} from "../../../../shared/githubPrSearch";
import { COLORS, MONO_FONT, SANS_FONT, fgTint } from "../../lanes/laneDesignTokens";
import { Z_LAYERS } from "../../ui/zLayers";
import { cn } from "../../ui/cn";
import { MENU_SURFACE_CLASS } from "../../ui/paneMenuTokens";
import { isImeComposing } from "../../../lib/imeComposition";
import { PrAgentAvatar } from "./PrAgentAvatar";
import { PrLabelPill } from "./PrLabelPill";
import "./githubPrFilters.css";

/** Wait this long after the last keystroke before asking GitHub. */
export const GITHUB_FILTER_OPTIONS_DEBOUNCE_MS = 250;

export type GitHubFilterOptionsLoader = (kind: GitHubPrFilterKind, query: string) => Promise<GitHubPrFilterOption[]>;

/**
 * GitHub's matches for a picker, asked only while the picker is open, after a
 * pause in typing, with stale answers dropped. A missing loader (an older host)
 * or a failure just leaves the loaded-row facets.
 */
export function useGitHubFilterOptions({
  enabled,
  kind,
  query,
  load,
}: {
  enabled: boolean;
  kind: GitHubPrFilterKind;
  query: string;
  load: GitHubFilterOptionsLoader | null;
}): { options: GitHubPrFilterOption[]; loading: boolean; failed: boolean } {
  const [state, setState] = React.useState<{ key: string; options: GitHubPrFilterOption[]; failed: boolean } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const loadRef = React.useRef(load);
  loadRef.current = load;
  const seqRef = React.useRef(0);
  const hasLoader = Boolean(load);
  const trimmed = query.trim();
  const key = `${kind}|${trimmed.toLowerCase()}`;
  React.useEffect(() => {
    if (!enabled || !hasLoader) {
      setLoading(false);
      return undefined;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const loader = loadRef.current;
      if (!loader) return;
      loader(kind, trimmed)
        .then((options) => {
          if (seq === seqRef.current) setState({ key, options, failed: false });
        })
        .catch(() => {
          if (seq === seqRef.current) setState({ key, options: [], failed: true });
        })
        .finally(() => {
          if (seq === seqRef.current) setLoading(false);
        });
    }, GITHUB_FILTER_OPTIONS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, hasLoader, key, kind, trimmed]);
  return {
    options: state?.key === key ? state.options : [],
    loading,
    failed: state?.key === key ? state.failed : false,
  };
}

export type GitHubPrFilterFacets = {
  /** Labels on the loaded rows, most-used first, with how many rows carry each. */
  labels: Array<{ name: string; color: string; description: string | null; count: number }>;
  /** Authors of the loaded rows, most-active first. */
  authors: Array<{ login: string; count: number }>;
};

type PickerSection = "fixed" | "selected" | "loaded" | "github" | "typed";

type PickerRow = {
  key: string;
  value: string;
  label: string;
  section: PickerSection;
  hint?: string | null;
  color?: string | null;
  avatarUrl?: string | null;
  count?: number | null;
  person?: boolean;
  selected: boolean;
};

const SECTION_TITLE: Record<PickerSection, string | null> = {
  fixed: null,
  selected: "Selected",
  loaded: "In this list",
  github: "On GitHub",
  typed: null,
};

const KIND_TITLE: Record<GitHubPrFilterKind, string> = {
  label: "Label",
  author: "Author",
  assignee: "Assignee",
};

/** The tab the panel opens on: the one used last in this window. */
let lastPickerKind: GitHubPrFilterKind = "label";

/** GitHub serves every user's picture at a stable URL, so a login is enough. */
function avatarFor(login: string, avatarUrl?: string | null): string {
  return avatarUrl || `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?size=40`;
}

function matchesQuery(query: string, ...values: Array<string | null | undefined>): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(q));
}

function personLabel(value: string, kind: "author" | "assignee"): string {
  if (value === GITHUB_PR_FILTER_ME) return kind === "author" ? "Me" : "Assigned to me";
  if (value === GITHUB_PR_FILTER_NO_ASSIGNEE) return "Nobody assigned";
  return value;
}

/** The chip text for one filter, plain words. */
export function describeGitHubPrFilter(kind: GitHubPrFilterKind, value: string): string {
  if (kind === "label") return value;
  if (kind === "author") return value === GITHUB_PR_FILTER_ME ? "By me" : `By ${value}`;
  if (value === GITHUB_PR_FILTER_ME) return "Assigned to me";
  if (value === GITHUB_PR_FILTER_NO_ASSIGNEE) return "Unassigned";
  return `Assigned to ${value}`;
}

function filterCount(filters: GitHubPrListFilters, kind: GitHubPrFilterKind): number {
  if (kind === "label") return filters.labels.length;
  return (kind === "author" ? filters.author : filters.assignee) ? 1 : 0;
}

function buildRows({
  kind,
  filters,
  facets,
  remote,
  query,
  pinnedSelected,
}: {
  kind: GitHubPrFilterKind;
  filters: GitHubPrListFilters;
  facets: GitHubPrFilterFacets;
  remote: GitHubPrFilterOption[];
  query: string;
  /** What was on when the tab opened: kept on top so rows do not jump as you pick. */
  pinnedSelected: readonly string[];
}): PickerRow[] {
  const out: PickerRow[] = [];
  const seen = new Set<string>();
  const push = (row: PickerRow) => {
    const id = row.value.toLowerCase();
    if (seen.has(id)) return;
    seen.add(id);
    out.push(row);
  };
  if (kind === "label") {
    const selected = new Set(filters.labels.map((label) => label.toLowerCase()));
    const facetByName = new Map(facets.labels.map((label) => [label.name.toLowerCase(), label]));
    const remoteByName = new Map(remote.map((option) => [option.value.toLowerCase(), option]));
    for (const name of pinnedSelected) {
      if (!matchesQuery(query, name)) continue;
      const facet = facetByName.get(name.toLowerCase());
      const option = remoteByName.get(name.toLowerCase());
      push({
        key: `sel:${name}`,
        value: name,
        label: name,
        section: "selected",
        color: facet?.color ?? option?.color ?? null,
        hint: facet?.description ?? option?.description ?? null,
        count: facet?.count ?? null,
        selected: selected.has(name.toLowerCase()),
      });
    }
    for (const label of facets.labels) {
      if (!matchesQuery(query, label.name, label.description)) continue;
      push({ key: `facet:${label.name}`, value: label.name, label: label.name, section: "loaded", hint: label.description, color: label.color, count: label.count, selected: selected.has(label.name.toLowerCase()) });
    }
    for (const option of remote) {
      push({ key: `gh:${option.value}`, value: option.value, label: option.value, section: "github", hint: option.description, color: option.color, selected: selected.has(option.value.toLowerCase()) });
    }
    if (query && !seen.has(query.toLowerCase())) {
      push({ key: `typed:${query}`, value: query, label: query, section: "typed", selected: false });
    }
    return out;
  }
  const current = kind === "author" ? filters.author : filters.assignee;
  const isCurrent = (value: string) => current?.toLowerCase() === value.toLowerCase();
  const fixed = kind === "author" ? [GITHUB_PR_FILTER_ME] : [GITHUB_PR_FILTER_ME, GITHUB_PR_FILTER_NO_ASSIGNEE];
  for (const value of fixed) {
    if (!matchesQuery(query, personLabel(value, kind))) continue;
    push({ key: `fixed:${value}`, value, label: personLabel(value, kind), section: "fixed", selected: current === value });
  }
  for (const value of pinnedSelected) {
    if (fixed.includes(value) || !matchesQuery(query, value)) continue;
    push({ key: `sel:${value}`, value, label: value, section: "selected", person: true, selected: isCurrent(value) });
  }
  // Loaded rows know who authored them; they say nothing about assignees.
  if (kind === "author") {
    for (const author of facets.authors) {
      if (!matchesQuery(query, author.login)) continue;
      push({ key: `facet:${author.login}`, value: author.login, label: author.login, section: "loaded", count: author.count, person: true, selected: isCurrent(author.login) });
    }
  }
  for (const option of remote) {
    push({
      key: `gh:${option.value}`,
      value: option.value,
      label: option.value,
      section: "github",
      hint: option.name && option.name !== option.value ? option.name : null,
      avatarUrl: option.avatarUrl,
      person: true,
      selected: isCurrent(option.value),
    });
  }
  const typedLogin = query ? normalizeGitHubLogin(query) : null;
  if (typedLogin && !seen.has(typedLogin.toLowerCase())) {
    push({ key: `typed:${typedLogin}`, value: typedLogin, label: typedLogin, section: "typed", person: true, selected: false });
  }
  return out;
}

function FilterPicker({
  kind,
  filters,
  facets,
  loadOptions,
  onChange,
  onDone,
}: {
  kind: GitHubPrFilterKind;
  filters: GitHubPrListFilters;
  facets: GitHubPrFilterFacets;
  loadOptions: GitHubFilterOptionsLoader | null;
  onChange: (next: GitHubPrListFilters) => void;
  onDone: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const trimmed = query.trim();
  const remote = useGitHubFilterOptions({ enabled: true, kind, query: trimmed, load: loadOptions });
  const [pinnedSelected] = React.useState<string[]>(() => {
    if (kind === "label") return [...filters.labels];
    const current = kind === "author" ? filters.author : filters.assignee;
    return current ? [current] : [];
  });

  const rows = React.useMemo(
    () => buildRows({ kind, filters, facets, remote: remote.options, query: trimmed, pinnedSelected }),
    [facets, filters, kind, pinnedSelected, remote.options, trimmed],
  );

  React.useEffect(() => setActive(0), [kind, trimmed]);
  const activeIndex = Math.min(active, Math.max(0, rows.length - 1));
  React.useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const pick = (value: string) => {
    if (kind === "label") {
      const has = filters.labels.some((label) => label.toLowerCase() === value.toLowerCase());
      onChange({
        ...filters,
        labels: has
          ? filters.labels.filter((label) => label.toLowerCase() !== value.toLowerCase())
          : [...filters.labels, value],
      });
      return;
    }
    const current = kind === "author" ? filters.author : filters.assignee;
    const next = current?.toLowerCase() === value.toLowerCase() ? null : value;
    onChange(kind === "author" ? { ...filters, author: next } : { ...filters, assignee: next });
    onDone();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((activeIndex + step + rows.length) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[activeIndex];
      if (row) pick(row.value);
    }
  };

  const multi = kind === "label";
  const placeholder = kind === "label" ? "Find a label" : "Find a person";
  let lastSection: PickerSection | null = null;
  return (
    <>
      <label className="ade-prf-search">
        <MagnifyingGlass size={12} aria-hidden />
        <input
          autoFocus
          className="ade-prf-search-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={`Find ${KIND_TITLE[kind].toLowerCase()}`}
          aria-controls={`github-pr-filter-list-${kind}`}
          aria-activedescendant={rows[activeIndex] ? `github-pr-filter-row-${kind}-${activeIndex}` : undefined}
          role="combobox"
          aria-expanded
          spellCheck={false}
          autoComplete="off"
        />
        {remote.loading ? <CircleNotch size={12} className="animate-spin" aria-label="Searching GitHub" /> : null}
      </label>
      <div
        ref={listRef}
        id={`github-pr-filter-list-${kind}`}
        className="ade-prf-list"
        role="listbox"
        aria-label={`${KIND_TITLE[kind]} options`}
        aria-multiselectable={multi || undefined}
        data-testid={`github-pr-filter-picker-${kind}`}
      >
        {rows.map((row, index) => {
          const title = row.section !== lastSection ? SECTION_TITLE[row.section] : null;
          lastSection = row.section;
          return (
            <React.Fragment key={row.key}>
              {title ? (
                <div className="ade-prf-section kit-eyebrow" role="presentation">
                  <span>{title}</span>
                  {row.section === "github" && remote.loading ? <span>Searching…</span> : null}
                </div>
              ) : null}
              <button
                type="button"
                id={`github-pr-filter-row-${kind}-${index}`}
                role="option"
                aria-selected={row.selected}
                data-row-index={index}
                data-active={index === activeIndex ? "true" : undefined}
                className="ade-prf-row"
                tabIndex={-1}
                onPointerMove={() => { if (index !== activeIndex) setActive(index); }}
                onClick={() => pick(row.value)}
              >
                <span className="ade-prf-check" data-shape={multi ? "box" : "radio"} data-on={row.selected ? "true" : undefined} aria-hidden>
                  {multi && row.selected ? <Check size={10} weight="bold" /> : null}
                </span>
                <span className="ade-prf-main">
                  {row.section === "typed" ? (
                    <span className="ade-prf-person">
                      <span>
                        {kind === "label" ? "Filter by label " : "Filter by "}
                        <strong>{kind === "label" ? `“${row.label}”` : `@${row.label}`}</strong>
                      </span>
                    </span>
                  ) : kind === "label" ? (
                    <PrLabelPill name={row.label} color={row.color} />
                  ) : row.person ? (
                    <span className="ade-prf-person">
                      <PrAgentAvatar login={row.value} avatarUrl={avatarFor(row.value, row.avatarUrl)} size={18} />
                      <span>{row.label}</span>
                    </span>
                  ) : (
                    <span className="ade-prf-person">
                      {row.value === GITHUB_PR_FILTER_NO_ASSIGNEE
                        ? <Prohibit size={16} aria-hidden style={{ color: "var(--kit-text-3)" }} />
                        : <UserCircle size={18} aria-hidden style={{ color: "var(--kit-text-2)" }} />}
                      <span>{row.label}</span>
                    </span>
                  )}
                  {row.hint ? <span className="ade-prf-desc">{row.hint}</span> : null}
                </span>
                {row.count != null ? (
                  <span className="kit-num ade-prf-count" title={`${row.count} loaded ${row.count === 1 ? "pull request" : "pull requests"}`}>
                    {row.count}
                  </span>
                ) : <span />}
              </button>
            </React.Fragment>
          );
        })}
        {rows.length === 0 ? (
          <div className="ade-prf-empty">
            {remote.loading
              ? "Searching GitHub…"
              : trimmed
                ? (kind === "label" ? "No label matches." : "Nobody matches. Type a full GitHub username.")
                : kind === "label" ? "No labels in this list yet. Type to search GitHub." : "Type to search GitHub."}
          </div>
        ) : null}
        {remote.failed ? <div className="ade-prf-note">GitHub did not answer; showing loaded pull requests only.</div> : null}
      </div>
    </>
  );
}

/**
 * One "Filter" control for the GitHub tab: a panel with Label / Author /
 * Assignee tabs over one searchable list. Each list shows what the loaded rows
 * carry first, then what GitHub returns. Nothing is fetched until it opens.
 */
export function GitHubPrFilterMenu({
  filters,
  facets,
  loadOptions,
  onChange,
  compact = false,
}: {
  filters: GitHubPrListFilters;
  facets: GitHubPrFilterFacets;
  /** Null on a host that cannot ask GitHub: the pickers show loaded rows only. */
  loadOptions: GitHubFilterOptionsLoader | null;
  onChange: (next: GitHubPrListFilters) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<GitHubPrFilterKind>(lastPickerKind);
  const active = hasGitHubPrListFilters(filters);
  const activeCount = filters.labels.length + (filters.author ? 1 : 0) + (filters.assignee ? 1 : 0);
  const chooseKind = (next: GitHubPrFilterKind) => {
    lastPickerKind = next;
    setKind(next);
  };
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKind(lastPickerKind);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={active ? `Filters: ${activeCount} on` : "Filter by label, author or assignee"}
          title="Filter by label, author or assignee"
          data-testid="github-pr-filter-button"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 22,
            padding: compact ? "0 5px" : "0 7px",
            marginRight: 4,
            borderRadius: 6,
            border: `1px solid ${active ? `color-mix(in srgb, ${COLORS.accent} 40%, transparent)` : fgTint(8)}`,
            background: active ? `color-mix(in srgb, ${COLORS.accent} 14%, transparent)` : "transparent",
            color: active ? COLORS.accent : COLORS.textMuted,
            fontFamily: SANS_FONT,
            fontSize: 10.5,
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          <FunnelSimple size={11} weight={active ? "fill" : "regular"} aria-hidden />
          {compact ? null : "Filter"}
          {active ? <span style={{ fontFamily: MONO_FONT, fontSize: 10 }}>{activeCount}</span> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className={cn(MENU_SURFACE_CLASS, "ade-prf-panel outline-none")}
          style={{ zIndex: Z_LAYERS.popover }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          data-testid="github-pr-filter-menu"
          aria-label="Filter pull requests"
        >
          <div className="ade-prf-head">
            <div className="kit-seg" data-case="sentence" role="tablist" aria-label="Filter by">
              {(["label", "author", "assignee"] as const).map((value) => {
                const count = filterCount(filters, value);
                return (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={kind === value}
                    data-testid={`github-pr-filter-tab-${value}`}
                    onClick={() => chooseKind(value)}
                  >
                    {KIND_TITLE[value]}
                    {count > 0 ? <span className="ade-prf-tab-count">{count}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
          <FilterPicker
            key={kind}
            kind={kind}
            filters={filters}
            facets={facets}
            loadOptions={loadOptions}
            onChange={onChange}
            onDone={() => setOpen(false)}
          />
          <div className="ade-prf-foot">
            {active ? (
              <>
                <span>{activeCount === 1 ? "1 filter on" : `${activeCount} filters on`}</span>
                <button
                  type="button"
                  className="kit-btn kit-btn-ghost"
                  data-size="sm"
                  onClick={() => onChange({ labels: [], author: null, assignee: null })}
                >
                  Clear all
                </button>
              </>
            ) : (
              <span><kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>↵</kbd> to pick</span>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The active filters as removable chips under the list chrome. */
export function GitHubPrFilterChips({
  filters,
  labelColors,
  onChange,
}: {
  filters: GitHubPrListFilters;
  labelColors: Map<string, string>;
  onChange: (next: GitHubPrListFilters) => void;
}) {
  if (!hasGitHubPrListFilters(filters)) return null;
  const removeButton = (text: string, remove: () => void) => (
    <button type="button" className="ade-prf-chip-x" onClick={remove} aria-label={`Remove filter ${text}`}>
      <X size={9} weight="bold" />
    </button>
  );
  const person = (kind: "author" | "assignee", value: string) => {
    const text = describeGitHubPrFilter(kind, value);
    const special = value === GITHUB_PR_FILTER_ME || value === GITHUB_PR_FILTER_NO_ASSIGNEE;
    return (
      <span key={kind} className="ade-prf-chip" title={text}>
        {special ? null : <PrAgentAvatar login={value} avatarUrl={avatarFor(value)} size={14} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {special ? text : <><b>{kind === "author" ? "By" : "Assigned to"}</b> {value}</>}
        </span>
        {removeButton(text, () => onChange(kind === "author" ? { ...filters, author: null } : { ...filters, assignee: null }))}
      </span>
    );
  };
  const chipCount = filters.labels.length + (filters.author ? 1 : 0) + (filters.assignee ? 1 : 0);
  return (
    <div className="ade-prf-chips" data-testid="github-pr-filter-chips">
      {filters.labels.map((label) => (
        <PrLabelPill key={`label:${label}`} name={label} color={labelColors.get(label.toLowerCase()) ?? null} style={{ paddingRight: 4 }}>
          {removeButton(label, () => onChange({ ...filters, labels: filters.labels.filter((value) => value !== label) }))}
        </PrLabelPill>
      ))}
      {filters.author ? person("author", filters.author) : null}
      {filters.assignee ? person("assignee", filters.assignee) : null}
      {chipCount > 1 ? (
        <button type="button" className="ade-prf-chips-clear" onClick={() => onChange({ labels: [], author: null, assignee: null })}>
          Clear all
        </button>
      ) : null}
    </div>
  );
}
