import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "../ui/cn";
import { useAppStore } from "../../state/appStore";
import type { ChatUserMinimapDisplayEntry } from "./chatUserMinimap.logic";

const HOVER_OPEN_MS = 60;
const HOVER_CLOSE_MS = 150;

type ChatUserMinimapProps = {
  displayEntries: ChatUserMinimapDisplayEntry[];
  activeDisplayIndex: number | null;
  onJumpToRow: (rowIndex: number) => void;
  placement?: "inside" | "outsideRight";
};

export function ChatUserMinimap({
  displayEntries,
  activeDisplayIndex,
  onJumpToRow,
  placement = "inside",
}: ChatUserMinimapProps) {
  const chatUserMinimapEnabled = useAppStore((s) => s.chatUserMinimapEnabled);
  const [menuOpen, setMenuOpen] = useState(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current != null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current != null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => {
    clearOpenTimer();
    clearCloseTimer();
  }, [clearCloseTimer, clearOpenTimer]);

  const handlePointerEnter = useCallback(() => {
    clearCloseTimer();
    clearOpenTimer();
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setMenuOpen(true);
    }, HOVER_OPEN_MS);
  }, [clearCloseTimer, clearOpenTimer]);

  const handlePointerLeave = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setMenuOpen(false);
    }, HOVER_CLOSE_MS);
  }, [clearCloseTimer, clearOpenTimer]);

  const handleSelect = useCallback(
    (rowIndex: number) => {
      setMenuOpen(false);
      clearOpenTimer();
      clearCloseTimer();
      onJumpToRow(rowIndex);
    },
    [clearCloseTimer, clearOpenTimer, onJumpToRow],
  );

  if (!chatUserMinimapEnabled || displayEntries.length === 0) {
    return null;
  }

  const dotRail = (
    <div className="flex flex-col items-center gap-1 py-0.5" aria-hidden={menuOpen}>
      {displayEntries.map((entry, index) => {
        const active = activeDisplayIndex != null && index === activeDisplayIndex;
        return (
          <button
            key={entry.key}
            type="button"
            title={entry.preview}
            aria-label={`User message ${index + 1}`}
            aria-current={active ? "true" : undefined}
            className={cn(
              "h-2 w-1.5 shrink-0 rounded-full transition-colors",
              active ? "bg-[var(--chat-accent)]" : "bg-fg/25 hover:bg-fg/45",
            )}
            onClick={() => handleSelect(entry.rowIndex)}
          />
        );
      })}
    </div>
  );

  const menu = menuOpen ? (
    <div
      className="max-h-[min(22rem,65vh)] w-[min(22rem,calc(100vw-6rem))] overflow-y-auto rounded-md border border-white/[0.06] bg-[color:rgb(12,12,16)]/95 px-1 py-1"
      role="menu"
      aria-label="Jump to user message"
    >
      <ul className="flex flex-col gap-0.5 p-0.5">
        {displayEntries.map((entry, index) => {
          const active = activeDisplayIndex != null && index === activeDisplayIndex;
          return (
            <li key={entry.key}>
              <button
                type="button"
                role="menuitem"
                className={cn(
                  "w-full rounded px-2 py-1.5 text-left font-sans text-[11px] leading-snug transition-colors",
                  active
                    ? "bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] text-fg"
                    : "text-fg/80 hover:bg-white/[0.06]",
                )}
                onClick={() => handleSelect(entry.rowIndex)}
              >
                <span className="line-clamp-3">{entry.preview}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  ) : null;

  const outside = placement === "outsideRight";

  return (
    <div
      className={cn(
        "pointer-events-none absolute top-3 z-20 flex flex-col",
        outside
          ? "left-full ml-3 items-start max-xl:left-auto max-xl:right-3 max-xl:ml-0 max-xl:items-end"
          : "right-3 items-end",
      )}
      role="region"
      aria-label="User message minimap"
    >
      <div
        className="pointer-events-auto flex flex-row items-start gap-2 rounded-lg border border-white/[0.08] bg-card/85 px-1.5 py-1.5 shadow-lg backdrop-blur-md"
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        {outside ? dotRail : menu}
        {outside ? menu : dotRail}
      </div>
    </div>
  );
}
