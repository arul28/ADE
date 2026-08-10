import React from "react";
import { Terminal } from "@phosphor-icons/react";
import { getModelById } from "../../../shared/modelRegistry";
import { resolveModelDescriptorWithRuntimeCatalog } from "../shared/ModelPicker/modelCatalog";
import { ModelRowLogo } from "../shared/ProviderLogos";
import { cn } from "../ui/cn";
import { COLORS } from "./laneDesignTokens";
import type { LaneAgent, LaneAgentActivity } from "./laneAgents";

function activityColor(activity: LaneAgentActivity): string {
  switch (activity) {
    case "working":
    case "monitoring": return COLORS.success;
    case "awaiting-input": return COLORS.warning;
    case "ended": return COLORS.danger;
    default: return COLORS.textDim;
  }
}

const ACTIVITY_TITLE: Record<LaneAgentActivity, string> = {
  working: "Working",
  monitoring: "Monitoring",
  "awaiting-input": "Awaiting input",
  idle: "Idle",
  ended: "Ended",
};

/** Tiny live pulse — spins while live, static dot otherwise. */
function ActivityPulse({ activity }: { activity: LaneAgentActivity }): React.ReactElement {
  const color = activityColor(activity);
  if (activity === "working" || activity === "monitoring" || activity === "awaiting-input") {
    return (
      <span
        className="shrink-0 animate-spin"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          border: `1.5px solid ${color}`,
          borderTopColor: "transparent",
          // A watch loop is live but not urgent — the same spinner, quieter, so
          // "still building" and "just watching" are told apart at a glance.
          ...(activity === "monitoring" ? { opacity: 0.55 } : {}),
        }}
        title={ACTIVITY_TITLE[activity]}
      />
    );
  }
  return (
    <span
      className="shrink-0"
      style={{ width: 8, height: 8, borderRadius: "50%", background: color }}
      title={ACTIVITY_TITLE[activity]}
    />
  );
}

export function LaneAgentRow({
  agent,
  highlighted,
  onOpen,
  compact = false,
}: {
  agent: LaneAgent;
  highlighted?: boolean;
  onOpen: (agent: LaneAgent) => void;
  compact?: boolean;
}) {
  const dead = agent.activity === "ended";
  const modelDesc = agent.modelId
    ? resolveModelDescriptorWithRuntimeCatalog(agent.modelId) ?? getModelById(agent.modelId)
    : undefined;
  const modelLabel = modelDesc?.displayName ?? agent.providerLabel;
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(agent);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
        "hover:bg-white/[0.05]",
        dead && "opacity-45",
        highlighted && "ring-1 ring-emerald-400/40",
      )}
      style={highlighted ? { background: "rgba(52,211,153,0.08)" } : undefined}
      title={agent.lastHint ?? agent.name}
    >
      <ActivityPulse activity={agent.activity} />
      {agent.kind === "cli" && !modelDesc ? (
        <Terminal size={compact ? 11 : 12} className="shrink-0 text-muted-fg/55" />
      ) : (
        <ModelRowLogo
          modelFamily={modelDesc?.family ?? "opencode"}
          cliCommand={modelDesc?.cliCommand}
          modelId={agent.modelId ?? undefined}
          providerModelId={modelDesc?.providerModelId}
          size={compact ? 11 : 12}
          className="shrink-0"
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-medium text-fg/85",
          compact ? "text-[10.5px]" : "text-[11px]",
        )}
      >
        {agent.name}
      </span>
      <span
        className={cn(
          "shrink-0 truncate text-muted-fg/55",
          compact ? "text-[9px]" : "text-[10px]",
        )}
        style={{ maxWidth: compact ? 70 : 96 }}
      >
        {modelLabel}
      </span>
      {highlighted && !dead ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 font-medium text-emerald-300/90",
            compact ? "text-[8.5px]" : "text-[9px]",
          )}
          style={{ background: "rgba(52,211,153,0.16)" }}
        >
          new
        </span>
      ) : null}
    </button>
  );
}

/**
 * Inline per-lane agent dashboard: lists all agents (ADE chat + CLI; shells
 * excluded), dead ones dimmed, each clickable to open in the Work tab. Shared
 * by the Lanes stack drawer, the graph lane cards, and the lane list rows.
 */
export function LaneAgentList({
  agents,
  highlightedSessionIds,
  onOpenAgent,
  compact = false,
  emptyHint,
}: {
  agents: LaneAgent[];
  highlightedSessionIds?: Set<string>;
  onOpenAgent: (agent: LaneAgent) => void;
  compact?: boolean;
  emptyHint?: string;
}) {
  if (!agents.length) {
    if (!emptyHint) return null;
    return (
      <div className={cn("px-2 py-1 text-muted-fg/45", compact ? "text-[9.5px]" : "text-[10px]")}>
        {emptyHint}
      </div>
    );
  }
  return (
    <div className="space-y-0.5">
      {agents.map((agent) => (
        <LaneAgentRow
          key={agent.sessionId}
          agent={agent}
          highlighted={highlightedSessionIds?.has(agent.sessionId)}
          onOpen={onOpenAgent}
          compact={compact}
        />
      ))}
    </div>
  );
}
