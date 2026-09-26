/**
 * The v2 OpenCode runner's event boundary.
 *
 * ADE's turn loop and transcript mappers were written against OpenCode's legacy
 * read model (`message.updated` / `message.part.updated` / `session.idle`).
 * The v2 runner (`POST /api/session/{id}/prompt` plus `/api/event`) publishes
 * `session.next.*` events with a different envelope, and the two read models are
 * disjoint, so this module normalizes the v2 wire shapes back into the legacy
 * `Event` union the loop already consumes. Nothing v2-shaped crosses into the
 * `AgentChatEvent` contract.
 */

import type {
  Event as OpenCodeRuntimeEvent,
  OpencodeClient,
  SessionMessage,
  SessionV2Info,
  V2Event,
} from "@opencode-ai/sdk/v2/client";

export type OpenCodeV2SessionInfo = SessionV2Info;

/**
 * The v2 API wraps every success body in an outer `data` envelope while the
 * generated client wraps the HTTP body in its own `data` field, so one unwrap
 * lands on the payload and two on a bare object. Every v2 read that reaches
 * into a response goes through here.
 */
export function unwrapOpenCodeV2Data<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined;
  const record = asRecord(value);
  if (!record) return value as T;
  return (record.data === undefined ? record : record.data) as T;
}

export type OpenCodeV2AdapterHooks = {
  /**
   * A durable prompt was promoted into the running conversation. Steering is
   * only "Steered" once this lands for the admitted message id; a row that
   * never sees it was never read mid-turn.
   */
  onPrompted?: (args: { sessionID: string; messageID: string; delivery: "steer" | "queue" }) => void;
  /** Fired after a child session (spawned by the `task` tool) is discovered. */
  onChildSession?: (info: OpenCodeV2SessionInfo) => void;
};

