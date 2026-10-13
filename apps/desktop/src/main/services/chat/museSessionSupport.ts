/**
 * Pure helpers between ADE's chat shapes and Muse Session Protocol shapes:
 * turn input, MCP servers, approval and question cards, effort.
 *
 * Kept out of `agentChatService.ts` so each mapping can be read (and checked)
 * on its own; the runtime there owns the I/O.
 */
import type {
  AgentChatApprovalDecision,
  AgentChatControlSubagentArgs,
  AgentChatEvent,
  AgentChatMcpServerConfig,
  AgentChatSubagentControlAction,
  PendingInputRequest,
} from "../../../shared/types";
import type {
  ApprovalChoice,
  ApprovalRequestParams,
  ReasoningEffort,
  SessionMcpServerConfig,
  TurnInputPart,
  UserInputAnswer,
  UserInputRequestParams,
} from "@muse-code/sdk/dist/src/msp.js";
import { buildAcpPromptBlocks, type AcpResolvedAttachment } from "./acpHost/acpPromptBlocks";

const MUSE_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export function normalizeMuseReasoningEffort(value: string | null | undefined): ReasoningEffort | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return undefined;
  return MUSE_REASONING_EFFORTS.find((effort) => effort === trimmed);
}

/**
 * Prompt text plus attachments as MSP input parts. Files are inlined as text
 * (or referenced by path when too large), images go as base64 `image` parts,
 * and MP4/QuickTime videos as `video` parts once `uploadVideo` stored them.
 * Reuses the ACP block builder so size limits, binary detection and image
 * fitting behave exactly as they do for the ACP providers.
 */
