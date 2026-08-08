/**
 * Versioned, dependency-free IPC contract for the Pi SDK worker.
 *
 * Keep this file free of Pi imports. The desktop process must be able to load
 * the bridge even when the user has not installed Pi.
 */

export const PI_SDK_PROTOCOL_VERSION = 1 as const;
export const PI_SDK_MIN_NODE = "22.19.0" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type PiSdkModelRef =
  | string
  | { provider: string; id?: string; modelId?: string };

export type PiSdkPackageLocation = {
  /** The package directory. `packageRoot` is accepted as an alias. */
  packageDir?: string;
  packageRoot?: string;
  /** Absolute package entry, normally `<packageRoot>/dist/index.js`. */
  packageEntry?: string;
};

export type PiSdkSessionTarget = {
  /** Open this JSONL session file. */
  sessionFile?: string | null;
  /** Resolve this Pi session id in sessionDir and open its file. */
  sessionId?: string | null;
  /** Continue the most recent session when true. */
  resume?: boolean | { sessionFile?: string | null; sessionId?: string | null };
};

export type PiSdkWorkerInit = PiSdkPackageLocation & {
  protocolVersion: typeof PI_SDK_PROTOCOL_VERSION;
  cwd: string;
  /** Passed to Pi as PI_CODING_AGENT_DIR. */
  agentDir: string;
  /** Passed to Pi as PI_CODING_AGENT_SESSION_DIR. */
  sessionDir?: string | null;
  modelRef?: PiSdkModelRef | null;
  thinkingLevel?: string | null;
  systemPrompt?: string | null;
  /** Environment supplied to Pi skill/resource discovery in the worker. */
  skillsEnv?: Record<string, string>;
  /** Load the installed SDK for model/auth inventory without creating a session. */
  inventoryOnly?: boolean;
  session?: PiSdkSessionTarget;
  /** Restrict built-in tools when an integration needs a read-only session. */
  tools?: string[];
  noTools?: "all" | "builtin";
};

export type PiSdkImage = {
  data: string;
  mimeType: string;
};

export type PiSdkPromptPayload = {
  prompt: string;
  images?: PiSdkImage[];
  /** Used only when prompt is sent while Pi is streaming. */
  streamingBehavior?: "steer" | "followUp";
};

export type PiSdkModelUpdate = {
  modelRef: PiSdkModelRef;
};

export type PiSdkThinkingUpdate = {
  thinkingLevel: string;
};

export type PiSdkCompactPayload = {
  customInstructions?: string | null;
};

export type PiSdkWorkerRequest =
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "init"; requestId: string; payload: PiSdkWorkerInit }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "send"; requestId: string; payload: PiSdkPromptPayload }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "steer"; requestId: string; payload: { prompt: string; images?: PiSdkImage[] } }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "follow_up"; requestId: string; payload: { prompt: string; images?: PiSdkImage[] } }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "abort"; requestId: string }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "dispose"; requestId: string }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "set_model"; requestId: string; payload: PiSdkModelUpdate }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "set_thinking"; requestId: string; payload: PiSdkThinkingUpdate }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "compact"; requestId: string; payload?: PiSdkCompactPayload }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "models"; requestId: string }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "auth"; requestId: string };

export type PiSdkReady = {
  protocolVersion: typeof PI_SDK_PROTOCOL_VERSION;
  packageRoot: string;
  packageEntry: string;
  version: string | null;
  sessionFile: string | null;
  sessionId: string | null;
  currentModel: JsonValue | null;
  thinkingLevel: string | null;
  availableModels: JsonValue[];
};

export type PiSdkLifecycleName =
  | "worker_started"
  | "package_loaded"
  | "initializing"
  | "ready"
  | "prompt_started"
  | "prompt_finished"
  | "prompt_failed"
  | "aborted"
  | "disposed";

