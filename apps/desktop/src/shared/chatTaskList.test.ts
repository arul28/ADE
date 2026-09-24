import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "./types/chat";
import {
  chatTaskListCurrentLabel,
  chatTaskListProgress,
  chatTaskListSummaryLine,
  deriveChatTaskList,
  foldTodoItemsIntoTaskItems,
  isChatTaskListEvent,
  isPlanProposalEvent,
  todoItemsCoveredByTaskItems,
} from "./chatTaskList";
import { mapCursorSdkMessageToChatEvents } from "../main/services/chat/cursorSdkEventMapper";
import { createDroidSdkEventMapperState, mapDroidSdkMessageToChatEvents } from "../main/services/chat/droidSdkEventMapper";
import { createAcpEventTranslator } from "../main/services/chat/acpHost/acpEventTranslator";

let second = 0;
function envelopes(...events: AgentChatEvent[]): AgentChatEventEnvelope[] {
  return events.map((event) => ({
    sessionId: "session-1",
    timestamp: new Date(Date.UTC(2026, 8, 23, 12, 0, second++)).toISOString(),
    event,
  }));
}

describe("deriveChatTaskList — per provider", () => {
  it("Claude TodoWrite: todo items with activeForm (TodoWriteInput: content, status, activeForm)", () => {
    // What `normalizeClaudeTodoItems` emits for a TodoWrite input.
    const list = deriveChatTaskList(envelopes({
      type: "todo_update",
      turnId: "t1",
      items: [
        { id: "todo-0", description: "Read the schema", status: "completed", activeForm: "Reading the schema" },
        { id: "todo-1", description: "Write the migration", status: "in_progress", activeForm: "Writing the migration" },
        { id: "todo-2", description: "Run tests", status: "pending", activeForm: "Running tests" },
      ],
    }));
    expect(list).toEqual({
      source: "todo",
      label: "Tasks",
      turnId: "t1",
      items: [
        { id: "todo-0", label: "Read the schema", status: "done", activeLabel: "Reading the schema" },
        { id: "todo-1", label: "Write the migration", status: "running", activeLabel: "Writing the migration" },
        { id: "todo-2", label: "Run tests", status: "pending", activeLabel: "Running tests" },
      ],
    });
    expect(chatTaskListSummaryLine(list!)).toBe("Tasks · 1/3 · Writing the migration");
  });

  it("Codex turn/plan/updated (TurnPlanStep: step, status): a short explanation becomes the label", () => {
    const list = deriveChatTaskList(envelopes({
      type: "plan",
      turnId: "t1",
      state: "updated",
      explanation: "Migrating the billing module",
      steps: [
        { text: "Read the current schema", status: "completed" },
        { text: "Write the migration", status: "in_progress" },
        { text: "Deploy", status: "failed" },
      ],
    }));
    expect(list?.source).toBe("plan");
    expect(list?.label).toBe("Migrating the billing module");
    expect(list?.items.map((item) => [item.id, item.status])).toEqual([
      ["step-0", "done"],
      ["step-1", "running"],
      ["step-2", "failed"],
    ]);
  });

  it("falls back to Plan when the explanation is long or multi-line", () => {
    const long = deriveChatTaskList(envelopes({
      type: "plan",
      explanation: "x".repeat(61),
      steps: [{ text: "One", status: "pending" }],
    }));
    const multiLine = deriveChatTaskList(envelopes({
      type: "plan",
      explanation: "First\nSecond",
      steps: [{ text: "One", status: "pending" }],
    }));
    expect(long?.label).toBe("Plan");
    expect(multiLine?.label).toBe("Plan");
  });

  it("Cursor updateTodos: the todo_update + plan pair from one call is one list, and cancelled is skipped", () => {
    // Payload shape: `UpdateTodosArgsSchema` / result `{ status, value: { todos } }`,
    // statuses `pending | inProgress | completed | cancelled`.
    const mapped = mapCursorSdkMessageToChatEvents({
      type: "tool_call",
      call_id: "tool_1",
      name: "updateTodos",
      status: "completed",
      args: { todos: [] },
      result: {
        status: "success",
        value: {
          todos: [
            { content: "Add subtract", status: "completed" },
            { content: "Add multiply", status: "inProgress" },
            { content: "Add divide", status: "cancelled" },
          ],
        },
      },
    }, { turnId: "t1", cwd: "/work" } as Parameters<typeof mapCursorSdkMessageToChatEvents>[1]);
    expect(mapped.map((event) => event.type)).toEqual(["todo_update", "plan"]);
    const list = deriveChatTaskList(envelopes(...mapped));
    expect(list?.source).toBe("plan");
    expect(list?.items).toEqual([
      { id: "step-0", label: "Add subtract", status: "done" },
      { id: "step-1", label: "Add multiply", status: "running" },
      { id: "step-2", label: "Add divide", status: "done", skipped: true, note: "skipped" },
    ]);
    // Skipped counts as settled; the summary names the running item.
    expect(chatTaskListSummaryLine(list!)).toBe("Plan · 2/3 · Add multiply");
  });

  it("OpenCode todo.updated (Todo: content, status incl. cancelled, no id on v2)", () => {
    // What the OpenCode `todo.updated` mapping emits.
    const list = deriveChatTaskList(envelopes({
      type: "todo_update",
      turnId: "t1",
      items: [
        { id: "todo-0", description: "Plan", status: "completed" },
        { id: "todo-1", description: "Drop legacy flag", status: "completed", cancelled: true },
        { id: "todo-2", description: "Ship", status: "pending" },
      ],
    }));
    expect(list?.items.map((item) => [item.label, item.status, item.skipped ?? false])).toEqual([
      ["Plan", "done", false],
      ["Drop legacy flag", "done", true],
      ["Ship", "pending", false],
    ]);
    // No running item: the collapsed line names the next pending one.
    expect(chatTaskListProgress(list!.items).current?.label).toBe("Ship");
    expect(chatTaskListSummaryLine(list!)).toBe("Tasks · 2/3 · Next: Ship");
  });

  it("ACP plan entries keep priority, and plan_removed clears the list", () => {
    const translator = createAcpEventTranslator();
    translator.beginTurn("t1");
    const planEvents = translator.translate({
      sessionUpdate: "plan",
      entries: [
        { content: "Investigate", priority: "high", status: "completed" },
        { content: "Fix", priority: "medium", status: "in_progress" },
      ],
    });
    const list = deriveChatTaskList(envelopes(...planEvents));
    expect(list?.items).toEqual([
      { id: "step-0", label: "Investigate", status: "done", priority: "high" },
      { id: "step-1", label: "Fix", status: "running", priority: "medium" },
    ]);
    const removed = translator.translate({ sessionUpdate: "plan_removed" });
    expect(deriveChatTaskList(envelopes(...planEvents, ...removed))).toBeNull();
  });

  it("Droid TodoWrite (`{ todos: string }` checklist) maps through the new todo_update", () => {
    const mapped = mapDroidSdkMessageToChatEvents({
      type: "tool_call",
      toolUseId: "tw-1",
      name: "TodoWrite",
      input: { todos: "1. [completed] Scaffold\n2. [in_progress] Wire the API\n3. [pending] Test" },
    }, { turnId: "t1", cwd: "/work", state: createDroidSdkEventMapperState() });
    const list = deriveChatTaskList(envelopes(...mapped));
    expect(list?.source).toBe("todo");
    expect(list?.items.map((item) => [item.id, item.label, item.status])).toEqual([
      ["1", "Scaffold", "done"],
      ["2", "Wire the API", "running"],
      ["3", "Test", "pending"],
    ]);
  });
});

