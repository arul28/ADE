import fs from "node:fs";
import path from "node:path";
import type {
  AgentChatCreateArgs,
  AgentChatPersonalProfile,
  AgentChatSessionSummary,
  PersonalChatAction,
  PersonalChatCallResponse,
  PersonalChatCapabilities,
  RuntimeActivityCounts,
} from "../../../../desktop/src/shared/types";
import { PERSONAL_CHAT_ACTIONS } from "../../../../desktop/src/shared/types";
import { USER_ONLY_CONSENT_CARD_REFUSAL } from "../../../../desktop/src/shared/types/macDesktop";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import { resolveReadableHistoryPath } from "../../../../desktop/src/main/services/storage/historyCompression";
import { stripHostOnlyChatMetadata } from "../../../../desktop/src/shared/chatAutoResume";
import { stripHostAuthoredMessageProvenance } from "../../../../desktop/src/main/services/chat/spawnMissionOwnership";
import {
  personalHostPathContext,
  validatePersonalHostCwd,
} from "../../../../desktop/src/main/services/chat/personalHostPaths";
import type { AdeRuntime } from "../../bootstrap";
import type { BufferedEvent, EventBufferDrainResult } from "../../eventBuffer";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { IMAGE_MIME_BY_EXTENSION, readImageFileAndSniffMime, saveImageTempAttachment } from "../imageAttachment";
import {
  projectAttachmentsDir,
  stageAttachmentBytes,
} from "../../../../desktop/src/shared/chatAttachmentStagingFs";
import {
  LEGACY_MAX_CHAT_ATTACHMENT_BYTES,
  legacyAttachmentCapMessage,
  maxBase64EncodedLength,
} from "../../../../desktop/src/shared/chatAttachmentLimits";
import { historyPageBeforeSequence } from "../sync/syncRemoteCommandService";

/**
 * An embedder's message args, with every marker only ADE may author removed.
 *
 * `personalChats.call` is an untrusted edge — it does not pass through the ADE
 * RPC's `withTrustedAgentProvenance` — and both dispatch paths it exposes reach
 * a dispatch commit point. A caller-asserted `usageLimitResume: "manual"` or
 * `scheduledWake` would exempt its message from the auto-resume cancel sweep
 * and leave a chat's resume armed through real activity, to fire an unattended
 * prompt later; `spawnDispatch` would let a caller
 * manufacture mission ownership. The rest of the caller's metadata is passed
 * through untouched.
 */
function withUntrustedChatMetadata(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const metadata = args.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return args;
  const sanitized: Record<string, unknown> = { ...(metadata as Record<string, unknown>) };
  stripHostAuthoredMessageProvenance(sanitized);
  const stripped = stripHostOnlyChatMetadata(sanitized);
  const { metadata: _untrusted, ...rest } = args;
  return stripped ? { ...rest, metadata: stripped } : rest;
}

type PersonalChatScopeOptions = {
  createRuntime?: typeof import("../../bootstrap").createAdeRuntime;
  /**
   * Runtime profile for the hidden machine-chat runtime. "chat" is the default
   * and what the desktop, TUI, and brain all use. "embedded" is for a runtime
   * an external embedder started (`ade runtime run --profile embedded`): same
   * personal-chat surface, no automations, and sync forced off.
   */
  runtimeProfile?: "chat" | "embedded";
};

type ObjectArgs = Record<string, unknown>;

export function summarizeRuntimeActivity(runtime: AdeRuntime): RuntimeActivityCounts {
  return {
    activeAgentTurns: runtime.agentChatService?.hasActiveWorkloads() ? 1 : 0,
    activeWorkSessions: runtime.ptyService.list({ status: "running", limit: 500 })
      .filter(
        (session) =>
          session.runtimeState === "running"
          || session.runtimeState === "waiting-input",
      ).length,
  };
}

function asObject(value: unknown): ObjectArgs {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectArgs
    : {};
}

