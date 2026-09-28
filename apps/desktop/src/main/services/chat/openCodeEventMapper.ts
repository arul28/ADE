import type { OpenCodeEvent } from "@opencode/client";
import type { AgentChatEvent, AgentChatSubagentTranscriptMessage } from "../../../shared/types/chat";
import { classifyProviderRetryCause, formatProviderRetryActivityDetail } from "../../../shared/providerRetryPresentation";
import { openCodeWebToolSourceRefs } from "./chatSourceAdapters";
import {
  isOpenCodeImageGenerationToolName,
  mapOpenCodeImageAttachment,
  mapOpenCodeImagePart,
} from "./openCodeStructuredActivity";
import {
  buildOpenCodeLiveContextUsage,
  createOpenCodeTurnUsage,
  recordOpenCodeStepFinish,
  type OpenCodeTurnUsage,
} from "./openCodeTurnUsage";

/**
 * Content mapping for one OpenCode 2.0 turn: the parent session's streamed
 * output (text, reasoning, tools, steps, usage, compaction, retries) as ADE
 * chat events.
 *
 * Only content lives here. Turn lifecycle, steering, permission and question
 * asks, and child sessions need the chat runtime and are handled there; this
 * module stays a pure function of the events it is given.
 */

type ActivityKind = Extract<AgentChatEvent, { type: "activity" }>["activity"];

export type OpenCodeMapperDeps = {
  activityForToolName(tool: string): { activity: ActivityKind; detail: string };
  reasoningDetail: string;
  workingDetail: string;
};

export type OpenCodeMappedEvent = {
  event: AgentChatEvent;
  /** Status the renderer replaces as it goes; never persisted to the transcript. */
  liveOnly?: boolean;
};

export type OpenCodeStructuredError = { type: string; message: string; status?: number };

type EventOf<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>;

/** The session id any OpenCode event concerns, or null for server-wide events. */
export function openCodeEventSessionId(event: OpenCodeEvent): string | null {
  const data = (event as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.sessionID === "string") return record.sessionID;
  const form = record.form as { sessionID?: unknown } | undefined;
  if (form && typeof form.sessionID === "string") return form.sessionID;
  return null;
}

