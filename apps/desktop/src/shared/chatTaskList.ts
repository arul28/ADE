import type { AgentChatEvent, AgentChatEventEnvelope } from "./types/chat";

/**
 * The chat's one task list.
 *
 * Every provider reports "what the agent is working through" in one of two
 * event shapes, and both land here:
 *
 * - `plan` — Codex `turn/plan/updated` and the `update_plan` tool, ACP
 *   `plan` / `plan_update` / `plan_removed`, Cursor `updateTodos`, and the
 *   Cursor `ade_update_plan` control fence.
 * - `todo_update` — Claude `TodoWrite` / `TaskCreate` / `TaskUpdate`, OpenCode
 *   `todo.updated`, Droid `TodoWrite`, Cursor `updateTodos`, the fence again,
 *   and legacy Codex `planningItem`s.
 *
 * Each update carries the whole list, so the newest one replaces what came
 * before. The exceptions: a todo update written onto a plan of the same turn
 * (or one the plan already names in full) updates that plan's steps instead of
 * replacing it — Cursor and the control fence emit both shapes for one list.
 * A `plan` with no steps and no proposal text (ACP `plan_removed`) and an empty
 * todo update clear the list.
 *
 * Codex plan-mode proposals (`plan` with no steps and streamed markdown) are
 * not task lists; they keep their own card and never touch this state.
 *
 * Desktop (thread card + Chat Info pane) and the `ade code` TUI all read this
 * module, so every surface shows the same list.
 */

export type ChatTaskStatus = "pending" | "running" | "done" | "failed";

export type ChatTaskItem = {
  /** Provider id when the provider has one, else a position-based id. */
  id: string;
  label: string;
  status: ChatTaskStatus;
  /** Claude's present-continuous label ("Running tests"), shown while running. */
  activeLabel?: string;
  /**
   * The provider cancelled this item. It is settled (`done`, counted as done)
   * and drawn dimmed with a "skipped" note instead of a check.
   */
  skipped?: boolean;
  /** Short right-aligned note. */
  note?: string;
  /** ACP plan-entry priority, when the agent reported one. Not drawn today. */
  priority?: "high" | "medium" | "low";
};

export type ChatTaskListSource = "plan" | "todo";

export type ChatTaskListSnapshot = {
  /** Which event shape wrote the list; drives the fallback label. */
  source: ChatTaskListSource;
  /** The plan explanation when it is short, else "Plan" or "Tasks". */
  label: string;
  items: ChatTaskItem[];
  /** Turn of the event that last changed the list. */
  turnId: string | null;
};

type PlanEvent = Extract<AgentChatEvent, { type: "plan" }>;
type TodoEvent = Extract<AgentChatEvent, { type: "todo_update" }>;
type WireStatus = PlanEvent["steps"][number]["status"] | TodoEvent["items"][number]["status"];

/** Longest plan explanation used as the list label. Longer ones fall back to "Plan". */
export const CHAT_TASK_LIST_LABEL_MAX_CHARS = 60;

/**
 * A Codex plan-mode proposal: no steps, markdown streamed in `streamingText`
 * (`item/plan/delta`, the completed `<proposed_plan>` item). It renders as the
 * plan card and is never a task list.
 */
export function isPlanProposalEvent(event: PlanEvent): boolean {
  if (event.steps.length > 0) return false;
  if (typeof event.streamingText === "string" && event.streamingText.trim().length > 0) return true;
  return event.state === "delta" || event.state === "complete";
}

/** True for every event that writes (or clears) the task list. */
export function isChatTaskListEvent(event: AgentChatEvent): boolean {
  if (event.type === "todo_update") return true;
  if (event.type === "plan") return !isPlanProposalEvent(event);
  return false;
}

function mapStatus(status: WireStatus): ChatTaskStatus {
  switch (status) {
    case "in_progress":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return "pending";
  }
}

function listLabel(source: ChatTaskListSource, explanation: string | null | undefined): string {
  const text = explanation?.trim() ?? "";
  if (text.length > 0 && text.length <= CHAT_TASK_LIST_LABEL_MAX_CHARS && !/[\r\n]/.test(text)) return text;
  return source === "plan" ? "Plan" : "Tasks";
}

function itemFromTodo(item: TodoEvent["items"][number], index: number): ChatTaskItem | null {
  const label = item.description?.trim() ?? "";
  if (!label) return null;
  const activeLabel = item.activeForm?.trim();
  return {
    id: item.id?.trim() || `todo-${index}`,
    label,
    status: mapStatus(item.status),
    ...(activeLabel && activeLabel !== label ? { activeLabel } : {}),
    ...(item.cancelled ? { skipped: true, status: "done" as const, note: "skipped" } : {}),
  };
}

function itemFromPlanStep(step: PlanEvent["steps"][number], index: number): ChatTaskItem | null {
  const label = step.text?.trim() ?? "";
  if (!label) return null;
  return {
    id: `step-${index}`,
    label,
    status: mapStatus(step.status),
    ...(step.priority ? { priority: step.priority } : {}),
    ...(step.cancelled ? { skipped: true, status: "done" as const, note: "skipped" } : {}),
  };
}

