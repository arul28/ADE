import fs from "node:fs";
import os from "node:os";
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
import {
  pathIsWithinRoot,
  samePathOnPlatform,
  stripExtendedLengthPrefix,
  trimTrailingSeparators,
} from "../../../../desktop/src/shared/pathContainment";
import { resolveReadableHistoryPath } from "../../../../desktop/src/main/services/storage/historyCompression";
import type { AdeRuntime } from "../../bootstrap";
import type { BufferedEvent, EventBufferDrainResult } from "../../eventBuffer";
import { resolveMachineAdeLayout } from "../projects/machineLayout";
import { readImageFileAndSniffMime, saveImageTempAttachment } from "../imageAttachment";
import { projectAttachmentsDir } from "../../../../desktop/src/shared/chatAttachmentStagingFs";

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
 * A filesystem root: "/", a Windows drive root, or a bare UNC share root.
 *
 * Deliberately NOT in `shared/pathContainment.ts` with the containment rule:
 * the UNC branch is specific to this guard. `path.win32.parse("\\\\srv\\share")`
 * reports its root as "\\", so the ordinary root comparison below would let a
 * whole file server through as if it were an ordinary folder.
 *
 * Mirrored by `isFilesystemRoot` in `packages/sdk/src/hostConfig.ts`, which
 * runs the same rule client-side.
 */
function isFilesystemRoot(resolved: string, impl: path.PlatformPath): boolean {
  const value = impl === path.win32 ? stripExtendedLengthPrefix(resolved, "win32") : resolved;
  const trimmed = trimTrailingSeparators(value, impl);
  if (impl === path.win32 && /^[\\/]{2}[^\\/]/.test(trimmed)) {
    const segments = trimmed.slice(2).split(/[\\/]+/).filter((part) => part.length > 0);
    return segments.length <= 2;
  }
  const root = impl.parse(value).root;
  if (!root.length) return false;
  return trimmed === trimTrailingSeparators(root, impl);
}

/**
 * The filesystem seam `validatePersonalHostCwd` needs, so it stays injectable.
 *
 * One call, and it may throw: `fs.realpathSync.native` on a path that does not
 * exist. The walk below is what turns that into an answer.
 */
export type PersonalHostCwdFs = { realpathSync: (target: string) => string };

/**
 * The real on-disk path of the deepest existing ancestor, with the missing tail
 * re-joined.
 *
 * `canonicalWindowsPath()` in `services/projects/machineLayout.ts` does exactly
 * this for Windows; the guards below need it on EVERY platform, because a
 * symlink defeats a lexical check the same way on macOS and Linux. The
 * directory may not exist yet — the create path mkdirs it after this returns —
 * so a plain `realpathSync` would throw on the ordinary case.
 *
 * A path that cannot be resolved at all comes back as the caller's own
 * normalization, which is what the checks used to receive unconditionally.
 */
