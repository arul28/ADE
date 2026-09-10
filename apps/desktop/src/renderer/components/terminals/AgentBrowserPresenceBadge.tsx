import { Globe } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { useAgentBrowserPresenceSince } from "./agentBrowserPresence";

/** One sentence, everywhere this badge appears. */
export const AGENT_BROWSER_PRESENCE_LABEL = "Using the browser";

/**
 * A globe beside a chat while its agent is driving the browser.
 *
 * Deliberately the smallest possible mark: no words, no count, no colour of its
 * own beyond the accent — the row's job is still the chat's title and status,
 * and this is a live-activity glyph, not a status label. The slow pulse is the
 * whole difference between "this chat can use the browser" (which is every
 * chat, and therefore not worth showing) and "it is using it right now".
 *
 * Renders nothing when the chat is not browsing, so every caller can place it
 * unconditionally.
 */
export function AgentBrowserPresenceBadge({
  chatSessionId,
  size = 12,
  className,
}: {
  chatSessionId: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const since = useAgentBrowserPresenceSince(chatSessionId);
  if (!since) return null;
  return (
    <span
      data-testid="agent-browser-presence"
      role="img"
      title={AGENT_BROWSER_PRESENCE_LABEL}
      aria-label={AGENT_BROWSER_PRESENCE_LABEL}
      className={cn(
        "inline-flex shrink-0 items-center justify-center text-accent/85",
        // 1.2s, and only when the person has not asked for less motion: a
        // permanent throb in a sidebar full of rows is exactly what
        // `prefers-reduced-motion` is for. Without the animation the glyph is
        // still present and still says the same thing.
        "motion-safe:animate-pulse motion-safe:[animation-duration:1.2s]",
        className,
      )}
    >
      <Globe size={size} weight="bold" />
    </span>
  );
}
