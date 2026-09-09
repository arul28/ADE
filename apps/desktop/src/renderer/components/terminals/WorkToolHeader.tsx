import { SquaresFour, X } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import type { WorkSidebarTab } from "../../state/appStore";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import {
  WORK_TOOL_DEFINITIONS,
  workToolAvailability,
  workToolDefinition,
  type WorkToolContext,
} from "./workTools";
import {
  workToolDotColor,
  workToolDotState,
  workToolSummary,
  type WorkToolDotState,
  type WorkToolStatusMap,
} from "./useWorkToolStatuses";

const CONTROL_CLASS = cn(
  "ade-shell-control inline-flex h-6 shrink-0 items-center justify-center gap-1.5 rounded-[6px] px-1.5",
  "border-0 text-[12px] font-medium text-muted-fg",
  "transition-colors duration-[120ms] ease-out hover:bg-white/[0.06] hover:text-fg",
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
);

/**
 * The tools pane header while a tool is open.
 *
 * Three jobs in 36px, and nothing else: get back to the picker, say what you
 * are looking at, and — the part the old tab rail did badly — keep the tools
 * you are NOT looking at reachable. A running shell, a tab an agent is holding,
 * a booted simulator each get a 6px dot on the right that switches to it.
 *
 * Everything decorative is gone: no tinted halo behind the icon, no dividing
 * rules between the three groups, no colour on the glyph. One hairline along
 * the bottom is the only line in the bar.
 */
