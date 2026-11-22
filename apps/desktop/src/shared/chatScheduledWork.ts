import type {
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatScheduledWorkItem,
  AgentChatScheduledWorkKind,
  AgentChatScheduledWorkOrigin,
  AgentChatScheduledWorkStatus,
} from "./types";
import { isRealSubagent, normalizeSubagentLifecycleEvent } from "./chatSubagents";

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
  /** IANA zone the cron is read in, when it is not the brain's local time. */
  timeZone?: string;
  nextRunAt?: string;
  lastRunAt?: string;
  firedAt?: string;
  late?: boolean;
  recurring?: boolean;
  durable?: boolean;
  cancellable?: boolean;
  sourceToolUseId?: string;
  sourceTaskId?: string;
  turnId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

type ScheduledWorkUpdateEvent = Extract<AgentChatEvent, { type: "scheduled_work_update" }>;

/** Id prefix of the resume ADE arms after a restart (`updateResumeScheduleId`). */
export const UPDATE_RESUME_ID_PREFIX = "update-resume:";

/**
 * The resume ADE arms after any restart (an update, a crash) uses the fixed
 * id, so a transcript event names it by its schedule id, old transcripts too.
 * It is not scheduled work the user set up, so no surface draws it: no wake
 * line, wake divider or wake message in the transcript, and no Schedule row.
 * The restart notice already says the agent continues
 * (`isRestartInterruptedNotice`).
 */
export function isRestartResumeScheduleId(scheduleId: string | null | undefined): boolean {
  return typeof scheduleId === "string" && scheduleId.startsWith(UPDATE_RESUME_ID_PREFIX);
}

/** Scheduled work that has not fired, stopped, or failed yet. */
export const SCHEDULED_WORK_PENDING_STATUSES: ReadonlySet<AgentChatScheduledWorkStatus> = new Set([
  "scheduled",
  "paused",
  "running",
]);

/**
 * Claude fires one-shots on minute boundaries and may run a little ahead of
 * the stored fire time. Within this window of its fire time a wake-up that
 * left the provider's inventory was delivered, not dropped.
 */
export const SCHEDULED_WAKE_FIRE_TOLERANCE_MS = 30_000;

/**
 * True when a one-shot `cancelled` update really records a delivery. Older brains
 * settled a wake-up that Claude fired on its own as cancelled
 * (it left the provider inventory). That update names no tool call and no
 * stop source, and arrives at or after the fire time. A real cancel (the
 * agent's CronDelete, a user's Cancel) carries one of the two.
 */
export function cancelRecordsDelivery(
  previous: Pick<ScheduledWorkUpdateEvent, "kind" | "nextRunAt"> | undefined,
  next: ScheduledWorkUpdateEvent,
  nextTimestamp: string,
): boolean {
  if (next.status !== "cancelled" || next.sourceToolUseId || next.stopSource) return false;
  const kind = previous?.kind ?? next.kind;
  if (kind !== "wakeup" && kind !== "loop") return false;
  const dueAt = previous?.nextRunAt ? Date.parse(previous.nextRunAt) : Number.NaN;
  const at = Date.parse(nextTimestamp);
  // Old brains only reconciled after the woken turn ended, so a cancel before
  // the due time is always a real one.
  return Number.isFinite(dueAt) && Number.isFinite(at) && at >= dueAt;
}

/**
 * One schedule's latest state from its previous update and a new one. Later
 * updates often carry fewer fields (an inventory snapshot, a cancel), so the
 * new one patches the old: a reason or fire time a reader already saw is
 * never dropped. The turn id is the new update's own; a settled schedule
 * keeps no stale next-run time.
 */