export type PiSdkWorkerResponse =
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "response"; requestId: string; ok: true; result?: JsonValue }
  | {
      protocolVersion: typeof PI_SDK_PROTOCOL_VERSION;
      type: "response";
      requestId: string;
      ok: false;
      error: string;
      errorCode?: string;
      detail?: JsonValue;
    }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "ready"; ready: PiSdkReady }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "sdk_event"; event: JsonValue; requestId?: string }
  | {
      protocolVersion: typeof PI_SDK_PROTOCOL_VERSION;
      type: "lifecycle";
      event: PiSdkLifecycleName;
      requestId?: string;
      detail?: JsonValue;
    }
  | {
      protocolVersion: typeof PI_SDK_PROTOCOL_VERSION;
      type: "error";
      operation: string;
      error: string;
      requestId?: string;
      detail?: JsonValue;
    }
  | { protocolVersion: typeof PI_SDK_PROTOCOL_VERSION; type: "log"; level: "debug" | "info" | "warn" | "error"; message: string; detail?: JsonValue };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isModelRef(value: unknown): value is PiSdkModelRef {
  if (nonEmptyString(value)) return true;
  if (!isRecord(value) || !nonEmptyString(value.provider)) return false;
  return nonEmptyString(value.id) || nonEmptyString(value.modelId);
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 12) return false;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function isPackageLocation(value: Record<string, unknown>): boolean {
  const paths = [value.packageDir, value.packageRoot, value.packageEntry].filter((item) => item !== undefined && item !== null);
  return paths.length > 0 && paths.every((item) => typeof item === "string" && item.trim().length > 0);
}

function isSessionTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.sessionFile != null && typeof value.sessionFile !== "string") return false;
  if (value.sessionId != null && typeof value.sessionId !== "string") return false;
  return value.resume == null || typeof value.resume === "boolean" || (isRecord(value.resume)
    && (value.resume.sessionFile == null || typeof value.resume.sessionFile === "string")
    && (value.resume.sessionId == null || typeof value.resume.sessionId === "string"));
}

/** Returns a human-readable validation failure without throwing. */
export function validatePiSdkWorkerRequest(raw: unknown): string | null {
  if (!isRecord(raw)) return "Pi SDK worker message must be an object.";
  if (raw.protocolVersion !== PI_SDK_PROTOCOL_VERSION) return `Unsupported Pi SDK protocol version: ${String(raw.protocolVersion)}.`;
  if (!nonEmptyString(raw.requestId)) return "Pi SDK worker message is missing requestId.";
  if (!nonEmptyString(raw.type)) return "Pi SDK worker message is missing type.";

  const type = raw.type;
  const payload = raw.payload;
  if (type === "init") {
    if (!isRecord(payload)) return "Pi SDK init payload must be an object.";
    if (!isPackageLocation(payload)) return "Pi SDK init requires packageRoot/packageDir or packageEntry.";
    if (!nonEmptyString(payload.cwd)) return "Pi SDK init requires an absolute cwd.";
    if (!nonEmptyString(payload.agentDir)) return "Pi SDK init requires an absolute agentDir.";
    if (payload.sessionDir != null && typeof payload.sessionDir !== "string") return "Pi SDK sessionDir must be a string or null.";
    if (payload.modelRef != null && !isModelRef(payload.modelRef)) return "Pi SDK modelRef must be a model string or {provider,id}.";
    if (payload.thinkingLevel != null && !nonEmptyString(payload.thinkingLevel)) return "Pi SDK thinkingLevel cannot be empty.";
    if (payload.tools != null && (!Array.isArray(payload.tools)
      || payload.tools.some((tool) => !nonEmptyString(tool)))) {
      return "Pi SDK tools must be an array of non-empty strings.";
    }
    if (payload.noTools != null && payload.noTools !== "all" && payload.noTools !== "builtin") {
      return "Pi SDK noTools must be all or builtin.";
    }
    if (payload.skillsEnv != null && (!isRecord(payload.skillsEnv)
      || Object.entries(payload.skillsEnv).some(([key, value]) => !nonEmptyString(key) || typeof value !== "string"))) {
      return "Pi SDK skillsEnv must be a string-to-string object.";
    }
    if (payload.inventoryOnly != null && typeof payload.inventoryOnly !== "boolean") {
      return "Pi SDK inventoryOnly must be a boolean.";
    }
    if (payload.session != null && !isSessionTarget(payload.session)) return "Pi SDK session target is invalid.";
    return null;
  }
  if (["send", "steer", "follow_up"].includes(type)) {
    if (!isRecord(payload) || !nonEmptyString(payload.prompt)) return `Pi SDK ${type} requires a non-empty prompt.`;
    if (payload.images != null && (!Array.isArray(payload.images)
      || payload.images.some((image) => !isRecord(image) || typeof image.data !== "string" || typeof image.mimeType !== "string"))) {
      return "Pi SDK send images must contain data and mimeType strings.";
    }
    if (type === "send" && payload.streamingBehavior != null
      && payload.streamingBehavior !== "steer" && payload.streamingBehavior !== "followUp") {
      return "Pi SDK send streamingBehavior must be steer or followUp.";
    }
  } else if (type === "set_model") {
    if (!isRecord(payload) || !isModelRef(payload.modelRef)) return "Pi SDK set_model requires a valid modelRef.";
  } else if (type === "set_thinking") {
    if (!isRecord(payload) || !nonEmptyString(payload.thinkingLevel)) return "Pi SDK set_thinking requires a thinkingLevel.";
  } else if (type === "compact" && payload != null && (!isRecord(payload)
    || (payload.customInstructions != null && typeof payload.customInstructions !== "string"))) {
    return "Pi SDK compact payload is invalid.";
  } else if (!["init", "abort", "dispose", "models", "auth", "compact"].includes(type)) {
    return `Unsupported Pi SDK worker request: ${String(type)}.`;
  }
  return null;
}

