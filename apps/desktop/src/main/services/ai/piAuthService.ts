// ---------------------------------------------------------------------------
// Pi in-app sign-in
//
// Drives Pi's own `ModelRuntime.login()` from inside ADE: enumerate the
// providers that can actually be signed into, run one login on a dedicated
// inventory-only worker, and relay Pi's prompts/notices to whatever surface is
// listening.
//
// Credentials stay Pi's. The worker hands ADE prompt text and the user's answer
// travels straight back through `respondToUi`; nothing that could be a token is
// stored, logged, or put on a status event.
// ---------------------------------------------------------------------------

import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  acquirePiSdkConnection,
  releasePiSdkConnection,
  type PiSdkPooled,
} from "../chat/piSdkPool";
import type {
  JsonValue,
  PiSdkUiNoticePayload,
  PiSdkUiRequestPayload,
} from "../chat/piSdkProtocol";
import { resolvePiInstallation, type PiInstallation } from "./piInstallation";
import type {
  PiAuthNotice,
  PiAuthPrompt,
  PiAuthStatusEvent,
  PiLoginMethod,
  PiLoginProvider,
} from "../../../shared/types/config";

export type { PiAuthStatusEvent, PiLoginProvider } from "../../../shared/types/config";

/**
 * Give up on a login after this long. A device-code grant legitimately takes
 * minutes, so this is generous — it exists to stop an abandoned flow from
 * holding a worker forever, not to pace the user.
 */
const PI_LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export type PiLoginResult = { ok: true } | { ok: false; error: string };

type AcquiredWorker = { pooled: PiSdkPooled; release: () => void };