export function WorkToolHeader({
  tool,
  context,
  contextLabel,
  statuses,
  backShortcut,
  onShowPicker,
  onPick,
  onClose,
}: {
  tool: WorkSidebarTab;
  context: WorkToolContext;
  /** Compact "what am I looking at" string — a tab title, a shell count, a branch. */
  contextLabel: string | null;
  statuses: WorkToolStatusMap;
  /** Key-cap shown in the "Back to tools" tooltip; the terminal's differs. */
  backShortcut?: string;
  onShowPicker: () => void;
  onPick: (tool: WorkSidebarTab) => void;
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  // The catalogue's own indexed lookup, not a scan with a `?? [0]` tail: that
  // fallback rendered "Terminal" — its icon, its colour — for any id the map
  // does not know, a wrong answer where the type says the case cannot happen.
  const definition = workToolDefinition(tool);

  // Only tools that are (a) not the one on screen, (b) usable here, and (c)
  // actually doing something. A dot for an idle tool would be noise; a dot for
  // an unavailable one would be a lie.
  // An erroring tool earns a dot even when it is not "live": a crashed App
  // Control session or a page full of console errors is exactly the thing you
  // want to be told about while looking at something else. So does one waiting
  // on you — a login handoff is the whole reason to look away from this tool.
  const activityTools = WORK_TOOL_DEFINITIONS.filter((entry) => (
    entry.id !== tool
    && workToolAvailability(entry.id, context).available
    && workToolDotState(statuses[entry.id]) !== "idle"
  ));

  // Unreachable given `WorkSidebarTab`, but the map is the truth and rendering
  // the terminal's identity for an unknown id is a worse answer than nothing.
  if (!definition) return null;
  const Icon = definition.icon;

  return (
    <div className="ade-pane-chrome ade-tool-pane-rule ade-tool-header flex min-h-[36px] shrink-0 items-center gap-2 px-2">
      <PaneTooltip label="Back to tools" shortcut={backShortcut} side="bottom">
        <button
          type="button"
          onClick={onShowPicker}
          aria-label="Back to tools"
          className={CONTROL_CLASS}
          data-variant="ghost"
        >
          <SquaresFour size={16} weight="regular" />
          <span>Tools</span>
        </button>
      </PaneTooltip>

      {/* Centred, so the pane's title sits on the pane's axis rather than
          wherever the left button happened to end. `min-w-0` + `flex-1` is
          what lets the context line be the thing that truncates at 280px. */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1.5">
        <Icon size={16} weight="regular" aria-hidden="true" className="shrink-0 text-muted-fg" />
        <span className="shrink-0 text-[13px] font-medium text-fg">{definition.label}</span>
        {contextLabel ? (
          /* The header is 36px of a pane that can be 280px wide, so this is the
             first thing to go: under 400px of pane the context drops entirely
             (`ade-tool-header` is the container query in index.css) and the
             tool's NAME survives whole, rather than both halves being sliced
             into "Browser · No ta…". Above that it truncates with the tooltip
             carrying the rest. */
          <span className="ade-tool-header-context flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="shrink-0 text-[12px] text-muted-fg/45">·</span>
            <PaneTooltip label={contextLabel} side="bottom" onlyWhenClipped className="min-w-0">
              <span className="block min-w-0 truncate text-[12px] text-muted-fg">
                {contextLabel}
              </span>
            </PaneTooltip>
          </span>
        ) : null}
      </div>

      {activityTools.length > 0 ? (
        <div
          className="flex shrink-0 items-center gap-1"
          role="group"
          aria-label="Other active tools"
        >
          {activityTools.map((entry) => {
            const status = statuses[entry.id];
            const dotState = workToolDotState(status);
            const dotColor = workToolDotColor(dotState, entry.color);
            // Same summary the picker card shows, so the dot's tooltip and the
            // card can never describe one tool two ways.
            const { tooltipLabel: label } = workToolSummary(
              entry,
              status,
              workToolAvailability(entry.id, context),
            );
            return (
              <PaneTooltip key={entry.id} label={label} side="bottom">
                <button
                  type="button"
                  onClick={() => onPick(entry.id)}
                  aria-label={`Switch to ${label}`}
                  data-tool-dot={entry.id}
                  className={cn(
                    "relative inline-flex h-5 w-5 items-center justify-center rounded-full",
                    "transition-colors duration-[120ms] ease-out hover:bg-white/[0.06]",
                    "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
                  )}
                >
                  <ActivityDot state={dotState} color={dotColor} reduceMotion={reduceMotion} />
                </button>
              </PaneTooltip>
            );
          })}
        </div>
      ) : null}

      <PaneTooltip label="Close Tools sidebar" side="left">
        <button
          type="button"
          className={cn(CONTROL_CLASS, "w-6 px-0")}
          data-variant="ghost"
          onClick={onClose}
          aria-label="Close Tools sidebar"
        >
          <X size={14} />
        </button>
      </PaneTooltip>
    </div>
  );
}

/** 6px, state-coloured: red is broken, amber needs you, the tool's hue is live. */
function ActivityDot({
  state,
  color,
  reduceMotion,
}: {
  state: WorkToolDotState;
  color: string;
  reduceMotion: boolean;
}) {
  if (reduceMotion) {
    return (
      <span
        aria-hidden="true"
        data-tool-dot-state={state}
        className="h-[6px] w-[6px] rounded-full"
        style={{ background: color }}
      />
    );
  }
  return (
    <motion.span
      aria-hidden="true"
      data-tool-dot-state={state}
      className="h-[6px] w-[6px] rounded-full"
      style={{ background: color }}
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
    />
  );
}

/**
 * The header shown on the picker page.
 *
 * Deliberately empty but for the ✕: the page underneath already carries the
 * word "Tools" as its title, and a bar that repeats it is the second heading
 * on a page with one thing to say.
 */
export function WorkToolPickerHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="ade-pane-chrome ade-tool-pane-rule flex min-h-[36px] shrink-0 items-center justify-end px-2">
      <PaneTooltip label="Close Tools sidebar" side="left">
        <button
          type="button"
          className={cn(CONTROL_CLASS, "w-6 px-0")}
          data-variant="ghost"
          onClick={onClose}
          aria-label="Close Tools sidebar"
        >
          <X size={14} />
        </button>
      </PaneTooltip>
    </div>
  );
}