export async function buildMuseTurnInput(args: {
  promptText: string;
  attachments: readonly AcpResolvedAttachment[];
  readAttachmentBytes: (attachment: AcpResolvedAttachment) => Promise<Buffer>;
  /**
   * Upload one video attachment (`media/upload`) and return its upload id.
   * Without it, or when it returns null, a video goes as a path hint like any
   * other file.
   */
  uploadVideo?: (attachment: AcpResolvedAttachment, mediaType: MuseVideoMediaType) => Promise<string | null>;
}): Promise<TurnInputPart[]> {
  const videoParts: TurnInputPart[] = [];
  const otherAttachments: AcpResolvedAttachment[] = [];
  const uploadVideo = args.uploadVideo;
  for (const attachment of args.attachments) {
    const mediaType = uploadVideo ? museVideoMediaType(attachment) : null;
    const uploadId = uploadVideo && mediaType ? await uploadVideo(attachment, mediaType) : null;
    if (uploadId) videoParts.push({ type: "video", uploadId });
    else otherAttachments.push(attachment);
  }
  const blocks = await buildAcpPromptBlocks({
    promptText: args.promptText,
    attachments: otherAttachments,
    agentSupportsImages: true,
    imagePrompt: ({ base64Data, mimeType, uri }) => (base64Data
      ? { type: "image", data: base64Data, mimeType }
      // MSP takes image bytes only; a URL image becomes a pointer the model can fetch.
      : { type: "text", text: `\nImage URL attachment: ${uri ?? ""}` }),
    readAttachmentBytes: args.readAttachmentBytes,
  });
  const parts: TurnInputPart[] = [];
  let text = "";
  const flushText = () => {
    if (text) parts.push({ type: "text", text });
    text = "";
  };
  for (const block of blocks as Array<Record<string, unknown>>) {
    if (block.type === "image" && typeof block.data === "string" && block.data) {
      flushText();
      parts.push({ type: "image", base64Data: block.data, mediaType: String(block.mimeType ?? "image/png") });
    } else if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  flushText();
  if (!parts.length) parts.push({ type: "text", text: args.promptText || " " });
  parts.push(...videoParts);
  return parts;
}

/** The two video types MSP `media/upload` accepts (`VideoInput`). */
export type MuseVideoMediaType = "video/mp4" | "video/quicktime";

/**
 * Whether an attachment is a video Muse can take as a `video` part. A
 * reference-only file (`hydrate: false`) never is: its bytes are never read.
 */
function museVideoMediaType(attachment: {
  type: string;
  path: string;
  mimeType?: string;
  hydrate?: boolean;
}): MuseVideoMediaType | null {
  if (attachment.type !== "file" || attachment.hydrate === false) return null;
  const mime = attachment.mimeType?.trim().toLowerCase();
  if (mime === "video/mp4" || mime === "video/quicktime") return mime;
  const extension = attachment.path.split(/[?#]/u, 1)[0]?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (extension === "mp4" || extension === "m4v") return "video/mp4";
  if (extension === "mov") return "video/quicktime";
  return null;
}

/** Raw bytes per `media/upload` chunk; each chunk's base64 frame stays well inside MSP's frame budget. */
const MUSE_MEDIA_UPLOAD_CHUNK_BYTES = 1024 * 1024;

/** Largest video ADE uploads; bigger ones go as a path hint. */
export const MUSE_MEDIA_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;

/** One `media/upload` call per chunk, in order, all under one client-minted upload id. */
export function museMediaUploadChunks(args: {
  bytes: Buffer;
  uploadId: string;
  sessionId: string;
  mediaType: MuseVideoMediaType;
}): Array<Record<string, unknown>> {
  const chunkCount = Math.max(1, Math.ceil(args.bytes.length / MUSE_MEDIA_UPLOAD_CHUNK_BYTES));
  const chunks: Array<Record<string, unknown>> = [];
  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const slice = args.bytes.subarray(chunkIndex * MUSE_MEDIA_UPLOAD_CHUNK_BYTES, (chunkIndex + 1) * MUSE_MEDIA_UPLOAD_CHUNK_BYTES);
    chunks.push({
      sessionId: args.sessionId,
      uploadId: args.uploadId,
      mediaType: args.mediaType,
      totalBytes: args.bytes.length,
      chunkCount,
      chunkIndex,
      chunkBase64: slice.toString("base64"),
    });
  }
  return chunks;
}

/**
 * ADE's MCP servers as MSP `session/start` `config.mcpServers`. `optional`
 * so a server that fails to start never blocks the chat. SSE has no MSP
 * transport and is skipped (the capability table says so).
 */
export function toMuseSessionMcpServers(
  servers: Record<string, AgentChatMcpServerConfig> | null | undefined,
): Record<string, SessionMcpServerConfig> {
  const out: Record<string, SessionMcpServerConfig> = {};
  for (const [name, server] of Object.entries(servers ?? {})) {
    if (server.type === "stdio") {
      out[name] = {
        transport: "stdio",
        command: server.command,
        ...(server.args?.length ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
        mode: "optional",
      };
    } else if (server.type === "http" && server.url) {
      out[name] = {
        transport: "streamableHttp",
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length ? { headers: server.headers } : {}),
        mode: "optional",
      };
    }
  }
  return out;
}

function approvalTitle(request: ApprovalRequestParams): string {
  const subject = request.subject;
  switch (subject?.kind) {
    case "shell":
      return "Muse wants to run a command";
    case "fileAccess":
      return "Muse wants to change a file";
    case "network":
      return "Muse wants network access";
    case "tool":
      return `Muse wants to use ${subject.toolName ?? request.toolName}`;
    default:
      return `Muse wants to use ${request.toolName}`;
  }
}

function approvalDescription(request: ApprovalRequestParams): string {
  const subject = request.subject;
  const target = subject?.command
    ?? subject?.path
    ?? (subject?.host ? `${subject.host}${subject.port ? `:${subject.port}` : ""}` : null)
    ?? subject?.target
    ?? null;
  const lines = [target ?? (request.rawArgs ?? "").slice(0, 2000)];
  if (request.protectedWrite) lines.push("This writes to a protected location.");
  if (request.judgeEscalated) lines.push("Muse's approval judge sent this to you.");
  if (request.subagentOrigin) lines.push("Requested by a Muse subagent.");
  return lines.filter(Boolean).join("\n");
}

/** Whether a Muse approval decision approved the request (`approved`, `approvedForSession`, ...). */
export function isMuseApprovedDecision(decision: string | null | undefined): boolean {
  return typeof decision === "string" && decision.startsWith("approved");
}

function isApprove(choice: ApprovalChoice): boolean {
  return isMuseApprovedDecision(choice.decision);
}

/**
 * The approval as an ADE permission card. Its options are Muse's own,
 * server-minted choices (label and id verbatim), so a decision ADE sends back
 * is always one the request offered.
 */
export function buildMuseApprovalCard(request: ApprovalRequestParams, cardId: string): PendingInputRequest {
  return {
    requestId: cardId,
    itemId: cardId,
    source: "muse",
    kind: "permissions",
    title: approvalTitle(request),
    description: approvalDescription(request),
    questions: [],
    allowsFreeform: request.availableChoices.some((choice) => choice.acceptsFeedback === true),
    blocking: true,
    canProceedWithoutAnswer: false,
    options: request.availableChoices.map((choice) => ({
      label: choice.label,
      value: choice.choiceId,
      ...(choice.rulePreview ? { description: choice.rulePreview } : {}),
      ...(isApprove(choice) && choice.scope === "once" ? { recommended: true } : {}),
    })),
    providerMetadata: {
      muse: true,
      approvalId: request.approvalId,
      toolName: request.toolName,
      subject: request.subject,
      rawArgs: request.rawArgs,
    },
    turnId: request.turnId,
  };
}

/**
 * Which Muse choice an ADE answer means. An explicit option pick wins; the
 * generic accept / accept-for-session / decline buttons map onto the choice
 * with the matching decision and scope. Never fails open: no deny choice and
 * a decline means "no choice" (the caller interrupts instead).
 */
export function museChoiceForAnswer(
  choices: readonly ApprovalChoice[],
  answer: { decision?: AgentChatApprovalDecision; responseText?: string | null; answers?: Record<string, string | string[]> },
): ApprovalChoice | null {
  const explicit = [
    answer.responseText?.trim(),
    ...Object.values(answer.answers ?? {}).flat(),
  ].find((value): value is string => typeof value === "string" && choices.some((choice) => choice.choiceId === value));
  if (explicit) return choices.find((choice) => choice.choiceId === explicit) ?? null;
  const decision = answer.decision ?? "decline";
  if (decision === "accept_for_session") {
    return choices.find((choice) => isApprove(choice) && choice.scope === "session")
      ?? choices.find((choice) => isApprove(choice) && choice.scope === "localPersistent")
      ?? choices.find((choice) => isApprove(choice))
      ?? null;
  }
  if (decision === "accept") {
    return choices.find((choice) => isApprove(choice) && choice.scope === "once")
      ?? choices.find((choice) => isApprove(choice))
      ?? null;
  }
  return choices.find((choice) => String(choice.decision) === "denied" && choice.scope === "once")
    ?? choices.find((choice) => String(choice.decision).startsWith("denied"))
    ?? null;
}

/** A Muse `request_user_input` prompt as an ADE question card. */
export function buildMuseQuestionCard(request: UserInputRequestParams, cardId: string): PendingInputRequest {
  const firstQuestion = request.questions[0];
  return {
    requestId: cardId,
    itemId: cardId,
    source: "muse",
    kind: "structured_question",
    title: firstQuestion?.header || "Muse has a question",
    description: request.questions.length === 1 && firstQuestion ? firstQuestion.question : null,
    questions: request.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({
        label: option.label,
        value: option.label,
        ...(option.description ? { description: option.description } : {}),
        ...(option.preview ? { preview: option.preview.content, previewFormat: option.preview.format === "html" ? "html" as const : "markdown" as const } : {}),
      })),
      multiSelect: question.selection.mode === "multiple",
      allowsFreeform: true,
    })),
    allowsFreeform: true,
    blocking: true,
    canProceedWithoutAnswer: false,
    ...(request.autoResolutionMs ? { autoResolutionMs: request.autoResolutionMs } : {}),
    providerMetadata: { muse: true, userInputId: request.userInputId, toolName: request.toolName },
    turnId: request.turnId,
  };
}

