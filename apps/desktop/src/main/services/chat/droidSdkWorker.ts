import type * as DroidSdkTypes from "@factory/droid-sdk";
import type {
  DroidSdkAskUserRequest,
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
import { loadDroidSdk } from "../ai/droidSdkLoader";

type DroidSdkModule = typeof DroidSdkTypes;
type DroidSession = Awaited<ReturnType<DroidSdkModule["createSession"]>>;

let sdkModule: DroidSdkModule | null = null;
let initState: DroidSdkWorkerInit | null = null;
let session: DroidSession | null = null;
const activeAborts = new Set<AbortController>();
let waiterSeq = 0;
const permissionWaiters = new Map<string, (decision: DroidSdkPermissionDecision) => void>();
const askUserWaiters = new Map<string, (response: DroidSdkAskUserResponse) => void>();

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

function coerceReasoning(value: DroidSdkReasoningEffort | null | undefined): DroidSdkTypes.ReasoningEffort | undefined {
  return value?.trim() ? value as DroidSdkTypes.ReasoningEffort : undefined;
}

function toDroidInteractionMode(
  sdk: DroidSdkModule,
  mode: DroidSdkSessionSettings["interactionMode"],
): DroidSdkTypes.DroidInteractionMode {
  switch (mode) {
    case "spec":
      return sdk.DroidInteractionMode.Spec;
    case "agi":
      return sdk.DroidInteractionMode.AGI;
    default:
      return sdk.DroidInteractionMode.Auto;
  }
}

function sessionOptions(
  sdk: DroidSdkModule,
  init: DroidSdkWorkerInit,
  settings: DroidSdkSessionSettings,
): DroidSdkTypes.CreateSessionOptions {
  return {
    cwd: init.laneRoot,
    execPath: init.droidPath,
    modelId: settings.modelId,
    autonomyLevel: settings.autonomyLevel as DroidSdkTypes.AutonomyLevel,
    interactionMode: toDroidInteractionMode(sdk, settings.interactionMode),
    reasoningEffort: coerceReasoning(settings.reasoningEffort),
    specModeModelId: settings.specModeModelId?.trim() || undefined,
    specModeReasoningEffort: coerceReasoning(settings.specModeReasoningEffort),
    ...(init.mcpServers?.length ? { mcpServers: init.mcpServers as DroidSdkTypes.CreateSessionOptions["mcpServers"] } : {}),
    permissionHandler: requestPermission,
    askUserHandler: requestAskUser,
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
  return {
    selectedOption: decision.selectedOption as DroidSdkTypes.RequestPermissionSelection,
    ...(decision.comment?.trim() ? { comment: decision.comment.trim() } : {}),
  };
}

// Droid's ask-user payload (`AskUserQuestion`) exposes only `topic`, `question`,
// and `options: string[]` — there is no per-option description, no multiSelect,
// and no default-value field in the SDK schema (the zod object is "passthrough",
// but no richer fields are documented or emitted). So we carry the topic through
// as the question header and surface each option as a bare label=value choice;
// that is the full ceiling of what the SDK provides. See `DroidSdkAskUserRequest`.
function summarizeAskUser(params: DroidSdkTypes.AskUserRequestParams): DroidSdkAskUserRequest {
  const questions = (params.questions ?? []).map((question, index) => {
    const topic = typeof question.topic === "string" ? question.topic.trim() : "";
    const options = (question.options ?? [])
      .map((option) => (typeof option === "string" ? option.trim() : ""))
      .filter((option) => option.length > 0)
      .map((option) => ({ label: option, value: option }));
    return {
      id: `q_${question.index ?? index + 1}`,
      ...(topic.length ? { header: topic } : {}),
      question: question.question,
      ...(options.length ? { options } : {}),
    };
  });
  return {
    id: params.toolCallId || `droid-ask-user-${Date.now()}`,
    toolCallId: params.toolCallId,
    title: questions.length === 1 ? "Question from Droid" : "Questions from Droid",
    questions,
    raw: params,
  };
}

async function requestAskUser(params: DroidSdkTypes.AskUserRequestParams): Promise<DroidSdkTypes.AskUserResult> {
  const request = summarizeAskUser(params);
  const waiterId = nextWaiterId("droid-ask-user");
  const requestWithId = { ...request, id: waiterId };
  const response = await new Promise<DroidSdkAskUserResponse>((resolve) => {
    askUserWaiters.set(waiterId, resolve);
    post({ type: "ask_user_request", requestId: waiterId, request: requestWithId });
  });
  askUserWaiters.delete(waiterId);
  return response as DroidSdkTypes.AskUserResult;
}

function normalizeAvailableModels(initResult: unknown): DroidSdkReady["availableModels"] {
  const record = initResult && typeof initResult === "object" ? initResult as Record<string, unknown> : null;
  const raw = Array.isArray(record?.availableModels) ? record.availableModels : [];
  return raw.flatMap((entry) => {
    const model = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
    if (!model) return [];
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    if (!id.length) return [];
    return [{
      id,
      modelId: typeof model.modelId === "string" ? model.modelId : null,
      displayName: typeof model.displayName === "string" ? model.displayName : null,
      shortDisplayName: typeof model.shortDisplayName === "string" ? model.shortDisplayName : null,
      supportedReasoningEfforts: Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts.filter((v): v is string => typeof v === "string")
        : undefined,
      defaultReasoningEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null,
      isCustom: model.isCustom === true,
    }];
  });
}

function buildReady(): DroidSdkReady {
  if (!session) throw new Error("Droid SDK worker is not initialized.");
  const initResult = session.initResult as unknown;
  const record = initResult && typeof initResult === "object" ? initResult as Record<string, unknown> : null;
  const currentModelId = typeof record?.currentModelId === "string" ? record.currentModelId : null;
  return {
    sessionId: session.sessionId,
    currentModelId,
    availableModels: normalizeAvailableModels(initResult),
  };
}

async function applySettings(settings: DroidSdkSessionSettings): Promise<void> {
  if (!session) throw new Error("Droid SDK worker is not initialized.");
  const sdk = await getSdk();
  if (settings.interactionMode === "spec") {
    await session.enterSpecMode({
      specModeModelId: settings.specModeModelId?.trim() || settings.modelId,
      specModeReasoningEffort: coerceReasoning(settings.specModeReasoningEffort ?? settings.reasoningEffort),
    });
    return;
  }
  await session.updateSettings({
    modelId: settings.modelId,
    autonomyLevel: settings.autonomyLevel as DroidSdkTypes.AutonomyLevel,
    interactionMode: toDroidInteractionMode(sdk, settings.interactionMode),
    reasoningEffort: coerceReasoning(settings.reasoningEffort),
  });
}

async function initWorker(init: DroidSdkWorkerInit): Promise<DroidSdkReady> {
  initState = init;
  const sdk = await getSdk();
  const resumeId = init.resumeSessionId?.trim();
  if (resumeId) {
    try {
      session = await sdk.resumeSession(resumeId, {
        cwd: init.laneRoot,
        execPath: init.droidPath,
        permissionHandler: requestPermission,
        askUserHandler: requestAskUser,
        ...(init.mcpServers?.length ? { mcpServers: init.mcpServers as DroidSdkTypes.ResumeSessionOptions["mcpServers"] } : {}),
      });
      await applySettings(init.settings);
    } catch (error) {
      post({
        type: "log",
        level: "warn",
        message: "Droid SDK resume failed; creating a new session.",
        detail: { resumeSessionId: resumeId, error: errorMessage(error) },
      });
      session = await sdk.createSession(sessionOptions(sdk, init, init.settings));
    }
  } else {
    session = await sdk.createSession(sessionOptions(sdk, init, init.settings));
  }
  const ready = buildReady();
  post({ type: "ready", ready });
  return ready;
}

async function sendPrompt(payload: DroidSdkWorkerRequest & { type: "send" }): Promise<unknown> {
  if (!session || !initState) throw new Error("Droid SDK worker is not initialized.");
  await applySettings(payload.payload.settings);
  const controller = new AbortController();
  activeAborts.add(controller);
  let tokenUsage: unknown = null;
  let firstError: unknown = null;
  try {
    const images = payload.payload.images?.map((image) => ({
      type: "base64" as const,
      data: image.data,
      mediaType: image.mimeType as DroidSdkTypes.Base64ImageSource["mediaType"],
    }));
    for await (const event of session.stream(payload.payload.promptText, {
      ...(images?.length ? { images } : {}),
      abortSignal: controller.signal,
    })) {
      if ((event as { type?: string }).type === "token_usage_update") tokenUsage = event;
      if ((event as { type?: string }).type === "turn_complete") {
        tokenUsage = (event as { tokenUsage?: unknown }).tokenUsage ?? tokenUsage;
      }
      if ((event as { type?: string }).type === "error" && firstError == null) firstError = event;
      post({ type: "sdk_event", event });
    }
    return {
      sessionId: session.sessionId,
      tokenUsage,
      success: firstError == null,
      ...(firstError ? { error: firstError } : {}),
    };
  } finally {
    activeAborts.delete(controller);
  }
}

// Terminate a single AGI mission worker. killWorkerSession lives only on the
// low-level DroidClient — DroidSession (what createSession/resumeSession return)
// exposes no public getter at @factory/droid-sdk 0.2.0 — so reach the underlying
// client via its (TS-private, runtime-present) `_client` field.
async function killWorker(workerSessionId: string): Promise<void> {
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
  await cancelRun().catch(() => undefined);
  await session?.close().catch(() => undefined);
  session = null;
  initState = null;
}

async function dispatch(req: DroidSdkWorkerRequest): Promise<unknown> {
  switch (req.type) {
    case "init":
      return initWorker(req.payload);
    case "send":
      return sendPrompt(req);
    case "settings_update":
      await applySettings(req.payload);
      return buildReady();
    case "cancel":
      await cancelRun();
      return {};
    case "kill_worker":
      await killWorker(req.payload.workerSessionId);
      return {};
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