type LegacySessionShape = {
  id: string;
  parentID?: string;
  title?: string;
  model?: { providerID: string; modelID: string };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textFromToolContent(content: unknown): {
  output: string;
  attachments: Array<Record<string, unknown>>;
} {
  if (!Array.isArray(content)) return { output: "", attachments: [] };
  const texts: string[] = [];
  const attachments: Array<Record<string, unknown>> = [];
  for (const entry of content) {
    const record = asRecord(entry);
    if (!record) continue;
    if (record.type === "text" && typeof record.text === "string") {
      texts.push(record.text);
      continue;
    }
    if (record.type === "file" && typeof record.uri === "string") {
      attachments.push({
        type: "file",
        mime: typeof record.mime === "string" ? record.mime : "application/octet-stream",
        url: record.uri,
        ...(typeof record.name === "string" ? { filename: record.name } : {}),
      });
    }
  }
  return { output: texts.join("\n"), attachments };
}

function parseToolInput(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function errorMessageOf(error: unknown): string {
  const record = asRecord(error);
  if (!record) return "OpenCode session failed.";
  const data = asRecord(record.data);
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  if (data && typeof data.message === "string" && data.message.trim()) return data.message.trim();
  return "OpenCode session failed.";
}

function errorNameOf(error: unknown): string {
  const record = asRecord(error);
  if (!record) return "UnknownError";
  if (typeof record.name === "string" && record.name.trim()) return record.name.trim();
  if (typeof record.type === "string" && record.type.trim()) {
    return record.type === "unknown" ? "UnknownError" : record.type;
  }
  return "UnknownError";
}

function legacySessionInfo(info: OpenCodeV2SessionInfo): LegacySessionShape {
  return {
    id: info.id,
    ...(info.parentID ? { parentID: info.parentID } : {}),
    ...(info.title ? { title: info.title } : {}),
    ...(info.model ? { model: { providerID: info.model.providerID, modelID: info.model.id } } : {}),
  };
}

function legacyMessageUpdated(
  sessionID: string,
  messageID: string,
  args: {
    role: "assistant" | "user";
    createdMs?: number;
    model?: { providerID: string; id: string } | null;
    summary?: boolean;
  },
): OpenCodeRuntimeEvent {
  return {
    type: "message.updated",
    properties: {
      sessionID,
      info: {
        id: messageID,
        sessionID,
        role: args.role,
        time: { created: args.createdMs ?? Date.now() },
        ...(args.summary ? { summary: true } : {}),
        ...(args.model ? { providerID: args.model.providerID, modelID: args.model.id } : {}),
      },
    },
  } as unknown as OpenCodeRuntimeEvent;
}

function legacyPartUpdated(
  sessionID: string,
  messageID: string,
  part: Record<string, unknown>,
  timeMs?: number,
): OpenCodeRuntimeEvent {
  return {
    type: "message.part.updated",
    properties: {
      sessionID,
      part: { sessionID, messageID, ...part },
      time: timeMs ?? Date.now(),
    },
  } as unknown as OpenCodeRuntimeEvent;
}

function legacyPartDelta(
  sessionID: string,
  messageID: string,
  partID: string,
  field: string,
  delta: string,
): OpenCodeRuntimeEvent {
  return {
    type: "message.part.delta",
    properties: { sessionID, messageID, partID, field, delta },
  } as OpenCodeRuntimeEvent;
}

function legacyIdle(sessionID: string): OpenCodeRuntimeEvent {
  return { type: "session.idle", properties: { sessionID } } as OpenCodeRuntimeEvent;
}

/** Legacy `session.created`, used to surface a v2 child session to the loop. */
function legacySessionCreated(info: OpenCodeV2SessionInfo): OpenCodeRuntimeEvent {
  return {
    type: "session.created",
    properties: { sessionID: info.id, info: legacySessionInfo(info) },
  } as unknown as OpenCodeRuntimeEvent;
}

type V2WireEnvelope = V2Event & { data?: Record<string, unknown>; properties?: Record<string, unknown> };

function dataOf(event: V2WireEnvelope): Record<string, unknown> {
  return (event.data ?? event.properties ?? {}) as Record<string, unknown>;
}

function sessionIdOf(event: V2WireEnvelope): string | null {
  const data = dataOf(event);
  const candidate = data.sessionID ?? data.sessionId;
  return typeof candidate === "string" && candidate.length ? candidate : null;
}

export type OpenCodeV2StreamArgs = {
  client: OpencodeClient;
  /** The chat's primary session. Events for foreign sessions are dropped. */
  sessionId: string;
  signal?: AbortSignal;
  onSseError?: (error: unknown) => void;
  hooks?: OpenCodeV2AdapterHooks;
};

type ToolInputCache = Map<string, Record<string, unknown>>;

type ToolNameCache = Map<string, string>;

function toolNameFor(cache: ToolNameCache, callID: string): string {
  return cache.get(callID) ?? "";
}

function assistantTextEvents(event: V2WireEnvelope): OpenCodeRuntimeEvent[] {
  const data = dataOf(event);
  const sessionID = String(data.sessionID);
  const messageID = String(data.assistantMessageID);
  const textID = `${messageID}:${String(data.textID)}`;
  switch (event.type) {
    case "session.next.text.started":
      return [legacyPartUpdated(sessionID, messageID, { id: textID, type: "text", text: "" }, Number(data.timestamp))];
    case "session.next.text.delta":
      return [legacyPartDelta(sessionID, messageID, textID, "text", String(data.delta ?? ""))];
    case "session.next.text.ended":
      return [legacyPartUpdated(sessionID, messageID, { id: textID, type: "text", text: String(data.text ?? "") }, Number(data.timestamp))];
    default:
      return [];
  }
}

function assistantReasoningEvents(event: V2WireEnvelope): OpenCodeRuntimeEvent[] {
  const data = dataOf(event);
  const sessionID = String(data.sessionID);
  const messageID = String(data.assistantMessageID);
  const reasoningID = `${messageID}:${String(data.reasoningID)}`;
  switch (event.type) {
    case "session.next.reasoning.started":
      return [legacyPartUpdated(sessionID, messageID, { id: reasoningID, type: "reasoning", text: "" }, Number(data.timestamp))];
    case "session.next.reasoning.delta":
      return [legacyPartDelta(sessionID, messageID, reasoningID, "reasoning", String(data.delta ?? ""))];
    case "session.next.reasoning.ended":
      return [legacyPartUpdated(
        sessionID,
        messageID,
        { id: reasoningID, type: "reasoning", text: String(data.text ?? "") },
        Number(data.timestamp),
      )];
    default:
      return [];
  }
}

function assistantToolEvents(
  event: V2WireEnvelope,
  toolInputs: ToolInputCache,
  toolNames: ToolNameCache,
): OpenCodeRuntimeEvent[] {
  const data = dataOf(event);
  const sessionID = String(data.sessionID);
  const messageID = String(data.assistantMessageID);
  if (typeof data.callID !== "string") return [];
  const callID = data.callID;
  switch (event.type) {
    case "session.next.tool.input.started": {
      toolInputs.set(callID, {});
      const name = String(data.name ?? "");
      toolNames.set(callID, name);
      return [legacyPartUpdated(
        sessionID,
        messageID,
        { id: callID, type: "tool", callID, tool: name, state: { status: "pending", input: {} } },
        Number(data.timestamp),
      )];
    }
    case "session.next.tool.input.ended": {
      const input = parseToolInput(String(data.text ?? ""));
      toolInputs.set(callID, input);
      return [legacyPartUpdated(
        sessionID,
        messageID,
        { id: callID, type: "tool", callID, tool: toolNameFor(toolNames, callID), state: { status: "pending", input } },
        Number(data.timestamp),
      )];
    }
    case "session.next.tool.called": {
      const input = asRecord(data.input) ?? {};
      toolInputs.set(callID, input);
      const name = String(data.tool ?? "");
      if (name) toolNames.set(callID, name);
      return [legacyPartUpdated(
        sessionID,
        messageID,
        { id: callID, type: "tool", callID, tool: name, state: { status: "running", input, time: { start: Number(data.timestamp) } } },
        Number(data.timestamp),
      )];
    }
    case "session.next.tool.progress": {
      const { output, attachments } = textFromToolContent(data.content);
      return [legacyPartUpdated(
        sessionID,
        messageID,
        {
          id: callID,
          type: "tool",
          callID,
          tool: toolNameFor(toolNames, callID),
          state: {
            status: "running",
            input: toolInputs.get(callID) ?? {},
            time: { start: Number(data.timestamp) },
            metadata: { structured: data.structured ?? {}, content: data.content ?? [], progressText: output, attachments },
          },
        },
        Number(data.timestamp),
      )];
    }
    case "session.next.tool.success": {
      const { output, attachments } = textFromToolContent(data.content);
      const input = toolInputs.get(callID) ?? {};
      return [legacyPartUpdated(
        sessionID,
        messageID,
        {
          id: callID,
          type: "tool",
          callID,
          tool: toolNameFor(toolNames, callID),
          state: {
            status: "completed",
            input,
            output,
            title: toolNameFor(toolNames, callID),
            metadata: asRecord(data.structured) ?? {},
            time: { start: Number(data.timestamp), end: Number(data.timestamp) },
            attachments: attachments.map((attachment, index) => ({
              id: `${callID}:attachment:${index}`,
              mime: attachment.mime,
              url: attachment.url,
              ...(attachment.filename ? { filename: attachment.filename } : {}),
            })),
          },
        },
        Number(data.timestamp),
      )];
    }
    case "session.next.tool.failed": {
      const input = toolInputs.get(callID) ?? {};
      return [legacyPartUpdated(
        sessionID,
        messageID,
        {
          id: callID,
          type: "tool",
          callID,
          tool: toolNameFor(toolNames, callID),
          state: {
            status: "error",
            input,
            error: errorMessageOf(data.error),
            metadata: asRecord(data.structured) ?? {},
            time: { start: Number(data.timestamp), end: Number(data.timestamp) },
          },
        },
        Number(data.timestamp),
      )];
    }
    default:
      return [];
  }
}

/**
 * Normalize one v2 event into the legacy event shapes the OpenCode turn loop
 * consumes. Returns an empty array for events with no legacy analogue (context
 * injection, agent/model switches, shell, revert).
 */
export function normalizeOpenCodeV2Event(
  raw: unknown,
  toolInputs: ToolInputCache = new Map(),
  toolNames: ToolNameCache = new Map(),
): { events: OpenCodeRuntimeEvent[]; sessionID: string | null; prompted?: { messageID: string; delivery: "steer" | "queue" } } {
  const event = raw as V2WireEnvelope;
  if (!event || typeof event.type !== "string") return { events: [], sessionID: null };
  const data = dataOf(event);
  const sessionID = sessionIdOf(event);

  switch (event.type) {
    case "session.next.prompt.admitted":
    case "session.next.prompted": {
      const messageID = typeof data.messageID === "string" ? data.messageID : "";
      const delivery = data.delivery === "steer" ? "steer" as const : "queue" as const;
      return {
        events: [],
        sessionID,
        ...(event.type === "session.next.prompted" && messageID
          ? { prompted: { messageID, delivery } }
          : {}),
      };
    }
    case "session.next.step.started": {
      const messageID = String(data.assistantMessageID);
      const model = asRecord(data.model);
      const events = [
        legacyMessageUpdated(String(data.sessionID), messageID, {
          role: "assistant",
          createdMs: Number(data.timestamp),
          model: model && typeof model.providerID === "string" && typeof model.id === "string"
            ? { providerID: model.providerID, id: model.id }
            : null,
        }),
        legacyPartUpdated(
          String(data.sessionID),
          messageID,
          { id: `step-start:${messageID}`, type: "step-start", ...(typeof data.snapshot === "string" ? { snapshot: data.snapshot } : {}) },
          Number(data.timestamp),
        ),
      ];
      return { events, sessionID };
    }
    case "session.next.step.ended": {
      const messageID = String(data.assistantMessageID);
      const tokens = asRecord(data.tokens) ?? {};
      const cache = asRecord(tokens.cache) ?? {};
      return {
        events: [legacyPartUpdated(
          String(data.sessionID),
          messageID,
          {
            id: `step-finish:${messageID}`,
            type: "step-finish",
            reason: typeof data.finish === "string" ? data.finish : "stop",
            cost: typeof data.cost === "number" ? data.cost : 0,
            tokens: {
              input: Number(tokens.input ?? 0),
              output: Number(tokens.output ?? 0),
              reasoning: Number(tokens.reasoning ?? 0),
              cache: { read: Number(cache.read ?? 0), write: Number(cache.write ?? 0) },
            },
          },
          Number(data.timestamp),
        )],
        sessionID,
      };
    }
    case "session.next.step.failed": {
      return {
        events: [{
          type: "session.error",
          properties: {
            sessionID: String(data.sessionID),
            error: {
              name: errorNameOf(data.error),
              data: { message: errorMessageOf(data.error) },
            },
          },
        } as unknown as OpenCodeRuntimeEvent],
        sessionID,
      };
    }
    case "session.next.text.started":
    case "session.next.text.delta":
    case "session.next.text.ended":
      return { events: assistantTextEvents(event), sessionID };
    case "session.next.reasoning.started":
    case "session.next.reasoning.delta":
    case "session.next.reasoning.ended":
      return { events: assistantReasoningEvents(event), sessionID };
    case "session.next.tool.input.started":
    case "session.next.tool.input.ended":
    case "session.next.tool.called":
    case "session.next.tool.progress":
    case "session.next.tool.success":
    case "session.next.tool.failed":
      return { events: assistantToolEvents(event, toolInputs, toolNames), sessionID };
    case "session.next.retried": {
      return {
        events: [{
          type: "session.status",
          properties: {
            sessionID: String(data.sessionID),
            status: {
              type: "retry",
              attempt: Number(data.attempt ?? 0),
              message: errorMessageOf(data.error),
            },
          },
        } as unknown as OpenCodeRuntimeEvent],
        sessionID,
      };
    }
    case "session.next.compaction.started": {
      return {
        events: [legacyPartUpdated(
          String(data.sessionID),
          String(data.messageID),
          {
            id: `compaction:${String(data.messageID)}`,
            type: "compaction",
            auto: data.reason !== "manual",
          },
          Number(data.timestamp),
        )],
        sessionID,
      };
    }
    case "session.next.compaction.ended": {
      return {
        events: [{
          type: "session.compacted",
          properties: { sessionID: String(data.sessionID) },
        } as OpenCodeRuntimeEvent],
        sessionID,
      };
    }
    case "permission.v2.asked": {
      const source = asRecord(data.source);
      return {
        events: [{
          type: "permission.asked",
          properties: {
            id: String(data.id),
            sessionID: String(data.sessionID),
            permission: typeof data.action === "string" ? data.action : "unknown",
            patterns: Array.isArray(data.resources) ? data.resources.filter((entry): entry is string => typeof entry === "string") : [],
            metadata: asRecord(data.metadata) ?? {},
            always: Array.isArray(data.save) ? data.save.filter((entry): entry is string => typeof entry === "string") : [],
            ...(source && source.type === "tool"
              ? { tool: { messageID: String(source.messageID ?? ""), callID: String(source.callID ?? "") } }
              : {}),
          },
        } as unknown as OpenCodeRuntimeEvent],
        sessionID,
      };
    }
    case "permission.v2.replied": {
      return {
        events: [{
          type: "permission.replied",
          properties: {
            sessionID: String(data.sessionID),
            requestID: String(data.requestID),
            reply: data.reply === "reject" ? "reject" : "once",
          },
        } as unknown as OpenCodeRuntimeEvent],
        sessionID,
      };
    }
    case "question.v2.asked": {
      return {
        events: [{
          type: "question.asked",
          properties: {
            id: String(data.id),
            sessionID: String(data.sessionID),
            questions: Array.isArray(data.questions) ? data.questions : [],
            ...(asRecord(data.tool) ? { tool: asRecord(data.tool) } : {}),
          },
        } as unknown as OpenCodeRuntimeEvent],
        sessionID,
      };
    }
    case "question.v2.replied":
    case "question.v2.rejected": {
      return {
        events: [{
          type: event.type === "question.v2.replied" ? "question.replied" : "question.rejected",
          properties: {
            sessionID: String(data.sessionID),
            requestID: String(data.requestID),
            ...(event.type === "question.v2.replied" ? { answers: [] } : {}),
          },
        } as unknown as OpenCodeRuntimeEvent],
        sessionID,
      };
    }
    case "session.error": {
      return {
        events: [{
          type: "session.error",
          properties: {
            ...(typeof data.sessionID === "string" ? { sessionID: data.sessionID } : {}),
            ...(data.error ? { error: data.error } : {}),
          },
        } as unknown as OpenCodeRuntimeEvent],
        sessionID,
      };
    }
    default:
      return { events: [], sessionID };
  }
}

/**
 * Subscribe to `/api/event` and normalize every event belonging to the chat's
 * session tree. An event from an unknown session is looked up once: a session
 * whose `parentID` is the chat's session is a subagent, announced with a
 * synthesized legacy `session.created` so the loop's child lifecycle runs
 * unchanged; anything else shares the server and is dropped.
 */
export async function openCodeV2EventStream(
  args: OpenCodeV2StreamArgs,
): Promise<AsyncGenerator<OpenCodeRuntimeEvent>> {
  const result = await args.client.v2.event.subscribe({
    signal: args.signal,
    sseMaxRetryAttempts: 2,
    onSseError: args.onSseError,
  } as Parameters<OpencodeClient["v2"]["event"]["subscribe"]>[0]);
  const source = result.stream as AsyncGenerator<V2Event>;
  const toolInputs: ToolInputCache = new Map();
  const toolNames: ToolNameCache = new Map();
  const sessionKinds = new Map<string, "parent" | "child" | "foreign">([[args.sessionId, "parent"]]);

  async function* iterate(): AsyncGenerator<OpenCodeRuntimeEvent> {
    for await (const raw of source) {
      const event = raw as V2WireEnvelope;
      if (!event || typeof event.type !== "string") continue;
      const sessionID = sessionIdOf(event);
      if (sessionID && !sessionKinds.has(sessionID)) {
        sessionKinds.set(sessionID, "foreign");
        try {
          const response = await args.client.v2.session.get({ sessionID });
          const info = unwrapOpenCodeV2Data<OpenCodeV2SessionInfo>(response.data);
          if (info && (info.parentID ?? null) === args.sessionId) {
            sessionKinds.set(sessionID, "child");
            args.hooks?.onChildSession?.(info);
            yield legacySessionCreated(info);
          }
        } catch {
          // An unreadable session stays foreign: dropping its events is safer
          // than attributing another chat's ask to this one.
        }
      }
      if (sessionID && sessionKinds.get(sessionID) === "foreign") continue;
      const normalized = normalizeOpenCodeV2Event(event, toolInputs, toolNames);
      if (normalized.prompted) {
        args.hooks?.onPrompted?.({
          sessionID: normalized.sessionID ?? args.sessionId,
          messageID: normalized.prompted.messageID,
          delivery: normalized.prompted.delivery,
        });
      }
      for (const mapped of normalized.events) yield mapped;
    }
  }

  return iterate();
}

/**
 * Idle events from `POST /api/session/{id}/wait`.
 *
 * 1.18.32 answers `503 "Session wait is not available yet"` for every call, so
 * this resolves `false` and the bounded active probe owns completion. When a
 * build implements it, a 204 means the agent loop is idle and the turn can end
 * immediately instead of waiting out the probe's quiet window.
 */
export async function openCodeV2WaitForIdle(args: {
  client: OpencodeClient;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  try {
    const response = await args.client.v2.session.wait(
      { sessionID: args.sessionId },
      { signal: args.signal },
    );
    // 1.18.32 answers 503 "Session wait is not available yet"; a build that
    // implements it answers 204 with no body.
    return response.response?.status === 204;
  } catch {
    return false;
  }
}

/** Session ids whose agent loop is running, from `GET /api/session/active`. */
export function readOpenCodeV2ActiveStatuses(raw: unknown): Record<string, "busy"> | null {
  const record = asRecord(raw);
  if (!record) return null;
  const out: Record<string, "busy"> = {};
  for (const [id, value] of Object.entries(record)) {
    const entry = asRecord(value);
    if (entry && entry.type === "running") out[id] = "busy";
  }
  return out;
}

/** A synthetic idle, so the loop's completion path is shared with legacy. */
export function openCodeV2IdleEvent(sessionID: string): OpenCodeRuntimeEvent {
  return legacyIdle(sessionID);
}

/**
 * Races the normalized stream against a wait-for-idle receipt. `wait` resolving
 * true yields one synthetic idle for the parent and every child; the merged
 * generator then ends normally when the caller aborts it.
 */
export async function* mergeOpenCodeV2IdleReceipt(
  source: AsyncGenerator<OpenCodeRuntimeEvent>,
  args: {
    wait: Promise<boolean>;
    parentSessionId: string;
    childSessionIds: () => readonly string[];
  },
): AsyncGenerator<OpenCodeRuntimeEvent> {
  const receipt = args.wait.then((idle) => ({ idle }));
  let pending = source.next();

  /** Emit every event the source has, in order, without a concurrent read. */
  async function* drain(): AsyncGenerator<OpenCodeRuntimeEvent> {
    while (true) {
      const result = await pending;
      if (result.done) return;
      yield result.value;
      pending = source.next();
    }
  }

  while (true) {
    const outcome = await Promise.race([
      pending.then((result) => ({ kind: "event" as const, result })),
      receipt.then((result) => ({ kind: "receipt" as const, result })),
    ]);
    if (outcome.kind === "event") {
      if (outcome.result.done) return;
      yield outcome.result.value;
      pending = source.next();
      continue;
    }
    if (outcome.result.idle) {
      // Real events already buffered precede the idle on the wire. Flush
      // everything that resolves within one macrotask before synthesizing the
      // terminal idles; the SSE reader settles its pending read in microtasks.
      const nextTick = (): Promise<{ kind: "tick" }> =>
        new Promise((resolve) => {
          if (typeof setImmediate === "function") setImmediate(() => resolve({ kind: "tick" }));
          else setTimeout(() => resolve({ kind: "tick" }), 0);
        });
      while (true) {
        const race = await Promise.race([
          pending.then((result) => ({ kind: "event" as const, result })),
          nextTick(),
        ]);
        if (race.kind === "tick") break;
        if (race.result.done) break;
        yield race.result.value;
        pending = source.next();
      }
      yield legacyIdle(args.parentSessionId);
      for (const childID of args.childSessionIds()) yield legacyIdle(childID);
    }
    yield* drain();
    return;
  }
}

/**
 * Map a v2 session's projected messages onto the legacy `{info, parts}` rows
 * the transcript mappers consume, so reopened transcripts and subagent
 * drill-ins render through the same code as a legacy session.
 */
export function mapOpenCodeV2MessagesToLegacyRows(messages: readonly SessionMessage[]): Array<{
  info: Record<string, unknown>;
  parts: Array<Record<string, unknown>>;
}> {
  const rows: Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    const created = typeof message.time?.created === "number" ? message.time.created : undefined;
    if (message.type === "user") {
      rows.push({
        info: {
          id: message.id,
          sessionID: "",
          role: "user",
          time: created === undefined ? undefined : { created },
        },
        parts: [{
          id: `${message.id}:text`,
          type: "text",
          text: message.text,
          messageID: message.id,
          sessionID: "",
        }],
      });
      continue;
    }
    if (message.type === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push({ id: `${message.id}:${block.id}`, type: "text", text: block.text, messageID: message.id, sessionID: "" });
          continue;
        }
        if (block.type === "reasoning") {
          parts.push({ id: `${message.id}:${block.id}`, type: "reasoning", text: block.text, messageID: message.id, sessionID: "" });
          continue;
        }
        parts.push({
          id: block.id,
          type: "tool",
          callID: block.id,
          tool: block.name,
          state: block.state,
          messageID: message.id,
          sessionID: "",
        });
      }
      rows.push({
        info: {
          id: message.id,
          sessionID: "",
          role: "assistant",
          time: created === undefined ? undefined : { created },
          ...(message.model ? { providerID: message.model.providerID, modelID: message.model.id } : {}),
          ...(message.cost !== undefined ? { cost: message.cost } : {}),
          ...(message.tokens ? { tokens: message.tokens } : {}),
        },
        parts,
      });
      continue;
    }
    if (message.type === "compaction") {
      rows.push({
        info: {
          id: message.id,
          sessionID: "",
          role: "assistant",
          summary: true,
          time: created === undefined ? undefined : { created },
        },
        parts: [{
          id: `${message.id}:compaction`,
          type: "compaction",
          auto: message.reason === "auto",
          messageID: message.id,
          sessionID: "",
        }],
      });
      continue;
    }
    if (message.type === "system" || message.type === "synthetic") {
      rows.push({
        info: {
          id: message.id,
          sessionID: "",
          role: "system",
          time: created === undefined ? undefined : { created },
        },
        parts: [{
          id: `${message.id}:text`,
          type: "text",
          text: message.text,
          synthetic: true,
          messageID: message.id,
          sessionID: "",
        }],
      });
    }
  }
  return rows;
}
