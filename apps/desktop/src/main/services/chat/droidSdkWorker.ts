import type * as DroidSdkTypes from "@factory/droid-sdk";
import type * as DroidSdkNodeTypes from "@factory/droid-sdk/node";
import type {
  DroidSdkAskUserResponse,
  DroidSdkPermissionDecision,
  DroidSdkPermissionRequest,
  DroidSdkReady,
  DroidSdkReasoningEffort,
  DroidSdkSessionSettings,
  DroidSdkWorkerInit,
  DroidSdkWorkerRequest,
  DroidSdkWorkerResponse,
} from "./droidSdkProtocol";
import {
  droidEditedSpecContentForRequest,
  droidInteractionModeValue,
  droidMcpToolsToDisable,
} from "./droidSdkProtocol";
import { loadDroidSdk } from "../ai/droidSdkLoader";
import { summarizeDroidAskUser } from "./droidSdkAskUser";
import { ensureDroidSpawnsAreWindowless } from "./droidSdkWindowsHide";
import { materializeWorkerImages } from "./workerAttachmentImages";

// Must run before the SDK spawns `droid`; see droidSdkWindowsHide.ts.
ensureDroidSpawnsAreWindowless();

// Session APIs live on the `/node` entrypoint (0.9.x); handler payload/result and
// content-block types stay on the browser-safe package root.
type DroidSdkModule = typeof DroidSdkNodeTypes;
type DroidSession = Awaited<ReturnType<DroidSdkModule["createSession"]>>;

let sdkModule: DroidSdkModule | null = null;
let initState: DroidSdkWorkerInit | null = null;
let session: DroidSession | null = null;
/**
 * Set when ADE put THIS session into Spec mode — on create, on the
 * resume-failure fallback, or in applySettings. 0.9.x exposes `exitSpecMode()`,
 * but the SDK still cannot tell ADE's Spec from one the user configured in
 * `~/.factory/settings.json`, so this flag is what authorizes leaving it.
 *
 * Known limit: a session resumed into a fresh worker that a PREVIOUS worker had
 * put into Spec starts with the flag false, and there is no way to read the live
 * mode back. Reaching that case needs a plan session, a worker restart, plan
 * turned off, and no chosen permission mode — and the alternative (assuming Spec
 * on every resume) would exit a mode ADE does not own.
 */
let enteredSpecMode = false;
/**
 * The most recent settings ADE pushed. Re-applied when the source branch is
 * re-opened after a `fork()` retired its handle, so the source is not reset to
 * the worker's original init snapshot.
 */
let latestSettings: DroidSdkSessionSettings | null = null;
/**
 * Source session id to re-open lazily after a `fork()` retired the live handle
 * and the immediate re-open failed. Keeps the source self-healing instead of
 * leaving the pooled worker with no session.
 */
let pendingResumeSessionId: string | null = null;
const activeAborts = new Set<AbortController>();
let waiterSeq = 0;
const permissionWaiters = new Map<string, (decision: DroidSdkPermissionDecision) => void>();
const askUserWaiters = new Map<string, (response: DroidSdkAskUserResponse) => void>();

/**
 * Serializes session acquisition/lifecycle transitions. Worker IPC dispatches
 * requests independently, so a `send`/`settings_update`/`kill_worker` must not
 * use a handle a concurrent `fork` is about to retire. `cancel` is deliberately
 * not gated — it has to interrupt an in-flight turn — and `dispose` flips
 * `disposed` first so a resume that lands after disposal is closed, not adopted.
 */
let disposed = false;
let sessionOpLock: Promise<unknown> = Promise.resolve();

function withSessionOp<T>(op: () => Promise<T>): Promise<T> {
  const next = sessionOpLock.then(op, op);
  sessionOpLock = next.catch(() => undefined);
  return next;
}

function nextWaiterId(prefix: string): string {
  waiterSeq = (waiterSeq + 1) >>> 0;
  return `${prefix}-${Date.now()}-${waiterSeq}`;
}