describe("deriveChatTaskList — replacement, merge, and clearing", () => {
  it("the newest update replaces an older list, across sources and turns", () => {
    const list = deriveChatTaskList(envelopes(
      { type: "plan", turnId: "t1", steps: [{ text: "Old step", status: "completed" }] },
      { type: "todo_update", turnId: "t2", items: [{ id: "a", description: "New task", status: "pending" }] },
    ));
    expect(list).toEqual({
      source: "todo",
      label: "Tasks",
      turnId: "t2",
      items: [{ id: "a", label: "New task", status: "pending" }],
    });
  });

  it("a todo update of the plan's turn writes onto the plan", () => {
    const list = deriveChatTaskList(envelopes(
      { type: "plan", turnId: "t1", explanation: "Ship it", steps: [{ text: "Read", status: "in_progress" }] },
      {
        type: "todo_update",
        turnId: "t1",
        items: [
          { id: "1", description: "Read", status: "completed" },
          { id: "2", description: "Write", status: "in_progress" },
        ],
      },
    ));
    expect(list?.source).toBe("plan");
    expect(list?.label).toBe("Ship it");
    expect(list?.items.map((item) => [item.label, item.status])).toEqual([
      ["Read", "done"],
      ["Write", "running"],
    ]);
  });

  it("a later-turn todo update the plan fully names is a status change of that plan", () => {
    const list = deriveChatTaskList(envelopes(
      { type: "plan", turnId: "t1", steps: [{ text: "Read", status: "pending" }, { text: "Write", status: "pending" }] },
      { type: "todo_update", turnId: "t2", items: [{ id: "1", description: "Read", status: "completed" }] },
    ));
    expect(list?.source).toBe("plan");
    expect(list?.turnId).toBe("t2");
    expect(list?.items.map((item) => item.status)).toEqual(["done", "pending"]);
  });

  it("an empty todo update and a step-less, text-less plan both clear the list", () => {
    const base: AgentChatEvent = { type: "todo_update", turnId: "t1", items: [{ id: "a", description: "A", status: "pending" }] };
    expect(deriveChatTaskList(envelopes(base, { type: "todo_update", turnId: "t2", items: [] }))).toBeNull();
    expect(deriveChatTaskList(envelopes(base, { type: "plan", turnId: "t2", steps: [] }))).toBeNull();
  });

  it("excludes Codex plan-mode proposals: they neither create nor clear the list", () => {
    const delta: AgentChatEvent = { type: "plan", steps: [], streamingText: "## Proposed", state: "delta", turnId: "t2", itemId: "p" };
    const complete: AgentChatEvent = { type: "plan", steps: [], streamingText: "## Proposed plan", state: "complete", turnId: "t2", itemId: "p" };
    expect(isPlanProposalEvent(delta as Extract<AgentChatEvent, { type: "plan" }>)).toBe(true);
    expect(isChatTaskListEvent(complete)).toBe(false);
    expect(deriveChatTaskList(envelopes(delta, complete))).toBeNull();
    const withList = deriveChatTaskList(envelopes(
      { type: "todo_update", turnId: "t1", items: [{ id: "a", description: "A", status: "pending" }] },
      delta,
      complete,
    ));
    expect(withList?.items.map((item) => item.label)).toEqual(["A"]);
  });

  it("returns null for a chat with no list events", () => {
    expect(deriveChatTaskList(envelopes({ type: "text", text: "hi", turnId: "t1" }))).toBeNull();
  });
});

