/**
 * Pure helpers between ADE's chat shapes and Muse Session Protocol shapes:
 * turn input, MCP servers, approval and question cards, effort.
 *
 * Kept out of `agentChatService.ts` so each mapping can be read (and checked)
 * on its own; the runtime there owns the I/O.
 */
import type {
  AgentChatApprovalDecision,
  AgentChatMcpServerConfig,
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
  return (MUSE_REASONING_EFFORTS as readonly string[]).includes(trimmed) ? trimmed as ReasoningEffort : undefined;
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
  for (const attachment of args.attachments) {
    const mediaType = args.uploadVideo ? museVideoMediaType(attachment) : null;
    const uploadId = mediaType ? await args.uploadVideo!(attachment, mediaType) : null;
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
export function museVideoMediaType(attachment: {
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
export const MUSE_MEDIA_UPLOAD_CHUNK_BYTES = 1024 * 1024;

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
  const lines = [target ? target : request.rawArgs.slice(0, 2000)];
  if (request.protectedWrite) lines.push("This writes to a protected location.");
  if (request.judgeEscalated) lines.push("Muse's approval judge sent this to you.");
  if (request.subagentOrigin) lines.push("Requested by a Muse subagent.");
  return lines.filter(Boolean).join("\n");
}

function isApprove(choice: ApprovalChoice): boolean {
  return String(choice.decision).startsWith("approved");
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
  return {
    requestId: cardId,
    itemId: cardId,
    source: "muse",
    kind: "structured_question",
    title: request.questions[0]?.header || "Muse has a question",
    description: request.questions.length === 1 ? request.questions[0]!.question : null,
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
