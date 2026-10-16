import { PaneTooltip } from "../ui/PaneTooltip";
import { workToolDefinition } from "./workTools";

/**
 * The small tool mark beside a lane name for App Control and the browser: this
 * lane has an app under App Control, or an agent of this lane owns a browser
 * tab. Same size and slot as the Apple and Mac Desktop marks, in the tool's own
 * glyph and colour — the ones its Work tab and floating preview show — so the
 * mark names the tool before the tooltip does.
 */
export function LaneWorkToolMarker({
  tool,
  laneId,
  label,
}: {
  tool: "app-control" | "browser";
  laneId: string;
  label: string;
}) {
  const definition = workToolDefinition(tool);
  if (!definition) return null;
  const Icon = definition.icon;
  return (
    <PaneTooltip label={label} className="shrink-0 items-center">
      <span
        role="img"
        aria-label={label}
        data-lane-work-tool={tool}
        data-lane-work-tool-lane={laneId}
        className="inline-flex shrink-0 items-center"
      >
        <Icon size={11} weight="regular" aria-hidden className="shrink-0" style={{ color: definition.color }} />
      </span>
    </PaneTooltip>
  );
}
