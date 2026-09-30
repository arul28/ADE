import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ChatCircleDots,
  Command,
  File,
  GitBranch,
  Globe,
  MagnifyingGlass,
  Plus,
  Sparkle,
  SpinnerGap,
  Terminal as TerminalIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { composerFileSearchQuery, type ComposerTrigger } from "../../../shared/composerTriggers";
import {
  CHAT_MENTION_KINDS,
  CHAT_MENTION_MAX_PER_KIND,
  CHAT_MENTION_MAX_RESULTS,
  compareChatMentionRanks,
  scoreChatMentionCandidate,
} from "../../../shared/chatMentions";
import {
  rankComposerModelMatches,
  type ComposerModelSuggestion,
} from "../../../shared/modelMentions";
import {
  classifySlashCommand,
  scoreSlashCommand,
  slashCommandSectionKey,
  type ClassifiableSlashCommand,
} from "../../../shared/slashCommandSections";
import { composerAtFileRankFields, rankComposerAtMenuItems } from "../../../shared/composerAtMenuRanking";
import type { ChatMentionKind, ChatMentionSuggestion } from "../../../shared/types/chatMentions";
import { cn } from "../ui/cn";
import { prStateTone } from "../../lib/prChatScope";
import { ModelRowLogo, ProviderLogo } from "../shared/ProviderLogos";
import type { PrSummary } from "../../../shared/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatCommandMenuItem =
  | { type: "file"; path: string; isDirectory?: boolean }
  | { type: "command"; name: string }
  | { type: "mention"; mention: ChatMentionSuggestion }
  | { type: "pr"; pr: ComposerPrSuggestion }
  | { type: "model"; model: ComposerModelSuggestion }
  | { type: "more"; sectionKey: string; count: number; label: string };

/** One row in the `#` pull-request menu. */
export type ComposerPrSuggestion = {
  number: number;
  title: string;
  state: PrSummary["state"];
  url: string;
  repo?: string;
};

export type ChatCommandMenuHandle = {
  moveUp(): void;
  moveDown(): void;
  /** Returns true when a row was actually selected (the menu had a match). */
  selectCurrent(): boolean;
};

type SlashCommand = ClassifiableSlashCommand & { source?: "sdk" | "local" };

type ChatCommandMenuProps = {
  /** The current trigger character and query. */
  trigger: ComposerTrigger | null;
  /** Available slash commands. */
  slashCommands: SlashCommand[];
  /** File search callback. When omitted, @ file suggestions are unavailable. */
  onFileSearch?: (query: string) => Promise<Array<{ path: string; isDirectory?: boolean }>>;
  /**
   * Entity mention search (chats / lanes / terminals in the active project).
   * When omitted the @ menu shows files only.
   */
  onMentionSearch?: (query: string) => Promise<ChatMentionSuggestion[]>;
  /**
   * Pull-request search for the `#` trigger. When omitted, `#` opens no menu
   * and the character stays ordinary text.
   */
  onPrSearch?: (query: string) => Promise<ComposerPrSuggestion[]>;
  /**
   * Models this chat can start. The @ menu lists a model only when the query
   * names it (prefix or substring), so an ordinary @ search is not flooded
   * with the whole catalog. A query that starts with "model" lists them all.
   */
  modelOptions?: ComposerModelSuggestion[];
  /** Anchor position in viewport coordinates. */
  anchor: { top: number; left: number; bottom?: number } | null;
  /** Called when user selects an item. */
  onSelect: (item: ChatCommandMenuItem) => void;
  /** Called when menu should close. */
  onClose: () => void;
  /**
   * Called once when a non-empty @ query settles with nothing to show. The
   * owner closes the menu and keeps it closed while the user keeps typing that
   * dead query — search only narrows, so more characters cannot bring matches
   * back.
   */
  onNoMatches?: (trigger: ComposerTrigger) => void;
};

type FileResult = { path: string; isDirectory?: boolean };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split a file path into dirname and basename for display. */
function splitPath(filePath: string): { dir: string; base: string } {
  const fields = composerAtFileRankFields(filePath);
  return { dir: fields.subtitle, base: fields.title };
}

/** Weaker than any real hit so an index-returned file is never dropped. */
const UNMATCHED_FILE_SCORE = 50;

