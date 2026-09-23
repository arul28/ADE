import type { AgentChatEvent, AgentChatPlanStep } from "./types/chat";

/**
 * How a todo list folds into the plan card of the same turn.
 *
 * Some providers (Cursor, Claude) write a todo list and a plan for the same
 * work. The plan card is the one that stays. The desktop transcript and the
 * `ade code` TUI both use these rules, so the two surfaces show the same card.
 */

type TodoItem = Extract<AgentChatEvent, { type: "todo_update" }>["items"][number];

/**
 * Write a todo update onto plan steps. A step with the same text takes the new
 * status; an item with new text adds a step. Returns a new array.
 */
export function foldTodoItemsIntoPlanSteps(
  steps: readonly AgentChatPlanStep[],
  items: readonly TodoItem[],
): AgentChatPlanStep[] {
  const next = steps.map((step) => ({ ...step }));
  for (const item of items) {
    const text = item.description.trim();
    if (!text) continue;
    // Todo statuses are a subset of plan-step statuses.
    const status: AgentChatPlanStep["status"] = item.status;
    const existing = next.find((step) => step.text.trim() === text);
    if (existing) existing.status = status;
    else next.push({ text, status });
  }
  return next;
}

/**
 * True when a plan already names every item of a todo update, so the todo row
 * would only repeat the plan card. An empty update is never covered.
 */
export function todoItemsCoveredByPlanSteps(
  items: readonly TodoItem[],
  steps: readonly { text: string }[],
): boolean {
  const texts = new Set(steps.map((step) => step.text.trim()).filter((text) => text.length > 0));
  if (!texts.size || items.length === 0) return false;
  return items.every((item) => texts.has(item.description.trim()));
}
