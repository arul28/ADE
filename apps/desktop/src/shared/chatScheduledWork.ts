import type {
  AgentChatEventEnvelope,
  AgentChatScheduledWorkKind,
  AgentChatScheduledWorkOrigin,
  AgentChatScheduledWorkStatus,
} from "./types";

export type ChatScheduledWorkSnapshot = {
  id: string;
  kind: AgentChatScheduledWorkKind;
  status: AgentChatScheduledWorkStatus;
  origin?: AgentChatScheduledWorkOrigin;
  title: string;
  summary: string | null;
  prompt?: string;
  reason?: string;
  cron?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  recurring?: boolean;
  durable?: boolean;
  sourceToolUseId?: string;
  sourceTaskId?: string;
  turnId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

function defaultScheduledWorkTitle(kind: AgentChatScheduledWorkKind): string {
  switch (kind) {
    case "wakeup":
      return "Scheduled wakeup";
    case "cron":
      return "Scheduled task";
    case "loop":
      return "Loop wakeup";
    case "remote_trigger":
      return "Remote trigger";
    case "background_task":
      return "Background work";
  }
}

function compareIsoDesc(left: string, right: string): number {
  return Date.parse(right) - Date.parse(left);
}

export function deriveScheduledWorkSnapshots(events: AgentChatEventEnvelope[]): ChatScheduledWorkSnapshot[] {
  const snapshots = new Map<string, ChatScheduledWorkSnapshot>();
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type !== "scheduled_work_update") continue;
    const existing = snapshots.get(event.id);
    snapshots.set(event.id, {
      id: event.id,
      kind: event.kind,
      status: event.status,
      origin: event.origin ?? existing?.origin,
      title: event.title?.trim() || existing?.title || defaultScheduledWorkTitle(event.kind),
      summary: event.summary?.trim() || existing?.summary || null,
      prompt: event.prompt ?? existing?.prompt,
      reason: event.reason ?? existing?.reason,
      cron: event.cron ?? existing?.cron,
      nextRunAt: event.nextRunAt ?? existing?.nextRunAt,
      lastRunAt: event.lastRunAt ?? existing?.lastRunAt,
      recurring: event.recurring ?? existing?.recurring,
      durable: event.durable ?? existing?.durable,
      sourceToolUseId: event.sourceToolUseId ?? existing?.sourceToolUseId,
      sourceTaskId: event.sourceTaskId ?? existing?.sourceTaskId,
      turnId: event.turnId ?? existing?.turnId,
      error: event.error ?? existing?.error,
      createdAt: existing?.createdAt ?? envelope.timestamp,
      updatedAt: envelope.timestamp,
    });
  }
  return [...snapshots.values()].sort((left, right) => compareIsoDesc(left.updatedAt, right.updatedAt));
}