function post(message: DroidSdkWorkerResponse): void {
  if (process.send) process.send(message);
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const message = error.message.trim();
  return message && message !== "Error" ? message : error.name || "Unknown Droid SDK error";
}

async function getSdk(): Promise<DroidSdkModule> {
  if (!sdkModule) sdkModule = await loadDroidSdk();
  return sdkModule;
}

/**
 * Ensures a live session is present. `DroidSession.fork()` retires the source
 * handle, so after a fork the source branch is re-opened here on demand (or
 * immediately, from `forkSession`) rather than leaving the pooled worker unable
 * to serve the source chat.
 *
 * Worker IPC is dispatched without serialization, so concurrent callers share
 * one in-flight resume; whichever handle resolves first becomes the live
 * session and any later handle is closed rather than leaked.
 */
let pendingResumePromise: Promise<void> | null = null;

async function ensureSession(): Promise<void> {
  if (session) return;
  const resumeId = pendingResumeSessionId;
  const state = initState;
  if (!resumeId || !state) throw new Error("Droid SDK worker is not initialized.");
  if (!pendingResumePromise) {
    pendingResumePromise = (async () => {
      const sdk = await getSdk();
      const resumed = await sdk.resumeSession(resumeId, resumeSessionOptions(state));
      if (disposed || session) {
        // The worker was disposed (or another recovery already adopted a handle)
        // while this resume was in flight; discard it instead of leaking.
        await resumed.close().catch(() => undefined);
        return;
      }
      session = resumed;
      pendingResumeSessionId = null;
      post({
        type: "log",
        level: "info",
        message: "Re-opened the Droid source session after a fork.",
        detail: { sessionId: resumed.id },
      });
    })().finally(() => {
      pendingResumePromise = null;
    });
  }
  await pendingResumePromise;
  if (!session) throw new Error("Droid SDK worker is not initialized.");
}

// Still accepts null: settings cross a process boundary as JSON, so the
// protocol type is a contract with the sender rather than a runtime guarantee.
function coerceReasoning(value: DroidSdkReasoningEffort | null | undefined): DroidSdkNodeTypes.ReasoningEffort | undefined {
  return value?.trim() ? value as DroidSdkNodeTypes.ReasoningEffort : undefined;
}

function sessionOptions(
  sdk: DroidSdkModule,
  init: DroidSdkWorkerInit,
  settings: DroidSdkSessionSettings,
): DroidSdkNodeTypes.CreateSessionOptions {
  const interactionMode = droidInteractionModeValue(sdk.DroidInteractionMode, settings.interactionMode);
  return {
    cwd: init.laneRoot,
    execPath: init.droidPath,
    modelId: settings.modelId,
    // Omitted, not defaulted: both keys are optional in the SDK and each
    // resolves independently from the user's settings.json when absent.
    ...(settings.autonomyLevel ? { autonomyLevel: settings.autonomyLevel as DroidSdkNodeTypes.AutonomyLevel } : {}),
    ...(interactionMode ? { interactionMode } : {}),
    reasoningEffort: coerceReasoning(settings.reasoningEffort),
    specModeModelId: settings.specModeModelId?.trim() || undefined,
    specModeReasoningEffort: coerceReasoning(settings.specModeReasoningEffort),
    ...(init.mcpServers?.length ? { mcpServers: init.mcpServers as DroidSdkNodeTypes.CreateSessionOptions["mcpServers"] } : {}),
    permissionHandler: requestPermission,
    askUserHandler: requestAskUser,
  };
}