function canonicalDeepestExisting(
  value: string,
  impl: path.PlatformPath,
  fsImpl: PersonalHostCwdFs,
): string {
  const original = impl.normalize(value);
  const missingParts: string[] = [];
  let cursor = original;
  for (;;) {
    try {
      return impl.join(fsImpl.realpathSync(cursor), ...missingParts);
    } catch {
      const parent = impl.dirname(cursor);
      if (parent === cursor) return original;
      missingParts.unshift(impl.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * The working directory a host asked a personal chat to run in.
 *
 * A personal chat's agent runs in a 0700 scratch directory under ADE_HOME by
 * default, which is the wrong place for a host whose value is acting on the
 * user's own files: anything the agent writes there is, to that user, gone. So
 * the host may name a directory — but only a directory it plausibly meant.
 *
 * Refused, and why each one:
 *  - a relative path, which would otherwise resolve against whatever the
 *    runtime process happens to be sitting in;
 *  - "~", because expanding it here and not expanding it in the SDK is exactly
 *    the kind of split that makes two careful readers disagree;
 *  - a filesystem, drive, or UNC share root, because a host that passes "/" by
 *    accident and an always-allow permission preset is a very bad afternoon;
 *  - the home directory itself, for the same reason one step smaller;
 *  - anything inside ADE's own state directory, because the agent would be
 *    editing the database, transcripts, and credentials of the runtime hosting
 *    it.
 *
 * Every one of those tests runs on the CANONICAL path, not on a lexical
 * normalization. A lexical check reads `~/work/shortcut` as a folder under
 * `~/work` and admits it, while the symlink behind that name points at `~/.ade`
 * or at `/` — which is precisely the thing the last two rules exist to refuse.
 * `adeDir` and `homeDir` are canonicalized the same way, or a symlinked ADE
 * home would fail to match a canonical candidate that is genuinely inside it.
 *
 * The message is prefixed `invalid_argument:` so the SDK can map it to a stable
 * error code rather than matching on prose.
 *
 * This function is the AUTHORITATIVE copy of the rule. `validateThreadCwd` in
 * `packages/sdk/src/hostConfig.ts` refuses the same five things lexically, on
 * the client, so a caller hears about a bad `cwd` before a round trip; that
 * copy cannot canonicalize because the SDK ships standalone to npm and has no
 * engine filesystem to consult. When a refusal changes here, change it there
 * too.
 */
export function validatePersonalHostCwd(
  value: unknown,
  context: {
    adeDir: string;
    homeDir: string;
    platform?: NodeJS.Platform;
    /** Injected so a test can stage a symlink without touching a real disk. */
    fs?: PersonalHostCwdFs;
  },
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("invalid_argument: requestedCwd must be a string.");
  }
  const raw = value.trim();
  if (!raw.length) return undefined;
  const platform = context.platform ?? process.platform;
  const impl = platform === "win32" ? path.win32 : path.posix;
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    throw new Error(
      "invalid_argument: requestedCwd must not start with '~'. Expand the home directory yourself "
      + "and pass an absolute path.",
    );
  }
  if (!impl.isAbsolute(raw)) {
    throw new Error(`invalid_argument: requestedCwd must be an absolute path. Received '${raw}'.`);
  }
  const fsImpl = context.fs ?? { realpathSync: (target: string) => fs.realpathSync.native(target) };
  // Strip `\\?\` after canonicalize and before every refusal. realpath on
  // Windows can keep the prefix while `os.homedir()` / ADE home do not, and
  // `\\?\C:\` looks like a UNC root to Node — a missed home or ADE-state
  // refusal, or a missed UNC share-root refusal. The returned path is the
  // unprefixed spelling so later containment sees one form.
  const resolved = stripExtendedLengthPrefix(canonicalDeepestExisting(raw, impl, fsImpl), platform);
  const homeDir = stripExtendedLengthPrefix(canonicalDeepestExisting(context.homeDir, impl, fsImpl), platform);
  const adeDir = stripExtendedLengthPrefix(canonicalDeepestExisting(context.adeDir, impl, fsImpl), platform);
  if (isFilesystemRoot(resolved, impl)) {
    throw new Error(
      `invalid_argument: requestedCwd must not be a filesystem root. Received '${raw}'.`,
    );
  }
  // `samePathOnPlatform`, not `===`: the case fold and the trailing-separator trim both
  // decide this answer, and the platform is passed rather than the path flavor
  // so macOS folds. A guard that refuses must fold — a missed fold skips the
  // refusal while the OS opens the very same folder.
  if (samePathOnPlatform(resolved, homeDir, platform)) {
    throw new Error(
      "invalid_argument: requestedCwd must not be the home directory itself. Name a folder inside it.",
    );
  }
  if (pathIsWithinRoot(adeDir, resolved, platform)) {
    throw new Error(
      "invalid_argument: requestedCwd must not be inside ADE's own state directory.",
    );
  }
  return trimTrailingSeparators(resolved, impl);
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
    return {
      version: 1,
      actions: [...PERSONAL_CHAT_ACTIONS],
      pushEvents: true,
      mcpServers: true,
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
        // A personal chat is never an orchestration lead. The orchestration
        // fields below are stripped, but `interactionMode` is forwarded, and
        // "orchestrator-lead" alone makes the runtime treat the session as a
        // lead: locked permissions, and MCP isolation that is always strict.
        // The chat would then run strict while its capability report said
        // strictRequested: false — a report contradicting the session it
        // describes. Refusing is the only outcome that keeps the report honest,
        // and no legitimate embedder asks a projectless chat to lead a run.
        if (args.interactionMode === "orchestrator-lead" || args.orchestrationRole === "lead") {
          throw new Error(
            "Personal chats cannot be orchestration leads. Create this chat without "
            + "interactionMode 'orchestrator-lead', or start it in a project.",
          );
        }
        const kickoffText = typeof args.kickoffText === "string" ? args.kickoffText.trim() : "";
        // Validated here rather than in the chat service: this is the boundary
        // an external embedder speaks to, and the refusal has to happen before
        // a session row exists, not after one is created pointing somewhere it
        // should never have pointed.
        const machineLayout = resolveMachineAdeLayout();
        const hostCwd = validatePersonalHostCwd(args.requestedCwd, {
          adeDir: machineLayout.adeDir,
          homeDir: os.homedir(),
        });
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
      case "interruptWithQueueMode":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.interrupt(args as never);
        break;
      case "stopTask":
        await this.requirePersonalSession(service, readSessionId(args));
        result = await service.stopTask(args as never);
        break;
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
        result = await service.respondToInput(args as never);
        break;
      case "approve":
        await this.requirePersonalSession(service, readSessionId(args));
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
          projectAttachmentsDir(runtime.projectRoot),
          args,
        );
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

  private requirePersonalTerminal(ptyId: string, sessionId?: string): string {
    const ownedSessionId = this.personalTerminalSessions.get(ptyId);
    if (!ownedSessionId || (sessionId && ownedSessionId !== sessionId)) {
      throw new Error(`Personal terminal '${ptyId}' was not found.`);
    }
    return ownedSessionId;
  }
}
