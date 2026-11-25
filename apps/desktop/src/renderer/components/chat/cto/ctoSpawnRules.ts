import type { ChatWorkLogEntry, SubagentCardGridMember } from "../chatTranscriptRows";
import { ctoRemoteSpawnForEntry, ctoToolBaseName } from "./ctoToolWords";

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
 * Tool calls whose only trace in the CTO thread is a spawn row: `spawnChat`
 * and the providers' own subagent tools (Claude `Agent`/`Task`, Codex
 * `spawn_agent`, OpenCode `task`, Cursor `task`). They leave the turn's tool
 * list so the thread shows one row per spawn and no tool noise.
 */
const CTO_SPAWN_TOOL_NAMES: ReadonlySet<string> = new Set(["spawnChat", "Agent", "Task", "task", "spawn_agent"]);

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
  if (!CTO_SPAWN_TOOL_NAMES.has(name)) return false;
  if (name !== "spawnChat") return true;
  return !ctoRemoteSpawnForEntry(entry) && spawnChatStartedLocally(entry.result);
}

/** The `spawnChat` result names the chat it made (object, JSON text, or MCP text content). */
function spawnChatStartedLocally(result: unknown): boolean {
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (!value || typeof value !== "object") return false;
  const content = (value as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const text = content.find((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text") as { text?: unknown } | undefined;
    if (typeof text?.text === "string") return spawnChatStartedLocally(text.text);
  }
  const record = value as { success?: unknown; sessionId?: unknown };
  return record.success !== false && typeof record.sessionId === "string" && record.sessionId.length > 0;
}
