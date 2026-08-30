/**
 * One job in the CI DAG, as a React Flow node.
 *
 * Modelled on how GitHub renders an Actions workflow graph: a fixed-width card
 * with the status on the left, the job name, and the elapsed time on the right,
 * connected by real handles so React Flow can route dependency edges to and
 * from the correct edges of the card.
 *
 * ## Why the card is a `div role="button"` and not a `<button>`
 *
 * The card carries a SECOND control — "open this job on GitHub" — and interactive
 * content may not nest inside a `<button>`: React's `validateDOMNesting` rejects
 * it and the inner control's activation is swallowed. So the card is an ARIA
 * button that owns its own `tabIndex`, `aria-pressed`, `aria-label` and
 * Enter/Space handling, and the GitHub control stops both `click` and `keydown`
 * from reaching it.
 *
 * React Flow's own node wrapper would otherwise be a competing tab stop
 * (`role="group"`, `tabIndex=0`); the canvas turns that off with
 * `nodesFocusable={false}` so each job is exactly one stop.
 *
 * Only loaded inside the lazily-imported canvas chunk — see `PrChecksTab`.
 */

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { PrPipelineState, PrWorkflowGraphNode } from "../../../../shared/types";
import type { StepProgress } from "./prChecksModel";
import { COLORS, MONO_FONT, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import {
  OpenOnGitHubButton,
  STATE_BORDER_STYLE,
  STATE_COLOR,
  STATE_LABEL,
  StateIcon,
  tint,
} from "./prChecksVisuals";

export type ChecksGraphNodeData = {
  node: PrWorkflowGraphNode;
  onCriticalPath: boolean;
  isSelected: boolean;
  isFocused: boolean;
  elapsedLabel: string | null;
  legCaption: string | null;
  /**
   * Step completion, only for a job that is executing. The old node listed
   * every step inline, which is a large part of why the tab read as clutter; a
   * running job needs "how far along", not a second copy of its log.
   */
  progress: StepProgress | null;
  onToggle: (node: PrWorkflowGraphNode) => void;
};

export type ChecksGraphFlowNode = Node<ChecksGraphNodeData, "checksJob">;

const HANDLE_STYLE = {
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: "none",
  background: "transparent",
  opacity: 0,
} as const;

function backgroundFor(state: PrPipelineState, isSelected: boolean): string {
  if (isSelected) return tint(COLORS.accent, 12);
  if (state === "failed") return tint(COLORS.danger, 7);
  return COLORS.cardBg;
}

/**
 * The card's accessible name. Read out, a job has to carry what the card shows
 * visually — its name, its status word, and how long it took — because the
 * status is otherwise only a glyph and a colour.
 */
export function checksGraphNodeLabel(
  node: Pick<PrWorkflowGraphNode, "displayName" | "state">,
  elapsedLabel: string | null,
  onCriticalPath: boolean,
): string {
  const parts = [`${node.displayName}, ${STATE_LABEL[node.state]}`];
  if (elapsedLabel) parts.push(elapsedLabel);
  if (onCriticalPath) parts.push("on the longest path");
  return parts.join(", ");
}

export const PrChecksGraphNode = memo(function PrChecksGraphNode({
  data,
}: NodeProps<ChecksGraphFlowNode>) {
  const { node, onCriticalPath, isSelected, isFocused, elapsedLabel, legCaption, progress } = data;
  const stateColor = STATE_COLOR[node.state];
  const outlined = isSelected || isFocused;
  const label = checksGraphNodeLabel(node, elapsedLabel, onCriticalPath);

  return (
    <div
      role="button"
      tabIndex={0}
      // The whole point of defect 3: a second activation closes the drawer.
      aria-pressed={isSelected}
      // Without this the name is computed from the contents, which reads out as
      // the status icon's label, the job name, "Open … on GitHub" and a duration
      // run together.
      aria-label={label}
      onClick={() => data.onToggle(node)}
      // A `div` has no native activation behaviour, so Enter and Space are wired
      // by hand. `preventDefault` on Space is what stops the pane scrolling.
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onToggle(node);
        }
      }}
      data-testid="pr-checks-graph-node"
      data-job-id={node.jobId}
      data-state={node.state}
      data-critical={onCriticalPath ? "true" : undefined}
      title={`${node.displayName} · ${STATE_LABEL[node.state]}`}
      // Keyboard focus gets an OUTLINE, not a ring: Tailwind's ring is a
      // box-shadow, and the inline `boxShadow` below (the critical-path stripe)
      // would beat it on specificity and swallow it silently.
      className="group relative flex h-full w-full cursor-pointer flex-col justify-center overflow-hidden px-2.5 focus-visible:[outline:2px_solid_var(--color-accent)] focus-visible:[outline-offset:1px]"
      style={{
        borderRadius: RADII.md,
        background: backgroundFor(node.state, isSelected),
        // Two non-colour channels live in this border: the STYLE says whether
        // the job ran at all, the extra weight says it is selected.
        border: `${outlined ? 1.5 : 1}px ${STATE_BORDER_STYLE[node.state]} ${
          outlined ? COLORS.accent : tint(stateColor, node.state === "queued" ? 45 : 34)
        }`,
        boxShadow: onCriticalPath ? `inset 3px 0 0 0 ${COLORS.accent}` : `inset 3px 0 0 0 ${stateColor}`,
      }}
    >
      {/* Both handles, always. React Flow caches a node's handle bounds and only
          recomputes them on a size, type or position change — the handles are
          1x1 and absolutely positioned, so adding one to a mounted node changes
          none of those, and the edges that need it silently fail to draw. */}
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />

      <div className="flex items-center gap-1.5">
        <StateIcon state={node.state} />
        <span
          className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
          style={{ color: COLORS.textPrimary, fontFamily: SANS_FONT }}
        >
          {node.displayName}
        </span>
        {node.detailsUrl ? (
          <OpenOnGitHubButton url={node.detailsUrl} name={node.displayName} padding={1} />
        ) : null}
        <span
          className="shrink-0 text-[10.5px] font-medium tabular-nums"
          style={{
            color: node.state === "running" ? COLORS.warning : COLORS.textDim,
            fontFamily: MONO_FONT,
          }}
          data-testid="pr-checks-node-duration"
        >
          {elapsedLabel ?? STATE_LABEL[node.state]}
        </span>
      </div>

      {node.legs.length > 0 ? (
        <>
          <div className="mt-[5px] flex gap-[3px] pl-[19px]" data-testid="pr-checks-node-legs">
            {node.legs.map((leg, index) => (
              <i
                key={`${leg.name}-${index}`}
                data-testid="pr-checks-node-leg"
                data-leg-state={leg.state}
                title={`${leg.name} · ${STATE_LABEL[leg.state]}`}
                className="block h-[3px] flex-1 rounded-[2px]"
                style={{
                  background: STATE_COLOR[leg.state],
                  // A leg that never ran is a hairline outline, not a filled
                  // bar, so the strip is readable without colour.
                  opacity: leg.state === "queued" || leg.state === "skipped" ? 0.4 : 1,
                }}
              />
            ))}
          </div>
          {legCaption ? (
            <div
              className="mt-1 truncate pl-[19px] text-[10px]"
              style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
              data-testid="pr-checks-node-leg-caption"
            >
              {legCaption}
            </div>
          ) : null}
        </>
      ) : null}

      {progress ? (
        <div className="mt-[6px] flex items-center gap-1.5 pl-[19px]" data-testid="pr-checks-node-progress">
          <span
            className="h-[2px] flex-1 overflow-hidden rounded-[2px]"
            style={{ background: tint(COLORS.textDim, 25) }}
          >
            <i className="block h-full" style={{ width: `${progress.pct}%`, background: COLORS.warning }} />
          </span>
          <span
            className="shrink-0 text-[9.5px] tabular-nums"
            style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}
            title={progress.currentStepName ?? undefined}
          >
            {progress.done}/{progress.total}
          </span>
        </div>
      ) : null}
    </div>
  );
});

export default PrChecksGraphNode;
