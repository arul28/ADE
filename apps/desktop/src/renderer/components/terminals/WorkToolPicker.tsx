import { useId } from "react";
import type { WorkSidebarTab } from "../../state/appStore";
import { cn } from "../ui/cn";
import {
  WORK_TOOL_DEFINITIONS,
  workToolAvailability,
  type WorkToolContext,
} from "./workTools";
import type { WorkToolStatusMap } from "./useWorkToolStatuses";

/**
 * The tools pane's front page: every tool ADE can open beside this session, what
 * each one is doing right now, and one click to take it over the pane.
 *
 * Deliberately a grid of cards rather than the old icon rail. The rail could
 * only say "these six things exist"; a card can say "two shells are running,
 * one of them is your dev server" — which is the actual question you open this
 * pane to answer.
 */
export function WorkToolPicker({
  activeTool,
  context,
  statuses,
  loading,
  onPick,
}: {
  activeTool: WorkSidebarTab | null;
  context: WorkToolContext;
  statuses: WorkToolStatusMap;
  loading: boolean;
  onPick: (tool: WorkSidebarTab) => void;
}) {
  const reasonIdPrefix = useId();

  return (
    <div className="h-full min-h-0 overflow-auto">
      <div
        role="group"
        aria-label="Work tools"
        className="grid grid-cols-2 gap-2 p-3"
      >
        {WORK_TOOL_DEFINITIONS.map((definition) => {
          const availability = workToolAvailability(definition.id, context);
          const status = statuses[definition.id];
          const reasonId = `${reasonIdPrefix}-${definition.id}`;
          // Unavailable tools say why instead of showing a status they cannot
          // have; available tools with nothing measured fall back to the blurb.
          const line = availability.available
            ? status?.line ?? definition.blurb
            : availability.reason;
          const showSkeleton = loading && availability.available && status?.line == null;
          const Icon = definition.icon;
          const isActive = activeTool === definition.id;
          return (
            <button
              key={definition.id}
              type="button"
              disabled={!availability.available}
              aria-current={isActive ? "true" : undefined}
              aria-describedby={availability.available ? undefined : reasonId}
              onClick={() => onPick(definition.id)}
              data-tool-id={definition.id}
              className={cn(
                "group relative flex min-h-[70px] flex-col items-start gap-1.5 rounded-[var(--radius-lg)]",
                "border border-white/[0.07] bg-card/60 px-2.5 py-2 text-left",
                "transition-[transform,border-color,background-color,box-shadow] duration-[120ms] ease-out",
                "hover:-translate-y-px hover:border-white/[0.16] hover:bg-card",
                "active:translate-y-0 active:scale-[0.985]",
                "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                "motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100",
                isActive && "border-white/20 bg-card",
                !availability.available
                  && "cursor-not-allowed opacity-45 hover:translate-y-0 hover:border-white/[0.07] hover:bg-card/60",
              )}
            >
              <span className="flex w-full items-center gap-2">
                <Icon
                  size={15}
                  weight="duotone"
                  style={{ color: availability.available ? definition.color : undefined }}
                  className={availability.available ? undefined : "text-muted-fg"}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4 text-fg">
                  {definition.label}
                </span>
                <WorkToolStatusGlyph
                  live={Boolean(availability.available && status?.live)}
                  color={definition.color}
                  disabled={!availability.available}
                />
              </span>
              {showSkeleton ? (
                <span
                  aria-hidden="true"
                  className="ade-tool-skeleton mt-0.5 h-[9px] w-3/4 rounded-full"
                />
              ) : (
                <span
                  id={availability.available ? undefined : reasonId}
                  className="line-clamp-2 text-[10.5px] leading-[14px] text-muted-fg"
                >
                  {line}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The right-side glyph on a card. A filled, softly ringed dot when the tool has
 * something live; a flat dim dot otherwise. Never a spinner — this reports a
 * fact, it does not claim work is in flight.
 */
function WorkToolStatusGlyph({
  live,
  color,
  disabled,
}: {
  live: boolean;
  color: string;
  disabled: boolean;
}) {
  if (disabled) return null;
  return (
    <span
      aria-hidden="true"
      className="h-[5px] w-[5px] shrink-0 rounded-full"
      style={
        live
          ? { background: color, boxShadow: `0 0 0 2.5px color-mix(in srgb, ${color} 18%, transparent)` }
          : { background: "color-mix(in srgb, var(--color-muted-fg) 35%, transparent)" }
      }
    />
  );
}
