import { describe, expect, it, vi } from "vitest";
import type { Event as OpenCodeRuntimeEvent } from "@opencode-ai/sdk/v2/client";
import type { SessionMessage } from "@opencode-ai/sdk/v2/client";
import {
  mapOpenCodeV2MessagesToLegacyRows,
  mergeOpenCodeV2IdleReceipt,
  normalizeOpenCodeV2Event,
  openCodeV2EventStream,
  readOpenCodeV2ActiveStatuses,
} from "./openCodeV2Events";

/**
 * The adapter is the v2 runner's only wire boundary: the turn loop and the
 * transcript mappers consume the legacy event shapes it produces, so these
 * tests pin the mapping (not the server) for every event family ADE renders.
 */
describe("normalizeOpenCodeV2Event", () => {
  const base = { id: "evt_1", location: { directory: "/repo" } };

  it("announces the assistant message and opens a step before its text", () => {
    const { events } = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.step.started",
      data: {
        timestamp: 1000,
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        agent: "ade-edit",
        model: { id: "gpt-5", providerID: "openai" },
      },
    });
    expect(events).toHaveLength(2);
    const message = events[0] as Extract<OpenCodeRuntimeEvent, { type: "message.updated" }>;
    const part = events[1] as Extract<OpenCodeRuntimeEvent, { type: "message.part.updated" }>;
    expect(message.type).toBe("message.updated");
    expect(message.properties.sessionID).toBe("ses_1");
    expect(message.properties.info).toMatchObject({
      id: "msg_a",
      role: "assistant",
      providerID: "openai",
      modelID: "gpt-5",
    });
    expect(part.type).toBe("message.part.updated");
    expect(part.properties.part).toMatchObject({ type: "step-start", messageID: "msg_a" });
  });

  it("maps text and reasoning deltas to namespaced parts so ids cannot collide across messages", () => {
    const started = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.text.started",
      data: { timestamp: 1, sessionID: "ses_1", assistantMessageID: "msg_a", textID: "text-0" },
    }).events[0] as Extract<OpenCodeRuntimeEvent, { type: "message.part.updated" }>;
    expect((started.properties.part as { id: string }).id).toBe("msg_a:text-0");

    const delta = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.text.delta",
      data: { timestamp: 2, sessionID: "ses_1", assistantMessageID: "msg_a", textID: "text-0", delta: "hi" },
    }).events[0] as Extract<OpenCodeRuntimeEvent, { type: "message.part.delta" }>;
    expect(delta.type).toBe("message.part.delta");
    expect(delta.properties).toMatchObject({
      sessionID: "ses_1",
      messageID: "msg_a",
      partID: "msg_a:text-0",
      field: "text",
      delta: "hi",
    });

    const reasoning = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.reasoning.ended",
      data: { timestamp: 3, sessionID: "ses_1", assistantMessageID: "msg_a", reasoningID: "reason-0", text: "thought" },
    }).events[0] as Extract<OpenCodeRuntimeEvent, { type: "message.part.updated" }>;
    expect(reasoning.properties.part).toMatchObject({ id: "msg_a:reason-0", type: "reasoning", text: "thought" });
  });

  it("carries the tool name across input/called/progress/success events", () => {
    const inputs = new Map<string, Record<string, unknown>>();
    const names = new Map<string, string>();
    normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.tool.input.started",
      data: { timestamp: 1, sessionID: "ses_1", assistantMessageID: "msg_a", callID: "call_1", name: "bash" },
    }, inputs, names);
    normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.tool.input.ended",
      data: { timestamp: 2, sessionID: "ses_1", assistantMessageID: "msg_a", callID: "call_1", text: "{\"command\":\"echo hi\"}" },
    }, inputs, names);
    const success = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.tool.success",
      data: {
        timestamp: 3,
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        callID: "call_1",
        structured: { exit: 0 },
        content: [{ type: "text", text: "hi\n" }],
      },
    }, inputs, names).events[0] as Extract<OpenCodeRuntimeEvent, { type: "message.part.updated" }>;
    const part = success.properties.part as {
      tool: string;
      state: { status: string; input: Record<string, unknown>; output: string };
    };
    expect(part.tool).toBe("bash");
    expect(part.state.status).toBe("completed");
    expect(part.state.input).toEqual({ command: "echo hi" });
    expect(part.state.output).toBe("hi\n");
  });

  it("maps step usage, retries, and compactions onto existing loop events", () => {
    const step = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.step.ended",
      data: {
        timestamp: 9,
        sessionID: "ses_1",
        assistantMessageID: "msg_a",
        finish: "stop",
        cost: 0.25,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      },
    }).events[0] as Extract<OpenCodeRuntimeEvent, { type: "message.part.updated" }>;
    expect(step.properties.part).toMatchObject({
      type: "step-finish",
      cost: 0.25,
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
    });

    const retry = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.retried",
      data: { timestamp: 9, sessionID: "ses_1", attempt: 2, error: { message: "overloaded", isRetryable: true } },
    }).events[0] as Extract<OpenCodeRuntimeEvent, { type: "session.status" }>;
    expect(retry.properties.status).toMatchObject({ type: "retry", attempt: 2, message: "overloaded" });

    const compaction = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.compaction.started",
      data: { timestamp: 9, sessionID: "ses_1", messageID: "msg_c", reason: "auto" },
    }).events[0] as Extract<OpenCodeRuntimeEvent, { type: "message.part.updated" }>;
    expect(compaction.properties.part).toMatchObject({ type: "compaction", auto: true });
    const ended = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.compaction.ended",
      data: { timestamp: 9, sessionID: "ses_1", messageID: "msg_c", reason: "auto", text: "summary", recent: "" },
    }).events[0];
    expect(ended.type).toBe("session.compacted");
  });

  it("renders a v2 permission ask as the request-id permission.asked shape", () => {
    const { events } = normalizeOpenCodeV2Event({
      ...base,
      type: "permission.v2.asked",
      data: {
        id: "per_1",
        sessionID: "ses_child",
        action: "bash",
        resources: ["echo hi"],
        save: ["echo hi"],
        source: { type: "tool", messageID: "msg_t", callID: "call_1" },
      },
    });
    expect(events[0].type).toBe("permission.asked");
    expect((events[0] as Extract<OpenCodeRuntimeEvent, { type: "permission.asked" }>).properties).toMatchObject({
      id: "per_1",
      sessionID: "ses_child",
      permission: "bash",
      patterns: ["echo hi"],
      always: ["echo hi"],
      tool: { messageID: "msg_t", callID: "call_1" },
    });
  });

  it("reports a step failure as a session error with its provider message", () => {
    const { events } = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.step.failed",
      data: { timestamp: 4, sessionID: "ses_1", assistantMessageID: "msg_a", error: { type: "unknown", message: "boom" } },
    });
    expect(events[0].type).toBe("session.error");
    expect((events[0] as Extract<OpenCodeRuntimeEvent, { type: "session.error" }>).properties.error).toMatchObject({
      name: "UnknownError",
      data: { message: "boom" },
    });
  });

  it("reports a promoted prompt through the prompted hook only", () => {
    const admitted = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.prompt.admitted",
      data: { timestamp: 1, sessionID: "ses_1", messageID: "msg_u", prompt: { text: "hello" }, delivery: "steer" },
    });
    expect(admitted.events).toEqual([]);
    expect(admitted.prompted).toBeUndefined();

    const prompted = normalizeOpenCodeV2Event({
      ...base,
      type: "session.next.prompted",
      data: { timestamp: 2, sessionID: "ses_1", messageID: "msg_u", prompt: { text: "hello" }, delivery: "steer" },
    });
    expect(prompted.prompted).toEqual({ messageID: "msg_u", delivery: "steer" });
  });
});