/**
 * ADE answers → MSP answers, one per question. A pick that matches an option
 * label is a selection; anything else is free text (Muse accepts both).
 */
export function museAnswersFor(
  request: UserInputRequestParams,
  answers: Record<string, string | string[]> | undefined,
  responseText: string | null | undefined,
): UserInputAnswer[] {
  return request.questions.map((question, index) => {
    const raw = answers?.[question.id];
    const values = (Array.isArray(raw) ? raw : raw != null ? [raw] : [])
      .map((value) => String(value).trim())
      .filter(Boolean);
    const labels = new Set(question.options.map((option) => option.label));
    const picked = values.filter((value) => labels.has(value));
    const free = values.filter((value) => !labels.has(value)).join("\n")
      || (index === 0 && !values.length ? responseText?.trim() ?? "" : "");
    if (question.selection.mode === "multiple" && picked.length) {
      return { questionId: question.id, selectedLabels: picked, ...(free ? { note: free } : {}) };
    }
    if (picked.length) {
      return { questionId: question.id, selectedLabel: picked[0]!, ...(free ? { note: free } : {}) };
    }
    return { questionId: question.id, freeText: free };
  });
}

/**
 * Muse's own verbs, as the slash menu lists them: not model turns. The same
 * list drives the menu and the names ADE treats as harness commands.
 */
