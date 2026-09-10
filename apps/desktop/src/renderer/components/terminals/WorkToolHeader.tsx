import { useEffect, useRef, useState } from "react";
import { DotsThree, Plus, SquaresFour, X } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { motion, useReducedMotion } from "motion/react";
import type { WorkSidebarTab } from "../../state/appStore";
import { cn } from "../ui/cn";
import { PaneTooltip } from "../ui/PaneTooltip";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS } from "../ui/paneMenuTokens";
import {
  WORK_TOOL_DEFINITIONS,
  workToolAvailability,
  workToolDefinition,
  workToolLabel,
  type WorkToolContext,
} from "./workTools";
import { useAnyAgentBrowserPresence } from "./agentBrowserPresence";
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
 * Below this the strip stops spelling tool names.
 *
 * A 280px pane cannot hold "Terminal", "Browser" and "Git" as words plus the
 * grid button, the +, and the ✕ — and a strip of half-sliced words is worse than
 * a strip of glyphs, which are what the picker cards taught you to read anyway.
 */
export const WORK_TOOL_TAB_LABEL_MIN_PX = 420;

/** Widths the layout spends. Measured against the rendered strip, not guessed. */
const TAB_WIDTH_WITH_LABEL_PX = 104;
const TAB_WIDTH_ICON_ONLY_PX = 28;
/** Everything in the row that is not a tab: grid button, `+`, ✕, padding, gaps. */
const CHROME_WIDTH_WITH_LABEL_PX = 134;
const CHROME_WIDTH_ICON_ONLY_PX = 96;
/** The "…" trigger, added only when something actually overflows. */
const OVERFLOW_WIDTH_PX = 28;

export type WorkToolTabLayout = {
  /** Tabs drawn in the strip, in strip order. */
  visible: WorkSidebarTab[];
  /** Tabs that only exist in the "…" menu. */
  overflow: WorkSidebarTab[];
  /** False below `WORK_TOOL_TAB_LABEL_MIN_PX`: glyph only. */
  showLabels: boolean;
};

/**
 * How many tabs fit, and which ones.
 *
 * Pure and exported so the two rules that matter can be tested without a layout
 * engine: labels drop before tabs do, and the ACTIVE tab is never the one that
 * overflows — a strip that hid the tool on screen would leave the pane with no
 * mark anywhere saying what you are looking at.
 *
 * An unmeasured width (first paint, jsdom) shows everything: the strip settles
 * one frame later, and starting from "everything fits" means the common wide
 * pane never flashes a "…" it does not need.
 */
export function workToolTabLayout(
  openTools: readonly WorkSidebarTab[],
  activeTool: WorkSidebarTab | null,
  width: number,
): WorkToolTabLayout {
  if (width <= 0 || openTools.length === 0) {
    return { visible: [...openTools], overflow: [], showLabels: width <= 0 || width >= WORK_TOOL_TAB_LABEL_MIN_PX };
  }
  // Labels go before tabs do. A wide-enough pane that still cannot spell every
  // open tool falls back to glyphs rather than hiding half the strip behind a
  // "…": six glyphs fit in the narrowest pane the splitter allows, so the menu
  // is the last resort it sounds like.
  const showLabels = width >= WORK_TOOL_TAB_LABEL_MIN_PX
    && CHROME_WIDTH_WITH_LABEL_PX + openTools.length * TAB_WIDTH_WITH_LABEL_PX <= width;
  const tabWidth = showLabels ? TAB_WIDTH_WITH_LABEL_PX : TAB_WIDTH_ICON_ONLY_PX;
  const chrome = showLabels ? CHROME_WIDTH_WITH_LABEL_PX : CHROME_WIDTH_ICON_ONLY_PX;
  const room = width - chrome;
  const fits = Math.floor(room / tabWidth);
  if (fits >= openTools.length) {
    return { visible: [...openTools], overflow: [], showLabels };
  }
  // One slot goes to the "…" itself. At least one tab is always drawn: a strip
  // that is nothing but an overflow menu is a menu, not a strip.
  const slots = Math.max(1, Math.floor((room - OVERFLOW_WIDTH_PX) / tabWidth));
  const visible = openTools.slice(0, slots);
  const overflow = openTools.slice(slots);
  if (activeTool && overflow.includes(activeTool)) {
    // The active tab takes the last visible slot, and the tab it displaces goes
    // into the menu — the strip keeps its order otherwise.
    const displaced = visible[visible.length - 1];
    visible[visible.length - 1] = activeTool;
    const index = overflow.indexOf(activeTool);
    overflow[index] = displaced;
  }
  return { visible, overflow, showLabels };
}

/** Live width of the header, or 0 until it has been measured. */
function useMeasuredWidth(): { ref: (node: HTMLDivElement | null) => void; width: number } {
  const [width, setWidth] = useState(0);
  const observed = useRef<HTMLDivElement | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  useEffect(() => () => observer.current?.disconnect(), []);

  const ref = (node: HTMLDivElement | null): void => {
    if (observed.current === node) return;
    observed.current = node;
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    setWidth(node.getBoundingClientRect().width);
    // Guarded because jsdom and the hosted web client's older engines may not
    // have it; without a live measurement the strip simply shows every tab.
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.current.observe(node);
  };

  return { ref, width };
}

