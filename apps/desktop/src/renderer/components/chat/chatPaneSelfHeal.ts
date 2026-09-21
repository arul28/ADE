import {
  decideOrphanBackgroundTerminal,
  decideOrphanSubagentTerminal,
  orphanRowChildSessionCandidate,
  type OrphanChildChatState,
  type OrphanStopAttribution,
} from "../../../shared/chatOrphanRunReconcile";
import { CHAT_STOP_REASON_RUNTIME_EXITED, type AgentChatSessionStatus } from "../../../shared/types";
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
 * The verdicts and the copy come from `shared/chatOrphanRunReconcile`, the same
 * module the host sweep decides with, so a row does not change its wording the
 * moment the host catches up with the renderer.
 *
 * Both signals are POSITIVE statements, never guesses:
 *  - `runtimeAlive === false` — the host says it holds no provider runtime for
 *    this chat. `undefined` means an older host that cannot say, and nothing is
 *    healed on an unknown.
 *  - `childChatStatuses` — the session status of a spawned ADE subagent chat.
 *    An `ended` chat is not running whatever the parent is doing; an `idle` one
 *    only counts once the parent runtime is gone too, because a just-spawned
 *    delegate reads `idle` for the seconds its own runtime takes to launch.
 */
export type ChatPaneLivenessContext = {
  /** `false` = the host holds no runtime for this chat. `undefined` = unknown. */
  runtimeAlive?: boolean;
  /** Session status by spawned-chat session id, for rows that map to ADE chats. */
  childChatStatuses?: ReadonlyMap<string, AgentChatSessionStatus>;
};

/**
 * Nobody pressed Stop: the pane heals because a process is gone. Same shape the
 * host sweep passes, so the rendered sentence is the same sentence.
 */
const PANE_SELF_HEAL_ATTRIBUTION: OrphanStopAttribution = {
  stopSource: "system",
  stopReason: CHAT_STOP_REASON_RUNTIME_EXITED,
};

/**
 * The spawned chat a subagent row stands for, if any. Accepts the same forms as
 * the host's `orphanRowChildSessionCandidate`: `deriveChatSubagentSnapshots`
 * already resolves `childSessionId` for spawned rows, and older folded
 * snapshots carry only the `chat:<id>` (or bare) taskId. A candidate that is
 * not really a chat simply misses in `childChatStatuses`.
 */
export function paneRowChildSessionId(snapshot: ChatSubagentSnapshot): string | null {
  const explicit = snapshot.childSessionId?.trim();
  if (explicit) return explicit;
  return orphanRowChildSessionCandidate(snapshot.taskId ?? "");
}

/**
 * What the pane can positively say about the spawned chat behind a row.
 *
 * `undefined` means "say nothing, leave the row alone" — either there is no
 * contradicting evidence, or the only evidence is an `idle` child while the
 * parent runtime is still alive, which is what a delegate looks like for the
 * first seconds of its life.
 */
function paneChildState(
  childStatus: AgentChatSessionStatus | undefined,
  runtimeGone: boolean,
): OrphanChildChatState | null | undefined {
  if (childStatus === "active") return "active";
  if (childStatus === "ended") return "ended";
  if (childStatus === "idle") return runtimeGone ? "idle" : undefined;
  return runtimeGone ? null : undefined;
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
    const childState = paneChildState(
      childSessionId ? statuses?.get(childSessionId) : undefined,
      runtimeGone,
    );
    if (childState === undefined) return snapshot;
    const terminal = decideOrphanSubagentTerminal({
      row: { name: snapshot.description, summary: snapshot.summary },
      childState,
      attribution: PANE_SELF_HEAL_ATTRIBUTION,
    });
    // A delegate chat that is still active outlives its parent's runtime and is
    // genuinely running. This is the one case that must keep saying "running".
    if (!terminal) return snapshot;
    changed = true;
    return {
      ...snapshot,
      status: terminal.status,
      summary: terminal.summary,
      finalSummary: snapshot.finalSummary ?? terminal.finalSummary,
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
    const terminal = decideOrphanBackgroundTerminal({ row: item, attribution: PANE_SELF_HEAL_ATTRIBUTION });
    return { ...item, status: terminal.status, summary: terminal.summary };
  });
  return changed ? healed : items;
}
