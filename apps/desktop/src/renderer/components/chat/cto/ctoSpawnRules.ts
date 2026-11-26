import type {
  ChatTranscriptGroupedEnvelope,
  ChatTranscriptRenderEnvelope,
  ChatWorkLogEntry,
  SubagentCardGridMember,
} from "../chatTranscriptRows";
import { ctoRemoteSpawnForEntry, ctoToolBaseName, ctoToolResultRecord } from "./ctoToolWords";

/**
 * A child chat the CTO started for real work: it gets its own "Started a new
 * task" row. Everything else the CTO starts (a read-only helper chat, a
 * provider's native subagent, a workflow agent) is a background task.
 */
export function isCtoStartedTask(member: SubagentCardGridMember): boolean {
  const { event } = member;
  return Boolean(event.childSessionId?.trim()) && event.readOnly !== true && !event.workflowName && !event.workflowProgress;
}

export function splitCtoSpawnMembers(members: readonly SubagentCardGridMember[]): {
  tasks: SubagentCardGridMember[];
  helpers: SubagentCardGridMember[];
} {
  const tasks: SubagentCardGridMember[] = [];
  const helpers: SubagentCardGridMember[] = [];
  for (const member of members) (isCtoStartedTask(member) ? tasks : helpers).push(member);
  return { tasks, helpers };
}

/**
 * The providers' own subagent tools (Claude `Agent`/`Task`, Codex
 * `spawn_agent`, OpenCode and Cursor `task`, Cursor `subagent`). Never an MCP
 * call: an MCP server's own `task` tool is not a spawn.
 */
const NATIVE_SPAWN_TOOL_NAMES: ReadonlySet<string> = new Set(["Agent", "Task", "task", "subagent", "spawn_agent"]);

/**
 * A finished spawn call that a spawn row already stands for, so it leaves the
 * turn's tool list: a local `spawnChat` that started a chat (its subagent card
 * draws the row) or a native subagent tool. A remote or ADE Cloud spawn draws
 * its own row from the call (`ctoRemoteSpawnForEntry`), and a failed spawn
 * stays in the list and draws a "Couldn't start" chip, so nothing the
 * person should see goes missing.
 */
export function isCtoSpawnToolEntry(entry: ChatWorkLogEntry): boolean {
  if (entry.entryKind !== "tool" || entry.status !== "completed") return false;
  const name = ctoToolBaseName(entry.toolName, entry.mcp?.tool ?? null);
  if (name === "spawnChat") {
    if (ctoRemoteSpawnForEntry(entry)) return false;
    const result = ctoToolResultRecord(entry.result);
    return result?.success !== false && typeof result?.sessionId === "string" && result.sessionId.length > 0;
  }
  return !entry.mcp && !/^mcp(__|\.)/.test((entry.toolName ?? "").trim()) && NATIVE_SPAWN_TOOL_NAMES.has(name);
}

/** Entries keep their identity while their row is unchanged, so a streamed event re-checks only new ones. */
const spawnToolEntryCache = new WeakMap<ChatWorkLogEntry, boolean>();

function isCachedCtoSpawnToolEntry(entry: ChatWorkLogEntry): boolean {
  let hit = spawnToolEntryCache.get(entry);
  if (hit === undefined) {
    hit = isCtoSpawnToolEntry(entry);
    spawnToolEntryCache.set(entry, hit);
  }
  return hit;
}

/**
 * A child chat's card whose first start is in an older page: the card came
 * from a later turn's result or restart. The "finished its turn" line already
 * reports that turn, and a second "Started a new task" row would be wrong.
 */
function isUnloadedChildCard(event: ChatTranscriptGroupedEnvelope["event"]): boolean {
  return (event.type === "subagent_spawn_anchor" || event.type === "subagent_result_card")
    && event.startNotLoaded === true
    && Boolean(event.childSessionId?.trim());
}

/**
 * The CTO thread's pass over the grouped rows, before the card grids form:
 * - A finished spawn call leaves its turn's tool list (the spawn row stands
 *   for it). A running one stays: the working line names it.
 * - A run of stopped cards goes back to its cards, so it draws as spawn rows
 *   and not as a "N agents stopped" card.
 * - A child chat's card with no loaded start draws nothing.
 * `visible` is the input of the grouping pass; it holds a stopped run's cards.
 */
export function ctoTranscriptRows(
  grouped: ChatTranscriptGroupedEnvelope[],
  visible: readonly ChatTranscriptRenderEnvelope[],
): ChatTranscriptGroupedEnvelope[] {
  let changed = false;
  let visibleByKey: Map<string, ChatTranscriptRenderEnvelope> | null = null;
  const out: ChatTranscriptGroupedEnvelope[] = [];
  for (const row of grouped) {
    const { event } = row;
    if (event.type === "work_log_group") {
      const entries = event.entries.filter((entry) => !isCachedCtoSpawnToolEntry(entry));
      if (entries.length === event.entries.length) {
        out.push(row);
      } else {
        changed = true;
        if (entries.length > 0) out.push({ ...row, event: { ...event, entries } });
      }
      continue;
    }
    if (event.type === "subagent_stopped_group") {
      changed = true;
      visibleByKey ??= new Map(visible.map((member) => [member.key, member]));
      for (const key of event.memberKeys) {
        const member = visibleByKey.get(key);
        if (member && !isUnloadedChildCard(member.event)) out.push(member);
      }
      continue;
    }
    if (isUnloadedChildCard(event)) {
      changed = true;
      continue;
    }
    out.push(row);
  }
  return changed ? out : grouped;
}
