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
  if (!sdkModule) sdkModule = await import("@factory/droid-sdk");
  return sdkModule;
}

function coerceReasoning(value: DroidSdkReasoningEffort | null | undefined): DroidSdkTypes.ReasoningEffort | undefined {
  return value?.trim() ? value as DroidSdkTypes.ReasoningEffort : undefined;
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
    interactionMode: settings.interactionMode === "spec"
      ? sdk.DroidInteractionMode.Spec
      : sdk.DroidInteractionMode.Auto,
    reasoningEffort: coerceReasoning(settings.reasoningEffort),
    specModeModelId: settings.specModeModelId?.trim() || undefined,
    specModeReasoningEffort: coerceReasoning(settings.specModeReasoningEffort),
    permissionHandler: requestPermission,
    askUserHandler: requestAskUser,
  };
}

function summarizePermission(params: DroidSdkTypes.RequestPermissionRequestParams): DroidSdkPermissionRequest {
  const toolUses = Array.isArray(params.toolUses) ? params.toolUses : [];
  const first = toolUses[0];
  const toolUse = first?.toolUse;
  const details = first?.details as Record<string, unknown> | undefined;
  const toolName = typeof toolUse?.name === "string" && toolUse.name.trim().length
    ? toolUse.name.trim()
    : typeof details?.type === "string" && details.type.trim().length
      ? details.type.trim()
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
    toolUseIds: toolUses
      .map((entry) => entry.toolUse?.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
    options: (params.options ?? []).map((option) => ({
      label: option.label,
      value: String(option.value),
    })),
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

function summarizeAskUser(params: DroidSdkTypes.AskUserRequestParams): DroidSdkAskUserRequest {
  const questions = (params.questions ?? []).map((question, index) => ({
    id: `q_${question.index ?? index + 1}`,
    header: question.topic,
    question: question.question,
    options: question.options?.map((option) => ({ label: option, value: option })),
  }));
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
    interactionMode: sdk.DroidInteractionMode.Auto,
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