type PiAuthHooks = {
  resolveInstallation(env: NodeJS.ProcessEnv): PiInstallation;
  acquireWorker(installation: PiInstallation, purpose: string): Promise<AcquiredWorker>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultHooks: PiAuthHooks = {
  resolveInstallation(env) {
    return resolvePiInstallation(env);
  },
  async acquireWorker(installation, purpose) {
    // Unique per flow so a sign-in can never join — or be evicted by — the
    // pooled worker backing a chat session.
    const poolKey = `pi-login:${installation.agentDir}:${purpose}:${randomUUID()}`;
    const acquired = await acquirePiSdkConnection({
      poolKey,
      packageRoot: installation.packageRoot!,
      packageEntry: installation.packageEntry!,
      cwd: path.resolve(process.cwd()),
      agentDir: installation.agentDir,
      inventoryOnly: true,
      baseEnv: process.env,
    });
    return {
      pooled: acquired.pooled,
      release: () => releasePiSdkConnection(poolKey, acquired.generation),
    };
  },
};

let hooks: PiAuthHooks = { ...defaultHooks };
type StatusListener = (event: PiAuthStatusEvent) => void;
const statusListeners = new Set<StatusListener>();

type ActiveFlow = {
  pooled: PiSdkPooled;
  /** The prompt Pi is currently blocked on, if any. */
  pendingRequestId: string | null;
  finish: (result: PiLoginResult) => void;
};
const activeFlows = new Map<string, ActiveFlow>();
/** Monotonic per-provider claim, so a superseded start can detect it lost. */
const startGenerations = new Map<string, number>();

/**
 * Subscribe a sink to Pi sign-in transitions. Multiple sinks may coexist so the
 * same transition can fan out to renderer windows and the runtime event buffer
 * remote/web clients drain. Returns an unsubscribe function.
 */
export function addPiAuthStatusListener(listener: StatusListener): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function emit(event: PiAuthStatusEvent): void {
  for (const listener of statusListeners) {
    try {
      listener(event);
    } catch {
      // A broken sink must not break the flow or starve other listeners.
    }
  }
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function toPrompt(requestId: string, payload: PiSdkUiRequestPayload, providerId: string): PiAuthPrompt {
  return {
    requestId,
    kind: payload.kind,
    title: payload.title?.trim() || `Sign in to ${providerId}`,
    message: payload.message,
    ...(payload.placeholder?.trim() ? { placeholder: payload.placeholder.trim() } : {}),
    ...(payload.options?.length
      ? {
          options: payload.options.map((option) => ({
            value: option.value,
            label: option.label,
            ...(option.description?.trim() ? { description: option.description.trim() } : {}),
          })),
        }
      : {}),
  };
}

function toNotice(payload: PiSdkUiNoticePayload): PiAuthNotice {
  const detail = jsonRecord(payload.detail);
  return {
    level: payload.level,
    message: payload.message,
    ...(jsonString(detail?.url) ? { url: jsonString(detail?.url)! } : {}),
    ...(jsonString(detail?.userCode) ? { userCode: jsonString(detail?.userCode)! } : {}),
    ...(jsonString(detail?.verificationUri)
      ? { verificationUri: jsonString(detail?.verificationUri)! }
      : {}),
  };
}

function requireSdk(installation: PiInstallation): void {
  if (installation.sdkAvailable && installation.packageRoot && installation.packageEntry) return;
  throw new Error(installation.blocker ?? "Pi's SDK package is unavailable, so ADE cannot sign in for you.");
}

function toLoginProvider(entry: JsonValue): PiLoginProvider | null {
  const record = jsonRecord(entry);
  const id = jsonString(record?.id);
  if (!id) return null;
  const rawTypes = Array.isArray(record?.authTypes) ? record.authTypes : [];
  const authTypes = rawTypes.filter(
    (value): value is PiLoginMethod => value === "oauth" || value === "api_key",
  );
  if (!authTypes.length) return null;
  return {
    id,
    name: jsonString(record?.name) ?? id,
    authTypes,
    configured: record?.configured === true
      || record?.authenticated === true
      || record?.isAuthenticated === true,
    ...(jsonString(record?.loginLabel) ? { loginLabel: jsonString(record?.loginLabel)! } : {}),
    ...(record?.isSubscription === true ? { isSubscription: true } : {}),
  };
}

/** Providers ADE can run an interactive sign-in for, in display order. */
export async function listPiLoginProviders(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PiLoginProvider[]> {
  const installation = hooks.resolveInstallation(env);
  requireSdk(installation);
  const { pooled, release } = await hooks.acquireWorker(installation, "inventory");
  try {
    const inventory = await pooled.requestAuth();
    const providers = (Array.isArray(inventory) ? inventory : [])
      .map(toLoginProvider)
      .filter((provider): provider is PiLoginProvider => provider !== null);
    return providers.sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    release();
  }
}

/**
 * Run one provider sign-in. Only one flow per provider is active at a time —
 * starting another cancels the first. Resolves once the flow settles; the
 * prompts in between arrive through `addPiAuthStatusListener`.
 */
export async function startPiLogin(args: {
  providerId: string;
  method?: PiLoginMethod | null;
}): Promise<PiLoginResult> {
  const providerId = args.providerId.trim();
  if (!providerId) return { ok: false, error: "Provider ID is required." };
  cancelPiLogin({ providerId });
  // Acquiring a worker is async, so two starts for the same provider can both
  // get past the cancel above. Claim the provider synchronously and re-check
  // after the await, or the loser would orphan a worker nobody releases.
  const generation = (startGenerations.get(providerId) ?? 0) + 1;
  startGenerations.set(providerId, generation);

  let acquired: AcquiredWorker;
  try {
    const installation = hooks.resolveInstallation(process.env);
    requireSdk(installation);
    acquired = await hooks.acquireWorker(installation, providerId);
  } catch (error) {
    const message = errorMessage(error);
    emit({ providerId, state: "error", error: message });
    return { ok: false, error: message };
  }

  if (startGenerations.get(providerId) !== generation) {
    acquired.pooled.cancelLogin();
    acquired.release();
    return { ok: false, error: "Sign-in was superseded by a newer attempt." };
  }

  const { pooled, release } = acquired;
  return await new Promise<PiLoginResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flow: ActiveFlow = {
      pooled,
      pendingRequestId: null,
      finish: (result) => {
        if (settled) return;
        settled = true;
        if (activeFlows.get(providerId) === flow) activeFlows.delete(providerId);
        if (timer) clearTimeout(timer);
        pooled.bridge.onUiRequest = null;
        pooled.bridge.onUiNotice = null;
        pooled.bridge.onUiCancel = null;
        release();
        emit(result.ok
          ? { providerId, state: "success" }
          : { providerId, state: "error", error: result.error });
        resolve(result);
      },
    };
    activeFlows.set(providerId, flow);

    pooled.bridge.onUiRequest = (requestId, payload) => {
      flow.pendingRequestId = requestId;
      emit({ providerId, state: "prompt", prompt: toPrompt(requestId, payload, providerId) });
    };
    // The worker settles its own prompts on timeout or abort. Without this the
    // card would stay on screen waiting for an answer nothing is listening for.
    pooled.bridge.onUiCancel = (requestId) => {
      if (flow.pendingRequestId !== requestId) return;
      flow.pendingRequestId = null;
      emit({ providerId, state: "pending" });
    };
    pooled.bridge.onUiNotice = (payload) => {
      emit({ providerId, state: "pending", notice: toNotice(payload) });
    };

    emit({ providerId, state: "pending" });
    timer = setTimeout(() => {
      pooled.cancelLogin();
      flow.finish({ ok: false, error: "Pi sign-in timed out. Start it again when you're ready." });
    }, PI_LOGIN_TIMEOUT_MS);
    timer.unref?.();

    void pooled
      .login({ providerId, ...(args.method ? { method: args.method } : {}) })
      .then(() => flow.finish({ ok: true }))
      .catch((error: unknown) => flow.finish({ ok: false, error: errorMessage(error) }));
  });
}

/** Answer the prompt Pi is blocked on. The value is relayed, never retained. */
export function submitPiLoginPrompt(args: {
  providerId: string;
  requestId: string;
  value: string;
}): { ok: boolean; error?: string } {
  const flow = activeFlows.get(args.providerId.trim());
  if (!flow) return { ok: false, error: "That sign-in is no longer running." };
  if (flow.pendingRequestId !== args.requestId) {
    return { ok: false, error: "That prompt has already been answered." };
  }
  flow.pendingRequestId = null;
  flow.pooled.respondToUi(args.requestId, { ok: true, value: args.value });
  return { ok: true };
}

/** Stop an in-flight sign-in (if any), release its worker, and settle it. */
export function cancelPiLogin(args: { providerId: string }): void {
  const providerId = args.providerId.trim();
  // Claiming a fresh generation cancels a start that is still acquiring its
  // worker: it has no flow to find yet, so without this the cancel is a no-op
  // and the sign-in the user stopped runs on holding a worker.
  startGenerations.set(providerId, (startGenerations.get(providerId) ?? 0) + 1);
  const flow = activeFlows.get(providerId);
  if (!flow) return;
  if (flow.pendingRequestId) {
    flow.pooled.respondToUi(flow.pendingRequestId, { ok: false, error: "Sign-in cancelled." });
    flow.pendingRequestId = null;
  }
  flow.pooled.cancelLogin();
  flow.finish({ ok: false, error: "Sign-in cancelled." });
}

// --- Test hooks ------------------------------------------------------------

export function __setPiAuthHooksForTests(partial: Partial<PiAuthHooks>): void {
  hooks = { ...hooks, ...partial };
}

export function __resetPiAuthServiceForTests(): void {
  for (const providerId of [...activeFlows.keys()]) {
    activeFlows.get(providerId)?.finish({ ok: false, error: "Pi auth service reset." });
  }
  activeFlows.clear();
  startGenerations.clear();
  hooks = { ...defaultHooks };
  statusListeners.clear();
}

export function __getActivePiLoginProviderIdsForTests(): string[] {
  return [...activeFlows.keys()];
}