/**
 * The tools pane header: a tab strip.
 *
 * Left edge is the grid button back to the picker; then one tab per OPEN tool,
 * left-aligned, the active one lit; then a `+` for another. There is no centred
 * title any more — the lit tab is the title, and a bar that also spelled the
 * name out was saying the same thing twice in 36px. A tool's one compact fact
 * (the page you are on, the branch) lives in its tab's tooltip.
 *
 * Tools that are NOT open still report themselves: a running shell, a tab an
 * agent is holding, a booted simulator each get a 6px dot on the right that
 * opens them. A tool with a tab has no dot — its tab carries its own.
 */
export function WorkToolHeader({
  activeTool,
  openTools,
  context,
  contextLabel,
  statuses,
  backShortcut,
  onShowPicker,
  onPick,
  onCloseTool,
  onClose,
}: {
  /** The tab on screen, or null while the picker page is showing. */
  activeTool: WorkSidebarTab | null;
  /** Every open tab, in strip order. */
  openTools: readonly WorkSidebarTab[];
  context: WorkToolContext;
  /**
   * Compact "what am I looking at" string for the ACTIVE tool — a tab title, a
   * shell count, a branch. It is the active tab's tooltip, not a header line.
   */
  contextLabel: string | null;
  statuses: WorkToolStatusMap;
  /** Key-cap shown in the "Back to tools" tooltip; the terminal's differs. */
  backShortcut?: string;
  onShowPicker: () => void;
  onPick: (tool: WorkSidebarTab) => void;
  onCloseTool: (tool: WorkSidebarTab) => void;
  onClose: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const { ref, width } = useMeasuredWidth();
  const [overflowOpen, setOverflowOpen] = useState(false);
  // OP3 additive: an agent is driving the browser right now. Read from the
  // shared presence store rather than `statuses`, which describes tabs.
  const agentBrowsing = useAnyAgentBrowserPresence();

  // Only tools that are (a) not open as a tab, (b) usable here, and (c) actually
  // doing something. A dot for an idle tool would be noise; a dot for an
  // unavailable one would be a lie; a dot for an open tool would duplicate its
  // tab, which already shows its own state.
  // An erroring tool earns a dot even when it is not "live": a crashed App
  // Control session or a page full of console errors is exactly the thing you
  // want to be told about while looking at something else. So does one waiting
  // on you — a login handoff is the whole reason to look away from this tool.
  const activityTools = WORK_TOOL_DEFINITIONS.filter((entry) => (
    !openTools.includes(entry.id)
    && workToolAvailability(entry.id, context).available
    && workToolDotState(statuses[entry.id]) !== "idle"
  ));

  const layout = workToolTabLayout(openTools, activeTool, width);

  /** A tab's tooltip: its status summary, plus the active tool's own one fact. */
  const tabTooltip = (tool: WorkSidebarTab): string => {
    const definition = workToolDefinition(tool);
    if (!definition) return workToolLabel(tool);
    if (tool === activeTool && contextLabel) return `${definition.label} · ${contextLabel}`;
    const { tooltipLabel } = workToolSummary(
      definition,
      statuses[tool],
      workToolAvailability(tool, context),
    );
    return tooltipLabel;
  };

  return (
    <div
      ref={ref}
      className="ade-pane-chrome ade-tool-pane-rule ade-tool-header flex min-h-[36px] shrink-0 items-center gap-1 px-2"
    >
      <PaneTooltip label="Back to tools" shortcut={backShortcut} side="bottom">
        <button
          type="button"
          onClick={onShowPicker}
          aria-label="Back to tools"
          className={cn(
            CONTROL_CLASS,
            layout.showLabels ? undefined : "w-6 px-0",
            // The picker IS a page you are on, so the button that shows it is
            // lit while you are there — the one state in this bar that is not
            // hover.
            activeTool === null && "bg-white/[0.06] text-fg",
          )}
          data-variant="ghost"
          data-state={activeTool === null ? "open" : undefined}
        >
          <SquaresFour size={16} weight="regular" />
          {layout.showLabels ? <span>Tools</span> : null}
        </button>
      </PaneTooltip>

      {/* The strip and its `+` share one flexible box, so the `+` sits directly
          after the last tab rather than being pushed to the far right by a
          flex-1 tablist. */}
      <div className="flex min-w-0 flex-1 items-center gap-1">
      {openTools.length > 0 ? (
        <div
          role="tablist"
          aria-label="Open tools"
          aria-orientation="horizontal"
          className="flex min-w-0 items-center gap-0.5"
        >
          {layout.visible.map((tool) => (
            <WorkToolTab
              key={tool}
              tool={tool}
              active={tool === activeTool}
              showLabel={layout.showLabels}
              tooltip={tabTooltip(tool)}
              /* An agent driving the browser is live activity the browser's own
                 status line cannot see (it describes tabs, not who is on them),
                 so it is OR-ed in here — see `agentBrowserPresence`. */
              dotState={tool === "browser" && agentBrowsing
                ? "live"
                : workToolDotState(statuses[tool])}
              onSelect={() => onPick(tool)}
              onCloseTool={() => onCloseTool(tool)}
            />
          ))}
          {layout.overflow.length > 0 ? (
            <DropdownMenu.Root open={overflowOpen} onOpenChange={setOverflowOpen}>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label={`${layout.overflow.length} more open tools`}
                  className={cn(CONTROL_CLASS, "w-6 px-0", "data-[state=open]:bg-white/[0.09] data-[state=open]:text-fg")}
                  data-variant="ghost"
                >
                  <DotsThree size={16} weight="bold" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="start" sideOffset={6} className={MENU_CONTENT_CLASS}>
                  {layout.overflow.map((tool) => {
                    const definition = workToolDefinition(tool);
                    const Glyph = definition?.icon;
                    return (
                      <DropdownMenu.Item
                        key={tool}
                        className={MENU_ITEM_CLASS}
                        onSelect={() => onPick(tool)}
                      >
                        {Glyph ? <Glyph size={12} className="shrink-0 opacity-70" /> : null}
                        <span className="min-w-0 flex-1 truncate">{workToolLabel(tool)}</span>
                      </DropdownMenu.Item>
                    );
                  })}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          ) : null}
        </div>
      ) : null}

      {/* Nothing to add while the picker is already up — that button IS the
          picker, and two controls opening one page is one too many. */}
      {activeTool !== null ? (
        <PaneTooltip label="Open another tool" side="bottom">
          <button
            type="button"
            onClick={onShowPicker}
            aria-label="Open another tool"
            className={cn(CONTROL_CLASS, "w-6 px-0")}
            data-variant="ghost"
          >
            <Plus size={14} weight="bold" />
          </button>
        </PaneTooltip>
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

/**
 * One tab: glyph, name, and a ✕ that appears when you point at it.
 *
 * The ✕ is a sibling of the tab button rather than a child — a button inside a
 * button is invalid, and the browser resolves it by dropping one of the two
 * click targets. Its space is reserved at rest instead of appearing on hover, so
 * pointing at a strip does not shuffle the tabs under the pointer.
 */
function WorkToolTab({
  tool,
  active,
  showLabel,
  tooltip,
  dotState,
  onSelect,
  onCloseTool,
}: {
  tool: WorkSidebarTab;
  active: boolean;
  showLabel: boolean;
  tooltip: string;
  dotState: WorkToolDotState;
  onSelect: () => void;
  onCloseTool: () => void;
}) {
  const definition = workToolDefinition(tool);
  if (!definition) return null;
  const Icon = definition.icon;
  return (
    <div className="group/tab relative flex min-w-0 shrink items-center">
      <PaneTooltip label={tooltip} side="bottom" className="min-w-0 shrink">
        <button
          type="button"
          role="tab"
          aria-selected={active}
          // The tooltip string doubles as the accessible name: an icon-only tab
          // has no text at all, and a name of "Browser" would drop the one fact
          // (the page, the shell count) the tab is carrying.
          aria-label={tooltip}
          data-tool-tab={tool}
          onClick={onSelect}
          className={cn(
            "inline-flex h-6 min-w-0 shrink items-center gap-1.5 rounded-[6px] border-0",
            "text-[12px] font-medium transition-colors duration-[120ms] ease-out",
            "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
            showLabel ? "px-1.5 pr-[20px]" : "w-6 justify-center px-0",
            active
              ? "bg-white/[0.07] text-fg"
              : "bg-transparent text-muted-fg hover:bg-white/[0.04] hover:text-fg",
          )}
        >
          <Icon
            size={16}
            weight="regular"
            aria-hidden="true"
            className={cn(
              "shrink-0",
              // Icon-only tabs hand their square to the ✕ on hover: it is the
              // only place a close target can go at 24px.
              !showLabel && "transition-opacity duration-[120ms] group-hover/tab:opacity-0",
            )}
          />
          {showLabel ? (
            <span className="min-w-0 truncate">{definition.label}</span>
          ) : null}
          {dotState !== "idle" && !active ? (
            <span
              aria-hidden="true"
              data-tool-tab-dot={dotState}
              className={cn(
                "h-[5px] w-[5px] shrink-0 rounded-full",
                showLabel ? undefined : "absolute right-[3px] top-[3px]",
              )}
              style={{ background: workToolDotColor(dotState, definition.color) }}
            />
          ) : null}
        </button>
      </PaneTooltip>
      <button
        type="button"
        onClick={onCloseTool}
        aria-label={`Close ${definition.label}`}
        className={cn(
          "absolute inset-y-0 right-0 my-auto inline-flex h-4 w-4 items-center justify-center rounded-[4px]",
          "text-muted-fg opacity-0 transition-opacity duration-[120ms] ease-out",
          "hover:bg-white/[0.09] hover:text-fg focus-visible:opacity-100",
          "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
          "group-hover/tab:opacity-100",
          showLabel ? "mr-[2px]" : "left-0 mx-auto",
        )}
      >
        <X size={10} weight="bold" />
      </button>
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