export type OpenCodeTurnMapper = {
  map(event: OpenCodeEvent): OpenCodeMappedEvent[];
  /** Every assistant character this turn produced. */
  readonly finalText: () => string;
  readonly usage: OpenCodeTurnUsage;
  /** Model that answered the last step, when OpenCode reported it. */
  readonly servedModel: () => { providerID: string; modelID: string } | null;
  /** The last step failure, which explains an `execution.failed` without detail. */
  readonly lastStepError: () => OpenCodeStructuredError | null;
  /** Child session a `subagent` tool call launched, from its progress events. */
  readonly childSessionForCall: (callId: string) => string | null;
  readonly callForChildSession: (childSessionId: string) => string | null;
  readonly toolName: (callId: string) => string | null;
};

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as { type?: unknown; text?: unknown };
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function createOpenCodeTurnMapper(args: {
  turnId: string;
  deps: OpenCodeMapperDeps;
  reasoningModel: boolean;
  contextWindow: number | null | undefined;
  model: string | undefined;
  now?: () => string;
}): OpenCodeTurnMapper {
  const { turnId, deps } = args;
  const now = args.now ?? (() => new Date().toISOString());
  const usage = createOpenCodeTurnUsage();
  const textByItem = new Map<string, string>();
  const reasoningByItem = new Map<string, string>();
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, unknown>();
  const toolFinished = new Set<string>();
  const childByCall = new Map<string, string>();
  const callByChild = new Map<string, string>();
  let stepNumber = 0;
  let finalText = "";
  let servedModel: { providerID: string; modelID: string } | null = null;
  let lastStepError: OpenCodeStructuredError | null = null;
  const emittedImageIds = new Set<string>();

  const activity = (kind: ActivityKind, detail: string): OpenCodeMappedEvent => ({
    event: { type: "activity", activity: kind, detail, turnId },
  });

  const itemKey = (messageId: string, ordinal: number, kind: "text" | "reasoning"): string =>
    `${messageId}:${kind}:${ordinal}`;

  const toolCall = (callId: string): OpenCodeMappedEvent => ({
    event: {
      type: "tool_call",
      tool: toolNames.get(callId) ?? "tool",
      args: toolInputs.get(callId) ?? {},
      itemId: callId,
      logicalItemId: callId,
      turnId,
    },
  });

  const onText = (
    kind: "text" | "reasoning",
    messageId: string,
    ordinal: number,
    appended: string,
  ): OpenCodeMappedEvent[] => {
    if (!appended.length) return [];
    const key = itemKey(messageId, ordinal, kind);
    if (kind === "reasoning") {
      reasoningByItem.set(key, (reasoningByItem.get(key) ?? "") + appended);
      return [
        activity("thinking", deps.reasoningDetail),
        { event: { type: "reasoning", text: appended, turnId, itemId: key } },
      ];
    }
    textByItem.set(key, (textByItem.get(key) ?? "") + appended);
    finalText += appended;
    return [{ event: { type: "text", text: appended, turnId, itemId: key } }];
  };

  /** A part's closing text, minus what its deltas already delivered. */
  const onTextEnded = (
    kind: "text" | "reasoning",
    messageId: string,
    ordinal: number,
    fullText: string,
  ): OpenCodeMappedEvent[] => {
    const seen = (kind === "text" ? textByItem : reasoningByItem).get(itemKey(messageId, ordinal, kind)) ?? "";
    if (!fullText.startsWith(seen)) return [];
    return onText(kind, messageId, ordinal, fullText.slice(seen.length));
  };

  const map = (event: OpenCodeEvent): OpenCodeMappedEvent[] => {
    switch (event.type) {
      case "session.step.started": {
        const data = (event as EventOf<"session.step.started">).data;
        stepNumber += 1;
        if (data.model?.providerID && data.model.id) {
          servedModel = { providerID: data.model.providerID, modelID: data.model.id };
        }
        return [
          { event: { type: "step_boundary", stepNumber, turnId } },
          args.reasoningModel
            ? activity("thinking", deps.reasoningDetail)
            : activity("working", deps.workingDetail),
        ];
      }
      case "session.text.delta": {
        const data = (event as EventOf<"session.text.delta">).data;
        return onText("text", data.assistantMessageID, data.ordinal, data.delta);
      }
      case "session.text.ended": {
        const data = (event as EventOf<"session.text.ended">).data;
        return onTextEnded("text", data.assistantMessageID, data.ordinal, data.text);
      }
      case "session.reasoning.delta": {
        const data = (event as EventOf<"session.reasoning.delta">).data;
        return onText("reasoning", data.assistantMessageID, data.ordinal, data.delta);
      }
      case "session.reasoning.ended": {
        const data = (event as EventOf<"session.reasoning.ended">).data;
        return onTextEnded("reasoning", data.assistantMessageID, data.ordinal, data.text);
      }
      case "session.tool.input.started": {
        const data = (event as EventOf<"session.tool.input.started">).data;
        toolNames.set(data.id, data.name);
        const next = deps.activityForToolName(data.name);
        return [activity(next.activity, next.detail), toolCall(data.id)];
      }
      case "session.tool.called": {
        const data = (event as EventOf<"session.tool.called">).data;
        toolInputs.set(data.id, data.input);
        return [toolCall(data.id)];
      }
      case "session.tool.progress": {
        const data = (event as EventOf<"session.tool.progress">).data;
        const childId = (data.metadata as { sessionID?: unknown } | undefined)?.sessionID;
        if (typeof childId === "string" && childId) {
          childByCall.set(data.id, childId);
          callByChild.set(childId, data.id);
        }
        return [];
      }
      case "session.tool.success": {
        const data = (event as EventOf<"session.tool.success">).data;
        if (toolFinished.has(data.id)) return [];
        toolFinished.add(data.id);
        const tool = toolNames.get(data.id) ?? "tool";
        const output = textFromContent(data.content);
        const sources = openCodeWebToolSourceRefs(tool, toolInputs.get(data.id), output, null);
        // An image a tool returns is a view (the `read` tool on a screenshot);
        // only an image-generation tool's output keeps the generation card.
        const generated = isOpenCodeImageGenerationToolName(tool);
        const images: OpenCodeMappedEvent[] = [];
        (Array.isArray(data.content) ? data.content : []).forEach((item, index) => {
          if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "file") return;
          const file = item as { uri?: unknown; mime?: unknown; name?: unknown };
          const part = { type: "file", id: `${data.id}:${index}`, url: file.uri, mime: file.mime, filename: file.name };
          const mapped = generated
            ? mapOpenCodeImagePart({ part, turnId, emittedPartIds: emittedImageIds })
            : mapOpenCodeImageAttachment({ part, turnId, emittedPartIds: emittedImageIds });
          if (mapped) images.push({ event: mapped });
        });
        return [...images, {
          event: {
            type: "tool_result",
            tool,
            result: { output, metadata: data.metadata ?? {} },
            ...(sources.length ? { sources } : {}),
            itemId: data.id,
            logicalItemId: data.id,
            turnId,
            status: "completed",
          },
        }];
      }
      case "session.tool.failed": {
        const data = (event as EventOf<"session.tool.failed">).data;
        if (toolFinished.has(data.id)) return [];
        toolFinished.add(data.id);
        const tool = toolNames.get(data.id) ?? "tool";
        const message = data.error?.message ?? "Tool failed";
        return [
          {
            event: {
              type: "tool_result",
              tool,
              result: { error: message, errorType: data.error?.type ?? null },
              itemId: data.id,
              logicalItemId: data.id,
              turnId,
              status: "failed",
            },
          },
          { event: { type: "error", message: `Tool '${tool}' failed: ${message}`, itemId: data.id, turnId } },
        ];
      }
      case "session.step.ended": {
        const data = (event as EventOf<"session.step.ended">).data;
        const step = recordOpenCodeStepFinish(usage, `step:${data.assistantMessageID}`, data, { describesContext: true });
        const out: OpenCodeMappedEvent[] = [];
        const live = buildOpenCodeLiveContextUsage(step, args.contextWindow, args.model, turnId);
        if (live) out.push({ event: { ...live, capturedAt: now() } });
        for (const file of data.files ?? []) {
          out.push({
            event: {
              type: "file_change",
              path: file,
              diff: `OpenCode updated ${file}`,
              kind: "modify",
              itemId: `${data.assistantMessageID}:${file}`,
              logicalItemId: data.assistantMessageID,
              turnId,
              status: "completed",
            },
          });
        }
        out.push(activity("working", deps.workingDetail));
        return out;
      }
      case "session.step.failed": {
        const data = (event as EventOf<"session.step.failed">).data;
        if (data.tokens) recordOpenCodeStepFinish(usage, `step:${data.assistantMessageID}`, data, { describesContext: true });
        lastStepError = data.error ?? null;
        return [];
      }
      case "session.compaction.started": {
        const data = (event as EventOf<"session.compaction.started">).data;
        return [{ event: { type: "context_compact", trigger: data.reason, state: "started", turnId } }];
      }
      case "session.compaction.ended": {
        const data = (event as EventOf<"session.compaction.ended">).data;
        if (data.tokens) recordOpenCodeStepFinish(usage, `compaction:${stepNumber}`, data, { describesContext: false });
        return [{ event: { type: "context_compact", trigger: data.reason, state: "completed", turnId } }];
      }
      case "session.compaction.failed": {
        const data = (event as EventOf<"session.compaction.failed">).data;
        return [{
          event: {
            type: "system_notice",
            noticeKind: "provider_health",
            severity: "warning",
            message: "OpenCode could not compact the conversation.",
            detail: data.error?.message ?? "",
            turnId,
          },
        }];
      }
      case "session.retry.scheduled": {
        const data = (event as EventOf<"session.retry.scheduled">).data;
        const delayMs = Math.max(0, data.at - Date.now());
        return [{
          liveOnly: true,
          event: {
            type: "activity",
            activity: "working",
            providerRetry: true,
            detail: formatProviderRetryActivityDetail({
              provider: "opencode",
              attempt: data.attempt,
              retryDelayMs: delayMs,
              cause: classifyProviderRetryCause(data.error?.message ?? "The provider request failed."),
            }),
            turnId,
          },
        }];
      }
      default:
        return [];
    }
  };

  return {
    map,
    finalText: () => finalText,
    usage,
    servedModel: () => servedModel,
    lastStepError: () => lastStepError,
    childSessionForCall: (callId) => childByCall.get(callId) ?? null,
    callForChildSession: (childId) => callByChild.get(childId) ?? null,
    toolName: (callId) => toolNames.get(callId) ?? null,
  };
}