export function mergeScheduledWorkEvent(
  previous: ScheduledWorkUpdateEvent | undefined,
  next: ScheduledWorkUpdateEvent,
  nextTimestamp: string,
): ScheduledWorkUpdateEvent {
  if (!previous) return next;
  const defined = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ) as ScheduledWorkUpdateEvent;
  const merged: ScheduledWorkUpdateEvent = { ...previous, ...defined };
  if (!next.turnId) delete merged.turnId;
  if (cancelRecordsDelivery(previous, next, nextTimestamp)) {
    merged.status = "completed";
    merged.firedAt = merged.firedAt ?? previous.nextRunAt;
  }
  if (!SCHEDULED_WORK_PENDING_STATUSES.has(merged.status) && next.nextRunAt === undefined) delete merged.nextRunAt;
  return merged;
}

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
    if (isRestartResumeScheduleId(event.id)) continue;
    const existing = snapshots.get(event.id);
    const deliveredNotCancelled = cancelRecordsDelivery(existing, event, envelope.timestamp);
    snapshots.set(event.id, {
      id: event.id,
      kind: event.kind,
      status: deliveredNotCancelled ? "completed" : event.status,
      origin: event.origin ?? existing?.origin,
      title: event.title?.trim() || existing?.title || defaultScheduledWorkTitle(event.kind),
      summary: event.summary?.trim() || existing?.summary || null,
      prompt: event.prompt ?? existing?.prompt,
      reason: event.reason ?? existing?.reason,
      cron: event.cron ?? existing?.cron,
      nextRunAt: event.nextRunAt ?? existing?.nextRunAt,
      lastRunAt: event.lastRunAt ?? existing?.lastRunAt,
      firedAt: event.firedAt ?? existing?.firedAt ?? (deliveredNotCancelled ? existing?.nextRunAt : undefined),
      late: event.late ?? existing?.late,
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

const ACTIVE_DURABLE_STATUSES = new Set<AgentChatScheduledWorkStatus>([
  "scheduled",
  "paused",
  "running",
  "fired",
]);

export function mergeManagedScheduledWorkSnapshots(
  events: AgentChatEventEnvelope[],
  managedWork?: AgentChatScheduledWorkItem[],
): ChatScheduledWorkSnapshot[] {
  const managedIds = new Set(managedWork?.map((item) => item.id) ?? []);
  const hasManagedRows = Boolean(managedWork?.length);
  const snapshots = new Map(
    deriveScheduledWorkSnapshots(events)
      .filter((snapshot) => !(
        hasManagedRows
        && snapshot.durable === true
        && ACTIVE_DURABLE_STATUSES.has(snapshot.status)
        && !managedIds.has(snapshot.id)
      ))
      .map((snapshot) => [snapshot.id, snapshot]),
  );

  for (const item of managedWork ?? []) {
    if (isRestartResumeScheduleId(item.id)) continue;
    snapshots.set(item.id, {
      id: item.id,
      kind: item.kind,
      status: item.status,
      origin: item.kind === "cron" ? "cron" : item.kind === "loop" ? "loop" : "schedule_wakeup",
      title: item.title,
      summary: item.outcomeSummary ?? null,
      prompt: item.prompt,
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.cron ? { cron: item.cron } : {}),
      ...(item.nextRunAt ? { nextRunAt: item.nextRunAt } : {}),
      ...(item.lastRunAt ? { lastRunAt: item.lastRunAt } : {}),
      ...(item.late ? { late: true } : {}),
      recurring: item.kind === "cron",
      durable: item.durable,
      cancellable: item.cancellable,
      createdAt: item.createdAt,
      updatedAt: item.lastRunAt ?? item.createdAt,
    });
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

const ONE_SHOT_HISTORY_STATUSES = new Set<AgentChatScheduledWorkStatus>([
  "fired",
  "completed",
]);

export function isFiredOneShotWakeup(snapshot: ChatScheduledWorkSnapshot): boolean {
  return (snapshot.kind === "wakeup" || snapshot.kind === "loop")
    && snapshot.recurring !== true
    && ONE_SHOT_HISTORY_STATUSES.has(snapshot.status);
}

export function isEarlierBackgroundItem(snapshot: ChatScheduledWorkSnapshot): boolean {
  return snapshot.status === "completed"
    || snapshot.status === "cancelled"
    || snapshot.status === "stopped";
}

export function isEarlierScheduleItem(snapshot: ChatScheduledWorkSnapshot): boolean {
  return isFiredOneShotWakeup(snapshot)
    || snapshot.status === "completed"
    || snapshot.status === "cancelled"
    || snapshot.status === "stopped";
}

export function deriveScheduleHistory(events: AgentChatEventEnvelope[]): ChatScheduledWorkSnapshot[] {
  return deriveScheduleItems(events).filter(isFiredOneShotWakeup);
}

export function deriveActiveScheduleItems(events: AgentChatEventEnvelope[]): ChatScheduledWorkSnapshot[] {
  const historyIds = new Set(deriveScheduleHistory(events).map((snapshot) => snapshot.id));
  return deriveScheduleItems(events).filter((snapshot) => !historyIds.has(snapshot.id));
}

export function deriveBackgroundItems(events: AgentChatEventEnvelope[]): ChatScheduledWorkSnapshot[] {
  const subagentIds = new Set<string>();
  for (const envelope of events) {
    const event = normalizeSubagentLifecycleEvent(envelope.event);
    if (!event) continue;
    if (!isRealSubagent({ taskType: event.taskType, agentType: event.agentType })) continue;
    if (event.taskId.trim()) subagentIds.add(event.taskId.trim());
    if (event.agentId?.trim()) subagentIds.add(event.agentId.trim());
  }

  return deriveScheduledWorkSnapshots(events).filter((snapshot) =>
    snapshot.kind === "background_task"
      && (!snapshot.sourceTaskId || !subagentIds.has(snapshot.sourceTaskId.trim())),
  );
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

  const addRange = (start: number, end: number, step: number): boolean => {
    if (
      !Number.isInteger(start)
      || !Number.isInteger(end)
      || !Number.isInteger(step)
      || step <= 0
      || start < minimum
      || end > maximum
      || start > end
    ) return false;
    for (let value = start; value <= end; value += step) values.add(normalize(value));
    return true;
  };

  for (const segment of source.split(",")) {
    if (!segment) return null;
    const stepParts = segment.split("/");
    if (stepParts.length > 2) return null;
    const [base, stepSource] = stepParts;
    const step = stepSource == null ? 1 : Number(stepSource);
    if (!base || !Number.isInteger(step) || step <= 0) return null;

    if (base === "*") {
      if (!addRange(minimum, maximum, step)) return null;
      continue;
    }

    const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
    if (rangeMatch) {
      if (!addRange(Number(rangeMatch[1]), Number(rangeMatch[2]), step)) return null;
      continue;
    }

    if (!/^\d+$/.test(base)) return null;
    const value = Number(base);
    if (!addRange(value, stepSource == null ? value : maximum, step)) return null;
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

/** A wall-clock reading: the date's own local fields, or a zone's read through UTC getters. */
function cronMatches(cron: ParsedCron, date: Date, utcFields: boolean): boolean {
  const minute = utcFields ? date.getUTCMinutes() : date.getMinutes();
  const hour = utcFields ? date.getUTCHours() : date.getHours();
  const month = (utcFields ? date.getUTCMonth() : date.getMonth()) + 1;
  if (!cron.minute.values.has(minute)) return false;
  if (!cron.hour.values.has(hour)) return false;
  if (!cron.month.values.has(month)) return false;

  const dayOfMonthMatches = cron.dayOfMonth.values.has(utcFields ? date.getUTCDate() : date.getDate());
  const dayOfWeekMatches = cron.dayOfWeek.values.has(utcFields ? date.getUTCDay() : date.getDay());
  if (cron.dayOfMonth.unrestricted) return dayOfWeekMatches;
  if (cron.dayOfWeek.unrestricted) return dayOfMonthMatches;
  return dayOfMonthMatches || dayOfWeekMatches;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat | null {
  if (zoneFormatters.has(timeZone)) return zoneFormatters.get(timeZone) ?? null;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    formatter = null;
  }
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}

/** True for an IANA time zone this runtime knows (`America/New_York`, `UTC`). */
export function isKnownTimeZone(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 64 && zoneFormatter(value) != null;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `ms`, in ms. */
function zoneOffsetMs(formatter: Intl.DateTimeFormat, ms: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour! % 24, parts.minute!, parts.second!);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant a zone's wall time (as UTC ms) names, the first one after
 * `nowMs`, or null. The offsets half a day either side bracket any DST change
 * near it: a repeated wall time has two instants (the first future one wins),
 * and a skipped one has none, so it lands just after the jump (the later
 * reading), never before it.
 */
function wallTimeToInstant(formatter: Intl.DateTimeFormat, wallMs: number, nowMs: number): number | null {
  const halfDay = 12 * 60 * 60_000;
  const candidates = [...new Set([
    wallMs - zoneOffsetMs(formatter, wallMs - halfDay),
    wallMs - zoneOffsetMs(formatter, wallMs + halfDay),
  ])].sort((a, b) => a - b);
  const exact = candidates.filter((at) => at + zoneOffsetMs(formatter, at) === wallMs);
  const picks = exact.length ? exact : [candidates[candidates.length - 1]!];
  return picks.find((at) => at > nowMs) ?? null;
}

/**
 * The next time `cron` fires after `nowMs`. With `timeZone` (an IANA zone) the
 * fields are read on that zone's wall clock, so "0 9 * * *" is 9am where the
 * person is even when the brain runs on a UTC cloud computer. Without one, or
 * with a zone this runtime does not know, they are read in the brain's local
 * time, as before.
 */
export function nextCronFireAt(cron: string, nowMs: number, timeZone?: string | null): number | null {
  const parsed = parseCron(cron);
  if (!parsed || !Number.isFinite(nowMs)) return null;
  const formatter = timeZone ? zoneFormatter(timeZone) : null;
  const maxMinutes = 60 * 24 * 366 * 5;

  if (!formatter) {
    const candidate = new Date(nowMs);
    if (!Number.isFinite(candidate.getTime())) return null;
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);
    for (let minute = 0; minute < maxMinutes; minute += 1) {
      if (cronMatches(parsed, candidate, false)) return candidate.getTime();
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return null;
  }

  // Walk the zone's wall clock (a Date read through its UTC getters), and turn
  // a match back into an instant. A wall time skipped by a DST jump lands an
  // hour later; one that repeats fires once.
  const wall = new Date(nowMs + zoneOffsetMs(formatter, nowMs));
  if (!Number.isFinite(wall.getTime())) return null;
  wall.setUTCSeconds(0, 0);
  wall.setUTCMinutes(wall.getUTCMinutes() + 1);
  for (let minute = 0; minute < maxMinutes; minute += 1) {
    if (cronMatches(parsed, wall, true)) {
      const instant = wallTimeToInstant(formatter, wall.getTime(), nowMs);
      if (instant != null) return instant;
    }
    wall.setUTCMinutes(wall.getUTCMinutes() + 1);
  }
  return null;
}

export type ResolvedScheduledWorkTiming = {
  kind: "cron" | "wakeup";
  recurring: boolean;
  fireAt: number;
  cron?: string;
};

export function resolveScheduledWorkTiming(
  input: {
    cron?: unknown;
    runAt?: unknown;
    delaySeconds?: unknown;
    recurring?: unknown;
  },
  nowMs: number,
  /** IANA zone the cron is read in; absent means the brain machine's local time. */
  timeZone?: string | null,
): ResolvedScheduledWorkTiming {
  if (input.recurring != null && typeof input.recurring !== "boolean") {
    throw new Error("Scheduled work recurring must be a boolean.");
  }
  if (input.cron != null && typeof input.cron !== "string") {
    throw new Error("Scheduled work cron must be a string.");
  }
  if (input.runAt != null && typeof input.runAt !== "string") {
    throw new Error("Scheduled work runAt must be a string.");
  }
  const cron = typeof input.cron === "string" ? input.cron.trim() : "";
  const runAt = typeof input.runAt === "string" ? input.runAt.trim() : "";
  if (typeof input.cron === "string" && !cron) {
    throw new Error("Scheduled work cron must not be empty.");
  }
  if (typeof input.runAt === "string" && !runAt) {
    throw new Error("Scheduled work runAt must not be empty.");
  }
  const hasDelaySeconds = input.delaySeconds != null;
  const scheduleInputCount = Number(Boolean(cron)) + Number(Boolean(runAt)) + Number(hasDelaySeconds);
  if (scheduleInputCount !== 1) {
    throw new Error("Scheduled work requires exactly one of cron, runAt, or delaySeconds.");
  }

  if (cron) {
    const fireAt = nextCronFireAt(cron, nowMs, timeZone);
    if (fireAt == null) {
      throw new Error(timeZone
        ? `Scheduled work cron must be a valid 5-field cron expression, read in ${timeZone}.`
        : "Scheduled work cron must be a valid 5-field cron expression in the ADE brain machine's local timezone.");
    }
    return {
      kind: input.recurring === false ? "wakeup" : "cron",
      recurring: input.recurring !== false,
      fireAt,
      cron,
    };
  }

  if (input.recurring === true) {
    throw new Error("Scheduled work runAt and delaySeconds schedules are one-shot and cannot recur.");
  }
  if (runAt) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(runAt)) {
      throw new Error("Scheduled work runAt must be an ISO 8601 timestamp with an explicit offset or Z.");
    }
    const fireAt = Date.parse(runAt);
    if (!Number.isFinite(fireAt) || fireAt <= nowMs) {
      throw new Error("Scheduled work runAt must be a valid future timestamp.");
    }
    return { kind: "wakeup", recurring: false, fireAt };
  }

  const delaySeconds = input.delaySeconds;
  if (typeof delaySeconds !== "number" || !Number.isFinite(delaySeconds) || !Number.isInteger(delaySeconds) || delaySeconds < 1) {
    throw new Error("Scheduled work delaySeconds must be a positive whole number.");
  }
  const fireAt = nowMs + delaySeconds * 1_000;
  if (!Number.isSafeInteger(fireAt) || !Number.isFinite(new Date(fireAt).getTime())) {
    throw new Error("Scheduled work delaySeconds is too large.");
  }
  return { kind: "wakeup", recurring: false, fireAt };
}

export function compactRelativeDuration(durationMs: number): string {
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
  if (
    (snapshot.kind !== "cron" && snapshot.kind !== "wakeup" && snapshot.kind !== "loop")
    || !Number.isFinite(nowMs)
  ) return null;

  const explicitNextRunAt = snapshot.nextRunAt ? Date.parse(snapshot.nextRunAt) : Number.NaN;
  const nextFireAt = Number.isFinite(explicitNextRunAt)
    ? explicitNextRunAt
    : snapshot.kind === "cron" && snapshot.cron
      ? nextCronFireAt(snapshot.cron, nowMs, snapshot.timeZone)
      : null;
  if (nextFireAt == null || !Number.isFinite(nextFireAt)) return null;

  const clock = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(nextFireAt));
  return `next in ${compactRelativeDuration(Math.max(0, nextFireAt - nowMs))} · ${clock}`;
}
