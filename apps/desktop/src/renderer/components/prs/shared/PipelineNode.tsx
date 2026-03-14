import { cn } from "../../ui/cn";

type PipelineNodeProps = {
  laneName: string;
  prNumber: number | null;
  state: string;
  position: number;
  isLast: boolean;
  selected?: boolean;
  onClick?: () => void;
};

const stateColors: Record<string, string> = {
  pending: "bg-muted/50 text-muted-fg",
  landing: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  rebasing: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  resolving: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  landed: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/15 text-red-400 border-red-500/30",
  paused: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  skipped: "bg-muted/30 text-muted-fg/50",
};

export function PipelineNode({
  laneName,
  prNumber,
  state,
  position,
  isLast,
  selected,
  onClick,
}: PipelineNodeProps) {
  return (
    <div className="flex items-stretch">
      {/* Connector line */}
      <div className="flex w-6 flex-col items-center">
        {/* Circle marker */}
        <div
          className={cn(
            "mt-2 h-2.5 w-2.5 rounded-full border-2 shrink-0",
            selected ? "border-accent bg-accent" : "border-border/40 bg-card",
          )}
        />
        {/* Vertical line */}
        {!isLast && <div className="w-px flex-1 bg-border/25" />}
      </div>

      {/* Node card */}
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "ml-1 mb-1 flex flex-1 items-center gap-2 rounded-lg border border-border/15 px-3 py-1.5 text-left text-xs transition-colors",
          selected
            ? "bg-accent/10 border-accent/30"
            : "bg-card/30 hover:bg-card/50",
        )}
      >
        <span className="text-muted-fg/50 font-mono w-4 text-center">{position}</span>
        <span className="flex-1 truncate font-medium text-foreground/90">{laneName}</span>
        {prNumber != null && (
          <span className="text-muted-fg/60 font-mono">#{prNumber}</span>
        )}
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize",
            stateColors[state] ?? "bg-muted/30 text-muted-fg",
          )}
        >
          {state}
        </span>
      </button>
    </div>
  );
}