export const MUSE_LOCAL_COMMANDS: ReadonlyArray<{ name: string; description: string; argumentHint?: string }> = [
  { name: "compact", description: "Summarize older context to free tokens." },
  { name: "goal", description: "Set, show, pause, resume, or clear Muse's goal.", argumentHint: "[pause|resume|clear|<objective>]" },
  { name: "recap", description: "Ask Muse for a recap of this session." },
  { name: "tasks", description: "Stop Muse's background tasks.", argumentHint: "stop" },
];

/**
 * A composer line Muse runs as a command rather than a turn. Anything else
 * (including a skill's `/shortcut`, which Muse expands itself) is null and is
 * sent as a normal turn.
 */
type MuseControlCommand =
  | { kind: "compact" }
  /** `arg` is empty for a bare `/goal`, which shows the current goal. */
  | { kind: "goal"; arg: string }
  | { kind: "recap" }
  | { kind: "stopTasks" }
  | { kind: "shell"; commandText: string };

export function parseMuseControlCommand(text: string): MuseControlCommand | null {
  const trimmed = text.trim();
  if (/^\/compact(?:\s+[\s\S]*)?$/i.test(trimmed)) return { kind: "compact" };
  const goal = trimmed.match(/^\/goal(?:\s+([\s\S]*))?$/i);
  if (goal) return { kind: "goal", arg: goal[1]?.trim() ?? "" };
  if (/^\/recap$/i.test(trimmed)) return { kind: "recap" };
  if (/^\/tasks\s+stop$/i.test(trimmed)) return { kind: "stopTasks" };
  if (trimmed.startsWith("!") && trimmed.length > 1) {
    return { kind: "shell", commandText: trimmed.slice(1).trim() };
  }
  return null;
}

/** A Muse subagent or workflow row, as the chat runtime tracks it (keyed by the transcript's item id). */
export type MuseSubagentItemRef = {
  kind: "subagent" | "workflow";
  subagentId: string | null;
  childSessionId: string | null;
  workflowRunId: string | null;
  running: boolean;
  paused: boolean;
  children: Array<{ childId: string; attempt: number; status: string; label: string | null }>;
};

type MuseSubagentControlRequest =
  | { method: string; params: Record<string, unknown> }
  | { refuse: string };

/**
 * The subagent and workflow controls ADE acts on (interrupt, resume, reopen,
 * close, pause, skip/retry a workflow child). Keyed by the shared union, so a
 * control added there fails to compile until it is allowed here. Every entry
 * point (IPC and the CLI, through `controlSubagent`) passes through
 * `museSubagentControlRequest`, which refuses anything else.
 */