function ensureUniqueTaskItemIds(items: readonly ChatTaskItem[]): ChatTaskItem[] {
  const seen = new Set<string>();
  return items.map((item, index) => {
    const base = item.id.trim() || `task-${index}`;
    let id = base;
    let suffix = 2;
    while (seen.has(id)) id = `${base}#${suffix++}`;
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

/**
 * Write a todo update onto the current list's items. An item with the same
 * text takes the new status; an item with new text is appended. Returns a new
 * array; the input is not mutated.
 */
export function foldTodoItemsIntoTaskItems(
  items: readonly ChatTaskItem[],
  todos: TodoEvent["items"],
): ChatTaskItem[] {
  const next = items.map((item) => ({ ...item }));
  const incomingItems = ensureUniqueTaskItemIds(todos.flatMap((todo, index) => {
    const item = itemFromTodo(todo, index);
    return item ? [item] : [];
  }));
  incomingItems.forEach((incoming) => {
    const existing = next.find((item) => item.id === incoming.id)
      ?? next.find((item) => item.label === incoming.label);
    if (!existing) {
      next.push(incoming);
      return;
    }
    existing.status = incoming.status;
    if (incoming.activeLabel) existing.activeLabel = incoming.activeLabel;
    else delete existing.activeLabel;
    if (incoming.skipped) {
      existing.skipped = true;
      existing.note = incoming.note;
    } else if (existing.skipped) {
      delete existing.skipped;
      delete existing.note;
    }
  });
  return ensureUniqueTaskItemIds(next);
}

/**
 * True when the list already names every item of a todo update, so the update
 * is a status change of that list rather than a new one. An empty update is
 * never covered.
 */
export function todoItemsCoveredByTaskItems(
  todos: TodoEvent["items"],
  items: readonly ChatTaskItem[],
): boolean {
  if (!items.length || todos.length === 0) return false;
  return todos.every((todo, index) => {
    const incoming = itemFromTodo(todo, index);
    return Boolean(incoming && (
      items.some((item) => item.id === incoming.id)
      || items.some((item) => item.label === incoming.label)
    ));
  });
}

/**
 * Apply one event to the list. Returns the same object when the event does not
 * touch the list, `null` when it clears it.
 */
export function reduceChatTaskList(
  current: ChatTaskListSnapshot | null,
  event: AgentChatEvent,
): ChatTaskListSnapshot | null {
  if (event.type === "plan") {
    if (isPlanProposalEvent(event)) return current;
    const items = ensureUniqueTaskItemIds(event.steps.flatMap((step, index) => itemFromPlanStep(step, index) ?? []));
    if (!items.length) return null;
    return {
      source: "plan",
      label: listLabel("plan", event.explanation),
      items,
      turnId: event.turnId ?? null,
    };
  }
  if (event.type === "todo_update") {
    const turnId = event.turnId ?? null;
    if (
      current?.source === "plan"
      && ((turnId !== null && current.turnId === turnId) || todoItemsCoveredByTaskItems(event.items, current.items))
    ) {
      return { ...current, items: foldTodoItemsIntoTaskItems(current.items, event.items), turnId: turnId ?? current.turnId };
    }
    const items = ensureUniqueTaskItemIds(event.items.flatMap((item, index) => itemFromTodo(item, index) ?? []));
    if (!items.length) return null;
    return { source: "todo", label: listLabel("todo", null), items, turnId };
  }
  return current;
}

/** The chat's current task list, or null when there is none. */
export function deriveChatTaskList(events: readonly AgentChatEventEnvelope[]): ChatTaskListSnapshot | null {
  let list: ChatTaskListSnapshot | null = null;
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type !== "plan" && event.type !== "todo_update") continue;
    list = reduceChatTaskList(list, event);
  }
  return list;
}

export type ChatTaskListProgress = {
  /** Settled items: done, including skipped ones. */
  done: number;
  total: number;
  running: number;
  failed: number;
  /**
   * The item the collapsed line names: the first running item, else the next
   * pending one, else null (every item is settled).
   */
  current: ChatTaskItem | null;
};

/** Counts are always derived from the items; nothing passes them in. */
export function chatTaskListProgress(items: readonly ChatTaskItem[]): ChatTaskListProgress {
  let done = 0;
  let running = 0;
  let failed = 0;
  let firstRunning: ChatTaskItem | null = null;
  let firstPending: ChatTaskItem | null = null;
  for (const item of items) {
    if (item.status === "done") {
      done += 1;
    } else if (item.status === "running") {
      running += 1;
      firstRunning ??= item;
    } else if (item.status === "failed") {
      failed += 1;
    } else {
      firstPending ??= item;
    }
  }
  return { done, total: items.length, running, failed, current: firstRunning ?? firstPending };
}

/** What a row reads: the running item's present-continuous label when it has one. */
export function chatTaskItemDisplayLabel(item: ChatTaskItem): string {
  return item.status === "running" && item.activeLabel ? item.activeLabel : item.label;
}

/**
 * What the collapsed line says after the count: the running item (its active
 * label), else `Next: <item>` for the next pending one. A settled list reads
 * `All done`, or `N failed` when any item failed. Null only for an empty list.
 */
export function chatTaskListCurrentLabel(progress: ChatTaskListProgress): string | null {
  const { current } = progress;
  if (current) return current.status === "running" ? chatTaskItemDisplayLabel(current) : `Next: ${current.label}`;
  if (progress.total === 0) return null;
  return progress.failed > 0 ? `${progress.failed} failed` : "All done";
}

/** The collapsed one-liner: `Plan · 4/7 · Writing the migration`. */
export function chatTaskListSummaryLine(list: ChatTaskListSnapshot): string {
  const progress = chatTaskListProgress(list.items);
  const parts = [list.label, `${progress.done}/${progress.total}`];
  const current = chatTaskListCurrentLabel(progress);
  if (current) parts.push(current);
  return parts.join(" · ");
}