describe("openCodeV2EventStream", () => {
  function eventStream(events: unknown[]): AsyncGenerator<unknown> {
    return (async function* () {
      for (const event of events) yield event;
    })();
  }

  function fakeClient(args: {
    events: unknown[];
    children?: Record<string, { id: string; parentID?: string }>;
  }): {
    client: Parameters<typeof openCodeV2EventStream>[0]["client"];
    get: ReturnType<typeof vi.fn>;
  } {
    const get = vi.fn(async ({ sessionID }: { sessionID: string }) => {
      const info = args.children?.[sessionID];
      if (!info) throw Object.assign(new Error("not found"), { status: 404, name: "NotFoundError" });
      return { data: info };
    });
    const client = {
      v2: {
        session: { get },
        event: { subscribe: vi.fn(async () => ({ stream: eventStream(args.events) })) },
      },
    } as unknown as Parameters<typeof openCodeV2EventStream>[0]["client"];
    return { client, get };
  }

  it("announces a child session before its first event and drops foreign sessions", async () => {
    const { client, get } = fakeClient({
      events: [
        {
          id: "evt_child",
          type: "permission.v2.asked",
          data: { id: "per_1", sessionID: "ses_child", action: "bash", resources: ["ls"] },
        },
        {
          id: "evt_other",
          type: "session.next.text.delta",
          data: { timestamp: 1, sessionID: "ses_other", assistantMessageID: "m", textID: "t", delta: "x" },
        },
      ],
      children: { ses_child: { id: "ses_child", parentID: "ses_parent" } },
    });
    const seen: OpenCodeRuntimeEvent[] = [];
    const stream = await openCodeV2EventStream({
      client,
      sessionId: "ses_parent",
      signal: new AbortController().signal,
    });
    for await (const event of stream) seen.push(event);

    expect(get).toHaveBeenCalledTimes(2);
    expect(seen.map((event) => event.type)).toEqual(["session.created", "permission.asked"]);
    const created = seen[0] as Extract<OpenCodeRuntimeEvent, { type: "session.created" }>;
    expect(created.properties.info).toMatchObject({ id: "ses_child", parentID: "ses_parent" });
  });

  it("does not ask the server twice for the same session and routes prompted to the hook", async () => {
    const { client, get } = fakeClient({
      events: [
        { id: "e1", type: "session.next.prompt.admitted", data: { timestamp: 1, sessionID: "ses_parent", messageID: "msg_u", prompt: { text: "x" }, delivery: "steer" } },
        { id: "e2", type: "session.next.prompted", data: { timestamp: 2, sessionID: "ses_parent", messageID: "msg_u", prompt: { text: "x" }, delivery: "steer" } },
        { id: "e3", type: "session.next.prompt.admitted", data: { timestamp: 3, sessionID: "ses_parent", messageID: "msg_v", prompt: { text: "y" }, delivery: "queue" } },
      ],
    });
    const promoted: Array<{ messageID: string; delivery: string }> = [];
    const stream = await openCodeV2EventStream({
      client,
      sessionId: "ses_parent",
      signal: new AbortController().signal,
      hooks: { onPrompted: (args) => promoted.push({ messageID: args.messageID, delivery: args.delivery }) },
    });
    for await (const _event of stream) {
      // No legacy events for prompt admissions.
    }
    expect(get).not.toHaveBeenCalled();
    expect(promoted).toEqual([{ messageID: "msg_u", delivery: "steer" }]);
  });
});