function resumeSessionOptions(init: DroidSdkWorkerInit): DroidSdkNodeTypes.ResumeSessionOptions {
  return {
    // 0.9.x `resumeSession` no longer accepts `cwd`: the session's persisted
    // working directory is authoritative, and the spawned CLI runs in this
    // worker's cwd (the lane root) regardless.
    execPath: init.droidPath,
    permissionHandler: requestPermission,
    askUserHandler: requestAskUser,
    ...(init.mcpServers?.length ? { mcpServers: init.mcpServers as DroidSdkNodeTypes.ResumeSessionOptions["mcpServers"] } : {}),
  };
}

// AGI mission proposals (ProposeMission confirmations) carry the orchestrator's
// plan in `details.proposal`, which may be a markdown string or a structured
// object. Render a readable summary so the user approves the mission with full
// context instead of an opaque "propose_mission" prompt.
function renderMissionProposal(proposal: unknown): string {
  if (typeof proposal === "string") return proposal.trim();
  if (proposal && typeof proposal === "object") {
    const record = proposal as Record<string, unknown>;
    const parts = [record.title, record.summary, record.description, record.objective, record.goal]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (parts.length) return parts.join("\n\n");
    try {
      return JSON.stringify(proposal, null, 2);
    } catch {
      return "";
    }
  }
  return "";
}

