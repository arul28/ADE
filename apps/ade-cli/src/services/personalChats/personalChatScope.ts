import fs from "node:fs";
import path from "node:path";
import type {
  AgentChatCreateArgs,
  AgentChatSessionSummary,
  PersonalChatAction,
  PersonalChatCallResponse,
  PersonalChatCapabilities,
  RuntimeActivityCounts,
} from "../../../../desktop/src/shared/types";
import { PERSONAL_CHAT_ACTIONS } from "../../../../desktop/src/shared/types";
import { resolveAdeLayout } from "../../../../desktop/src/shared/adeLayout";
import { resolveReadableHistoryPath } from "../../../../desktop/src/main/services/storage/historyCompression";
import type { AdeRuntime } from "../../bootstrap";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { readImageFileAndSniffMime, saveImageTempAttachment } from "../imageAttachment";

type PersonalChatScopeOptions = {
  createRuntime?: typeof import("../../bootstrap").createAdeRuntime;
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
  private readonly personalTerminalSessions = new Map<string, string>();

  constructor(private readonly options: PersonalChatScopeOptions = {}) {}

  capabilities(): PersonalChatCapabilities {
    return { version: 1, actions: [...PERSONAL_CHAT_ACTIONS] };
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
            return session.surface === "personal"
              ? session
              : { ...session, surface: "personal" as const };
          });
        break;
      }
      case "create": {
        const provider = requiredString(args.provider, "provider") as AgentChatCreateArgs["provider"];
        const model = requiredString(args.model, "model");
        const laneId = await this.getInternalLaneId(runtime);
        const kickoffText = typeof args.kickoffText === "string" ? args.kickoffText.trim() : "";
        const {
          laneId: _laneId,
          requestedCwd: _requestedCwd,
          surface: _surface,
          sessionProfile: _sessionProfile,
          identityKey: _identityKey,
          automationId: _automationId,
          automationRunId: _automationRunId,
          orchestrationRunId: _orchestrationRunId,
          orchestrationRole: _orchestrationRole,
          orchestrationParentSessionId: _orchestrationParentSessionId,
          orchestrationTag: _orchestrationTag,
          orchestrationStepId: _orchestrationStepId,
          orchestrationBundlePath: _orchestrationBundlePath,
          kickoffText: _kickoffText,
          ...forwarded
        } = args;
        const created = await service.createSession({
          ...forwarded,
          laneId,
          provider,
          model,
          surface: "personal",
          sessionProfile: "light",
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
      case "getSummary":
        result = await this.requirePersonalSession(service, readSessionId(args));
        break;
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
        result = await service.sendMessage(args as never);
        break;
      case "steer":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.steer(args as never);
        break;
      case "cancelSteer":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.cancelSteer(args as never);
        break;
      case "editSteer":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.editSteer(args as never);
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
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.interrupt(args as never);
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
        result = await service.respondToInput(args as never);
        break;
      case "approve":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.approveToolUse(args as never);
        break;
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
      case "updateSession": {
        const sessionId = readSessionId(args);
        await this.requirePersonalSession(service, sessionId);
        result = await service.updateSession(args as never);
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
        result = await service.getChatEventHistoryPage(sessionId, {
          beforeOffset: Number(args.beforeOffset),
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
        result = await saveImageTempAttachment(
          path.join(runtime.projectRoot, ".ade", "attachments"),
          args,
        );
        break;
      case "getImageDataUrl": {
        const attachmentsRoot = await fs.promises.realpath(
          path.join(runtime.projectRoot, ".ade", "attachments"),
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

  private async getRuntime(): Promise<AdeRuntime> {
    if (this.runtimePromise) return await this.runtimePromise;
    this.runtimePromise = this.createRuntime();
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
      runtimeProfile: "chat",
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

  private requirePersonalTerminal(ptyId: string, sessionId?: string): string {
    const ownedSessionId = this.personalTerminalSessions.get(ptyId);
    if (!ownedSessionId || (sessionId && ownedSessionId !== sessionId)) {
      throw new Error(`Personal terminal '${ptyId}' was not found.`);
    }
    return ownedSessionId;
  }
}
