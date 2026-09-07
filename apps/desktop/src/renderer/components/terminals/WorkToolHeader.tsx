import type { ReactNode } from "react";
import { SquaresFour, X } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import type { WorkSidebarTab } from "../../state/appStore";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import { WORK_TOOL_DEFINITIONS, workToolAvailability, type WorkToolContext } from "./workTools";
import {
  workToolDotColor,
  workToolDotState,
  workToolHasError,
  type WorkToolDotState,
  type WorkToolStatusMap,
} from "./useWorkToolStatuses";
import { workToolErrorSuffix } from "./workToolErrors";

/** Shared-element id linking a tool's activity dot to its header icon halo. */
function toolMarkerLayoutId(tool: WorkSidebarTab): string {
  return `work-tool-marker:${tool}`;
}

const OVERSHOOT = [0.34, 1.56, 0.64, 1] as const;

const CLOSE_BUTTON_CLASS = cn(
  "ade-shell-control inline-flex h-full w-9 shrink-0 items-center justify-center self-stretch rounded-none",
  "border-l border-white/[0.08] text-muted-fg/70 transition-colors duration-[120ms] hover:bg-white/[0.04] hover:text-fg",
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
);

/**
 * The tools pane header while a tool is open.
 *
 * Three jobs in 36px: get back to the picker, say what you are looking at, and
 * — the part the old tab rail did badly — keep the tools you are NOT looking at
 * visible. A running shell, a tab an agent is holding, a booted simulator each
 * get a dot on the right; clicking one switches to it, and the dot flies into
 * the header icon on the way (a shared `layoutId`), so the switch reads as the
 * same object moving rather than two unrelated repaints.
 */
export function WorkToolHeader({
  tool,
  context,
  contextLabel,
  statuses,
  contextAction,
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
  /**
   * One small control belonging to the tool on screen, rendered just before the
   * activity dots. Exists so a panel mounted `chromeless` (the PR pane) can
   * surrender its own title bar without losing its one action.
   */
  contextAction?: ReactNode;
  /** Key-cap shown in the "Back to tools" tooltip; the terminal's differs. */
  backShortcut?: string;
  onShowPicker: () => void;
  onPick: (tool: WorkSidebarTab) => void;
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const definition = WORK_TOOL_DEFINITIONS.find((entry) => entry.id === tool)
    ?? WORK_TOOL_DEFINITIONS[0];
  const Icon = definition.icon;

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

  return (
    <div className="ade-pane-chrome flex min-h-[36px] shrink-0 items-stretch border-b border-white/[0.08]">
      <PaneTooltip label="Back to tools" shortcut={backShortcut} side="bottom">
        <button
          type="button"
          onClick={onShowPicker}
          aria-label="Back to tools"
          className={cn(
            "ade-shell-control inline-flex h-full shrink-0 items-center gap-1.5 self-stretch rounded-none border-0 border-r",
            "border-white/[0.08] px-2.5 text-[11px] font-medium text-muted-fg/85",
            "transition-colors duration-[120ms] ease-out hover:bg-white/[0.04] hover:text-fg",
            "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
          )}
          data-variant="ghost"
        >
          <SquaresFour size={13} weight="bold" />
          <span>Tools</span>
        </button>
      </PaneTooltip>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5">
        <span className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center">
          {reduceMotion ? (
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full"
              style={{ background: `color-mix(in srgb, ${definition.color} 16%, transparent)` }}
            />
          ) : (
            <motion.span
              aria-hidden="true"
              layoutId={toolMarkerLayoutId(definition.id)}
              className="absolute inset-0 rounded-full"
              style={{ background: `color-mix(in srgb, ${definition.color} 16%, transparent)` }}
              transition={{ duration: 0.24, ease: OVERSHOOT }}
            />
          )}
          <Icon size={13} weight="duotone" style={{ color: definition.color }} className="relative" />
        </span>
        <span className="shrink-0 truncate text-[11.5px] font-medium text-fg">{definition.label}</span>
        {contextLabel ? (
          <>
            <span aria-hidden="true" className="shrink-0 text-[10px] text-muted-fg/45">·</span>
            {/* The header is 36px of a pane that can be 280px wide, so this is
                the line most likely to be cut. The tooltip is where the rest
                of it lives. */}
            <PaneTooltip label={contextLabel} side="bottom" className="min-w-0 flex-1">
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-fg">
                {contextLabel}
              </span>
            </PaneTooltip>
          </>
        ) : null}
      </div>

      {contextAction ? (
        <div className="flex shrink-0 items-center pr-0.5">{contextAction}</div>
      ) : null}

      {activityTools.length > 0 ? (
        <div
          className="flex shrink-0 items-center gap-1 pr-1.5"
          role="group"
          aria-label="Other active tools"
        >
          {activityTools.map((entry) => {
            const status = statuses[entry.id];
            const dotState = workToolDotState(status);
            const dotColor = workToolDotColor(dotState, entry.color);
            const suffix = workToolHasError(status) ? workToolErrorSuffix(status?.errorCount ?? 0) : "";
            const detail = status?.line ? `${status.line}${suffix}` : suffix.replace(/^ · /, "");
            const label = detail ? `${entry.label} — ${detail}` : entry.label;
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
                  <ActivityDot state={dotState} color={dotColor} reduceMotion={reduceMotion} tool={entry.id} />
                </button>
              </PaneTooltip>
            );
          })}
        </div>
      ) : null}

      <PaneTooltip label="Close Tools sidebar" side="left" className="self-stretch">
        <button
          type="button"
          className={CLOSE_BUTTON_CLASS}
          data-variant="ghost"
          onClick={onClose}
          aria-label="Close Tools sidebar"
        >
          <X size={13} />
        </button>
      </PaneTooltip>
    </div>
  );
}

/** 6px, state-coloured, and the shared-element half of the switch animation. */
function ActivityDot({
  state,
  color,
  reduceMotion,
  tool,
}: {
  state: WorkToolDotState;
  color: string;
  reduceMotion: boolean;
  tool: WorkSidebarTab;
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
      layoutId={toolMarkerLayoutId(tool)}
      data-tool-dot-state={state}
      className="h-[6px] w-[6px] rounded-full"
      style={{ background: color }}
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: 0.24, ease: OVERSHOOT }}
    />
  );
}

/** The header shown on the picker page — no tool to name, nothing to switch to. */
export function WorkToolPickerHeader({ onClose }: { onClose: () => void }) {
  return (
    <div className="ade-pane-chrome flex min-h-[36px] shrink-0 items-stretch border-b border-white/[0.08]">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3">
        <SquaresFour size={13} weight="bold" className="shrink-0 text-muted-fg/70" />
        <span className="truncate text-[11.5px] font-medium text-fg">Tools</span>
      </div>
      <PaneTooltip label="Close Tools sidebar" side="left" className="self-stretch">
        <button
          type="button"
          className={CLOSE_BUTTON_CLASS}
          data-variant="ghost"
          onClick={onClose}
          aria-label="Close Tools sidebar"
        >
          <X size={13} />
        </button>
      </PaneTooltip>
    </div>
  );
}
