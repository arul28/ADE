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
  MagnifyingGlass,
  SpinnerGap,
  Terminal as TerminalIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import type { ComposerTrigger } from "../../../shared/composerTriggers";
import { CHAT_MENTION_KINDS, CHAT_MENTION_MAX_PER_KIND } from "../../../shared/chatMentions";
import type { ChatMentionKind, ChatMentionSuggestion } from "../../../shared/types/chatMentions";
import { cn } from "../ui/cn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatCommandMenuItem =
  | { type: "file"; path: string }
  | { type: "command"; name: string }
  | { type: "mention"; mention: ChatMentionSuggestion };

export type ChatCommandMenuHandle = {
  moveUp(): void;
  moveDown(): void;
  /** Returns true when a row was actually selected (the menu had a match). */
  selectCurrent(): boolean;
};

type ChatCommandMenuProps = {
  /** The current trigger character and query. */
  trigger: ComposerTrigger | null;
  /** Available slash commands. */
  slashCommands: Array<{ name: string; description: string; argumentHint?: string; source?: "sdk" | "local" }>;
  /** File search callback. When omitted, @ file suggestions are unavailable. */
  onFileSearch?: (query: string) => Promise<Array<{ path: string }>>;
  /**
   * Entity mention search (chats / lanes / terminals in the active project).
   * When omitted the @ menu shows files only.
   */
  onMentionSearch?: (query: string) => Promise<ChatMentionSuggestion[]>;
  /** Anchor position in viewport coordinates. */
  anchor: { top: number; left: number; bottom?: number } | null;
  /** Called when user selects an item. */
  onSelect: (item: ChatCommandMenuItem) => void;
  /** Called when menu should close. */
  onClose: () => void;
};

type FileResult = { path: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple fuzzy match: every character of `query` appears in `target` in order. */
function fuzzyMatch(target: string, query: string): boolean {
  if (!query) return true;
  const lTarget = target.toLowerCase();
  const lQuery = query.toLowerCase();
  let ti = 0;
  for (let qi = 0; qi < lQuery.length; qi++) {
    const idx = lTarget.indexOf(lQuery[qi], ti);
    if (idx === -1) return false;
    ti = idx + 1;
  }
  return true;
}

/** Split a file path into dirname and basename for display. */
function splitPath(filePath: string): { dir: string; base: string } {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return { dir: "", base: filePath };
  return { dir: filePath.slice(0, lastSlash + 1), base: filePath.slice(lastSlash + 1) };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const MAX_FILE_RESULTS = 8;
const MAX_COMMAND_RESULTS = 10;
const MENU_WIDTH = 420;
const MENU_HEIGHT = 328;
const VIEWPORT_GUTTER = 8;
const MENU_GAP = 8;
const DEBOUNCE_MS = 40;
const QUERY_CACHE_MAX = 40;

// ---------------------------------------------------------------------------
// Async suggestion source (short debounce, provider-scoped cache, stale guard)
// ---------------------------------------------------------------------------

type SuggestionSource<T> = ((query: string) => Promise<T[]>) | undefined;
type SuggestionState<T> = { search: SuggestionSource<T>; results: T[] };

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
  const [state, setState] = useState<SuggestionState<T>>({ search: undefined, results: [] });
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
      setState({ search, results: [] });
      setLoading(false);
      return;
    }

    // Cached queries belong to one provider; a provider change drops them all.
    if (cacheRef.current.search !== search) {
      cacheRef.current = { search, map: new Map() };
    }
    const cached = cacheRef.current.map.get(query);
    if (cached) {
      setState({ search, results: cached.slice(0, max) });
      setLoading(false);
    } else {
      setState({ search, results: [] });
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
        setState({ search, results: results.slice(0, max) });
      } catch {
        if (seqRef.current === seq && !cached) setState({ search, results: [] });
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    }, cached ? 0 : DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [enabled, query, search, max, cacheKey]);

  // Results produced by a previous provider are discarded rather than shown.
  return { results: state.search === search ? state.results : [], loading };
}


const MENTION_SECTION_LABEL: Record<ChatMentionKind, string> = {
  chat: "Chats",
  lane: "Lanes",
  terminal: "Terminals",
};

const MENTION_SECTION_ICON: Record<ChatMentionKind, PhosphorIcon> = {
  chat: ChatCircleDots,
  lane: GitBranch,
  terminal: TerminalIcon,
};