describe("mergeOpenCodeV2IdleReceipt", () => {
  it("yields the parent and child idle when wait reports the loop ended", async () => {
    const source = (async function* () {
      yield { type: "session.next.step.ended" } as unknown as OpenCodeRuntimeEvent;
    })();
    const events: OpenCodeRuntimeEvent[] = [];
    for await (const event of mergeOpenCodeV2IdleReceipt(source, {
      wait: Promise.resolve(true),
      parentSessionId: "ses_parent",
      childSessionIds: () => ["ses_child"],
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual([
      "session.next.step.ended",
      "session.idle",
      "session.idle",
    ]);
  });

  it("keeps draining the source when wait is unavailable", async () => {
    const source = (async function* () {
      yield { type: "session.next.step.started" } as unknown as OpenCodeRuntimeEvent;
      yield { type: "session.next.step.ended" } as unknown as OpenCodeRuntimeEvent;
    })();
    const events: OpenCodeRuntimeEvent[] = [];
    for await (const event of mergeOpenCodeV2IdleReceipt(source, {
      wait: Promise.resolve(false),
      parentSessionId: "ses_parent",
      childSessionIds: () => [],
    })) {
      events.push(event);
    }
    expect(events.map((event) => event.type)).toEqual(["session.next.step.started", "session.next.step.ended"]);
  });
});

describe("readOpenCodeV2ActiveStatuses", () => {
  it("reports running sessions as busy and treats missing entries as idle", () => {
    expect(readOpenCodeV2ActiveStatuses({ ses_a: { type: "running" } })).toEqual({ ses_a: "busy" });
    expect(readOpenCodeV2ActiveStatuses({ ses_a: { type: "sleeping" } })).toEqual({});
    expect(readOpenCodeV2ActiveStatuses(null)).toBeNull();
  });
});

describe("mapOpenCodeV2MessagesToLegacyRows", () => {
  it("maps assistant text, tools, usage and user rows onto the legacy row shape", () => {
    const messages: SessionMessage[] = [
      {
        id: "msg_u",
        time: { created: 1000 },
        type: "user",
        text: "hello",
      },
      {
        id: "msg_a",
        time: { created: 2000, completed: 3000 },
        type: "assistant",
        agent: "ade-edit",
        model: { id: "gpt-5", providerID: "openai" },
        cost: 0.1,
        tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        content: [
          { type: "reasoning", id: "r1", text: "thinking" },
          { type: "text", id: "t1", text: "answer" },
          {
            type: "tool",
            id: "call_1",
            name: "bash",
            time: { created: 2500, completed: 2900 },
            state: { status: "completed", input: { command: "ls" }, content: [], structured: {} },
          },
        ],
      },
    ];
    const rows = mapOpenCodeV2MessagesToLegacyRows(messages);
    expect(rows).toHaveLength(2);
    expect(rows[0].info).toMatchObject({ id: "msg_u", role: "user" });
    expect(rows[0].parts[0]).toMatchObject({ type: "text", text: "hello" });
    expect(rows[1].info).toMatchObject({ id: "msg_a", role: "assistant", providerID: "openai", modelID: "gpt-5", cost: 0.1 });
    expect(rows[1].parts.map((part) => part.type)).toEqual(["reasoning", "text", "tool"]);
    expect(rows[1].parts[2]).toMatchObject({ callID: "call_1", tool: "bash" });
  });
});
