import { useEffect, useMemo, useRef, useState } from "react";
import { ClockCounterClockwise, MagnifyingGlass, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { isMacPlatform } from "../../lib/platform";
import { isPromptSearchShortcut, type AgentChatPromptHistoryEntry } from "./chatPromptHistory";

const MAX_RESULTS = 60;

/** Newest first; every word of the query must appear, in any order and case. */
function matchPrompts(
  entries: readonly AgentChatPromptHistoryEntry[],
  query: string,
): Array<{ entry: AgentChatPromptHistoryEntry; index: number }> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches: Array<{ entry: AgentChatPromptHistoryEntry; index: number }> = [];
  for (let index = entries.length - 1; index >= 0 && matches.length < MAX_RESULTS; index -= 1) {
    const entry = entries[index]!;
    const haystack = entry.text.toLowerCase();
    if (words.every((word) => haystack.includes(word))) matches.push({ entry, index });
  }
  return matches;
}

/**
 * Ctrl+R in the composer: search every prompt ↑ can reach (this chat's, then
 * the rest of this computer's). Enter puts the pick in the composer the way
 * ↑ would, so ↓ still brings back what was there before.
 */
export function PromptHistorySearch({
  entries,
  onPick,
  onClose,
}: {
  entries: readonly AgentChatPromptHistoryEntry[];
  onPick: (entry: AgentChatPromptHistoryEntry, index: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => matchPrompts(entries, query), [entries, query]);

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-prompt-search-index="${highlighted}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const pick = (position: number) => {
    const match = matches[position];
    if (match) onPick(match.entry, match.index);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const older = event.key === "ArrowDown" || isPromptSearchShortcut(event, isMacPlatform());
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (older) {
      // The shortcut again steps to the next older match, as in a shell.
      event.preventDefault();
      setHighlighted((value) => Math.min(value + 1, Math.max(matches.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlighted((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(highlighted);
    }
  };

  return (
    <div className="mx-2 my-1.5 flex flex-col overflow-hidden rounded-lg border border-[color:var(--chat-panel-border)] bg-black/15" data-prompt-history-search="">
      <div className="flex items-center gap-2 border-b border-[color:var(--chat-panel-border)] px-2.5 py-1.5">
        <MagnifyingGlass size={13} className="shrink-0 text-muted-fg/55" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            // Clicking a result moves focus into the list first; anything else closes.
            if (!event.currentTarget.closest("[data-prompt-history-search]")?.contains(event.relatedTarget as Node | null)) onClose();
          }}
          placeholder="Search your prompts"
          aria-label="Search prompt history"
          aria-controls="prompt-history-search-results"
          aria-activedescendant={matches.length ? `prompt-history-search-${highlighted}` : undefined}
          className="min-w-0 flex-1 border-0 bg-transparent p-0 font-sans shadow-none outline-none ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none text-[length:calc(var(--chat-font-size)*12/14)] text-fg/90 placeholder:text-muted-fg/45"
          spellCheck={false}
        />
        <span className="shrink-0 font-sans text-[10px] text-muted-fg/45">Enter to use · Esc to close</span>
        <button
          type="button"
          aria-label="Close prompt search"
          className="shrink-0 rounded p-0.5 text-muted-fg/50 transition-colors hover:text-fg/85"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClose}
        >
          <X size={11} weight="bold" />
        </button>
      </div>
      <div
        ref={listRef}
        id="prompt-history-search-results"
        role="listbox"
        aria-label="Matching prompts"
        className="max-h-56 overflow-y-auto p-1"
      >
        {matches.length ? matches.map(({ entry, index }, position) => (
          <div
            key={entry.eventKey}
            id={`prompt-history-search-${position}`}
            role="option"
            aria-selected={position === highlighted}
            data-prompt-search-index={position}
            tabIndex={-1}
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setHighlighted(position)}
            onClick={() => onPick(entry, index)}
            className={cn(
              "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*12/14)]",
              position === highlighted ? "bg-fg/[0.07] text-fg/90" : "text-fg/70",
            )}
          >
            <ClockCounterClockwise size={12} className="mt-[3px] shrink-0 text-muted-fg/45" aria-hidden />
            <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words">{entry.text}</span>
            <span className="shrink-0 pt-px text-[10px] text-muted-fg/45">{entry.fromOtherChat ? "Other chat" : "This chat"}</span>
          </div>
        )) : (
          <div className="px-2 py-3 text-center font-sans text-[11px] text-muted-fg/55">
            {entries.length ? "No prompt matches." : "Prompts you send show up here."}
          </div>
        )}
      </div>
    </div>
  );
}