/** One row, with its flat keyboard index already resolved by the sections memo. */
type MenuRowEntry = { item: ChatCommandMenuItem; index: number };

type MenuSection = {
  key: string;
  label: string;
  Icon: PhosphorIcon;
  rows: MenuRowEntry[];
};

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
        "ade-chat-drawer-row mx-1 flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-[11px]",
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
  const viewportHeight = typeof window === "undefined" ? MENU_HEIGHT + VIEWPORT_GUTTER * 2 : window.innerHeight;
  const width = Math.max(260, Math.min(MENU_WIDTH, viewportWidth - VIEWPORT_GUTTER * 2));
  const maxLeft = Math.max(VIEWPORT_GUTTER, viewportWidth - width - VIEWPORT_GUTTER);
  const left = Math.min(Math.max(VIEWPORT_GUTTER, anchor.left), maxLeft);
  const anchorBottom = typeof anchor.bottom === "number" ? anchor.bottom : anchor.top;
  const roomAbove = Math.max(0, anchor.top - VIEWPORT_GUTTER);
  const roomBelow = Math.max(0, viewportHeight - anchorBottom - VIEWPORT_GUTTER);

  if (roomAbove >= MENU_HEIGHT || roomAbove >= roomBelow) {
    return {
      left,
      width,
      bottom: Math.max(VIEWPORT_GUTTER, viewportHeight - anchor.top + MENU_GAP),
      maxHeight: Math.max(160, Math.min(MENU_HEIGHT, roomAbove - MENU_GAP)),
    };
  }

  return {
    left,
    width,
    top: Math.min(viewportHeight - VIEWPORT_GUTTER, anchorBottom + MENU_GAP),
    maxHeight: Math.max(160, Math.min(MENU_HEIGHT, roomBelow - MENU_GAP)),
  };
}