const SUBAGENT_CONTROL_ACTIONS: Record<AgentChatSubagentControlAction, true> = {
  interrupt: true,
  resume: true,
  reopen: true,
  close: true,
  pause: true,
  skip_child: true,
  retry_child: true,
};

export function isAgentChatSubagentControlAction(value: string): value is AgentChatSubagentControlAction {
  return Object.hasOwn(SUBAGENT_CONTROL_ACTIONS, value);
}

/**
 * The MSP command a subagent or workflow control maps to, or the reason ADE
 * refuses it. `sessionId` is the Muse session the row belongs to.
 */
export function museSubagentControlRequest(
  ref: MuseSubagentItemRef,
  args: AgentChatControlSubagentArgs,
  sessionId: string,
): MuseSubagentControlRequest {
  if (!isAgentChatSubagentControlAction(args.action)) {
    return { refuse: `Unknown subagent control action: ${String(args.action)}.` };
  }
  if (ref.kind === "workflow") {
    if (!ref.workflowRunId) return { refuse: "Muse did not name this workflow's run." };
    if (args.action === "pause") {
      return { method: "workflow/pause", params: { sessionId, workflowRunId: ref.workflowRunId } };
    }
    if (args.action === "resume") {
      return { method: "workflow/resume", params: { sessionId, workflowRunId: ref.workflowRunId } };
    }
    if (args.action === "skip_child" || args.action === "retry_child") {
      const childId = args.childId?.trim();
      const child = childId ? ref.children.find((entry) => entry.childId === childId) : undefined;
      const attempt = typeof args.attempt === "number" && Number.isInteger(args.attempt) && args.attempt >= 1
        ? args.attempt
        : child?.attempt;
      if (!childId || !attempt) return { refuse: "Name the workflow child (and its current attempt) to skip or retry." };
      return {
        method: "workflow/childControl",
        params: {
          sessionId,
          workflowRunId: ref.workflowRunId,
          childId,
          attempt,
          action: args.action === "skip_child" ? "skip" : "retry",
        },
      };
    }
    return { refuse: `A Muse workflow cannot ${args.action}.` };
  }
  if (!ref.subagentId) return { refuse: "Muse did not name this subagent." };
  if (args.action === "pause" || args.action === "skip_child" || args.action === "retry_child") {
    return { refuse: `A Muse subagent cannot ${args.action.replace("_", " ")}.` };
  }
  const reason = args.reason?.trim() || undefined;
  return {
    method: `subagent/${args.action}`,
    params: {
      sessionId,
      subagentId: ref.subagentId,
      ...(reason && (args.action === "interrupt" || args.action === "close") ? { reason } : {}),
    },
  };
}

type MuseTerminalStatus = "completed" | "interrupted" | "failed";

/**
 * A turn's terminal state in ADE words. ADE's own Stop (`interrupted`) turns
 * any non-completed terminal into an interruption; a completed turn stays
 * completed.
 */
export function museTerminalStatus(terminal: string, interrupted = false): MuseTerminalStatus {
  if (terminal === "completed") return "completed";
  if (interrupted || terminal === "cancelled") return "interrupted";
  return "failed";
}

type DoneEvent = Extract<AgentChatEvent, { type: "done" }>;

/** The `done` event that closes a Muse turn, with its model, served model and usage. */
export function museDoneEvent(args: {
  turnId: string;
  terminal: string;
  interrupted?: boolean;
  model: DoneEvent["model"];
  modelId?: DoneEvent["modelId"] | null;
  servedModel?: string | null;
  usage?: DoneEvent["usage"];
}): DoneEvent {
  return {
    type: "done",
    turnId: args.turnId,
    status: museTerminalStatus(args.terminal, args.interrupted),
    model: args.model,
    ...(args.modelId ? { modelId: args.modelId } : {}),
    ...(args.servedModel ? { servedModel: args.servedModel } : {}),
    ...(args.usage ? { usage: args.usage } : {}),
  };
}