type SessionMessageInfo = Awaited<ReturnType<import("@opencode/client").OpenCodeClient["message"]["list"]>>["data"][number];

function toIso(ms: number | undefined): string | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}

/**
 * A child session's stored messages as drill-in transcript rows. Each row
 * carries one formed chat event, the shape the renderer shows as-is.
 */
export function mapOpenCodeMessagesToTranscript(
  sessionId: string,
  messages: readonly SessionMessageInfo[],
): AgentChatSubagentTranscriptMessage[] {
  const rows: AgentChatSubagentTranscriptMessage[] = [];
  const push = (uuid: string, type: AgentChatSubagentTranscriptMessage["type"], event: AgentChatEvent, text: string | undefined, at: number | undefined): void => {
    const timestamp = toIso(at);
    rows.push({
      type,
      uuid,
      sessionId,
      parentToolUseId: null,
      message: event,
      ...(text ? { text } : {}),
      ...(timestamp ? { timestamp } : {}),
    });
  };
  for (const message of messages) {
    if (message.type === "user") {
      if (message.text.trim()) {
        push(message.id, "user", { type: "user_message", text: message.text, messageId: message.id }, message.text, message.time.created);
      }
      continue;
    }
    if (message.type !== "assistant") continue;
    message.content.forEach((part, index) => {
      const id = `${message.id}:${index}`;
      if (part.type === "text" && part.text.trim()) {
        push(id, "assistant", { type: "text", text: part.text, messageId: message.id, itemId: id }, part.text, message.time.created);
      } else if (part.type === "reasoning" && part.text.trim()) {
        push(id, "assistant", { type: "reasoning", text: part.text, itemId: id }, undefined, message.time.created);
      } else if (part.type === "tool") {
        const input = part.state.status === "streaming" ? {} : part.state.input;
        push(`${part.id}:call`, "assistant", { type: "tool_call", tool: part.name, args: input, itemId: part.id }, undefined, part.time.created);
        if (part.state.status === "completed" || part.state.status === "error") {
          const output = textFromContent(part.state.content ?? []);
          push(`${part.id}:result`, "assistant", {
            type: "tool_result",
            tool: part.name,
            result: part.state.status === "error" ? { error: part.state.error.message, output } : { output },
            itemId: part.id,
            status: part.state.status === "error" ? "failed" : "completed",
          }, undefined, part.time.completed ?? part.time.created);
        }
      }
    });
  }
  return rows;
}