/** Section accents: one colour per group, on the header icon and label. */
const SECTION_ACCENT: Record<string, string> = {
  models: "text-violet-300/80",
  chats: "text-sky-300/80",
  lanes: "text-emerald-300/80",
  files: "text-amber-300/80",
  terminals: "text-cyan-300/80",
  commands: "text-violet-300/80",
  skills: "text-emerald-300/80",
  mcp: "text-teal-300/80",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MAX_FILE_RESULTS = 16;
const MAX_SLASH_RESULTS = 60;
const MENU_WIDTH = 460;
/** The menu grows to this share of the window before it scrolls. */
const MENU_MAX_HEIGHT_RATIO = 0.6;
const MENU_MAX_HEIGHT_CAP = 640;
const SECTION_DEFAULT_LIMIT = 3;
/** The section holding the overall best match shows this many rows. */
const SECTION_BEST_LIMIT = 5;
const VIEWPORT_GUTTER = 8;
const MENU_GAP = 8;
const DEBOUNCE_MS = 40;
const QUERY_CACHE_MAX = 40;
// ---------------------------------------------------------------------------
// Async suggestion source (short debounce, provider-scoped cache, stale guard)
// ---------------------------------------------------------------------------

type SuggestionSource<T> = ((query: string) => Promise<T[]>) | undefined;
/** `query` is the query these results belong to — anything else is in flight. */
type SuggestionState<T> = { search: SuggestionSource<T>; query: string | null; results: T[] };

/**
 * One @-menu suggestion source. Cached queries render in the same frame with a
 * silent background revalidation; cold queries wait DEBOUNCE_MS. The cache is
 * keyed by query *and* provider identity and is cleared when the menu closes,
 * so staleness never outlives one interaction. There is no polling: a fetch
 * happens only on menu-open and on keystroke.
 */
function useDebouncedSuggestions<T>(
  enabled: boolean,
  query: string,
  search: SuggestionSource<T>,
  max: number,
  /** Identity of the open menu; `null` means "closed — drop the cache". */
  cacheKey: string | null,
): { results: T[]; loading: boolean } {
  const [state, setState] = useState<SuggestionState<T>>({ search: undefined, query: null, results: [] });
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef<{ search: SuggestionSource<T>; map: Map<string, T[]> }>({
    search: undefined,
    map: new Map(),
  });
  const seqRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (cacheKey == null) {
      cacheRef.current.map.clear();
      seqRef.current += 1;
    }
  }, [cacheKey]);

  useEffect(() => {
    if (!enabled || !search) {
      seqRef.current += 1;
      setState({ search, query, results: [] });
      setLoading(false);
      return;
    }

    // Cached queries belong to one provider; a provider change drops them all.
    if (cacheRef.current.search !== search) {
      cacheRef.current = { search, map: new Map() };
    }
    const cached = cacheRef.current.map.get(query);
    if (cached) {
      setState({ search, query, results: cached.slice(0, max) });
      setLoading(false);
    } else {
      setState({ search, query, results: [] });
      setLoading(true);
    }

    const seq = ++seqRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await search(query);
        if (seqRef.current !== seq) return;
        const { map } = cacheRef.current;
        map.delete(query);
        map.set(query, results);
        if (map.size > QUERY_CACHE_MAX) {
          const oldest = map.keys().next().value;
          if (oldest !== undefined) map.delete(oldest);
        }
        setState({ search, query, results: results.slice(0, max) });
      } catch {
        if (seqRef.current === seq && !cached) setState({ search, query, results: [] });
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    }, cached ? 0 : DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [enabled, query, search, max, cacheKey]);

  // Results produced by a previous provider or a previous query are discarded
  // rather than shown, and count as still-loading: state updates from this
  // render's effects are not visible to consumers until the next render, so
  // `loading` alone would read "settled" for one frame after every keystroke.
  const stale = state.search !== search || state.query !== query;
  return { results: stale ? [] : state.results, loading: loading || stale };
}


const MENTION_SECTION_ICON: Record<ChatMentionKind, PhosphorIcon> = {
  chat: ChatCircleDots,
  lane: GitBranch,
  terminal: TerminalIcon,
};

const MENTION_SECTION_LABEL: Record<ChatMentionKind, string> = {
  chat: "Chats",
  lane: "Lanes",
  terminal: "Terminals",
};

/** The fixed section order after the best-match section leads. */
const AT_SECTION_ORDER = ["models", "chats", "lanes", "files", "terminals"];

/** One row, with its flat keyboard index already resolved by the sections memo. */
type MenuRowEntry = { item: ChatCommandMenuItem; index: number };

