import type { ReactNode } from "react";
import {
  SubagentCardGrid,
  SubagentResultCard,
  SubagentSpawnCard,
  SubagentStoppedGroupCard,
} from "./SubagentActivityCards";
import type {
  SubagentCardGridEvent,
  SubagentCardGridMember,
  SubagentResultCardRenderEvent,
  SubagentSpawnAnchorRenderEvent,
  SubagentStoppedGroupEvent,
} from "./chatTranscriptRows";

export type SpawnedChatProviderProps = {
  sessionProvider?: string | null;
  resolveSpawnedChatProvider?: (sessionId: string) => string | null;
};

export type SubagentTimelineEvent =
  | SubagentSpawnAnchorRenderEvent
  | SubagentResultCardRenderEvent
  | SubagentCardGridEvent
  | SubagentStoppedGroupEvent;

export type SubagentTimelineRenderOptions = SpawnedChatProviderProps & {
  laneId?: string | null;
  chatInfoHostAvailable?: boolean;
  onOpenChatInfo?: (taskId: string) => void;
  onStopSubagent?: (taskId: string) => void;
};

function subagentCardProvider(
  explicitProvider: string | null | undefined,
  childSessionId: string | null | undefined,
  options?: SubagentTimelineRenderOptions,
): string | null {
  const declaredProvider = explicitProvider?.trim();
  if (declaredProvider) return declaredProvider;
  const childProvider = childSessionId
    ? options?.resolveSpawnedChatProvider?.(childSessionId) ?? null
    : null;
  return childProvider ?? options?.sessionProvider ?? null;
}

function renderSubagentCard(
  event: SubagentSpawnAnchorRenderEvent | SubagentResultCardRenderEvent,
  options?: SubagentTimelineRenderOptions,
): ReactNode {
  const openTranscript = !event.childSessionId && options?.chatInfoHostAvailable
    ? () => options.onOpenChatInfo?.(event.agentKey)
    : undefined;
  if (event.type === "subagent_spawn_anchor") {
    return (
      <SubagentSpawnCard
        event={event}
        laneId={options?.laneId ?? null}
        provider={subagentCardProvider(event.provider, event.childSessionId, options)}
        onOpenTranscript={openTranscript}
        onStop={event.taskId && options?.onStopSubagent
          ? (taskId) => options.onStopSubagent?.(taskId)
          : undefined}
      />
    );
  }
  return (
    <SubagentResultCard
      event={event}
      laneId={options?.laneId ?? null}
      provider={subagentCardProvider(event.provider, event.childSessionId, options)}
      onViewTranscript={openTranscript}
    />
  );
}

/** Render a lone card, a mixed grid, or a stopped group through one owner. */
export function renderSubagentTimelineRow(
  envelope: { key: string; timestamp: string; event: SubagentTimelineEvent },
  options?: SubagentTimelineRenderOptions,
): ReactNode {
  const { event } = envelope;
  if (event.type === "subagent_stopped_group") {
    return <SubagentStoppedGroupCard event={event} />;
  }
  const members: SubagentCardGridMember[] = event.type === "subagent_card_grid"
    ? event.members
    : [{ key: envelope.key, timestamp: envelope.timestamp, event }];
  return (
    <SubagentCardGrid
      members={members}
      renderCard={(member) => renderSubagentCard(member.event, options)}
    />
  );
}