/** Narrow a validated IPC message without importing any Pi types. */
export function parsePiSdkWorkerRequest(raw: unknown): PiSdkWorkerRequest | null {
  return validatePiSdkWorkerRequest(raw) === null ? raw as PiSdkWorkerRequest : null;
}

/** Returns a human-readable validation failure for an untrusted worker response. */
export function validatePiSdkWorkerResponse(raw: unknown): string | null {
  if (!isRecord(raw)) return "Pi SDK worker response must be an object.";
  if (raw.protocolVersion !== PI_SDK_PROTOCOL_VERSION) return `Unsupported Pi SDK protocol version: ${String(raw.protocolVersion)}.`;
  if (!nonEmptyString(raw.type)) return "Pi SDK worker response is missing type.";

  if (raw.type === "response") {
    if (!nonEmptyString(raw.requestId)) return "Pi SDK response is missing requestId.";
    if (typeof raw.ok !== "boolean") return "Pi SDK response is missing ok.";
    if (raw.ok) {
      if (raw.result !== undefined && !isJsonValue(raw.result)) return "Pi SDK response result must be JSON-safe.";
    } else {
      if (!nonEmptyString(raw.error)) return "Pi SDK error response is missing error.";
      if (raw.errorCode !== undefined && !nonEmptyString(raw.errorCode)) return "Pi SDK errorCode must be a non-empty string.";
      if (raw.detail !== undefined && !isJsonValue(raw.detail)) return "Pi SDK response detail must be JSON-safe.";
    }
    return null;
  }

  if (raw.type === "ready") {
    if (!isRecord(raw.ready)) return "Pi SDK ready response is missing ready data.";
    const ready = raw.ready;
    if (ready.protocolVersion !== PI_SDK_PROTOCOL_VERSION) return "Pi SDK ready response has an invalid protocol version.";
    if (!nonEmptyString(ready.packageRoot) || !nonEmptyString(ready.packageEntry)) return "Pi SDK ready response is missing package paths.";
    if (!("version" in ready) || (ready.version !== null && typeof ready.version !== "string")) return "Pi SDK ready version must be a string or null.";
    if (!("sessionFile" in ready) || (ready.sessionFile !== null && typeof ready.sessionFile !== "string")) return "Pi SDK ready sessionFile must be a string or null.";
    if (!("sessionId" in ready) || (ready.sessionId !== null && typeof ready.sessionId !== "string")) return "Pi SDK ready sessionId must be a string or null.";
    if (!("currentModel" in ready) || (ready.currentModel !== null && !isJsonValue(ready.currentModel))) return "Pi SDK ready currentModel must be JSON-safe.";
    if (!("thinkingLevel" in ready) || (ready.thinkingLevel !== null && typeof ready.thinkingLevel !== "string")) return "Pi SDK ready thinkingLevel must be a string or null.";
    if (!Array.isArray(ready.availableModels) || !ready.availableModels.every((model) => isJsonValue(model))) return "Pi SDK ready availableModels must be JSON-safe.";
    return null;
  }

  if (raw.type === "sdk_event") {
    return isJsonValue(raw.event) ? null : "Pi SDK event must be JSON-safe.";
  }

  if (raw.type === "lifecycle") {
    const lifecycleNames: PiSdkLifecycleName[] = [
      "worker_started",
      "package_loaded",
      "initializing",
      "ready",
      "prompt_started",
      "prompt_finished",
      "prompt_failed",
      "aborted",
      "disposed",
    ];
    if (!lifecycleNames.includes(raw.event as PiSdkLifecycleName)) return "Pi SDK lifecycle event is invalid.";
    if (raw.requestId !== undefined && !nonEmptyString(raw.requestId)) return "Pi SDK lifecycle requestId must be a non-empty string.";
    if (raw.detail !== undefined && !isJsonValue(raw.detail)) return "Pi SDK lifecycle detail must be JSON-safe.";
    return null;
  }

  if (raw.type === "error") {
    if (!nonEmptyString(raw.operation) || !nonEmptyString(raw.error)) return "Pi SDK error event is missing operation or error.";
    if (raw.requestId !== undefined && !nonEmptyString(raw.requestId)) return "Pi SDK error requestId must be a non-empty string.";
    if (raw.detail !== undefined && !isJsonValue(raw.detail)) return "Pi SDK error detail must be JSON-safe.";
    return null;
  }

  if (raw.type === "log") {
    if (raw.level !== "debug" && raw.level !== "info" && raw.level !== "warn" && raw.level !== "error") return "Pi SDK log level is invalid.";
    if (typeof raw.message !== "string") return "Pi SDK log message must be a string.";
    if (raw.detail !== undefined && !isJsonValue(raw.detail)) return "Pi SDK log detail must be JSON-safe.";
    return null;
  }

  return `Unsupported Pi SDK worker response: ${String(raw.type)}.`;
}