function summarizePermission(params: DroidSdkTypes.RequestPermissionRequestParams): DroidSdkPermissionRequest {
  const toolUses = Array.isArray(params.toolUses) ? params.toolUses : [];
  const first = toolUses[0];
  const toolUse = first?.toolUse;
  const details = first?.details as Record<string, unknown> | undefined;
  const detailType = typeof details?.type === "string" ? details.type : "";
  const optionList = (params.options ?? []).map((option) => ({
    label: option.label,
    value: String(option.value),
  }));
  const toolUseIdList = toolUses
    .map((entry) => entry.toolUse?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  // Mission-proposal confirmation: surface the actual plan.
  if (detailType === "propose_mission") {
    const proposalText = renderMissionProposal(details?.proposal);
    const truncated = proposalText.length > 2000 ? `${proposalText.slice(0, 2000)}…` : proposalText;
    return {
      id: toolUse?.id ?? `droid-mission-${Date.now()}`,
      title: typeof details?.title === "string" && details.title.trim().length
        ? details.title.trim()
        : "Droid mission proposal",
      summary: truncated || "Droid proposed a mission. Approve to let it decompose the work and run worker subagents.",
      toolName: "propose_mission",
      toolInput: details?.proposal,
      toolUseIds: toolUseIdList,
      options: optionList,
      raw: params,
    };
  }

  // Start-mission-run confirmation: explain what approving begins.
  if (detailType === "start_mission_run") {
    const running = typeof details?.runningMissionCount === "number" ? details.runningMissionCount : 0;
    return {
      id: toolUse?.id ?? `droid-mission-run-${Date.now()}`,
      title: "Start mission run",
      summary: running > 0
        ? `Begin executing the approved mission (${running} mission${running === 1 ? "" : "s"} already running).`
        : "Begin executing the approved mission.",
      toolName: "start_mission_run",
      toolInput: details,
      toolUseIds: toolUseIdList,
      options: optionList,
      raw: params,
    };
  }

  const toolName = typeof toolUse?.name === "string" && toolUse.name.trim().length
    ? toolUse.name.trim()
    : detailType.length
      ? detailType
      : "tool";
  const title =
    typeof details?.title === "string" && details.title.trim().length
      ? details.title.trim()
      : toolName;
  const summary =
    typeof details?.fullCommand === "string" && details.fullCommand.trim().length
      ? details.fullCommand.trim()
      : typeof details?.filePath === "string" && details.filePath.trim().length
        ? details.filePath.trim()
        : title;
  return {
    id: toolUse?.id ?? `droid-permission-${Date.now()}`,
    title,
    summary,
    toolName,
    toolInput: toolUse?.input,
    toolUseIds: toolUseIdList,
    options: optionList,
    raw: params,
  };
}

async function requestPermission(
  params: DroidSdkTypes.RequestPermissionRequestParams,
): Promise<DroidSdkTypes.RequestPermissionHandlerResult> {
  const request = summarizePermission(params);
  const waiterId = nextWaiterId("droid-permission");
  const requestWithId = { ...request, id: waiterId };
  const decision = await new Promise<DroidSdkPermissionDecision>((resolve) => {
    permissionWaiters.set(waiterId, resolve);
    post({ type: "permission_request", requestId: waiterId, request: requestWithId });
  });
  permissionWaiters.delete(waiterId);
  const comment = decision.comment?.trim();
  if (decision.selectedOption === "proceed_edit") {
    const editedSpecContent = droidEditedSpecContentForRequest(params.toolUses);
    if (editedSpecContent != null) {
      return {
        selectedOption: "proceed_edit",
        ...(comment ? { comment } : {}),
        editedSpecContent,
      } as DroidSdkTypes.RequestPermissionHandlerResult;
    }
    return {
      selectedOption: "cancel",
      comment: comment ?? "ADE has no plan editor for this confirmation; the request was cancelled.",
    } as DroidSdkTypes.RequestPermissionHandlerResult;
  }
  return {
    selectedOption: decision.selectedOption as DroidSdkTypes.RequestPermissionSelection,
    ...(comment ? { comment } : {}),
  } as DroidSdkTypes.RequestPermissionHandlerResult;
}

async function requestAskUser(params: DroidSdkTypes.AskUserRequestParams): Promise<DroidSdkTypes.AskUserResult> {
  const request = summarizeDroidAskUser(params);
  const waiterId = nextWaiterId("droid-ask-user");
  const requestWithId = { ...request, id: waiterId };
  const response = await new Promise<DroidSdkAskUserResponse>((resolve) => {
    askUserWaiters.set(waiterId, resolve);
    post({ type: "ask_user_request", requestId: waiterId, request: requestWithId });
  });
  askUserWaiters.delete(waiterId);
  return response as DroidSdkTypes.AskUserResult;
}

/**
 * The model Droid resolved for this session.
 *
 * `DroidSession` in @factory/droid-sdk 0.9.x exposes the live settings through
 * `session.settings` (and the session id through `session.id`); the old
 * `initResult.currentModelId`/`initResult.availableModels` surface is gone. The
 * model *list* is discovered separately via the CLI (`droidModelsDiscovery`), so
 * `availableModels` is intentionally empty here.
 */
function buildReady(): DroidSdkReady {
  if (!session) throw new Error("Droid SDK worker is not initialized.");
  // `modelId` is required on the SDK's `SessionSettings`.
  const modelId = session.settings.modelId.trim();
  return {
    sessionId: session.id,
    currentModelId: modelId.length ? modelId : null,
    availableModels: [],
  };
}

/**
 * DroidSession exposes MCP enumeration publicly, but @factory/droid-sdk 0.9.x
 * still exposes the per-tool enable switch (`toggleMcpTool`) only on its
 * low-level client. Keep the private-field bridge in one place and fail closed
 * if a future SDK removes it.
 */
async function disableUnmanagedMcpTools(): Promise<void> {
  const allowedServerNames = initState?.allowedMcpServerNames;
  if (!session || !allowedServerNames) return;
  // 0.9.x `listMcpTools()` returns `McpToolInfo[]` directly (0.2 wrapped it in
  // `{ tools }`).
  const listed = await session.listMcpTools();
  if (!Array.isArray(listed)) {
    throw new Error("Droid did not return a valid MCP tool list for the strict MCP sweep.");
  }
  const toDisable = droidMcpToolsToDisable(listed, allowedServerNames);
  if (!toDisable.length) return;
  const client = (session as unknown as {
    _client?: {
      toggleMcpTool?: (params: {
        serverName: string;
        toolName: string;
        enabled: boolean;
      }) => Promise<unknown>;
    };
  })._client;
  if (!client || typeof client.toggleMcpTool !== "function") {
    throw new Error("This Droid SDK build does not expose session-scoped toggleMcpTool.");
  }
  for (const tool of toDisable) {
    await client.toggleMcpTool({
      serverName: tool.serverName,
      toolName: tool.toolName,
      enabled: false,
    });
  }
  post({
    type: "log",
    level: "debug",
    message: "Disabled unmanaged Droid MCP tools.",
    detail: { disabledCount: toDisable.length },
  });
}

async function applySettings(settings: DroidSdkSessionSettings): Promise<void> {
  await ensureSession();
  if (!session) throw new Error("Droid SDK worker is not initialized.");
  latestSettings = settings;
  const sdk = await getSdk();
  await disableUnmanagedMcpTools();
  if (settings.interactionMode === "spec") {
    await session.enterSpecMode({
      specModeModelId: settings.specModeModelId?.trim() || settings.modelId,
      specModeReasoningEffort: coerceReasoning(settings.specModeReasoningEffort ?? settings.reasoningEffort),
    });
    enteredSpecMode = true;
    return;
  }
  // Omitting the mode leaves Droid's own setting alone, which is the point.
  // 0.9.x exposes `exitSpecMode()`, so a Spec ADE itself entered is left
  // explicitly instead of restating Auto over whatever the user configured.
  const statedInteractionMode = droidInteractionModeValue(sdk.DroidInteractionMode, settings.interactionMode);
  if (enteredSpecMode && !statedInteractionMode) {
    // Clear the flag only on success so a failed exit is retried by the next
    // settings push instead of leaving ADE believing the session left Spec.
    try {
      await session.exitSpecMode();
      enteredSpecMode = false;
    } catch (error) {
      post({
        type: "log",
        level: "warn",
        message: "Droid exitSpecMode failed; leaving the session in its current mode.",
        detail: { error: errorMessage(error) },
      });
    }
  } else if (statedInteractionMode) {
    enteredSpecMode = false;
  }
  await session.updateSettings({
    modelId: settings.modelId,
    ...(settings.autonomyLevel ? { autonomyLevel: settings.autonomyLevel as DroidSdkNodeTypes.AutonomyLevel } : {}),
    ...(statedInteractionMode ? { interactionMode: statedInteractionMode } : {}),
    reasoningEffort: coerceReasoning(settings.reasoningEffort),
  });
}

async function initWorker(init: DroidSdkWorkerInit): Promise<DroidSdkReady> {
  initState = init;
  enteredSpecMode = false;
  disposed = false;
  latestSettings = init.settings;
  pendingResumeSessionId = null;
  const sdk = await getSdk();
  const resumeId = init.resumeSessionId?.trim();
  if (resumeId) {
    try {
      // 0.9.x `resumeSession` no longer accepts `cwd`: the session's persisted
      // working directory is authoritative, and the spawned CLI runs in this
      // worker's cwd (the lane root) regardless.
      session = await sdk.resumeSession(resumeId, resumeSessionOptions(init));
      // Deliberately NOT seeded from the mode Droid reports here. That reading
      // cannot tell a Spec this ADE entered from one the user configured in
      // ~/.factory/settings.json, and exiting the latter would be exactly the
      // override this branch removes. applySettings below sets the flag when ADE
      // itself restates Spec, which covers every resume ADE drives.
      await applySettings(init.settings);
    } catch (error) {
      post({
        type: "log",
        level: "warn",
        message: "Droid SDK resume failed; creating a new session.",
        detail: { resumeSessionId: resumeId, error: errorMessage(error) },
      });
      session = await sdk.createSession(sessionOptions(sdk, init, init.settings));
      enteredSpecMode = init.settings.interactionMode === "spec";
    }
  } else {
    session = await sdk.createSession(sessionOptions(sdk, init, init.settings));
    enteredSpecMode = init.settings.interactionMode === "spec";
  }
  await disableUnmanagedMcpTools();
  const ready = buildReady();
  post({ type: "ready", ready });
  return ready;
}

async function sendPrompt(payload: DroidSdkWorkerRequest & { type: "send" }): Promise<unknown> {
  if (!initState) throw new Error("Droid SDK worker is not initialized.");
  // Acquire/refresh the session under the lifecycle gate; the long stream itself
  // runs outside it so `cancel` can still interrupt the turn.
  await withSessionOp(() => applySettings(payload.payload.settings));
  if (!session) throw new Error("Droid SDK worker is not initialized.");
  const controller = new AbortController();
  activeAborts.add(controller);
  let tokenUsage: unknown = null;
  let firstError: unknown = null;
  let resultSuccess = true;
  try {
    const materialized = await materializeWorkerImages(payload.payload.images, { label: "Droid SDK" });
    const images = materialized.map((image) => {
      if (!("data" in image)) {
        throw new Error("Droid SDK image URLs are not supported.");
      }
      return {
        type: "base64" as const,
        data: image.data,
        mediaType: image.mimeType as DroidSdkTypes.Base64ImageSource["mediaType"],
      };
    });
    // `includePartialMessages` is required to keep receiving assistant/thinking
    // text deltas, `tool_progress`, `working_state_changed`, `token_usage_update`,
    // and the mission events — the default 0.9.x stream yields only complete
    // messages. The terminal event is `result` (0.2's `turn_complete` is gone).
    // The literal `true` selects the `DroidStreamEvent` overload, so `event` is
    // discriminated and needs no casts.
    const streamOptions: {
      images?: DroidSdkTypes.Base64ImageSource[];
      abortSignal: AbortSignal;
      includePartialMessages: true;
    } = {
      abortSignal: controller.signal,
      includePartialMessages: true,
      ...(images.length ? { images } : {}),
    };
    for await (const event of session.stream(payload.payload.promptText, streamOptions)) {
      if (event.type === "token_usage_update") tokenUsage = event;
      if (event.type === "result") {
        tokenUsage = event.tokenUsage ?? tokenUsage;
        if (event.success === false) {
          resultSuccess = false;
          // The stream's terminal `result` carries the failure cause but the
          // event mapper drops `result`, so surface the cause as an `error`
          // event (the turn still ends failed) or users lose the provider text.
          if (event.error && firstError == null) {
            firstError = event.error;
            post({ type: "sdk_event", event: event.error });
          }
        }
      }
      if (event.type === "error" && firstError == null) firstError = event;
      post({ type: "sdk_event", event });
    }
    return {
      sessionId: session.id,
      tokenUsage,
      success: firstError == null && resultSuccess,
      ...(firstError ? { error: firstError } : {}),
    };
  } finally {
    activeAborts.delete(controller);
  }
}

// Terminate a single AGI mission worker. killWorkerSession lives only on the
// low-level DroidClient — DroidSession (what createSession/resumeSession return)
// exposes no public getter at @factory/droid-sdk 0.9.x — so reach the underlying
// client via its (TS-private, runtime-present) `_client` field.
async function killWorker(workerSessionId: string): Promise<void> {
  return withSessionOp(() => killWorkerLocked(workerSessionId));
}

async function killWorkerLocked(workerSessionId: string): Promise<void> {
  await ensureSession();
  if (!session) throw new Error("Droid SDK worker is not initialized.");
  const id = workerSessionId?.trim();
  if (!id) return;
  const client = (session as unknown as {
    _client?: { killWorkerSession?: (params: { workerSessionId: string }) => Promise<unknown> };
  })._client;
  if (!client || typeof client.killWorkerSession !== "function") {
    throw new Error("This Droid SDK build does not expose killWorkerSession.");
  }
  await client.killWorkerSession({ workerSessionId: id });
}

async function forkSession(): Promise<{ newSessionId: string }> {
  return withSessionOp(forkSessionLocked);
}

async function forkSessionLocked(): Promise<{ newSessionId: string }> {
  await ensureSession();
  if (!session || !initState) throw new Error("Droid SDK worker is not initialized.");
  const sdk = await getSdk();
  const sourceSessionId = session.id;
  // 0.9.x `fork()` returns the forked session and retires the source handle —
  // any later use of the source throws `SessionReplacedError`. ADE keeps the
  // source chat open after a fork, so once the fork id is captured, close the
  // fork handle and re-open the original branch to keep the source usable. The
  // new chat resumes the fork id in its own worker.
  const forked = await session.fork();
  const newSessionId = typeof forked?.id === "string" ? forked.id.trim() : "";
  if (!newSessionId) {
    throw new Error("Droid fork returned no session id.");
  }
  await forked.close().catch(() => undefined);
  let resumed: DroidSession | null = null;
  try {
    resumed = await sdk.resumeSession(sourceSessionId, resumeSessionOptions(initState));
    session = resumed;
    // Re-apply the LATEST settings, not the worker's init snapshot: the source
    // may have changed model, left Spec, or stopped stating a mode since then.
    await applySettings(latestSettings ?? initState.settings);
  } catch (error) {
    // Close a handle that never became the live session so a lazy retry does not
    // leak a process; the source re-opens on the next request.
    if (resumed) await resumed.close().catch(() => undefined);
    // `fork()` retired the source handle. Retry the re-open lazily on the next
    // source request so the pooled worker self-heals instead of failing every
    // later turn with "not initialized".
    session = null;
    pendingResumeSessionId = sourceSessionId;
    post({
      type: "log",
      level: "warn",
      message: "Droid fork succeeded but the source session re-open failed; it retries on next use.",
      detail: { sourceSessionId, error: errorMessage(error) },
    });
  }
  return { newSessionId };
}

async function cancelRun(): Promise<void> {
  for (const [, resolve] of permissionWaiters) resolve({ selectedOption: "cancel" });
  permissionWaiters.clear();
  for (const [, resolve] of askUserWaiters) resolve({ cancelled: true, answers: [] });
  askUserWaiters.clear();
  for (const controller of activeAborts) controller.abort();
  activeAborts.clear();
  await session?.interrupt().catch(() => undefined);
}

async function dispose(): Promise<void> {
  disposed = true;
  await cancelRun().catch(() => undefined);
  await session?.close().catch(() => undefined);
  session = null;
  enteredSpecMode = false;
  latestSettings = null;
  pendingResumeSessionId = null;
  initState = null;
}

async function dispatch(req: DroidSdkWorkerRequest): Promise<unknown> {
  switch (req.type) {
    case "init":
      return initWorker(req.payload);
    case "send":
      return sendPrompt(req);
    case "settings_update":
      await withSessionOp(() => applySettings(req.payload));
      return buildReady();
    case "cancel":
      await cancelRun();
      return {};
    case "kill_worker":
      await killWorker(req.payload.workerSessionId);
      return {};
    case "fork_session":
      return await forkSession();
    case "dispose":
      await dispose();
      return {};
    case "permission_response": {
      permissionWaiters.get(req.requestId)?.(req.payload);
      return {};
    }
    case "ask_user_response": {
      askUserWaiters.get(req.requestId)?.(req.payload);
      return {};
    }
    default:
      throw new Error(`Unsupported Droid SDK worker request ${(req as { type?: string }).type}`);
  }
}

process.on("message", (raw: unknown) => {
  const req = raw as DroidSdkWorkerRequest;
  if (!req || typeof req !== "object" || typeof req.requestId !== "string") return;
  void dispatch(req)
    .then((result) => {
      post({ type: "response", requestId: req.requestId, ok: true, result });
    })
    .catch((error) => {
      post({ type: "response", requestId: req.requestId, ok: false, error: errorMessage(error) });
    });
});

process.once("disconnect", () => {
  void dispose().finally(() => process.exit(0));
});