function requiredString(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

/**
 * `personalChats.call` is an untrusted edge, so it never answers a card only
 * the user may answer (the Mac Desktop input lease, the Windows shared seat).
 * A personal chat has no lane and so never raises one; this keeps it that way.
 */
function refuseUserOnlyConsentCard(
  service: { isUserOnlyPendingInput?: (args: { sessionId: string; itemId: string }) => boolean },
  args: ObjectArgs,
): void {
  const itemId = typeof args.itemId === "string" ? args.itemId.trim() : "";
  if (itemId && service.isUserOnlyPendingInput?.({ sessionId: readSessionId(args), itemId })) {
    throw new Error(USER_ONLY_CONSENT_CARD_REFUSAL);
  }
}

/**
 * A chat row with what the rail reads off its session row: the synced `pinned`
 * column, and the agent's own reports (`ade chat activity|note|ask`).
 */
function withRowMeta<T extends AgentChatSessionSummary>(runtime: AdeRuntime, summary: T): T {
  const row = runtime.sessionService.get(summary.sessionId);
  if (!row) return summary;
  return {
    ...summary,
    ...(row.pinned === true ? { pinned: true } : {}),
    ...(row.activityStatus ? { activityStatus: row.activityStatus } : {}),
    ...(row.statusNote ? { statusNote: row.statusNote } : {}),
    ...(row.attentionRequestedAt
      ? { attentionRequestedAt: row.attentionRequestedAt, attentionMessage: row.attentionMessage ?? null }
      : {}),
    ...(!summary.currentTurnStartedAt && row.currentTurnStartedAt
      ? { currentTurnStartedAt: row.currentTurnStartedAt }
      : {}),
  };
}

/** Is this payload an image by its declared MIME type or its file name? */
function declaresImage(args: ObjectArgs): boolean {
  const mime = typeof args.mimeType === "string" ? args.mimeType : typeof args.mime === "string" ? args.mime : "";
  if (mime.trim().toLowerCase().startsWith("image/")) return true;
  const dataUrl = typeof args.dataUrl === "string" ? args.dataUrl.trim() : "";
  if (dataUrl.toLowerCase().startsWith("data:image/")) return true;
  const filename = typeof args.filename === "string" ? args.filename : "";
  return Boolean(IMAGE_MIME_BY_EXTENSION[path.extname(filename).toLowerCase()]);
}

/**
 * Stage a non-image file a personal chat attaches (a PDF, a CSV, source).
 *
 * The same contract as a project's `chat.saveTempAttachment`: base64 bytes up
 * to the legacy cap, written under a fresh UUID name in this runtime's own
 * attachment store with only a validated extension kept from the caller's
 * name. The caller never picks the path, so it can only add a file there, never
 * read or overwrite one; the agent receives that path like any attachment.
 */
async function saveFileTempAttachment(attachmentsDir: string, args: ObjectArgs): Promise<{ path: string }> {
  const base64 = typeof args.base64 === "string" ? args.base64 : typeof args.data === "string" ? args.data : "";
  const compact = base64.replace(/\s+/g, "");
  if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error("Temporary attachment base64 is invalid.");
  }
  if (compact.length > maxBase64EncodedLength(LEGACY_MAX_CHAT_ATTACHMENT_BYTES)) {
    throw new Error(legacyAttachmentCapMessage("Temporary attachments"));
  }
  const content = Buffer.from(compact, "base64");
  if (content.byteLength > LEGACY_MAX_CHAT_ATTACHMENT_BYTES) {
    throw new Error(legacyAttachmentCapMessage("Temporary attachments"));
  }
  if (content.byteLength === 0) throw new Error("This attachment was empty.");
  return await stageAttachmentBytes({
    content,
    filename: typeof args.filename === "string" ? args.filename : null,
    attachmentsDir,
  });
}

/** The call's args without the ADE-surface claim, which no chat service method takes. */
function withoutAssistantClaim(args: ObjectArgs): ObjectArgs {
  if (!("personalProfile" in args)) return args;
  const { personalProfile: _claim, ...rest } = args;
  return rest;
}

function readSessionId(args: ObjectArgs): string {
  return requiredString(args.sessionId, "sessionId");
}

function readLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(500, Math.floor(value)));
}

