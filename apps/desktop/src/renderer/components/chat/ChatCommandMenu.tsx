import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import { Command, File, MagnifyingGlass, SpinnerGap } from "@phosphor-icons/react";
import { cn } from "../ui/cn";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChatCommandMenuItem =
  | { type: "file"; path: string }
  | { type: "command"; name: string };

export type ChatCommandMenuHandle = {
  moveUp(): void;
  moveDown(): void;
  selectCurrent(): void;
};

type ChatCommandMenuProps = {
  /** The current trigger character and query. */
  trigger: { type: "at" | "slash"; query: string; cursorIndex: number } | null;
  /** Available slash commands. */
  slashCommands: Array<{ name: string; description: string }>;
  /** Session ID for file search. */
  sessionId: string | null;
  /** Anchor position: { top, left } relative to the container. */
  anchor: { top: number; left: number } | null;
  /** Called when user selects an item. */
  onSelect: (item: ChatCommandMenuItem) => void;
  /** Called when menu should close. */
  onClose: () => void;
};

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
const DEBOUNCE_MS = 300;

export const ChatCommandMenu = forwardRef<ChatCommandMenuHandle, ChatCommandMenuProps>(
  function ChatCommandMenu({ trigger, slashCommands, sessionId, anchor, onSelect, onClose }, ref) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [fileResults, setFileResults] = useState<Array<{ path: string }>>([]);
    const [fileLoading, setFileLoading] = useState(false);
    const listRef = useRef<HTMLDivElement | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ---- Slash command filtering ----
    const filteredCommands = useMemo(() => {
      if (!trigger || trigger.type !== "slash") return [];
      return slashCommands
        .filter((cmd) => fuzzyMatch(cmd.name, trigger.query))
        .slice(0, MAX_COMMAND_RESULTS);
    }, [trigger, slashCommands]);

    // ---- File search with debounce ----
    useEffect(() => {
      if (!trigger || trigger.type !== "at") {
        setFileResults([]);
        setFileLoading(false);
        return;
      }

      const query = trigger.query;
      if (!sessionId || !query.trim()) {
        setFileResults([]);
        setFileLoading(false);
        return;
      }

      setFileLoading(true);

      if (debounceRef.current) clearTimeout(debounceRef.current);

      debounceRef.current = setTimeout(async () => {
        try {
          const results = await window.ade.agentChat.fileSearch({
            sessionId,
            query: query.trim(),
          });
          setFileResults(results.slice(0, MAX_FILE_RESULTS));
        } catch {
          setFileResults([]);
        } finally {
          setFileLoading(false);
        }
      }, DEBOUNCE_MS);

      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }, [trigger, sessionId]);

    // ---- Derive display items ----
    const items: ChatCommandMenuItem[] = useMemo(() => {
      if (!trigger) return [];
      if (trigger.type === "at") {
        return fileResults.map((r) => ({ type: "file" as const, path: r.path }));
      }
      return filteredCommands.map((c) => ({ type: "command" as const, name: c.name }));
    }, [trigger, fileResults, filteredCommands]);

    // ---- Reset selection when items change ----
    useEffect(() => {
      setSelectedIndex(0);
    }, [items.length, trigger?.query]);

    // ---- Scroll selected item into view ----
    useEffect(() => {
      const container = listRef.current;
      if (!container) return;
      const el = container.children[selectedIndex] as HTMLElement | undefined;
      el?.scrollIntoView({ block: "nearest" });
    }, [selectedIndex]);

    // ---- Imperative handle for keyboard navigation ----
    const handleSelect = useCallback(
      (index: number) => {
        const item = items[index];
        if (!item) return;
        onSelect(item);
        onClose();
      },
      [items, onClose, onSelect],
    );

    useImperativeHandle(
      ref,
      () => ({
        moveUp() {
          setSelectedIndex((prev) => (prev <= 0 ? items.length - 1 : prev - 1));
        },
        moveDown() {
          setSelectedIndex((prev) => (prev >= items.length - 1 ? 0 : prev + 1));
        },
        selectCurrent() {
          handleSelect(selectedIndex);
        },
      }),
      [items.length, selectedIndex, handleSelect],
    );

    // ---- Visibility ----
    const visible = trigger !== null && anchor !== null;

    // ---- Description lookup for commands ----
    const descriptionMap = useMemo(() => {
      const map = new Map<string, string>();
      for (const cmd of slashCommands) {
        map.set(cmd.name, cmd.description);
      }
      return map;
    }, [slashCommands]);

    const query = trigger?.query.trim() ?? "";
    const isAtTrigger = trigger?.type === "at";
    const isUnavailable = isAtTrigger && !sessionId;
    const isIdle = Boolean(trigger) && !query.length && !isUnavailable;
    const isNoResults = Boolean(query.length) && !fileLoading && items.length === 0 && (!isAtTrigger || Boolean(sessionId));

    return (
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="ade-chat-drawer-glass absolute z-50 min-w-[300px] max-w-[340px] overflow-hidden"
            style={{ top: anchor!.top, left: anchor!.left, marginTop: "-8px" }}
          >
            {/* Header hint */}
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-3.5 py-2.5">
              {trigger!.type === "at" ? (
                <>
                  <MagnifyingGlass size={12} weight="bold" className="text-violet-400/60" />
                  <span className="text-[10px] font-medium tracking-wide text-fg/46">File search</span>
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
              {/* Loading state */}
              {fileLoading && trigger!.type === "at" && (
                <div className="flex items-center gap-2 px-3 py-2">
                  <SpinnerGap size={12} weight="bold" className="animate-spin text-violet-400/50" />
                  <span className="text-[11px] text-fg/30">Searching...</span>
                </div>
              )}

              {/* Empty state */}
              {!fileLoading && isIdle && (
                <div className="px-3 py-2 text-[11px] text-fg/30">
                  {isAtTrigger ? "Type to search files" : "Type to search commands"}
                </div>
              )}
              {!fileLoading && isUnavailable && (
                <div className="px-3 py-2 text-[11px] text-fg/30">File search unavailable for this session</div>
              )}
              {!fileLoading && isNoResults && (
                <div className="px-3 py-2 text-[11px] text-fg/30">
                  {isAtTrigger ? `No matches for "${query}"` : `No commands match "${query}"`}
                </div>
              )}

              {/* Items */}
              {items.map((item, i) => {
                const isSelected = i === selectedIndex;

                if (item.type === "file") {
                  const { dir, base } = splitPath(item.path);
                  return (
                    <div
                      key={item.path}
                      data-active={isSelected}
                      className={cn(
                        "ade-chat-drawer-row mx-1 flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-[11px]",
                        isSelected ? "text-fg/88" : "text-fg/58",
                      )}
                      onMouseEnter={() => setSelectedIndex(i)}
                      onClick={() => handleSelect(i)}
                    >
                      <File size={13} weight="duotone" className={cn("shrink-0", isSelected ? "text-violet-400/80" : "text-fg/30")} />
                      <span className="truncate">
                        {dir && <span className="text-fg/30">{dir}</span>}
                        <span className={cn(isSelected ? "text-violet-200/90 font-medium" : "text-fg/70")}>{base}</span>
                      </span>
                    </div>
                  );
                }

                const description = descriptionMap.get(item.name) ?? "";
                return (
                  <div
                    key={item.name}
                    data-active={isSelected}
                    className={cn(
                      "ade-chat-drawer-row mx-1 flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-[11px]",
                      isSelected ? "text-fg/88" : "text-fg/58",
                    )}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => handleSelect(i)}
                  >
                    <Command size={13} weight="duotone" className={cn("shrink-0", isSelected ? "text-violet-400/80" : "text-fg/30")} />
                    <span className={cn(isSelected ? "text-violet-200/90 font-medium" : "text-fg/70")}>/{item.name}</span>
                    {description && (
                      <span className="ml-auto truncate text-fg/40">{description}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    );
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
      e.preventDefault();
      handle.selectCurrent();
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