/** Validate the success payload for the request that produced it. */
export function validatePiSdkWorkerResult(
  type: PiSdkWorkerRequest["type"],
  result: unknown,
): string | null {
  if (type === "init" || type === "set_model" || type === "set_thinking") {
    if (!isRecord(result)) return `Pi SDK ${type} result must contain ready session data.`;
    if (result.protocolVersion !== PI_SDK_PROTOCOL_VERSION) return `Pi SDK ${type} result has an invalid protocol version.`;
    if (!nonEmptyString(result.packageRoot) || !nonEmptyString(result.packageEntry)) return `Pi SDK ${type} result is missing package paths.`;
    if (!("version" in result) || (result.version !== null && typeof result.version !== "string")) return `Pi SDK ${type} version must be a string or null.`;
    if (!("sessionFile" in result) || (result.sessionFile !== null && typeof result.sessionFile !== "string")) return `Pi SDK ${type} sessionFile must be a string or null.`;
    if (!("sessionId" in result) || (result.sessionId !== null && typeof result.sessionId !== "string")) return `Pi SDK ${type} sessionId must be a string or null.`;
    if (!("currentModel" in result) || (result.currentModel !== null && !isJsonValue(result.currentModel))) return `Pi SDK ${type} currentModel must be JSON-safe.`;
    if (!("thinkingLevel" in result) || (result.thinkingLevel !== null && typeof result.thinkingLevel !== "string")) return `Pi SDK ${type} thinkingLevel must be a string or null.`;
    if (!Array.isArray(result.availableModels) || !result.availableModels.every((model) => isJsonValue(model))) return `Pi SDK ${type} availableModels must be JSON-safe.`;
    return null;
  }
  if (type === "models") {
    return Array.isArray(result) && result.every((model) => isJsonValue(model))
      ? null
      : "Pi SDK models result must be a JSON-safe array.";
  }
  if (type === "auth") {
    return Array.isArray(result) && result.every((provider) => isJsonValue(provider))
      ? null
      : "Pi SDK auth result must be a JSON-safe array.";
  }
  if (result !== undefined && !isJsonValue(result)) return `Pi SDK ${type} result must be JSON-safe.`;
  return null;
}

/** Narrow a validated child-process response without importing any Pi types. */
export function parsePiSdkWorkerResponse(raw: unknown): PiSdkWorkerResponse | null {
  return validatePiSdkWorkerResponse(raw) === null ? raw as PiSdkWorkerResponse : null;
}

/** Convert SDK values to a bounded JSON-safe value before crossing IPC. */
export function toPiSdkJson(value: unknown, depth = 0, seen = new WeakSet<object>()): JsonValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value === "function" || typeof value === "symbol") return null;
  if (depth >= 8) return "[truncated]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    };
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toPiSdkJson(item, depth + 1, seen));
  const output: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = toPiSdkJson(item, depth + 1, seen);
  }
  return output;
}

export function normalizePiSdkModelRef(ref: PiSdkModelRef): { provider: string; id: string } {
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    const slash = trimmed.indexOf("/");
    if (slash <= 0 || slash === trimmed.length - 1) {
      throw new Error(`Invalid Pi model "${trimmed}". Use provider/model-id.`);
    }
    return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
  }
  const provider = typeof ref.provider === "string" ? ref.provider.trim() : "";
  const idValue = typeof ref.id === "string" && ref.id.trim() ? ref.id : ref.modelId;
  const id = typeof idValue === "string" ? idValue.trim() : "";
  if (!provider || !id) throw new Error("Invalid Pi model. Both provider and model id are required.");
  return { provider, id };
}