function readDimension(value: unknown, label: string, fallback?: number): number {
  if (value == null && fallback != null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return Math.floor(value);
}

function isPersonalChatAction(value: unknown): value is PersonalChatAction {
  return typeof value === "string" && (PERSONAL_CHAT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Machine-owned chat scope. It deliberately stays out of ProjectRegistry, so
 * the synthetic project/lane required by the existing chat + PTY services can
 * never leak into project pickers, recents, or mobile project catalogs.
 */
export class PersonalChatScope {
  private runtimePromise: Promise<AdeRuntime> | null = null;
  /** The local desktop's bridge token, handed on by the brain. */
  private desktopBridgeAuthToken: string | null = null;

  /**
   * The local desktop's bridge token, so this runtime can mint browser
   * capabilities for its chats (`ADE_BROWSER_ACTOR_TOKEN`): without it an
   * assistant chat's `ade browser` is refused. Applied to a live runtime now
   * and to a runtime created later on creation. An embedded runtime never
   * receives one (the brain only forwards it on the chat profile).
   */
  setDesktopBridgeAuthToken(authToken: string): void {
    const token = authToken.trim();
    if (!token || this.options.runtimeProfile === "embedded") return;
    this.desktopBridgeAuthToken = token;
    if (!this.runtimePromise) return;
    void this.runtimePromise
      .then((runtime) => runtime.configureBuiltInBrowserDesktopBridgeAuth?.(token))
      .catch(() => undefined);
  }
  private readonly personalTerminalSessions = new Map<string, string>();

  constructor(private readonly options: PersonalChatScopeOptions = {}) {}

  capabilities(): PersonalChatCapabilities {
    return {
      version: 1,
      actions: [...PERSONAL_CHAT_ACTIONS],
      pushEvents: true,
      mcpServers: true,
      updateMcpServers: true,
    };
  }

  /**
   * Read activity only when the machine chat runtime is already booted. Update
   * idleness probes must never create the personal-chat runtime as a side
   * effect.
   */
  async activitySummary(): Promise<RuntimeActivityCounts> {
    const pending = this.runtimePromise;
    if (!pending) return { activeAgentTurns: 0, activeWorkSessions: 0 };
    const runtime = await pending.catch(() => null);
    if (!runtime) return { activeAgentTurns: 0, activeWorkSessions: 0 };
    return summarizeRuntimeActivity(runtime);
  }

  /**
   * Existing personal-chat users should not pay the hidden runtime's cold boot
   * after opening the Chats pane. Fresh installs remain lazy.
   */
  async warmExisting(): Promise<void> {
    const layout = resolveMachineAdeLayout();
    const stateRoot = layout.personalChatsStateRoot ?? path.join(layout.adeDir, "personal-chats", "state");
    if (!fs.existsSync(path.join(stateRoot, ".ade", "ade.db"))) return;
    await this.getRuntime();
  }

  async call(
    actionValue: unknown,
    argsValue: unknown,
    signal?: AbortSignal,
  ): Promise<PersonalChatCallResponse> {
    if (!isPersonalChatAction(actionValue)) {
      throw new Error(`Unsupported personal chat action: ${String(actionValue ?? "")}.`);
    }
    const action = actionValue;
    const args = asObject(argsValue);
    const runtime = await this.getRuntime();
    const service = runtime.agentChatService;
    if (!service) throw new Error("Personal chat service is not available.");

    let result: unknown;
    switch (action) {
      case "list": {
        const sessions = await service.listSessions(undefined, {
          includeIdentity: false,
          includeAutomation: true,
          includeArchived: args.includeArchived === true,
        });
        // This runtime is a private machine-owned scope: every chat row inside
        // it is personal. Older rows may have lost their surface while being
        // reconstructed for a follow-up, so repair and return them instead of
        // filtering intact transcripts out of the UI.
        result = sessions
          .filter((session) => session.surface !== "automation")
          .map((session) => {
            if (session.surface !== "personal") {
              service.ensureSessionSurface(session.sessionId, "personal");
            }
            const row = session.surface === "personal"
              ? session
              : { ...session, surface: "personal" as const };
            return withRowMeta(runtime, row);
          });
        break;
      }
      case "setPinned": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        // The same synced column a Work chat's pin lives in, so a pin made on
        // one client shows on every client of this machine.
        runtime.sessionService.updateMeta({ sessionId, pinned: requiredBoolean(args.pinned, "pinned") });
        const summary = await service.getSessionSummary(sessionId);
        result = summary ? withRowMeta(runtime, summary) : null;
        break;
      }
      case "slashCommands": {
        const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
        if (sessionId) await this.requirePersonalSession(service, sessionId);
        const provider = typeof args.provider === "string" && args.provider.trim()
          ? args.provider.trim() as AgentChatCreateArgs["provider"]
          : null;
        // The internal lane, never a caller's: a provider-only lookup reads the
        // personal workspace, not whatever project the caller has open.
        result = service.getSlashCommands({
          ...(sessionId ? { sessionId } : {}),
          ...(provider ? { provider } : {}),
          laneId: await this.getInternalLaneId(runtime),
        });
        break;
      }
      case "create": {
        const provider = requiredString(args.provider, "provider") as AgentChatCreateArgs["provider"];
        const model = requiredString(args.model, "model");
        const laneId = await this.getInternalLaneId(runtime);
        const kickoffText = typeof args.kickoffText === "string" ? args.kickoffText.trim() : "";
        // `requestedCwd` is validated here, at the boundary an external
        // embedder speaks to, because the directory is created below, before
        // any session row exists. `attachmentRoots` is validated by the chat
        // service, which applies the same rule (`personalHostPaths`) on every
        // route.
        const hostCwd = validatePersonalHostCwd(args.requestedCwd, personalHostPathContext());
        if (hostCwd) {
          // 0755, not the 0700 of the runtime's own scratch workspace: this is
          // a directory the user is meant to open in a file browser, which is
          // the entire reason a host names one.
          fs.mkdirSync(hostCwd, { recursive: true, mode: 0o755 });
        }
        const {
          laneId: _laneId,
          requestedCwd: _requestedCwd,
          surface: _surface,
          sessionProfile: _sessionProfile,
          identityKey: _identityKey,
          automationId: _automationId,
          automationRunId: _automationRunId,
          orchestrationParentSessionId: _orchestrationParentSessionId,
          kickoffText: _kickoffText,
          attachmentRoots: _attachmentRoots,
          personalProfile: _personalProfile,
          ...forwarded
        } = args;
        // What this chat is for. An embedded runtime (an SDK host) is always
        // `embedded`, whatever the caller sent. Elsewhere only an explicit
        // `assistant` — what ADE's own UI and `ade chat create --personal`
        // send — gets the assistant surface; an absent value stays `embedded`,
        // so an SDK client attached to this runtime keeps today's behavior.
        const personalProfile: AgentChatPersonalProfile = this.options.runtimeProfile !== "embedded"
          && args.personalProfile === "assistant"
          ? "assistant"
          : "embedded";
        const created = await service.createSession({
          ...forwarded,
          // Named explicitly rather than left to `...forwarded`: these are the
          // ADE SDK's contract with an external embedder, and adding either one
          // to the strip-list above must be a deliberate act, not a side effect
          // of someone else editing that list. The chat service validates both
          // and REFUSES the create when a server is unusable or the provider
          // cannot carry it — nothing is dropped silently, here or there.
          ...(args.mcpServers !== undefined
            ? { mcpServers: args.mcpServers as AgentChatCreateArgs["mcpServers"] }
            : {}),
          // Both values forwarded, not just `true`. Personal chats are created
          // on the "light" session profile, which is strict by default, so an
          // explicit `false` (the SDK's `loadUserMcpServers: true`) is the only
          // way an embedder can ask for the user's own MCP config — collapsing
          // it to absent silently ignored the request.
          ...(typeof args.strictMcpConfig === "boolean"
            ? { strictMcpConfig: args.strictMcpConfig }
            : {}),
          // Named explicitly for the same reason as the MCP pair above: it is
          // still in the strip-list destructure, so leaving it to `...forwarded`
          // would silently drop it the moment someone reads that list as the
          // definition of what a personal chat may not set.
          ...(hostCwd ? { requestedCwd: hostCwd } : {}),
          // Validated and canonicalized by the chat service, which applies the
          // same rule on every route (`validatePersonalAttachmentRoots`).
          ...(args.attachmentRoots !== undefined
            ? { attachmentRoots: args.attachmentRoots as AgentChatCreateArgs["attachmentRoots"] }
            : {}),
          laneId,
          provider,
          model,
          surface: "personal",
          personalProfile,
          // The assistant runs as a full chat (tool gate, approval cards, the
          // user's MCP servers); the SDK surface keeps the lean profile.
          sessionProfile: personalProfile === "assistant" ? "workflow" : "light",
          permissionMode: typeof args.permissionMode === "string"
            ? args.permissionMode as AgentChatCreateArgs["permissionMode"]
            : "default",
        } as AgentChatCreateArgs);
        if (kickoffText) {
          await service.sendMessage({ sessionId: created.id, text: kickoffText }, { awaitDispatch: false });
        }
        result = await service.getSessionSummary(created.id);
        break;
      }
      case "getSummary": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        this.claimForAssistant(service, sessionId, args);
        result = await this.requirePersonalSession(service, sessionId);
        break;
      }
      case "read": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = await service.readTranscript(
          sessionId,
          readLimit(args.limit),
          typeof args.since === "string" ? args.since : undefined,
          signal,
        );
        break;
      }
      case "send":
        await this.requirePersonalSession(service, readSessionId(args));
        this.claimForAssistant(service, readSessionId(args), args);
        result = await service.sendMessage(withUntrustedChatMetadata(withoutAssistantClaim(args)) as never);
        break;
      case "steer":
        await this.requirePersonalSession(service, readSessionId(args));
        this.claimForAssistant(service, readSessionId(args), args);
        result = await service.steer(withUntrustedChatMetadata(withoutAssistantClaim(args)) as never);
        break;
      case "cancelSteer":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.cancelSteer(args as never);
        break;
      case "editSteer":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.editSteer(args as never);
        break;
      case "moveSteer":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.moveSteer(args as never);
        break;
      case "dispatchSteer":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.dispatchSteer(args as never);
        break;
      case "cancelDispatchedSteer":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.cancelDispatchedSteer(args as never);
        break;
      case "interrupt":
      case "interruptWithQueueMode":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.interrupt(args as never);
        break;
      case "stopTask": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = await service.stopTask({
          sessionId,
          taskId: requiredString(args.taskId, "taskId"),
        });
        break;
      }
      case "restoreCancelledQueue":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.restoreCancelledQueue(args as never);
        break;
      case "recoverTurn":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.recoverTurn(args as never);
        break;
      case "resolveUnprocessedMessage":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.resolveUnprocessedMessage(args as never);
        break;
      case "respondToInput":
        await this.requirePersonalSession(service, readSessionId(args));
        refuseUserOnlyConsentCard(service, args);
        result = await service.respondToInput(args as never);
        break;
      case "approve":
        await this.requirePersonalSession(service, readSessionId(args));
        refuseUserOnlyConsentCard(service, args);
        result = await service.approveToolUse(args as never);
        break;
      case "pendingInputs": {
        // Read-only, and the answer path's mirror: a host that reloads its UI
        // asks what is still waiting rather than inferring it from events it no
        // longer holds.
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = service.listPendingInputs({ sessionId });
        break;
      }
      case "createScheduledWork": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = await service.createScheduledWork({ ...args, sessionId } as never);
        break;
      }
      case "cancelScheduledWork": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = await service.cancelScheduledWork({
          sessionId,
          scheduleId: requiredString(args.scheduleId, "scheduleId"),
        });
        break;
      }
      case "setScheduledWorkPaused": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = await service.setScheduledWorkPaused({
          sessionId,
          paused: requiredBoolean(args.paused, "paused"),
        });
        break;
      }
      case "resumeUsageLimitNow": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = await service.resumeUsageLimitNow({ sessionId });
        break;
      }
      case "continueUsageLimitOnAlternate": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = await service.continueUsageLimitOnAlternate({ sessionId });
        break;
      }
      case "updateSession": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        // `mcpServers` and `attachmentRoots` ride through with the rest: the
        // chat service accepts both only for a personal session, which
        // `requirePersonalSession` has just established, and validates them
        // exactly as create does.
        await service.updateSession(args as never);
        // The same shape create returns. The summary already withholds header
        // values, so the reply never echoes back a credential the host sent.
        result = await service.getSessionSummary(sessionId);
        break;
      }
      case "rerunLastTurn": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        const text = args.text;
        if (text !== undefined && typeof text !== "string") {
          throw new Error("invalid_argument: text must be a string.");
        }
        // Dropping a malformed list would resend the original attachments.
        if (args.attachments !== undefined && !Array.isArray(args.attachments)) {
          throw new Error("invalid_argument: attachments must be an array.");
        }
        result = await service.rerunLastTurn({
          sessionId,
          ...(text !== undefined ? { text } : {}),
          ...(typeof args.displayText === "string" ? { displayText: args.displayText } : {}),
          ...(Array.isArray(args.attachments) ? { attachments: args.attachments as never } : {}),
        });
        break;
      }
      case "archive":
      case "unarchive":
      case "delete": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        const method = action === "archive"
          ? service.archiveSession
          : action === "unarchive"
            ? service.unarchiveSession
            : service.deleteSession;
        await method({ sessionId });
        result = { ok: true };
        break;
      }
      case "models":
        if (typeof args.provider === "string" && args.provider.trim()) {
          result = await service.getAvailableModels({ provider: args.provider.trim() as never });
        } else {
          const catalog = await service.getModelCatalog({});
          result = catalog.groups.flatMap((group) =>
            group.providers.flatMap((provider) => provider.subsections.flatMap((subsection) => subsection.models)),
          );
        }
        break;
      case "modelCatalog":
        result = await service.getModelCatalog(args as never);
        break;
      case "getEventHistory": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = await service.getChatEventHistory(sessionId, {
          ...(typeof args.maxEvents === "number" ? { maxEvents: args.maxEvents } : {}),
          ...(typeof args.maxBytes === "number" ? { maxBytes: args.maxBytes } : {}),
          ...(signal ? { signal } : {}),
        });
        break;
      }
      case "getEventHistoryPage": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        // chatLogV2 durable cursor; takes precedence over the byte cursor.
        const beforeSequence = historyPageBeforeSequence(args.beforeSequence);
        result = await service.getChatEventHistoryPage(sessionId, {
          beforeOffset: Number(args.beforeOffset),
          ...(beforeSequence != null ? { beforeSequence } : {}),
          ...(typeof args.maxBytes === "number" ? { maxBytes: args.maxBytes } : {}),
          ...(signal ? { signal } : {}),
        });
        break;
      }
      case "terminalCreate": {
        const chatSessionId = typeof args.chatSessionId === "string" && args.chatSessionId.trim()
          ? args.chatSessionId.trim()
          : null;
        if (chatSessionId) await this.requirePersonalSession(service, chatSessionId);
        const laneId = await this.getInternalLaneId(runtime);
        const created = await runtime.ptyService.create({
          laneId,
          cwd: runtime.workspaceRoot,
          ...(chatSessionId ? { chatSessionId } : {}),
          cols: readDimension(args.cols, "cols", 120),
          rows: readDimension(args.rows, "rows", 36),
          title: "Personal terminal",
          tracked: true,
          toolType: "shell",
        });
        this.personalTerminalSessions.set(created.ptyId, created.sessionId);
        result = created;
        break;
      }
      case "terminalWrite": {
        const ptyId = requiredString(args.ptyId, "ptyId");
        this.requirePersonalTerminal(ptyId);
        if (typeof args.data !== "string") throw new Error("data must be a string.");
        result = await runtime.ptyService.writeTerminal({ ptyId, data: args.data });
        break;
      }
      case "terminalResize": {
        const ptyId = requiredString(args.ptyId, "ptyId");
        this.requirePersonalTerminal(ptyId);
        result = runtime.ptyService.resizeTerminal({
          ptyId,
          cols: readDimension(args.cols, "cols"),
          rows: readDimension(args.rows, "rows"),
        });
        break;
      }
      case "terminalDispose": {
        const ptyId = requiredString(args.ptyId, "ptyId");
        const sessionId = requiredString(args.sessionId, "sessionId");
        this.requirePersonalTerminal(ptyId, sessionId);
        result = runtime.ptyService.dispose({ ptyId, sessionId });
        this.personalTerminalSessions.delete(ptyId);
        break;
      }
      case "saveTempAttachment":
        // An image keeps the strict route (bytes sniffed against the declared
        // type). Any other file is staged as bytes, like a project chat's.
        result = declaresImage(args)
          ? await saveImageTempAttachment(projectAttachmentsDir(runtime.projectRoot), args)
          : await saveFileTempAttachment(projectAttachmentsDir(runtime.projectRoot), args);
        break;
      case "getImageDataUrl": {
        const attachmentsRoot = await fs.promises.realpath(
          projectAttachmentsDir(runtime.projectRoot),
        );
        const requestedPath = await fs.promises.realpath(requiredString(args.path, "path"));
        if (requestedPath !== attachmentsRoot && !requestedPath.startsWith(`${attachmentsRoot}${path.sep}`)) {
          throw new Error("Personal chat attachment path is outside the attachment store.");
        }
        const image = await readImageFileAndSniffMime(requestedPath);
        result = {
          dataUrl: `data:${image.mimeType};base64,${image.data.toString("base64")}`,
          mimeType: image.mimeType,
        };
        break;
      }
      // The agent's own row reports. A personal chat's `ade chat activity`
      // lands here (the CLI routes it by `--personal` / `ADE_CHAT_SCOPE`); the
      // session service validates the value exactly as a project's does.
      case "setSessionActivity": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        const value = args.value ?? null;
        if (value !== null && typeof value !== "string") {
          throw new Error("setSessionActivity requires a supported string `value` or null.");
        }
        if (!runtime.sessionService.setSessionActivity(sessionId, value)) {
          throw new Error(`Personal chat session '${sessionId}' was not found.`);
        }
        result = { ok: true, sessionId, value };
        break;
      }
      case "setSessionStatusNote": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        if (typeof args.note !== "string") throw new Error("setSessionStatusNote requires a string `note` field.");
        if (!runtime.sessionService.setStatusNote(sessionId, args.note || null)) {
          throw new Error(`Personal chat session '${sessionId}' was not found.`);
        }
        result = { ok: true, sessionId };
        break;
      }
      case "requestSessionAttention": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        const message = requiredString(args.message, "message");
        if (!runtime.sessionService.requestAttention(sessionId, message)) {
          throw new Error(`Personal chat session '${sessionId}' was not found.`);
        }
        result = { ok: true, sessionId };
        break;
      }
    }
    return { action, result };
  }

  async streamEvents(argsValue: unknown) {
    const args = asObject(argsValue);
    const runtime = await this.getRuntime();
    const cursor = typeof args.cursor === "number" && Number.isFinite(args.cursor)
      ? Math.max(0, Math.floor(args.cursor))
      : 0;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(1000, Math.floor(args.limit)))
      : 100;
    return runtime.eventBuffer.drain(cursor, limit);
  }

  /**
   * Live event stream for the machine chat scope.
   *
   * `streamEvents` above is a cursor drain, which costs an RPC round trip per
   * poll and adds latency to every streamed token. This is the same event
   * buffer wired to a listener instead, so the RPC server can forward each
   * event as a `runtime/event` notification. The drain stays exactly as it was
   * — the web client uses it, and a client that cannot hold a socket open still
   * needs it.
   *
   * The caller owns the returned `unsubscribe`. Booting the runtime here is
   * deliberate: a subscriber wants events from now on, and a lazily-created
   * runtime that boots later would silently miss everything before it.
   */
  async subscribeEvents(
    argsValue: unknown,
    listener: (event: BufferedEvent, eventEpoch: string) => void,
  ): Promise<{
    unsubscribe: () => void;
    /**
     * Buffered events, already category-filtered. `replay.eventEpoch` is the
     * epoch every caller reads — there is deliberately no second copy of it on
     * this object, because two fields that must agree eventually will not.
     */
    replay: EventBufferDrainResult;
  }> {
    const args = asObject(argsValue);
    const runtime = await this.getRuntime();
    const category = typeof args.category === "string" ? args.category.trim() : "";
    const cursor = typeof args.cursor === "number" && Number.isFinite(args.cursor)
      ? Math.max(0, Math.floor(args.cursor))
      : 0;
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(1000, Math.floor(args.limit)))
      : 100;
    const shouldForward = (event: BufferedEvent): boolean =>
      !category || event.category === category;
    const eventEpoch = runtime.eventBuffer.epoch();
    // Subscribe before draining, matching runtimeEvents.subscribe. The reverse
    // order drops every event published between the drain and the listener
    // attaching — the exact window a busy chat fills. The cost is that an event
    // landing inside that window can arrive twice; `BufferedEvent.id` is
    // monotonic, so a client dedupes on it. A duplicate is recoverable, a gap
    // is not.
    const unsubscribe = runtime.eventBuffer.subscribe((event) => {
      if (shouldForward(event)) listener(event, eventEpoch);
    });
    const drained = args.replay === false
      ? {
        events: [],
        nextCursor: runtime.eventBuffer.latestCursor(),
        hasMore: false,
        eventEpoch,
        gap: false,
        oldestCursor: null,
      }
      : runtime.eventBuffer.drain(cursor, limit);
    // The category filter has to apply to the replay too. Filtering only the
    // live stream meant a subscriber asking for one category still received
    // every buffered event of every other category on connect — the project
    // path filters its replay at emit time and this did not.
    //
    // Cursor and hasMore stay as the raw drain reports them, matching the
    // project path: they describe the buffer page that was read, not the
    // subset forwarded, so a client's next cursor still advances past filtered
    // events instead of re-reading them forever.
    const replay = { ...drained, events: drained.events.filter(shouldForward) };
    return { unsubscribe, replay };
  }

  async transcriptPath(sessionIdValue: unknown): Promise<string | null> {
    const sessionId = requiredString(sessionIdValue, "sessionId");
    const runtime = await this.getRuntime();
    const service = runtime.agentChatService;
    if (!service || !(await this.resolvePersonalSession(service, sessionId))) return null;
    // The session transcript is byte-capped. Remote clients must tail the
    // dedicated durable chat transcript or long conversations stop updating.
    const durablePath = path.join(resolveAdeLayout(runtime.projectRoot).chatTranscriptsDir, `${sessionId}.jsonl`);
    const legacyPath = runtime.sessionService.get(sessionId)?.transcriptPath ?? "";
    return resolveReadableHistoryPath(durablePath)
      ?? resolveReadableHistoryPath(legacyPath)
      ?? (legacyPath || durablePath);
  }

  async isTurnActive(sessionIdValue: unknown): Promise<boolean> {
    const sessionId = requiredString(sessionIdValue, "sessionId");
    const runtime = await this.getRuntime();
    const service = runtime.agentChatService;
    if (!service) return false;
    const summary = await this.resolvePersonalSession(service, sessionId);
    return summary?.status === "active";
  }

  async dispose(): Promise<void> {
    const pending = this.runtimePromise;
    this.runtimePromise = null;
    const runtime = await pending?.catch(() => null);
    this.personalTerminalSessions.clear();
    runtime?.dispose();
  }

  /**
   * The personal runtime, booting it when needed. For the brain's wake router,
   * which delivers a child's completion into a personal chat that asked for it.
   */
  async runtimeForDelivery(): Promise<AdeRuntime> {
    return await this.getRuntime();
  }

  /** The personal runtime only if it is already up; never boots it. */
  peekRuntime(): Promise<AdeRuntime> | null {
    return this.runtimePromise;
  }

  private async getRuntime(): Promise<AdeRuntime> {
    if (this.runtimePromise) return await this.runtimePromise;
    this.runtimePromise = this.createRuntime().then((runtime) => {
      const token = this.desktopBridgeAuthToken;
      if (token) void runtime.configureBuiltInBrowserDesktopBridgeAuth?.(token)?.catch(() => undefined);
      return runtime;
    });
    try {
      return await this.runtimePromise;
    } catch (error) {
      this.runtimePromise = null;
      throw error;
    }
  }

  private async createRuntime(): Promise<AdeRuntime> {
    const layout = resolveMachineAdeLayout();
    const stateRoot = layout.personalChatsStateRoot ?? path.join(layout.adeDir, "personal-chats", "state");
    const workspaceRoot = layout.personalChatsWorkspaceRoot ?? path.join(layout.adeDir, "personal-chats", "workspaces");
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    const createRuntime = this.options.createRuntime
      ?? (await import("../../bootstrap")).createAdeRuntime;
    return await createRuntime({
      projectRoot: stateRoot,
      workspaceRoot,
      primaryWorktreePath: workspaceRoot,
      chatRuntime: "agent",
      runtimeProfile: this.options.runtimeProfile ?? "chat",
      publishPushEvents: false,
      syncRuntime: { enabled: false },
    });
  }

  private async getInternalLaneId(runtime: AdeRuntime): Promise<string> {
    const lanes = await runtime.laneService.list({ includeArchived: false, includeStatus: false });
    const primary = lanes.find((lane) => lane.laneType === "primary") ?? lanes[0];
    if (!primary) throw new Error("Personal chat workspace is unavailable.");
    return primary.id;
  }

  private async requirePersonalSession(
    service: NonNullable<AdeRuntime["agentChatService"]>,
    sessionId: string,
  ): Promise<AgentChatSessionSummary> {
    const summary = await this.resolvePersonalSession(service, sessionId);
    if (!summary) {
      throw new Error(`Personal chat session '${sessionId}' was not found.`);
    }
    return summary;
  }

  private async resolvePersonalSession(
    service: NonNullable<AdeRuntime["agentChatService"]>,
    sessionId: string,
  ): Promise<AgentChatSessionSummary | null> {
    const summary = await service.getSessionSummary(sessionId);
    if (!summary || summary.surface === "automation") {
      return null;
    }
    if (summary.surface !== "personal") {
      service.ensureSessionSurface(sessionId, "personal");
      return { ...summary, surface: "personal" };
    }
    return summary;
  }

  /**
   * The legacy-row upgrade rule. ADE's own Chats surfaces (desktop, web, iOS,
   * `ade chat --personal`) send `personalProfile: "assistant"` on the calls that
   * use a chat; a row written before profiles existed (no profile at all) then
   * becomes an `assistant` chat, persisted. Never on an embedded-profile runtime
   * (an SDK host's), never for a row with an explicit profile, and never by
   * omission: an SDK client attached to this runtime does not send the claim.
   */
  private claimForAssistant(
    service: NonNullable<AdeRuntime["agentChatService"]>,
    sessionId: string,
    args: ObjectArgs,
  ): void {
    if (this.options.runtimeProfile === "embedded" || args.personalProfile !== "assistant") return;
    service.adoptLegacyPersonalSessionAsAssistant?.(sessionId);
  }

  private requirePersonalTerminal(ptyId: string, sessionId?: string): string {
    const ownedSessionId = this.personalTerminalSessions.get(ptyId);
    if (!ownedSessionId || (sessionId && ownedSessionId !== sessionId)) {
      throw new Error(`Personal terminal '${ptyId}' was not found.`);
    }
    return ownedSessionId;
  }
}
