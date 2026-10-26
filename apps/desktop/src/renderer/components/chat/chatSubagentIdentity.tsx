import { Check, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { toneText } from "../lanes/laneDesignTokens";
import { deriveSubagentCardName } from "../../../shared/chatSubagents";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";

export type ChatSubagentIdentityInput = {
  agentType?: string | null;
  description?: string | null;
  label?: string | null;
  agentId?: string | null;
  taskId: string;
};

/**
 * The Chat Info subagents row name: the same rule the inline transcript cards
 * use (`deriveSubagentCardName` — task description, then label, then agent
 * type, with Codex `/root/...` paths humanized and placeholders skipped), so
 * one agent reads the same in both places.
 */
export function chatSubagentDisplayName(snapshot: ChatSubagentIdentityInput): string {
  return deriveSubagentCardName(snapshot);
}

const AGENT_IDENTITY_COLORS = [
  "#e9a6a6", "#a6cfe9", "#b6e0aa", "#e6cba0", "#c8b0e6", "#eebfdc", "#9fe0d6", "#e0d79f",
];

export function chatSubagentColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AGENT_IDENTITY_COLORS[hash % AGENT_IDENTITY_COLORS.length]!;
}

function glyphHash(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function identiconCells(id: string): boolean[] {
  const hash = glyphHash(id);
  const left = [0, 1, 2].map((i) => Boolean((hash >> i) & 1));
  const center = [3, 4, 5].map((i) => Boolean((hash >> i) & 1));
  if (!left.some(Boolean) && !center.some(Boolean)) center[1] = true;
  return [
    left[0]!, center[0]!, left[0]!,
    left[1]!, center[1]!, left[1]!,
    left[2]!, center[2]!, left[2]!,
  ];
}

export function ChatSubagentGlyph({
  id,
  color,
  status,
  size = 18,
  needsYou = false,
  emphasis = false,
}: {
  id: string;
  color: string;
  // When omitted, renders the plain identicon: no spinner ring, no
  // completed/failed corner badge, no dimming. Used for compact lineage cues
  // (e.g. the Work sidebar card) where only the pattern+color identity matters.
  status?: ChatSubagentSnapshot["status"];
  /** Overall glyph size in px (svg + wrapper). Defaults to 18. */
  size?: number;
  /** Waiting on the user: a still amber ring replaces the running spinner. */
  needsYou?: boolean;
  /**
   * The glyph is the row's only status mark (the actions pane): a bolder,
   * faster running ring and larger check / x badges.
   */
  emphasis?: boolean;
}) {
  const badgeSize = emphasis ? 11 : 9;
  const cells = identiconCells(id);
  // Pastel identity colours glow on dark pages; on light ones they deepen so the glyph stays visible.
  const ink = toneText(color);
  const isRunning = status === "running";
  const dimmed = status === "completed" || status === "stopped";
  const cell = 4;
  const gap = 1;
  const pad = 2;

  return (
    <span
      className="relative flex shrink-0 items-center justify-center"
      style={{ height: size, width: size }}
    >
      {needsYou ? (
        <span
          aria-hidden
          className="absolute -inset-[2px] rounded-full border border-amber-300/80"
        />
      ) : isRunning ? (
        // Transform-only spin (compositor), off under reduced motion.
        <span
          aria-hidden
          className={cn(
            "absolute -inset-[2px] rounded-full motion-safe:animate-spin",
            emphasis ? "border-[1.5px] [animation-duration:2.4s]" : "border [animation-duration:5s]",
          )}
          style={{
            borderColor: "transparent",
            borderTopColor: ink,
            ...(emphasis ? { borderRightColor: ink } : null),
            opacity: emphasis ? 0.85 : 0.7,
          }}
        />
      ) : null}
      <svg
        aria-hidden
        width={size}
        height={size}
        viewBox="0 0 18 18"
        className={cn("rounded-full", dimmed && "opacity-55")}
        style={{ backgroundColor: `color-mix(in srgb, ${color} 16%, transparent)` }}
      >
        {cells.map((lit, i) => {
          if (!lit) return null;
          const col = i % 3;
          const row = Math.floor(i / 3);
          return (
            <rect
              key={i}
              x={pad + col * (cell + gap)}
              y={pad + row * (cell + gap)}
              width={cell}
              height={cell}
              rx={1}
              style={{ fill: ink }}
            />
          );
        })}
      </svg>
      {status === "completed" ? (
        <Check aria-hidden size={badgeSize} weight="bold" className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[color:var(--work-sidebar-bg,#1a1a1e)] text-emerald-300/90" />
      ) : null}
      {status === "failed" ? (
        <X aria-hidden size={badgeSize} weight="bold" className="absolute -bottom-0.5 -right-0.5 rounded-full bg-[color:var(--work-sidebar-bg,#1a1a1e)] text-rose-300/90" />
      ) : null}
    </span>
  );
}
