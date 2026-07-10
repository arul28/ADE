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
  const terminalTurnEventIndex = new Map<string, number>();
  const lastNonTerminalUpdateIndex = new Map<string, number>();
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const envelope = events[eventIndex]!;
    const event = envelope.event;
    if (
      (event.type === "done" || (event.type === "status" && event.turnStatus !== "started"))
      && event.turnId
    ) {
      terminalTurnEventIndex.set(event.turnId, eventIndex);
    }
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
    if (event.status === "scheduled" || event.status === "running") {
      lastNonTerminalUpdateIndex.set(event.id, eventIndex);
    }
  }

  for (const [id, snapshot] of snapshots) {
    if (
      snapshot.kind !== "background_task"
      || (snapshot.status !== "scheduled" && snapshot.status !== "running")
      || !snapshot.turnId
    ) {
      continue;
    }
    const finishedAt = terminalTurnEventIndex.get(snapshot.turnId);
    const lastNonTerminalAt = lastNonTerminalUpdateIndex.get(id);
    if (finishedAt != null && lastNonTerminalAt != null && finishedAt > lastNonTerminalAt) {
      snapshots.set(id, { ...snapshot, status: "stopped" });
    }
  }
  return [...snapshots.values()].sort((left, right) => compareIsoDesc(left.updatedAt, right.updatedAt));
}

const SCHEDULE_KINDS = new Set<AgentChatScheduledWorkKind>([
  "wakeup",
  "cron",
  "loop",
  "remote_trigger",
]);

export function deriveScheduleItems(events: AgentChatEventEnvelope[]): ChatScheduledWorkSnapshot[] {
  return deriveScheduledWorkSnapshots(events).filter((snapshot) => SCHEDULE_KINDS.has(snapshot.kind));
}

export function deriveBackgroundItems(events: AgentChatEventEnvelope[]): ChatScheduledWorkSnapshot[] {
  return deriveScheduledWorkSnapshots(events).filter((snapshot) => snapshot.kind === "background_task");
}

function firstMeaningfulLine(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0) ?? "";
}

export function backgroundCommandLabel(titleOrCommand: string): string {
  let original: string;
  try {
    original = firstMeaningfulLine(String(titleOrCommand ?? ""));
  } catch {
    return "";
  }
  if (!original) return "";

  let label = original;
  for (let pass = 0; pass < 32; pass += 1) {
    const before = label;
    label = label
      .replace(/^cd\s+(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|(?:\\.|[^\s&])+?)\s*&&\s*/i, "")
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]*)\s+)+/, "")
      .replace(/^(?:nohup|exec)\s+/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (label === before || !label) break;
  }
  return label || original;
}

/**
 * Extract the working directory from a leading `cd <path> && …` prefix on a
 * background command (the same wrapper backgroundCommandLabel strips). Returns
 * the path (quotes removed) or null when there is no `cd` prefix. Used by the
 * actions pane to show a dim cwd chip on the expanded background row.
 */
export function backgroundCommandCwd(titleOrCommand: string): string | null {
  const source = firstMeaningfulLine(String(titleOrCommand ?? ""));
  if (!source) return null;
  const match = /^cd\s+("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|(?:\\.|[^\s&])+?)\s*&&/i.exec(source);
  if (!match) return null;
  const raw = match[1]!.trim();
  if ((raw.startsWith("\"") && raw.endsWith("\"")) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

type ParsedCronField = {
  values: Set<number>;
  unrestricted: boolean;
};

type ParsedCron = {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
};

function parseCronField(
  source: string,
  minimum: number,
  maximum: number,
  normalize: (value: number) => number = (value) => value,
): ParsedCronField | null {
  if (!source || /\s/.test(source)) return null;
  const values = new Set<number>();
  for (const part of source.split(",")) {
    if (!part) return null;
    if (part === "*") {
      for (let value = minimum; value <= maximum; value += 1) values.add(normalize(value));
      continue;
    }
    const stepMatch = /^\*\/(\d+)$/.exec(part);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!Number.isInteger(step) || step <= 0) return null;
      for (let value = minimum; value <= maximum; value += step) values.add(normalize(value));
      continue;
    }
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < minimum || value > maximum) return null;
    values.add(normalize(value));
  }

  const allValues = new Set<number>();
  for (let value = minimum; value <= maximum; value += 1) allValues.add(normalize(value));
  return { values, unrestricted: values.size === allValues.size };
}

function parseCron(source: string): ParsedCron | null {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minute = parseCronField(fields[0]!, 0, 59);
  const hour = parseCronField(fields[1]!, 0, 23);
  const dayOfMonth = parseCronField(fields[2]!, 1, 31);
  const month = parseCronField(fields[3]!, 1, 12);
  const dayOfWeek = parseCronField(fields[4]!, 0, 7, (value) => value === 7 ? 0 : value);
  return minute && hour && dayOfMonth && month && dayOfWeek
    ? { minute, hour, dayOfMonth, month, dayOfWeek }
    : null;
}

function cronMatches(cron: ParsedCron, date: Date): boolean {
  if (!cron.minute.values.has(date.getMinutes())) return false;
  if (!cron.hour.values.has(date.getHours())) return false;
  if (!cron.month.values.has(date.getMonth() + 1)) return false;

  const dayOfMonthMatches = cron.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatches = cron.dayOfWeek.values.has(date.getDay());
  if (cron.dayOfMonth.unrestricted) return dayOfWeekMatches;
  if (cron.dayOfWeek.unrestricted) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

function nextCronFireAt(cron: string, nowMs: number): number | null {
  const parsed = parseCron(cron);
  if (!parsed || !Number.isFinite(nowMs)) return null;
  const candidate = new Date(nowMs);
  if (!Number.isFinite(candidate.getTime())) return null;
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxMinutes = 60 * 24 * 366 * 5;
  for (let minute = 0; minute < maxMinutes; minute += 1) {
    if (cronMatches(parsed, candidate)) return candidate.getTime();
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}

function compactRelativeDuration(durationMs: number): string {
  const totalMinutes = Math.max(0, Math.ceil(durationMs / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export function scheduledNextFireLabel(
  snapshot: ChatScheduledWorkSnapshot,
  nowMs: number,
): string | null {
  if ((snapshot.kind !== "cron" && snapshot.kind !== "wakeup") || !Number.isFinite(nowMs)) return null;

  const explicitNextRunAt = snapshot.nextRunAt ? Date.parse(snapshot.nextRunAt) : Number.NaN;
  const nextFireAt = Number.isFinite(explicitNextRunAt)
    ? explicitNextRunAt
    : snapshot.kind === "cron" && snapshot.cron
      ? nextCronFireAt(snapshot.cron, nowMs)
      : null;
  if (nextFireAt == null || !Number.isFinite(nextFireAt)) return null;

  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(nextFireAt));
  return `next in ${compactRelativeDuration(Math.max(0, nextFireAt - nowMs))} · ${clock}`;
}