describe("fold helpers", () => {
  it("matches task ids before labels and gives duplicate incoming ids unique names", () => {
    const next = foldTodoItemsIntoTaskItems([
      { id: "task-a", label: "Rename this", status: "pending" },
      { id: "task-b", label: "Keep this label", status: "pending" },
    ], [
      { id: "task-a", description: "Keep this label", status: "completed" },
      { id: "task-a", description: "A distinct task", status: "in_progress" },
    ]);

    expect(next.map(({ id, label, status }) => [id, label, status])).toEqual([
      ["task-a", "Rename this", "done"],
      ["task-b", "Keep this label", "pending"],
      ["task-a#2", "A distinct task", "running"],
    ]);
  });

  it("updates a matching item, appends a new one, and never mutates the input", () => {
    const items = [{ id: "step-0", label: "Read", status: "pending" as const }];
    const next = foldTodoItemsIntoTaskItems(items, [
      { id: "1", description: " Read ", status: "completed" },
      { id: "2", description: "Write", status: "in_progress", activeForm: "Writing" },
      { id: "3", description: "   ", status: "pending" },
    ]);
    expect(next).toEqual([
      { id: "step-0", label: "Read", status: "done" },
      { id: "2", label: "Write", status: "running", activeLabel: "Writing" },
    ]);
    expect(items[0]?.status).toBe("pending");
  });

  it("treats a todo update as covered only when the list names every item", () => {
    const items = [
      { id: "a", label: "Read", status: "pending" as const },
      { id: "b", label: "Write", status: "pending" as const },
    ];
    expect(todoItemsCoveredByTaskItems([{ id: "1", description: "Read", status: "pending" }], items)).toBe(true);
    expect(todoItemsCoveredByTaskItems([
      { id: "1", description: "Read", status: "pending" },
      { id: "2", description: "Deploy", status: "pending" },
    ], items)).toBe(false);
    expect(todoItemsCoveredByTaskItems([], items)).toBe(false);
    expect(todoItemsCoveredByTaskItems([{ id: "1", description: "Read", status: "pending" }], [])).toBe(false);
  });
});

describe("summary line", () => {
  const list = {
    source: "todo" as const,
    label: "Tasks",
    turnId: null,
    items: [
      { id: "1", label: "A", status: "done" as const },
      { id: "2", label: "B", status: "running" as const, activeLabel: "Doing B" },
      { id: "3", label: "C", status: "pending" as const },
    ],
  };

  it("names the running item by its active label", () => {
    expect(chatTaskListSummaryLine(list)).toBe("Tasks · 1/3 · Doing B");
  });

  it("names the next pending item when nothing runs, including an untouched list", () => {
    const idle = { ...list, items: list.items.map((item) => (item.id === "2" ? { ...item, status: "done" as const } : item)) };
    expect(chatTaskListSummaryLine(idle)).toBe("Tasks · 2/3 · Next: C");
    // The live Haiku case: four created tasks, none ever marked running.
    const untouched = { ...list, items: ["A", "B", "C", "D"].map((label, index) => ({ id: String(index), label, status: "pending" as const })) };
    expect(chatTaskListSummaryLine(untouched)).toBe("Tasks · 0/4 · Next: A");
  });

  it("reads All done when every item settled, and names failures instead", () => {
    const settled = { ...list, items: list.items.map((item) => ({ ...item, status: "done" as const })) };
    expect(chatTaskListSummaryLine(settled)).toBe("Tasks · 3/3 · All done");
    const withFailure = { ...list, items: [...settled.items.slice(0, 2), { id: "3", label: "C", status: "failed" as const }] };
    expect(chatTaskListCurrentLabel(chatTaskListProgress(withFailure.items))).toBe("1 failed");
    expect(chatTaskListCurrentLabel(chatTaskListProgress([]))).toBeNull();
  });
});