type MenuSection = {
  key: string;
  label: string;
  Icon: PhosphorIcon;
  accent: string;
  rows: MenuRowEntry[];
};

/** A section before layout: its scored rows, in rank order. */
type RawSection = {
  key: string;
  label: string;
  Icon: PhosphorIcon;
  accent: string;
  rows: Array<{ item: ChatCommandMenuItem; score: number }>;
  /** The noun a `+ N more` row names, e.g. "models". */
  moreLabel: string;
};

/**
 * Assign flat keyboard indices after applying the section layout: best-match
 * first (for `@`), a per-section row cap, and a `+ N more` row when a section
 * has rows beyond its cap.
 */
function layoutSections(
  raw: RawSection[],
  options: {
    bestKey: string | null;
    bestFirst: boolean;
    fixedOrder: string[];
    expanded: Set<string>;
  },
): MenuSection[] {
  const present = raw.filter((section) => section.rows.length > 0);
  if (!present.length) return [];
  const order = new Map(options.fixedOrder.map((key, index) => [key, index]));
  const ordered = [...present].sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
  if (options.bestFirst && options.bestKey) {
    const best = ordered.find((section) => section.key === options.bestKey);
    if (best) {
      const rest = ordered.filter((section) => section !== best);
      rest.unshift(best);
      ordered.length = 0;
      ordered.push(...rest);
    }
  }
  let nextIndex = 0;
  return ordered.map((section) => {
    const limit = options.expanded.has(section.key)
      ? Number.POSITIVE_INFINITY
      : section.key === options.bestKey
        ? SECTION_BEST_LIMIT
        : SECTION_DEFAULT_LIMIT;
    const taken = section.rows.slice(0, limit);
    const rows: MenuRowEntry[] = taken.map((row) => ({ item: row.item, index: nextIndex++ }));
    const remaining = section.rows.length - taken.length;
    if (remaining > 0) {
      rows.push({
        item: { type: "more", sectionKey: section.key, count: remaining, label: section.moreLabel },
        index: nextIndex++,
      });
    }
    return { key: section.key, label: section.label, Icon: section.Icon, accent: section.accent, rows };
  });
}

function lowestScore(sections: RawSection[]): string | null {
  let bestKey: string | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const section of sections) {
    const score = section.rows[0]?.score;
    if (score === undefined) continue;
    if (score < best) {
      best = score;
      bestKey = section.key;
    }
  }
  return bestKey;
}

/**
 * Shared row chrome. Every branch renders the same box, so selection styling,
 * the `data-menu-index` scroll anchor, and the hover/click wiring live once.
 */
function MenuRow({
  index,
  selected,
  onHover,
  onSelect,
  children,
}: {
  index: number;
  selected: boolean;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
  children: React.ReactNode;
}) {
  return (
    <div
      data-active={selected}
      data-menu-index={index}
      className={cn(
        "ade-chat-drawer-row mx-1 flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[11px]",
        selected ? "text-fg/88" : "text-fg/58",
      )}
      onMouseEnter={() => onHover(index)}
      onClick={() => onSelect(index)}
    >
      {children}
    </div>
  );
}

function getViewportMenuStyle(anchor: NonNullable<ChatCommandMenuProps["anchor"]>): CSSProperties {
  const viewportWidth = typeof window === "undefined" ? MENU_WIDTH + VIEWPORT_GUTTER * 2 : window.innerWidth;
  const viewportHeight = typeof window === "undefined" ? 720 : window.innerHeight;
  const width = Math.max(280, Math.min(MENU_WIDTH, viewportWidth - VIEWPORT_GUTTER * 2));
  const maxHeight = Math.max(220, Math.min(MENU_MAX_HEIGHT_CAP, viewportHeight * MENU_MAX_HEIGHT_RATIO));
  const maxLeft = Math.max(VIEWPORT_GUTTER, viewportWidth - width - VIEWPORT_GUTTER);
  const left = Math.min(Math.max(VIEWPORT_GUTTER, anchor.left), maxLeft);
  const anchorBottom = typeof anchor.bottom === "number" ? anchor.bottom : anchor.top;
  const roomAbove = Math.max(0, anchor.top - VIEWPORT_GUTTER);
  const roomBelow = Math.max(0, viewportHeight - anchorBottom - VIEWPORT_GUTTER);

  if (roomAbove >= maxHeight || roomAbove >= roomBelow) {
    return {
      left,
      width,
      bottom: Math.max(VIEWPORT_GUTTER, viewportHeight - anchor.top + MENU_GAP),
      maxHeight: Math.max(160, Math.min(maxHeight, roomAbove - MENU_GAP)),
    };
  }

  return {
    left,
    width,
    top: Math.min(viewportHeight - VIEWPORT_GUTTER, anchorBottom + MENU_GAP),
    maxHeight: Math.max(160, Math.min(maxHeight, roomBelow - MENU_GAP)),
  };
}

