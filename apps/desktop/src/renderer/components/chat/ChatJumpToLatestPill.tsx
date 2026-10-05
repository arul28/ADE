import { createPortal } from "react-dom";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { ChatComposerOverlayClear, useChatComposerJumpSlot } from "./chatComposerOverlayInset";

const PILL_CLASS =
  "pointer-events-auto flex shrink-0 items-center gap-1 rounded-full border border-violet-400/30 px-2 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-medium text-violet-100 transition-colors";

/**
 * "Jump To Latest", shown while the reader is scrolled away from the live tail.
 *
 * It docks at the end of the composer's chip row while that row shows a chip,
 * level with the chips, and otherwise floats centered just above the composer.
 * Its own component so docking re-renders only the pill, not the transcript.
 */
export function ChatJumpToLatestPill({ newRows, onJump }: { newRows: number; onJump: () => void }) {
  const slot = useChatComposerJumpSlot();
  const docked = slot !== null;
  const button = (
    <button
      type="button"
      onClick={onJump}
      data-testid="chat-jump-to-latest"
      data-docked={docked ? "" : undefined}
      // Docked, it sits over transcript text like the chips beside it and
      // takes the same opaque plate (index.css `--status-chip-fill`).
      data-overlay-plate={docked ? "" : undefined}
      className={cn(
        PILL_CLASS,
        docked
          ? "h-[22px] [--status-chip-fill:rgb(139_92_246/0.2)] hover:[--status-chip-fill:rgb(139_92_246/0.3)]"
          : "py-1 bg-violet-500/20 shadow-lg shadow-violet-500/20 backdrop-blur-md hover:bg-violet-500/30",
      )}
      aria-label={newRows > 0 ? `${newRows} new · Jump To Latest` : "Jump to latest message"}
    >
      <CaretDown size={9} weight="bold" />
      {/* Answers "did I miss anything?" without making the reader scroll to find out. */}
      <span>{newRows > 0 ? `${newRows} new · Jump To Latest` : "Jump To Latest"}</span>
    </button>
  );
  if (slot) return createPortal(button, slot);
  return (
    <ChatComposerOverlayClear basePx={16} className="pointer-events-none absolute left-1/2 z-10 -translate-x-1/2">
      {button}
    </ChatComposerOverlayClear>
  );
}
