import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";

import { cn } from "../../ui/cn";
import { pluginIcon } from "../../plugins/pluginIcons";
import { SOCKET_TONE_COLOR } from "../../plugins/sockets/socketUi";
import type { GraphNodeData } from "../graphTypes";

/**
 * A shape a plugin contributed to the canvas.
 *
 * Deliberately one step quieter than a lane card, the same bargain
 * `SocketBadge` strikes on a row: narrower, dashed, smaller type, and the
 * plugin's name always visible under it. A plugin gets to be present on the
 * diagram; it does not get to look like a branch.
 *
 * The attribution line is not decoration. Everything else on this canvas is
 * something git or GitHub said, and a card that read as ADE's own while
 * asserting whatever a third party published would be the one genuinely
 * dishonest pixel on the tab.
 */
export function GraphPluginNode({ data, selected }: NodeProps<Node<GraphNodeData>>) {
  const entry = data.pluginNode;
  // React Flow selects this renderer by `type`, and only the overlay builder
  // sets that type — but the data is still typed as the shared node shape, so
  // the absence of an entry is a wiring bug rather than a state to draw.
  if (!entry) return null;
  const { payload, identity } = entry;
  const tone = SOCKET_TONE_COLOR[payload.tone];
  // The plugin's own accent wins over the payload tone for the FRAME, so two
  // plugins annotating the same lane are told apart at a glance; the tone stays
  // on the label, where it carries the per-node meaning.
  const frame = identity.accent || tone;
  const Icon = pluginIcon(payload.icon ?? identity.icon ?? undefined);
  const pressable = typeof data.onPressPluginNode === "function";

  return (
    <div
      data-tour="plugin:lanes.graph-node"
      data-plugin-id={identity.pluginId}
      className={cn(
        "group relative rounded-lg border border-dashed bg-card/85 px-2 py-1.5 text-[11px] shadow-sm transition-all duration-150",
        selected && "ring-2 ring-accent",
        data.dimmed && "opacity-30",
        pressable && "cursor-pointer hover:bg-card"
      )}
      style={{ width: 168, borderColor: `color-mix(in srgb, ${frame} 55%, transparent)` }}
      title={payload.detail ? `${payload.label} — ${payload.detail}` : payload.label}
    >
      <div className="flex items-center gap-1.5">
        <Icon size={13} weight="regular" color={tone} />
        <span className="truncate font-medium" style={{ color: tone }}>
          {payload.label}
        </span>
      </div>
      {payload.detail ? (
        <div className="mt-0.5 truncate text-[10px] text-muted-fg">{payload.detail}</div>
      ) : null}
      <div
        className="mt-1 truncate text-[9px] uppercase tracking-[0.08em]"
        style={{ color: `color-mix(in srgb, ${frame} 72%, var(--color-muted-fg))` }}
      >
        {identity.displayName}
      </div>
      <Handle
        id="target"
        type="target"
        position={Position.Top}
        style={{ width: 8, height: 8, opacity: 0, pointerEvents: "none", border: 0, background: "transparent" }}
      />
      <Handle
        id="source"
        type="source"
        position={Position.Bottom}
        style={{ width: 8, height: 8, opacity: 0, pointerEvents: "none", border: 0, background: "transparent" }}
      />
    </div>
  );
}