export const ChatCommandMenu = forwardRef<ChatCommandMenuHandle, ChatCommandMenuProps>(
  function ChatCommandMenu(
    { trigger, slashCommands, onFileSearch, onMentionSearch, onPrSearch, modelOptions, anchor, onSelect, onClose, onNoMatches },
    ref,
  ) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set());
    const listRef = useRef<HTMLDivElement | null>(null);

    const triggerType = trigger?.type ?? null;
    const triggerQuery = trigger?.query ?? "";

    // ---- `/` ranking ----
    const rankedCommands = useMemo(() => {
      if (!trigger || trigger.type !== "slash") return [];
      const scored = slashCommands
        .map((command) => ({ command, score: scoreSlashCommand(command, trigger.query) }))
        .filter((row): row is { command: SlashCommand; score: number } => row.score !== null);
      const best = scored.reduce<number | null>((min, row) => (min === null || row.score < min ? row.score : min), null);
      const keepScattered = best !== null && best >= 3;
      const kept = scored.filter((row) => keepScattered || row.score < 3);
      kept.sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return a.command.name < b.command.name ? -1 : a.command.name > b.command.name ? 1 : 0;
      });
      return kept.slice(0, MAX_SLASH_RESULTS);
    }, [trigger, slashCommands]);

    // ---- @ sources: files + entity mentions, each independently debounced ----
    const atQuery = triggerType === "at" ? triggerQuery.trim() : "";
    const fileQuery = triggerType === "at" ? composerFileSearchQuery(triggerQuery) : "";
    const atActive = triggerType === "at";

    // `triggerType` is null while the menu is closed, which drops both caches.
    const { results: fileResults, loading: fileLoading } = useDebouncedSuggestions<FileResult>(
      atActive,
      fileQuery,
      onFileSearch,
      MAX_FILE_RESULTS,
      triggerType,
    );
    const { results: mentionResults, loading: mentionLoading } =
      useDebouncedSuggestions<ChatMentionSuggestion>(
        atActive,
        atQuery,
        onMentionSearch,
        CHAT_MENTION_MAX_PER_KIND * CHAT_MENTION_KINDS.length,
        triggerType,
      );

    // ---- `#` source: pull requests in this project ----
    const hashActive = triggerType === "hash";
    const hashQuery = hashActive ? triggerQuery.trim() : "";
    const { results: prResults, loading: prLoading } = useDebouncedSuggestions<ComposerPrSuggestion>(
      hashActive,
      hashQuery,
      onPrSearch,
      MAX_FILE_RESULTS,
      triggerType,
    );

    // ---- Description lookup for commands ----
    const commandMap = useMemo(() => {
      const map = new Map<string, SlashCommand>();
      for (const cmd of slashCommands) map.set(cmd.name, cmd);
      return map;
    }, [slashCommands]);

    // ---- Raw sections (ranked, uncapped) ----
    const rawSections = useMemo((): { sections: RawSection[]; bestFirst: boolean; fixedOrder: string[] } => {
      if (!trigger) return { sections: [], bestFirst: false, fixedOrder: [] };

      if (trigger.type === "hash") {
        if (!prResults.length) return { sections: [], bestFirst: false, fixedOrder: ["prs"] };
        return {
          bestFirst: false,
          fixedOrder: ["prs"],
          sections: [{
            key: "prs",
            label: "Pull requests",
            Icon: MagnifyingGlass,
            accent: SECTION_ACCENT.files,
            moreLabel: "pull requests",
            rows: prResults.map((pr) => ({ item: { type: "pr" as const, pr }, score: 0 })),
          }],
        };
      }

      if (trigger.type === "slash") {
        const bySection = new Map<string, { label: string; Icon: PhosphorIcon; accent: string; rows: Array<{ item: ChatCommandMenuItem; score: number }>; moreLabel: string }>();
        for (const { command, score } of rankedCommands) {
          const key = slashCommandSectionKey(command);
          const classification = classifySlashCommand(command);
          const sectionKey = key === "mcp" && classification.server ? `mcp:${classification.server}` : key;
          const label = key === "commands"
            ? "Commands"
            : key === "skills"
              ? "Skills"
              : classification.server ?? "MCP prompts";
          const Icon = key === "skills" ? Sparkle : key === "mcp" ? Globe : Command;
          const accent = SECTION_ACCENT[key] ?? SECTION_ACCENT.commands;
          const entry = bySection.get(sectionKey) ?? { label, Icon, accent, rows: [], moreLabel: key === "skills" ? "skills" : key === "mcp" ? "prompts" : "commands" };
          entry.rows.push({ item: { type: "command" as const, name: command.name }, score });
          bySection.set(sectionKey, entry);
        }
        const sections: RawSection[] = [...bySection.entries()].map(([key, value]) => ({ key, ...value }));
        return { sections, bestFirst: false, fixedOrder: ["commands", "skills", ...sections.filter((s) => s.key.startsWith("mcp:")).map((s) => s.key)] };
      }

      // `@`
      const sections: RawSection[] = [];
      const models = rankComposerModelMatches(modelOptions ?? [], atQuery);
      sections.push({
        key: "models",
        label: "Models",
        Icon: Sparkle,
        accent: SECTION_ACCENT.models,
        moreLabel: "models",
        rows: models.entries.map((entry) => ({ item: { type: "model" as const, model: entry.model }, score: entry.score })),
      });

      for (const kind of CHAT_MENTION_KINDS) {
        const rows = mentionResults
          .filter((mention) => mention.kind === kind)
          .map((mention) => ({ mention, match: scoreChatMentionCandidate({ title: mention.title, subtitle: mention.subtitle }, atQuery) }))
          .filter((row): row is { mention: ChatMentionSuggestion; match: { score: number; titlePrefixLength: number } } => row.match !== null)
          .sort((a, b) => compareChatMentionRanks(
            { item: a.mention, score: a.match.score, titlePrefixLength: a.match.titlePrefixLength },
            { item: b.mention, score: b.match.score, titlePrefixLength: b.match.titlePrefixLength },
          ));
        sections.push({
          key: `${kind}s`,
          label: MENTION_SECTION_LABEL[kind],
          Icon: MENTION_SECTION_ICON[kind],
          accent: SECTION_ACCENT[`${kind}s`] ?? SECTION_ACCENT.chats,
          moreLabel: MENTION_SECTION_LABEL[kind].toLowerCase(),
          rows: rows.map((row) => ({ item: { type: "mention" as const, mention: row.mention }, score: row.match.score })),
        });
      }

      sections.push({
        key: "files",
        label: "Files",
        Icon: File,
        accent: SECTION_ACCENT.files,
        moreLabel: "files",
        rows: fileResults.map((file) => {
          const fields = composerAtFileRankFields(file.path);
          const match = scoreChatMentionCandidate({ title: file.path, subtitle: fields.title }, atQuery)
            ?? { score: UNMATCHED_FILE_SCORE, titlePrefixLength: 0 };
          return { item: { type: "file" as const, path: file.path, ...(file.isDirectory ? { isDirectory: true as const } : {}) }, score: match.score };
        }).sort((a, b) => (a.score - b.score) || (a.item.type === "file" && b.item.type === "file" && a.item.path < b.item.path ? -1 : 1)),
      });

      return { sections, bestFirst: true, fixedOrder: AT_SECTION_ORDER };
    }, [trigger, rankedCommands, mentionResults, prResults, atQuery, fileResults, modelOptions]);

    const bestKey = useMemo(() => lowestScore(rawSections.sections), [rawSections]);

    const sections = useMemo((): MenuSection[] => layoutSections(rawSections.sections, {
      bestKey,
      bestFirst: rawSections.bestFirst,
      fixedOrder: rawSections.fixedOrder,
      expanded: expandedSections,
    }), [rawSections, bestKey, expandedSections]);

    const items: ChatCommandMenuItem[] = useMemo(
      () => sections.flatMap((section) => section.rows.map((row) => row.item)),
      [sections],
    );

    // ---- Reset selection when items change; collapse sections on a new query ----
    useEffect(() => {
      setSelectedIndex((prev) => (items.length ? Math.min(prev, items.length - 1) : 0));
    }, [items.length]);
    useEffect(() => {
      setSelectedIndex(0);
      setExpandedSections(new Set());
    }, [trigger?.query, trigger?.type]);

    // ---- Scroll selected item into view ----
    useEffect(() => {
      const container = listRef.current;
      if (!container) return;
      // Section headers are interleaved with rows, so index by data attribute
      // rather than by child position.
      const el = container.querySelector<HTMLElement>(`[data-menu-index="${selectedIndex}"]`);
      // jsdom (tests) has no scrollIntoView; a real browser always does.
      if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    }, [selectedIndex, sections]);

    // ---- Imperative handle for keyboard navigation ----
    const handleSelect = useCallback(
      (index: number): boolean => {
        const item = items[index];
        if (!item) return false;
        if (item.type === "more") {
          // Expand the section in place; keep the menu open so the user sees it.
          setExpandedSections((current) => {
            const next = new Set(current);
            next.add(item.sectionKey);
            return next;
          });
          return true;
        }
        onSelect(item);
        onClose();
        return true;
      },
      [items, onClose, onSelect],
    );

    useImperativeHandle(
      ref,
      () => ({
        moveUp() {
          if (!items.length) return;
          setSelectedIndex((prev) => (prev <= 0 ? items.length - 1 : prev - 1));
        },
        moveDown() {
          if (!items.length) return;
          setSelectedIndex((prev) => (prev >= items.length - 1 ? 0 : prev + 1));
        },
        selectCurrent() {
          return handleSelect(selectedIndex);
        },
      }),
      [items.length, selectedIndex, handleSelect],
    );

    // ---- Visibility ----
    // `#` is ordinary prose (`#123`, `#fff`, `# note`). Without a PR search
    // wired there is nothing to show, so the trigger must not open a popup.
    const hashUnsupported = trigger?.type === "hash" && !onPrSearch;
    const visible = trigger !== null && anchor !== null && !hashUnsupported;

    const query = trigger?.query.trim() ?? "";
    const isAtTrigger = trigger?.type === "at";
    const isHashTrigger = trigger?.type === "hash";
    const canSearchAt = Boolean(onFileSearch) || Boolean(onMentionSearch);
    const loading = fileLoading || mentionLoading || prLoading;

    // ---- Dead-query dismissal ----
    // An @ query that settles with zero rows is reported once so the owner can
    // close the menu instead of leaving it parked over the draft while the user
    // types the rest of a sentence. An empty query is a browse, not a search:
    // it can legitimately show nothing now and match once the user types.
    const reportedEmptyQueryRef = useRef<string | null>(null);
    useEffect(() => {
      // Applies to `@` and `#` alike: a query that settles with no rows is
      // reported once so the owner can close the menu instead of leaving it
      // parked over the draft while the user keeps typing a sentence.
      const dismissable = trigger
        && ((trigger.type === "at" && canSearchAt) || (trigger.type === "hash" && Boolean(onPrSearch)));
      if (!trigger || !dismissable) {
        reportedEmptyQueryRef.current = null;
        return;
      }
      if (!trigger.query.trim() || loading || items.length > 0) return;
      if (reportedEmptyQueryRef.current === trigger.query) return;
      reportedEmptyQueryRef.current = trigger.query;
      onNoMatches?.(trigger);
    }, [trigger, canSearchAt, loading, items.length, onNoMatches, onPrSearch]);

    // One empty-state message; the branches are mutually exclusive by construction.
    const emptyMessage = !trigger || loading
      ? null
      : isAtTrigger && !canSearchAt
        ? "Search unavailable for this session"
        : !query.length
          ? (isAtTrigger
              // Empty @ is a real browse now; an empty result means the
              // workspace genuinely had nothing to list, not "type first".
              ? (items.length === 0
                  ? (onMentionSearch
                      ? "No files, chats, lanes, or terminals to browse — type to search"
                      : "No files to browse — type to search")
                  : null)
              : isHashTrigger
                ? (items.length === 0 ? "No pull requests to browse — type to search" : null)
                : "Type to search commands")
          : items.length === 0
            ? (isAtTrigger
                ? `No matches for "${query}"`
                : isHashTrigger
                  ? `No pull requests match "${query}"`
                  : `No commands match "${query}"`)
            : null;
    const menuStyle = anchor ? getViewportMenuStyle(anchor) : undefined;

    const menu = (
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="ade-chat-drawer-glass ade-chat-drawer-solid fixed z-[1000] flex flex-col overflow-hidden"
            style={menuStyle}
          >
            {/* Header hint */}
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-3.5 py-2.5">
              {trigger!.type === "at" ? (
                <>
                  <MagnifyingGlass size={12} weight="bold" className="text-violet-400/60" />
                  <span className="text-[10px] font-medium tracking-wide text-fg/46">
                    {onMentionSearch ? "Models, chats, lanes, files, terminals" : "File search"}
                  </span>
                </>
              ) : isHashTrigger ? (
                <>
                  <MagnifyingGlass size={12} weight="bold" className="text-violet-400/60" />
                  <span className="text-[10px] font-medium tracking-wide text-fg/46">Pull requests</span>
                </>
              ) : (
                <>
                  <Command size={12} weight="bold" className="text-violet-400/60" />
                  <span className="text-[10px] font-medium tracking-wide text-fg/46">Commands, skills, MCP prompts</span>
                </>
              )}
            </div>

            {/* Results list */}
            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
              {/* Loading state — only when there is nothing cached to show */}
              {loading && (trigger!.type === "at" || trigger!.type === "hash") && items.length === 0 && (
                <div className="flex items-center gap-2 px-3 py-2">
                  <SpinnerGap size={12} weight="bold" className="animate-spin text-violet-400/50" />
                  <span className="text-[11px] text-fg/30">Searching...</span>
                </div>
              )}

              {/* Empty state */}
              {emptyMessage && <div className="px-3 py-2 text-[11px] text-fg/30">{emptyMessage}</div>}

              {/* Sections. Row indices come precomputed from the memo above. */}
              {sections.map((section) => (
                <div key={section.key}>
                  <div className="flex items-center gap-1.5 px-3.5 pb-1 pt-2">
                    <section.Icon size={10} weight="bold" className={section.accent} />
                    <span className={cn("text-[9px] font-semibold uppercase tracking-[0.08em]", section.accent)}>
                      {section.label}
                    </span>
                  </div>
                  {section.rows.map(({ item, index }) => {
                    const isSelected = index === selectedIndex;
                    const iconClass = cn("shrink-0", isSelected ? "text-violet-400/80" : "text-fg/30");
                    const labelClass = isSelected ? "text-violet-200/90 font-medium" : "text-fg/70";

                    if (item.type === "more") {
                      return (
                        <MenuRow
                          key={`more:${item.sectionKey}`}
                          index={index}
                          selected={isSelected}
                          onHover={setSelectedIndex}
                          onSelect={handleSelect}
                        >
                          <Plus size={12} weight="bold" className={iconClass} />
                          <span className="truncate text-fg/50">
                            + {item.count} more {item.label}
                          </span>
                          <span className="ml-auto shrink-0 text-[10px] text-fg/30">Tab to expand</span>
                        </MenuRow>
                      );
                    }

                    if (item.type === "file") {
                      const { dir, base } = splitPath(item.path);
                      return (
                        <MenuRow
                          key={item.path}
                          index={index}
                          selected={isSelected}
                          onHover={setSelectedIndex}
                          onSelect={handleSelect}
                        >
                          <File size={13} weight="duotone" className={iconClass} />
                          <span className="truncate">
                            {dir && <span className="text-fg/30">{dir}</span>}
                            <span className={labelClass}>{base}</span>
                          </span>
                        </MenuRow>
                      );
                    }

                    if (item.type === "pr") {
                      const stateDot = prStateTone(item.pr.state).dot;
                      return (
                        <MenuRow
                          key={`pr:${item.pr.repo ?? ""}#${item.pr.number}`}
                          index={index}
                          selected={isSelected}
                          onHover={setSelectedIndex}
                          onSelect={handleSelect}
                        >
                          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", stateDot)} aria-hidden />
                          <span className={cn("shrink-0 font-medium", labelClass)}>#{item.pr.number}</span>
                          <span className="truncate text-fg/60">{item.pr.title}</span>
                          {item.pr.repo ? (
                            <span className="ml-auto max-w-[40%] shrink-0 truncate text-fg/34">{item.pr.repo}</span>
                          ) : null}
                        </MenuRow>
                      );
                    }

                    if (item.type === "model") {
                      return (
                        <MenuRow
                          key={`model:${item.model.modelId}`}
                          index={index}
                          selected={isSelected}
                          onHover={setSelectedIndex}
                          onSelect={handleSelect}
                        >
                          <ModelRowLogo
                            modelFamily={item.model.modelFamily ?? ""}
                            cliCommand={item.model.cliCommand}
                            modelId={item.model.modelId}
                            providerModelId={item.model.providerModelId}
                            openCodeProviderId={item.model.openCodeProviderId}
                            size={13}
                          />
                          <span className={cn("truncate", labelClass)}>{item.model.title}</span>
                          <span className="ml-auto flex shrink-0 items-center gap-1">
                            {item.model.provider ? <ProviderLogo family={item.model.provider} size={11} /> : null}
                            {item.model.routeKey ? <ProviderLogo family={item.model.routeKey} size={11} /> : null}
                          </span>
                        </MenuRow>
                      );
                    }

                    if (item.type === "mention") {
                      const MentionIcon = MENTION_SECTION_ICON[item.mention.kind];
                      return (
                        <MenuRow
                          key={`${item.mention.kind}:${item.mention.id}`}
                          index={index}
                          selected={isSelected}
                          onHover={setSelectedIndex}
                          onSelect={handleSelect}
                        >
                          <MentionIcon size={13} weight="duotone" className={iconClass} />
                          <span className={cn("truncate", labelClass)}>{item.mention.title}</span>
                          {item.mention.subtitle ? (
                            <span className="ml-auto max-w-[45%] shrink-0 truncate text-fg/34">
                              {item.mention.subtitle}
                            </span>
                          ) : null}
                        </MenuRow>
                      );
                    }

                    const command = commandMap.get(item.name);
                    const classification = command ? classifySlashCommand(command) : null;
                    const sourceMark = classification?.kind === "mcp"
                      ? (classification.server ? <ProviderLogo family={classification.server} size={11} /> : <Globe size={11} weight="duotone" className={iconClass} />)
                      : classification?.kind === "skill"
                        ? <Sparkle size={12} weight="duotone" className={iconClass} />
                        : <Command size={13} weight="duotone" className={iconClass} />;
                    const sourceLabel = classification?.kind === "mcp"
                      ? classification.server ?? "mcp"
                      : classification?.kind === "skill"
                        ? classification.origin
                        : classification?.origin === "provider" ? "provider" : null;
                    return (
                      <MenuRow
                        key={item.name}
                        index={index}
                        selected={isSelected}
                        onHover={setSelectedIndex}
                        onSelect={handleSelect}
                      >
                        {sourceMark}
                        <span className={cn(
                          "w-[180px] max-w-[44%] shrink-0 truncate whitespace-nowrap",
                          labelClass,
                        )}>/{item.name}</span>
                        {command?.argumentHint ? (
                          <span className="shrink-0 text-fg/32">{command.argumentHint}</span>
                        ) : null}
                        {command?.description && (
                          <span className="ml-auto truncate text-fg/40">{command.description}</span>
                        )}
                        {sourceLabel ? (
                          <span className="ml-auto shrink-0 rounded-sm bg-white/[0.05] px-1 py-px text-[9px] text-fg/40">
                            {sourceLabel}
                          </span>
                        ) : null}
                      </MenuRow>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Key hints */}
            <div className="border-t border-white/[0.06] px-3.5 py-1.5 text-[10px] text-fg/32">
              ↑↓ move · Tab insert · Esc close
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );

    return typeof document === "undefined" ? menu : createPortal(menu, document.body);
  },
);

ChatCommandMenu.displayName = "ChatCommandMenu";

// ---------------------------------------------------------------------------
// Keyboard helper
// ---------------------------------------------------------------------------

/**
 * Forwards relevant keyboard events to the command menu.
 * Returns `true` if the event was consumed and should not propagate.
 */
export function handleCommandMenuKeyDown(
  e: React.KeyboardEvent,
  menuRef: React.RefObject<ChatCommandMenuHandle | null>,
  onClose?: () => void,
): boolean {
  const handle = menuRef.current;
  if (!handle) return false;

  switch (e.key) {
    case "ArrowUp": {
      e.preventDefault();
      handle.moveUp();
      return true;
    }
    case "ArrowDown": {
      e.preventDefault();
      handle.moveDown();
      return true;
    }
    case "Enter":
    case "Tab": {
      // No matching row: report unhandled so Enter/Tab keep their normal
      // send/focus behavior instead of becoming a dead key.
      if (!handle.selectCurrent()) return false;
      e.preventDefault();
      return true;
    }
    case "Escape": {
      e.preventDefault();
      onClose?.();
      return true;
    }
    default:
      return false;
  }
}
