import type { AgentChatSessionStatus } from "../../../shared/types";
import type { ChatScheduledWorkSnapshot, ChatSubagentSnapshot } from "./chatExecutionSummary";

/**
 * Renderer-side truth check for "running" rows in the chat-actions pane.
 *
 * The pane is derived entirely from the event stream, and the Claude Agent SDK
 * emits nothing when a parent process exits — so a subagent or background row
 * that was running at that moment renders "running" until something writes a
 * terminal event. The main-process sweep writes those events, but it is a
 * sweep: it lands late, it can be behind a backlog, and a client reading a
 * synced transcript may see the stale rows before the owning host has run it at
 * all. So the pane also heals what it can see for itself.
 *
 * Both signals are POSITIVE statements, never guesses:
 *  - `runtimeAlive === false` — the host says it holds no provider runtime for
 *    this chat. `undefined` means an older host that cannot say, and nothing is
 *    healed on an unknown.
 *  - `childChatStatuses` — the session status of a spawned ADE subagent chat.
 *    A row whose own chat is idle or ended is not running, whatever the parent
 *    runtime is doing.
 */
export type ChatPaneLivenessContext = {
  /** `false` = the host holds no runtime for this chat. `undefined` = unknown. */
  runtimeAlive?: boolean;
  /** Session status by spawned-chat session id, for rows that map to ADE chats. */
  childChatStatuses?: ReadonlyMap<string, AgentChatSessionStatus>;
};

export const PANE_SELF_HEAL_RUNTIME_GONE_SUMMARY = "Stopped: the runtime process exited";
export const PANE_SELF_HEAL_CHAT_IDLE_SUMMARY = "Stopped: the subagent chat is idle";
export const PANE_SELF_HEAL_CHAT_ENDED_SUMMARY = "Stopped: the subagent chat ended";

/**
 * The spawned chat a subagent row stands for, if any. Mirrors the main-side
 * candidate rule: `deriveChatSubagentSnapshots` already resolves
 * `childSessionId` for spawned rows, and the `chat:<id>` taskId is the fallback
 * for a snapshot folded before that field existed.
 */
export function paneRowChildSessionId(snapshot: ChatSubagentSnapshot): string | null {
  const explicit = snapshot.childSessionId?.trim();
  if (explicit) return explicit;
  const taskId = snapshot.taskId?.trim() ?? "";
  if (!taskId.startsWith("chat:")) return null;
  const child = taskId.slice("chat:".length).trim();
  return child.length ? child : null;
}

function healedSummary(snapshot: ChatSubagentSnapshot, fallback: string): string {
  const own = snapshot.summary?.trim();
  return own && own !== snapshot.description.trim() ? own : fallback;
}

/**
 * Rewrite every subagent row that claims to be running but demonstrably is not.
 *
 * Returns the same array identity when nothing changes, so the pane's memos do
 * not re-render on a healthy chat.
 */
export function selfHealSubagentSnapshots(
  snapshots: ChatSubagentSnapshot[],
  context: ChatPaneLivenessContext,
): ChatSubagentSnapshot[] {
  const runtimeGone = context.runtimeAlive === false;
  const statuses = context.childChatStatuses;
  if (!runtimeGone && !statuses?.size) return snapshots;

  let changed = false;
  const healed = snapshots.map((snapshot) => {
    if (snapshot.status !== "running") return snapshot;
    const childSessionId = paneRowChildSessionId(snapshot);
    const childStatus = childSessionId ? statuses?.get(childSessionId) : undefined;
    // A delegate chat that is still active outlives its parent's runtime and is
    // genuinely running. This is the one case that must keep saying "running".
    if (childStatus === "active") return snapshot;
    const fallback = childStatus === "ended"
      ? PANE_SELF_HEAL_CHAT_ENDED_SUMMARY
      : childStatus === "idle"
        ? PANE_SELF_HEAL_CHAT_IDLE_SUMMARY
        : PANE_SELF_HEAL_RUNTIME_GONE_SUMMARY;
    if (!runtimeGone && childStatus === undefined) return snapshot;
    changed = true;
    const summary = healedSummary(snapshot, fallback);
    return {
      ...snapshot,
      status: "stopped" as const,
      summary,
      finalSummary: snapshot.finalSummary ?? summary,
    };
  });
  return changed ? healed : snapshots;
}

/**
 * Background commands have no second source of truth — the shell died with the
 * runtime — so a dead runtime terminalizes every open row.
 */
export function selfHealBackgroundSnapshots(
  items: ChatScheduledWorkSnapshot[],
  context: ChatPaneLivenessContext,
): ChatScheduledWorkSnapshot[] {
  if (context.runtimeAlive !== false) return items;
  let changed = false;
  const healed = items.map((item) => {
    if (item.status !== "running" && item.status !== "fired" && item.status !== "scheduled") return item;
    changed = true;
    const own = item.summary?.trim();
    return {
      ...item,
      status: "stopped" as const,
      summary: own && own !== item.title.trim() ? own : PANE_SELF_HEAL_RUNTIME_GONE_SUMMARY,
    };
  });
  return changed ? healed : items;
}
