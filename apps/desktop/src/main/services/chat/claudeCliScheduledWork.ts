import fs from "node:fs";
import { claudeSessionPath } from "../externalSessions/discoverClaude";

/**
 * Native scheduled work (`ScheduleWakeup`, `CronCreate`, `CronDelete`, and the
 * `/loop` built on them) from a tracked Claude Code CLI, read from the CLI's
 * own session JSONL.
 *
 * An ADE chat mirrors these into ADE's durable scheduler from the SDK's
 * PostToolUse hook. A CLI has no hook ADE owns, but Claude Code writes every
 * tool call and its result to `~/.claude/projects/<cwd>/<session>.jsonl`, and
 * a successful scheduling call carries its structured result there
 * (`toolUseResult`: `scheduledFor` for a wakeup, `id`/`recurring`/`durable`
 * for a cron). Only calls that succeeded are returned; a failed or still
 * running call has no `toolUseResult` and is left out.
 */

export type ClaudeCliScheduleEvent =
  | {
    kind: "wakeup";
    toolUseId: string;
    at: string;
    prompt: string;
    reason: string | null;
    /** The provider's clamped fire time, epoch ms. */
    fireAt: number;
  }
  | { kind: "wakeup_stop"; toolUseId: string; at: string }
  | {
    kind: "cron";
    toolUseId: string;
    at: string;
    cronId: string;
    cron: string;
    prompt: string;
    recurring: boolean;
    /** Epoch ms of the provider's next run, when it sent one. */
    nextFireAt: number | null;
  }
  | { kind: "cron_delete"; toolUseId: string; at: string; cronId: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** `Server__ScheduleWakeup` / `mcp__x__CronCreate` → the base tool name. */
function baseToolName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}

/**
 * Successful scheduling calls in JSONL order, newer than `afterTimestamp`
 * (the record's `timestamp`, ISO). Duplicate records of one call (a sidechain
 * copy) resolve to one event.
 */
export function extractClaudeCliScheduleEvents(
  lines: readonly string[],
  afterTimestamp: string | null = null,
): ClaudeCliScheduleEvent[] {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const events: ClaudeCliScheduleEvent[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!line.includes("ScheduleWakeup") && !line.includes("Cron") && !line.includes("tool_result")) continue;
    let record: Record<string, unknown> | null;
    try {
      record = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record) continue;
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message!.content as unknown[] : [];
    for (const raw of content) {
      const block = asRecord(raw);
      if (!block) continue;
      if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
        const name = baseToolName(block.name);
        if (name === "ScheduleWakeup" || name === "CronCreate" || name === "CronDelete") {
          uses.set(block.id, { name, input: asRecord(block.input) ?? {} });
        }
        continue;
      }
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const use = uses.get(block.tool_use_id);
      const result = asRecord(record.toolUseResult);
      if (!use || !result || block.is_error === true || seen.has(block.tool_use_id)) continue;
      const at = text(record.timestamp) ?? "";
      if (afterTimestamp && at && at <= afterTimestamp) continue;
      seen.add(block.tool_use_id);
      const toolUseId = block.tool_use_id;
      if (use.name === "ScheduleWakeup") {
        if (result.stopped === true || use.input.stop === true) {
          events.push({ kind: "wakeup_stop", toolUseId, at });
          continue;
        }
        const fireAt = typeof result.scheduledFor === "number" && Number.isFinite(result.scheduledFor) && result.scheduledFor > 0
          ? result.scheduledFor
          : null;
        const prompt = text(use.input.prompt) ?? text(use.input.reason);
        if (fireAt == null || !prompt || use.input.noop === true) continue;
        events.push({ kind: "wakeup", toolUseId, at, prompt, reason: text(use.input.reason), fireAt });
        continue;
      }
      if (use.name === "CronCreate") {
        const cronId = text(result.id);
        const cron = text(use.input.cron);
        const prompt = text(use.input.prompt);
        if (!cronId || !cron || !prompt) continue;
        events.push({
          kind: "cron",
          toolUseId,
          at,
          cronId,
          cron,
          prompt,
          recurring: typeof result.recurring === "boolean" ? result.recurring : use.input.recurring !== false,
          nextFireAt: typeof result.nextFireAt === "number" && Number.isFinite(result.nextFireAt) ? result.nextFireAt : null,
        });
        continue;
      }
      const cronId = text(use.input.id) ?? text(result.id);
      if (cronId) events.push({ kind: "cron_delete", toolUseId, at, cronId });
    }
  }
  return events;
}

const SESSION_TAIL_BYTES = 512 * 1024;

/** The last part of a Claude Code session JSONL, whole lines only; [] when unreadable. */
export async function readClaudeCliSessionTail(args: {
  targetId: string | null | undefined;
  cwd: string | null | undefined;
  /** The account's `CLAUDE_CONFIG_DIR` the CLI ran under; null for the default. */
  configDir?: string | null;
}): Promise<string[]> {
  const configDir = args.configDir?.trim() || null;
  const targetId = args.targetId?.trim();
  const cwd = args.cwd?.trim();
  if (!targetId || !cwd) return [];
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(claudeSessionPath({ sessionId: targetId, cwd, ...(configDir ? { configDir } : {}) }), "r");
    const stat = await handle.stat();
    const length = Math.min(stat.size, SESSION_TAIL_BYTES);
    if (length <= 0) return [];
    const offset = stat.size - length;
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u);
    if (offset > 0) lines.shift();
    return lines.filter((line) => line.trim().length > 0);
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The newest record time in a Claude Code session JSONL tail, epoch ms; null when none has one. */
export function lastClaudeCliRecordMs(lines: readonly string[]): number | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record: unknown;
    try {
      record = JSON.parse(lines[index] ?? "");
    } catch {
      continue;
    }
    const stamp = asRecord(record)?.timestamp;
    const ms = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}