export const ChatCommandMenu = forwardRef<ChatCommandMenuHandle, ChatCommandMenuProps>(
  function ChatCommandMenu(
    { trigger, slashCommands, onFileSearch, onMentionSearch, anchor, onSelect, onClose },
    ref,
  ) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const listRef = useRef<HTMLDivElement | null>(null);

    const triggerType = trigger?.type ?? null;
    const triggerQuery = trigger?.query ?? "";

    // ---- Slash command filtering ----
    const filteredCommands = useMemo(() => {
      if (!trigger || trigger.type !== "slash") return [];
      return slashCommands
        .filter((cmd) => fuzzyMatch(cmd.name, trigger.query))
        .slice(0, MAX_COMMAND_RESULTS);
    }, [trigger, slashCommands]);

    // ---- @ sources: files + entity mentions, each independently debounced ----
    const atQuery = triggerType === "at" ? triggerQuery.trim() : "";
    const atActive = triggerType === "at";

    // `triggerType` is null while the menu is closed, which drops both caches.
    const { results: fileResults, loading: fileLoading } = useDebouncedSuggestions<FileResult>(
      atActive,
      atQuery,
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

    // ---- Derive display sections (flat item list drives keyboard nav) ----
    // Flat keyboard indices are assigned here, once, rather than by a mutable
    // counter threaded through the render tree.
    const sections = useMemo((): MenuSection[] => {
      if (!trigger) return [];
      let nextIndex = 0;
      const withIndices = (entries: ChatCommandMenuItem[]): MenuRowEntry[] =>
        entries.map((item) => ({ item, index: nextIndex++ }));

      if (trigger.type !== "at") {
        return [
          {
            key: "commands",
            label: "Slash commands",
            Icon: Command,
            rows: withIndices(
              filteredCommands.map((c) => ({ type: "command" as const, name: c.name })),
            ),
          },
        ];
      }
      const out: MenuSection[] = [];
      if (fileResults.length) {
        out.push({
          key: "files",
          label: "Files",
          Icon: File,
          rows: withIndices(fileResults.map((r) => ({ type: "file" as const, path: r.path }))),
        });
      }
      for (const kind of CHAT_MENTION_KINDS) {
        const mentions = mentionResults
          .filter((entry) => entry.kind === kind)
          .slice(0, CHAT_MENTION_MAX_PER_KIND);
        if (!mentions.length) continue;
        out.push({
          key: kind,
          label: MENTION_SECTION_LABEL[kind],
          Icon: MENTION_SECTION_ICON[kind],
          rows: withIndices(mentions.map((mention) => ({ type: "mention" as const, mention }))),
        });
      }
      return out;
    }, [trigger, filteredCommands, fileResults, mentionResults]);

    const items: ChatCommandMenuItem[] = useMemo(
      () => sections.flatMap((section) => section.rows.map((row) => row.item)),
      [sections],
    );

    // ---- Reset selection when items change ----
    useEffect(() => {
      setSelectedIndex(0);
    }, [items.length, trigger?.query]);

    // ---- Scroll selected item into view ----
    useEffect(() => {
      const container = listRef.current;
      if (!container) return;
      // Section headers are interleaved with rows, so index by data attribute
      // rather than by child position.
      const el = container.querySelector<HTMLElement>(`[data-menu-index="${selectedIndex}"]`);
      el?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    // ---- Imperative handle for keyboard navigation ----
    const handleSelect = useCallback(
      (index: number): boolean => {
        const item = items[index];
        if (!item) return false;
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
    const visible = trigger !== null && anchor !== null;

    // ---- Description lookup for commands ----
    const commandMap = useMemo(() => {
      const map = new Map<string, { description: string; argumentHint?: string; source?: "sdk" | "local" }>();
      for (const cmd of slashCommands) {
        map.set(cmd.name, {
          description: cmd.description,
          argumentHint: cmd.argumentHint,
          source: cmd.source,
        });
      }
      return map;
    }, [slashCommands]);

    const query = trigger?.query.trim() ?? "";
    const isAtTrigger = trigger?.type === "at";
    const canSearchAt = Boolean(onFileSearch) || Boolean(onMentionSearch);
    const loading = fileLoading || mentionLoading;
    // One empty-state message; the branches are mutually exclusive by construction.
    const emptyMessage = !trigger || loading
      ? null
      : isAtTrigger && !canSearchAt
        ? "Search unavailable for this session"
        : !query.length
          ? (isAtTrigger ? (items.length === 0 ? "Type to search files" : null) : "Type to search commands")
          : items.length === 0
            ? (isAtTrigger ? `No matches for "${query}"` : `No commands match "${query}"`)
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
            className="ade-chat-drawer-glass fixed z-[1000] overflow-hidden"
            style={menuStyle}
          >
            {/* Header hint */}
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-3.5 py-2.5">
              {trigger!.type === "at" ? (
                <>
                  <MagnifyingGlass size={12} weight="bold" className="text-violet-400/60" />
                  <span className="text-[10px] font-medium tracking-wide text-fg/46">
                    {onMentionSearch ? "Files, chats, lanes & terminals" : "File search"}
                  </span>
                </>
              ) : (
                <>
                  <Command size={12} weight="bold" className="text-violet-400/60" />
                  <span className="text-[10px] font-medium tracking-wide text-fg/46">Slash commands</span>
                </>
              )}
            </div>

            {/* Results list */}
            <div ref={listRef} className="max-h-[280px] overflow-y-auto py-1">
              {/* Loading state — only when there is nothing cached to show */}
              {loading && trigger!.type === "at" && items.length === 0 && (
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
                  {/* Section headers are noise when the menu is one section. */}
                  {sections.length > 1 && (
                    <div className="flex items-center gap-1.5 px-3.5 pb-1 pt-2">
                      <section.Icon size={10} weight="bold" className="text-fg/28" />
                      <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-fg/32">
                        {section.label}
                      </span>
                    </div>
                  )}
                  {section.rows.map(({ item, index }) => {
                    const isSelected = index === selectedIndex;
                    const iconClass = cn("shrink-0", isSelected ? "text-violet-400/80" : "text-fg/30");
                    const labelClass = isSelected ? "text-violet-200/90 font-medium" : "text-fg/70";

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

                    if (item.type === "mention") {
                      // The section already resolved the per-kind icon.
                      const MentionIcon = section.Icon;
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
                    const description = command?.description ?? "";
                    return (
                      <MenuRow
                        key={item.name}
                        index={index}
                        selected={isSelected}
                        onHover={setSelectedIndex}
                        onSelect={handleSelect}
                      >
                        <Command size={13} weight="duotone" className={iconClass} />
                        <span className={cn(
                          "w-[220px] max-w-[56%] shrink-0 truncate whitespace-nowrap",
                          labelClass,
                        )}>/{item.name}</span>
                        {command?.argumentHint ? (
                          <span className="shrink-0 text-fg/32">{command.argumentHint}</span>
                        ) : null}
                        {description && (
                          <span className="ml-auto truncate text-fg/40">{description}</span>
                        )}
                      </MenuRow>
                    );
                  })}
                </div>
              ))}
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
