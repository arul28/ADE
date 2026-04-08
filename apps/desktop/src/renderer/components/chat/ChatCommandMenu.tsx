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
import { Command, File, FolderOpen, MagnifyingGlass, SpinnerGap } from "@phosphor-icons/react";
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
        if (item) onSelect(item);
      },
      [items, onSelect],
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

    return (
      <AnimatePresence>
        {visible && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="absolute z-50 min-w-[280px] overflow-hidden rounded-xl border border-white/[0.08] bg-card/98 shadow-float backdrop-blur-xl"
            style={{ top: anchor!.top, left: anchor!.left }}
          >
            {/* Header hint */}
            <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-3 py-1.5">
              {trigger!.type === "at" ? (
                <>
                  <MagnifyingGlass size={11} weight="bold" className="text-fg/30" />
                  <span className="text-[10px] font-mono text-fg/30">File search</span>
                </>
              ) : (
                <>
                  <Command size={11} weight="bold" className="text-fg/30" />
                  <span className="text-[10px] font-mono text-fg/30">Commands</span>
                </>
              )}
            </div>

            {/* Results list */}
            <div ref={listRef} className="max-h-[280px] overflow-y-auto py-1">
              {/* Loading state */}
              {fileLoading && trigger!.type === "at" && (
                <div className="flex items-center gap-2 px-3 py-2">
                  <SpinnerGap size={12} weight="bold" className="animate-spin text-fg/30" />
                  <span className="text-[11px] font-mono text-fg/30">Searching...</span>
                </div>
              )}

              {/* Empty state */}
              {!fileLoading && items.length === 0 && (
                <div className="px-3 py-2 text-[11px] font-mono text-fg/30">No matches</div>
              )}

              {/* Items */}
              {items.map((item, i) => {
                const isSelected = i === selectedIndex;

                if (item.type === "file") {
                  const { dir, base } = splitPath(item.path);
                  return (
                    <div
                      key={item.path}
                      className={cn(
                        "mx-1 flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] font-mono transition-colors",
                        isSelected ? "rounded-lg bg-white/[0.06]" : "rounded-lg",
                      )}
                      onMouseEnter={() => setSelectedIndex(i)}
                      onClick={() => handleSelect(i)}
                    >
                      <File size={13} weight="duotone" className="shrink-0 text-fg/40" />
                      <span className="truncate">
                        {dir && <span className="text-fg/30">{dir}</span>}
                        <span className="text-fg/70">{base}</span>
                      </span>
                    </div>
                  );
                }

                const description = descriptionMap.get(item.name) ?? "";
                return (
                  <div
                    key={item.name}
                    className={cn(
                      "mx-1 flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[11px] font-mono transition-colors",
                      isSelected ? "rounded-lg bg-white/[0.06]" : "rounded-lg",
                    )}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => handleSelect(i)}
                  >
                    <FolderOpen size={13} weight="duotone" className="shrink-0 text-fg/40" />
                    <span className="text-fg/80">/{item.name}</span>
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
      return true;
    }
    default:
      return false;
  }
}
