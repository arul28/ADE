import { useState } from "react";
import type { PendingInputRequest } from "../../../shared/types";
import { cn } from "../ui/cn";

/** How many waiting cards the stack lists before it folds the rest into "+N more". */
export const PENDING_INPUT_STACK_VISIBLE = 3;

export type PendingInputStackEntry = {
  itemId: string;
  request: PendingInputRequest;
};

/** Who asks: the subagent's name, or the chat's own agent. */
export function pendingInputAskerName(request: PendingInputRequest): string {
  return request.subagent?.name ?? "Main agent";
}

function pendingInputSummary(request: PendingInputRequest): string {
  return (request.description ?? request.title ?? request.questions[0]?.question ?? "Waiting for you").trim();
}

/**
 * The cards waiting in this chat when there is more than one: one row per
 * card naming who asks (a subagent or the main agent), the open one marked.
 * A click opens that card in the composer. Three rows, then "+N more".
 */
export function PendingInputStack({
  entries,
  activeItemId,
  onSelect,
}: {
  entries: readonly PendingInputStackEntry[];
  activeItemId: string | null;
  onSelect: (itemId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (entries.length < 2) return null;
  const shown = expanded ? entries : entries.slice(0, PENDING_INPUT_STACK_VISIBLE);
  const hiddenCount = entries.length - shown.length;
  return (
    <div className="border-b border-border/10 px-4 py-2" data-testid="pending-input-stack">
      <div className="mb-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-widest text-fg/40">
        {entries.length} waiting for you
      </div>
      <ul className="flex flex-col gap-0.5">
        {shown.map((entry) => {
          const active = entry.itemId === activeItemId;
          return (
            <li key={entry.itemId}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => onSelect(entry.itemId)}
                className={cn(
                  "flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-left font-sans text-[length:calc(var(--chat-font-size)*11/14)] transition-colors",
                  active ? "bg-fg/[0.07] text-fg/85" : "text-fg/60 hover:bg-fg/[0.04]",
                )}
              >
                <span className="shrink-0 font-semibold">{pendingInputAskerName(entry.request)}</span>
                <span className="min-w-0 truncate text-fg/50">{pendingInputSummary(entry.request)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mt-0.5 px-2 font-sans text-[length:calc(var(--chat-font-size)*10.5/14)] text-fg/50 hover:text-fg/75"
        >
          +{hiddenCount} more
        </button>
      ) : null}
    </div>
  );
}
