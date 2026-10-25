import React from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  CaretLeft,
  CaretRight,
  Check,
  CircleNotch,
  FunnelSimple,
  MagnifyingGlass,
  Tag,
  User,
  UserCircle,
  X,
} from "@phosphor-icons/react";

import type {
  GitHubPrFilterKind,
  GitHubPrFilterOption,
  GitHubPrListFilters,
  PrLabel,
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
import { MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS, MENU_SURFACE_CLASS } from "../../ui/paneMenuTokens";
import { isImeComposing } from "../../../lib/imeComposition";
import { PrAgentAvatar } from "./PrAgentAvatar";

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
  labels: PrLabel[];
  authors: string[];
};

type PickerRow = {
  key: string;
  value: string;
  label: string;
  hint?: string | null;
  color?: string | null;
  avatarUrl?: string | null;
  person?: boolean;
  selected: boolean;
};

function matchesQuery(query: string, ...values: Array<string | null | undefined>): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(q));
}

function personLabel(value: string, kind: "author" | "assignee"): string {
  if (value === GITHUB_PR_FILTER_ME) return kind === "author" ? "Me" : "Assigned to me";
  if (value === GITHUB_PR_FILTER_NO_ASSIGNEE) return "Unassigned";
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

function FilterPicker({
  kind,
  filters,
  facets,
  loadOptions,
  onChange,
  onBack,
  onDone,
}: {
  kind: GitHubPrFilterKind;
  filters: GitHubPrListFilters;
  facets: GitHubPrFilterFacets;
  loadOptions: GitHubFilterOptionsLoader | null;
  onChange: (next: GitHubPrListFilters) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const trimmed = query.trim();
  const remote = useGitHubFilterOptions({ enabled: true, kind, query: trimmed, load: loadOptions });

  const rows = React.useMemo((): PickerRow[] => {
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
      const facetColor = new Map(facets.labels.map((label) => [label.name.toLowerCase(), label]));
      for (const name of filters.labels) {
        push({ key: `sel:${name}`, value: name, label: name, color: facetColor.get(name.toLowerCase())?.color ?? null, selected: true });
      }
      for (const label of facets.labels) {
        if (!matchesQuery(trimmed, label.name, label.description)) continue;
        push({ key: `facet:${label.name}`, value: label.name, label: label.name, hint: label.description, color: label.color, selected: selected.has(label.name.toLowerCase()) });
      }
      for (const option of remote.options) {
        push({ key: `gh:${option.value}`, value: option.value, label: option.value, hint: option.description, color: option.color, selected: selected.has(option.value.toLowerCase()) });
      }
      return out;
    }
    const current = kind === "author" ? filters.author : filters.assignee;
    const fixed = kind === "author"
      ? [GITHUB_PR_FILTER_ME]
      : [GITHUB_PR_FILTER_ME, GITHUB_PR_FILTER_NO_ASSIGNEE];
    for (const value of fixed) {
      if (!matchesQuery(trimmed, personLabel(value, kind))) continue;
      push({ key: `fixed:${value}`, value, label: personLabel(value, kind), selected: current === value });
    }
    if (current && !fixed.includes(current)) {
      push({ key: `sel:${current}`, value: current, label: current, person: true, selected: true });
    }
    // Loaded rows know who authored them; they say nothing about assignees.
    if (kind === "author") {
      for (const login of facets.authors) {
        if (!matchesQuery(trimmed, login)) continue;
        push({ key: `facet:${login}`, value: login, label: login, person: true, selected: current?.toLowerCase() === login.toLowerCase() });
      }
    }
    for (const option of remote.options) {
      push({
        key: `gh:${option.value}`,
        value: option.value,
        label: option.value,
        hint: option.name,
        avatarUrl: option.avatarUrl,
        person: true,
        selected: current?.toLowerCase() === option.value.toLowerCase(),
      });
    }
    return out;
  }, [facets.authors, facets.labels, filters.assignee, filters.author, filters.labels, kind, remote.options, trimmed]);

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

  // Enter takes the first match; when nothing matched, a typed label or a
  // valid login is used as is (a label GitHub has not been asked about yet).
  const submit = () => {
    const first = rows.find((row) => !row.selected) ?? rows[0];
    if (first && (trimmed === "" || matchesQuery(trimmed, first.label, first.value))) {
      pick(first.value);
      return;
    }
    if (!trimmed) return;
    if (kind === "label") pick(trimmed);
    else {
      const login = normalizeGitHubLogin(trimmed);
      if (login) pick(login);
    }
  };

  const title = kind === "label" ? "Label" : kind === "author" ? "Author" : "Assignee";
  return (
    <div data-testid={`github-pr-filter-picker-${kind}`} style={{ width: 260 }}>
      <div className="flex items-center gap-1 px-1 pb-1">
        <button type="button" onClick={onBack} aria-label="Back to filters" className="kit-icon-btn inline-flex items-center justify-center rounded" style={{ width: 22, height: 22, color: COLORS.textMuted, background: "none", border: "none", cursor: "pointer" }}>
          <CaretLeft size={12} weight="bold" />
        </button>
        <span className="text-[11.5px] font-semibold" style={{ color: COLORS.textPrimary }}>{title}</span>
        <span style={{ flex: 1 }} />
        {remote.loading ? <CircleNotch size={11} className="animate-spin" aria-label="Searching GitHub" style={{ color: COLORS.textDim }} /> : null}
      </div>
      <div className="mx-1 mb-1 flex items-center gap-1.5 rounded-md px-2" style={{ height: 26, border: `1px solid ${fgTint(8)}`, background: COLORS.recessedBg }}>
        <MagnifyingGlass size={11} style={{ color: COLORS.textDim, flexShrink: 0 }} />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isImeComposing(event)) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={kind === "label" ? "Find a label" : "Find a person"}
          aria-label={`Find ${title.toLowerCase()}`}
          className="min-w-0 flex-1 bg-transparent text-[11.5px] outline-none"
          style={{ border: "none", color: COLORS.textPrimary, fontFamily: SANS_FONT }}
        />
      </div>
      <div className="max-h-[min(50vh,320px)] overflow-y-auto overscroll-contain" role="listbox" aria-label={`${title} options`} aria-multiselectable={kind === "label" || undefined}>
        {rows.map((row) => (
          <button
            key={row.key}
            type="button"
            role="option"
            aria-selected={row.selected}
            onClick={() => pick(row.value)}
            className={cn(MENU_ITEM_CLASS, "w-full text-left hover:bg-fg/[0.07]")}
            style={{ background: "none", border: "none" }}
          >
            {kind === "label" ? (
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: row.color ? `#${row.color}` : fgTint(30) }} />
            ) : row.person ? (
              <PrAgentAvatar login={row.value} avatarUrl={row.avatarUrl ?? null} size={16} />
            ) : (
              <UserCircle size={14} style={{ color: COLORS.textMuted }} />
            )}
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            {row.hint ? <span className="max-w-[90px] truncate text-[10px]" style={{ color: COLORS.textDim }}>{row.hint}</span> : null}
            {row.selected ? <Check size={11} weight="bold" style={{ color: COLORS.accent, flexShrink: 0 }} /> : null}
          </button>
        ))}
        {rows.length === 0 && !remote.loading ? (
          <div className="px-2 py-2 text-[11px]" style={{ color: COLORS.textDim }}>
            {trimmed ? (kind === "label" ? "No label matches. Press Enter to filter by it anyway." : "Nobody matches.") : "Nothing to pick yet."}
          </div>
        ) : null}
        {remote.failed ? (
          <div className="px-2 py-1.5 text-[10.5px]" style={{ color: COLORS.textDim }}>Could not ask GitHub; showing loaded pull requests only.</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One "Filter" control for the GitHub tab: Label / Author / Assignee, each a
 * searchable picker that lists what the loaded rows show first and then what
 * GitHub returns. Nothing is fetched until a picker opens.
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
  const [view, setView] = React.useState<GitHubPrFilterKind | null>(null);
  const active = hasGitHubPrListFilters(filters);
  const activeCount = filters.labels.length + (filters.author ? 1 : 0) + (filters.assignee ? 1 : 0);
  const rootRows: Array<{ kind: GitHubPrFilterKind; label: string; icon: typeof Tag; value: string | null }> = [
    { kind: "label", label: "Label", icon: Tag, value: filters.labels.length ? filters.labels.join(", ") : null },
    { kind: "author", label: "Author", icon: User, value: filters.author ? personLabel(filters.author, "author") : null },
    { kind: "assignee", label: "Assignee", icon: UserCircle, value: filters.assignee ? personLabel(filters.assignee, "assignee") : null },
  ];
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setView(null);
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
          className={cn(MENU_SURFACE_CLASS, "outline-none")}
          style={{ zIndex: Z_LAYERS.popover }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {view ? (
            <FilterPicker
              kind={view}
              filters={filters}
              facets={facets}
              loadOptions={loadOptions}
              onChange={onChange}
              onBack={() => setView(null)}
              onDone={() => {
                setOpen(false);
                setView(null);
              }}
            />
          ) : (
            <div style={{ width: 228 }} data-testid="github-pr-filter-menu">
              <div className={MENU_LABEL_CLASS}>Filter pull requests</div>
              {rootRows.map((row) => {
                const Icon = row.icon;
                return (
                  <button
                    key={row.kind}
                    type="button"
                    onClick={() => setView(row.kind)}
                    className={cn(MENU_ITEM_CLASS, "w-full text-left hover:bg-fg/[0.07]")}
                    style={{ background: "none", border: "none" }}
                  >
                    <Icon size={13} style={{ color: COLORS.textMuted }} />
                    <span className="flex-1">{row.label}</span>
                    {row.value ? <span className="max-w-[110px] truncate text-[10.5px]" style={{ color: COLORS.accent }}>{row.value}</span> : null}
                    <CaretRight size={10} style={{ color: COLORS.textDim }} />
                  </button>
                );
              })}
              {active ? (
                <>
                  <div className={MENU_SEPARATOR_CLASS} />
                  <button
                    type="button"
                    onClick={() => {
                      onChange({ labels: [], author: null, assignee: null });
                      setOpen(false);
                    }}
                    className={cn(MENU_ITEM_CLASS, "w-full text-left hover:bg-fg/[0.07]")}
                    style={{ background: "none", border: "none", color: COLORS.textMuted }}
                  >
                    <X size={12} />
                    Clear filters
                  </button>
                </>
              ) : null}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The active filters as small removable pills under the list chrome. */
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
  const chips: Array<{ key: string; text: string; color: string | null; remove: () => void }> = [
    ...filters.labels.map((label) => ({
      key: `label:${label}`,
      text: label,
      color: labelColors.get(label.toLowerCase()) ?? null,
      remove: () => onChange({ ...filters, labels: filters.labels.filter((value) => value !== label) }),
    })),
    ...(filters.author ? [{
      key: "author",
      text: describeGitHubPrFilter("author", filters.author),
      color: null,
      remove: () => onChange({ ...filters, author: null }),
    }] : []),
    ...(filters.assignee ? [{
      key: "assignee",
      text: describeGitHubPrFilter("assignee", filters.assignee),
      color: null,
      remove: () => onChange({ ...filters, assignee: null }),
    }] : []),
  ];
  return (
    <div data-testid="github-pr-filter-chips" style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "6px 10px 0", flexShrink: 0 }}>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="kit-tag"
          style={{ display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%", textTransform: "none", letterSpacing: 0 }}
        >
          {chip.color ? <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: `#${chip.color}` }} /> : null}
          <span className="truncate">{chip.text}</span>
          <button
            type="button"
            onClick={chip.remove}
            aria-label={`Remove filter ${chip.text}`}
            style={{ display: "inline-flex", padding: 0, background: "none", border: "none", cursor: "pointer", color: "inherit", opacity: 0.6 }}
          >
            <X size={9} weight="bold" />
          </button>
        </span>
      ))}
      {chips.length > 1 ? (
        <button
          type="button"
          onClick={() => onChange({ labels: [], author: null, assignee: null })}
          style={{ background: "none", border: "none", padding: "0 2px", cursor: "pointer", fontSize: 10.5, color: COLORS.textDim, fontFamily: SANS_FONT }}
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}
