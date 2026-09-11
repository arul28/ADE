import type { SyncHostReadinessSnapshot, SyncHostRecoveryResult } from "../../../shared/types/syncHostRecovery";
import {
  isProjectHostTransportDrop,
  nextProjectHostPhase,
  parseSyncHostReadinessSnapshot,
  parseSyncHostRecoveryResult,
  PROJECT_HOST_SILENT_RETRY_MS,
  projectHostShouldTakeOverImmediately,
  parseSyncHostConflict,
  readHostUnavailableDetails,
  type ProjectHostUiPhase,
} from "../../../shared/syncHostRecoveryUi";
import {
  SYNC_HOST_CONFLICT_BODY,
  SYNC_HOST_CONFLICT_HEADLINE,
  SYNC_HOST_DIAGNOSE_ACTION,
  SYNC_HOST_RECOVER_ACTION,
} from "../../../shared/types/syncHostRecovery";

export type ProjectHostRecoveryState = {
  phase: ProjectHostUiPhase;
  snapshot: SyncHostReadinessSnapshot | null;
  recovery: SyncHostRecoveryResult | null;
};

type SendCommand = (action: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * Identity of the client that owns this store. Deliberately opaque — the store
 * only needs reference equality, and importing the sync client here would be a
 * cycle.
 */
export type ProjectHostRecoveryClient = object;

const listeners = new Set<(state: ProjectHostRecoveryState) => void>();
let sendCommand: SendCommand | null = null;
let boundClient: ProjectHostRecoveryClient | null = null;
let sleepFn: (ms: number) => Promise<void> = defaultSleep;
let retryGeneration = 0;
let retryTask: Promise<void> | null = null;
let retryTaskGeneration: number | null = null;

let state: ProjectHostRecoveryState = {
  phase: "ready",
  snapshot: null,
  recovery: null,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function emit(): void {
  for (const listener of listeners) listener(state);
}

function setState(next: ProjectHostRecoveryState): void {
  state = next;
  emit();
}

function cancelSilentRetry(): void {
  retryGeneration += 1;
  retryTask = null;
  retryTaskGeneration = null;
}

export function getProjectHostRecoveryState(): ProjectHostRecoveryState {
  return state;
}

export function subscribeProjectHostRecovery(
  listener: (next: ProjectHostRecoveryState) => void,
): () => void {
  listeners.add(listener);
  listener(state);
  return () => {
    listeners.delete(listener);
  };
}

function isBoundClient(client: ProjectHostRecoveryClient): boolean {
  return boundClient !== null && client === boundClient;
}

/**
 * Point the store at one client. The browser can hold several machine sessions
 * at once, and the repair this store offers terminates a process, so the
 * binding must follow whichever machine the user is actually looking at.
 * Passing `null` disarms the store entirely.
 */
/**
 * Four lifecycle doors, in the order a reader needs them:
 *
 * - `bindProjectHostRecoverySend(send, owner)` — arm the store for ONE client.
 *   Prefer `client.ts`'s `bindProjectHostRecoveryClient`, which builds the send
 *   closure; call this directly only from tests.
 * - `noteProjectHostDisconnected(client)` — that client's socket dropped. Clears
 *   what the UI shows but KEEPS the binding, because a repair that restarts the
 *   brain drops the socket on purpose.
 * - `releaseProjectHostRecoveryClient(client)` — that client is gone. Unbinds,
 *   but only if it is the current owner, so a disposing background session
 *   cannot disarm the machine on screen.
 * - `resetProjectHostRecoveryStore()` — full teardown. Tests only.
 *
 * Every input is owner-checked: a destructive repair must target the machine
 * the user is looking at, not whichever client connected last.
 */
export function bindProjectHostRecoverySend(
  send: SendCommand | null,
  client: ProjectHostRecoveryClient | null,
): void {
  const nextClient = send ? client : null;
  if (nextClient !== boundClient) {
    // The screen is about to speak for a different machine; nothing the
    // previous one reported still applies to it.
    cancelSilentRetry();
    setState({ phase: "ready", snapshot: null, recovery: null });
  }
  sendCommand = send;
  boundClient = nextClient;
}

/**
 * A transport drop clears what the UI is showing but must NOT unbind the
 * transport: the same client reconnects, and a repair that has already been
 * offered has to stay clickable afterwards.
 *
 * The one state a drop does not clear is `recovering` — the repair restarts
 * this machine on purpose, so the socket closing is a step of it, not its
 * verdict. The next hello decides.
 */
export function noteProjectHostDisconnected(client: ProjectHostRecoveryClient): void {
  if (!isBoundClient(client)) return;
  cancelSilentRetry();
  if (state.phase === "recovering") return;
  setState({ phase: "ready", snapshot: null, recovery: null });
}

/**
 * Disposal path. A background session tearing itself down must not disarm the
 * client the user is looking at — that would leave Fix and Retry inert.
 */
export function releaseProjectHostRecoveryClient(client: ProjectHostRecoveryClient): void {
  if (!isBoundClient(client)) return;
  bindProjectHostRecoverySend(null, null);
}

/** Full teardown, including the transport binding and test hooks. */
export function resetProjectHostRecoveryStore(): void {
  cancelSilentRetry();
  sendCommand = null;
  boundClient = null;
  sleepFn = defaultSleep;
  setState({ phase: "ready", snapshot: null, recovery: null });
}

export function configureProjectHostRecoveryStoreForTests(args: {
  sleep?: (ms: number) => Promise<void>;
} = {}): void {
  if (args.sleep) sleepFn = args.sleep;
}

function applySnapshot(
  snapshot: SyncHostReadinessSnapshot | null,
  extras: { retriesExhausted?: boolean } = {},
): void {
  const phase = nextProjectHostPhase({
    current: state.phase === "recovering" ? "takeover" : state.phase,
    snapshot,
    retriesExhausted: extras.retriesExhausted,
  });
  setState({
    phase,
    snapshot,
    recovery: phase === "ready" ? null : state.recovery,
  });
  if (phase === "retrying" && sendCommand) {
    void startSilentRetry();
  } else if (phase !== "retrying") {
    cancelSilentRetry();
  }
}

export function applyProjectHostHello(raw: unknown, client: ProjectHostRecoveryClient): void {
  if (!isBoundClient(client)) return;
  const snapshot = parseSyncHostReadinessSnapshot(raw);
  if (!snapshot || snapshot.state === "ready") {
    cancelSilentRetry();
    setState({ phase: "ready", snapshot: snapshot ?? null, recovery: null });
    return;
  }
  // Reconnecting mid-repair: a host that is merely still starting is the
  // restart we asked for, so keep the progress screen and re-check on the
  // silent-retry schedule. A conflict that survived the restart is an answer.
  if (state.phase === "recovering" && !projectHostShouldTakeOverImmediately(snapshot)) {
    setState({ phase: "recovering", snapshot, recovery: state.recovery });
    void startSilentRetry();
    return;
  }
  applySnapshot(snapshot);
}

export function noteProjectHostUnavailable(
  error: unknown,
  client: ProjectHostRecoveryClient,
): void {
  if (!isBoundClient(client)) return;
  applyHostUnavailable(error);
}

function applyHostUnavailable(error: unknown): void {
  const details = readHostUnavailableDetails(error);
  if (!details) return;
  // Every other command fails while the repair restarts this machine. Those
  // failures are the repair happening, not news, and must not replace the
  // progress screen.
  if (state.phase === "recovering") return;
  const errorSnapshot = parseSyncHostReadinessSnapshot(details.snapshot);
  const snapshot = errorSnapshot ?? state.snapshot;
  if (projectHostShouldTakeOverImmediately(snapshot) || details.reason === "conflict") {
    // Parse the conflict the error carried. Dropping it here used to cost the
    // owner label, the project, the impact line — and, because Fix connection
    // needs a conflict, the repair button itself.
    const conflict = parseSyncHostConflict(details.conflict);
    // A conflict verified right after a "starting" snapshot arrives with its
    // own `details.conflict` and no `details.snapshot`; falling back to the
    // held snapshot there would keep showing "starting" and discard it.
    const carried = conflict ? errorSnapshot : snapshot;
    applySnapshot(carried ?? {
      state: "conflict",
      headline: SYNC_HOST_CONFLICT_HEADLINE,
      body: details.message?.trim() || SYNC_HOST_CONFLICT_BODY,
      conflict,
      recoveryEligible: details.recoveryEligible === true || conflict?.recoveryEligible === true,
    });
    return;
  }
  applySnapshot(snapshot ?? {
    state: details.reason === "starting" ? "starting" : "unavailable",
    headline: "Starting services",
    body: details.message?.trim() || "This machine is starting its project connection.",
    conflict: null,
    recoveryEligible: false,
  });
}

async function startSilentRetry(): Promise<void> {
  const generation = retryGeneration;
  if (retryTask) return;
  retryTaskGeneration = generation;
  retryTask = (async () => {
    for (const delay of PROJECT_HOST_SILENT_RETRY_MS) {
      await sleepFn(delay);
      if (generation !== retryGeneration) return;
      const snapshot = await diagnose();
      if (generation !== retryGeneration) return;
      if (!snapshot || snapshot.state === "ready") {
        applySnapshot(snapshot);
        return;
      }
      if (projectHostShouldTakeOverImmediately(snapshot)) {
        applySnapshot(snapshot);
        return;
      }
    }
    if (generation === retryGeneration) {
      applySnapshot(state.snapshot, { retriesExhausted: true });
    }
  })().finally(() => {
    if (retryTaskGeneration === generation) {
      retryTask = null;
      retryTaskGeneration = null;
    }
  });
}

async function diagnose(): Promise<SyncHostReadinessSnapshot | null> {
  const send = sendCommand;
  const owner = boundClient;
  if (!send) return state.snapshot;
  try {
    const raw = await send(SYNC_HOST_DIAGNOSE_ACTION, {});
    if (owner !== boundClient) return state.snapshot;
    return parseSyncHostReadinessSnapshot(raw) ?? state.snapshot;
  } catch (error) {
    if (owner !== boundClient) return state.snapshot;
    applyHostUnavailable(error);
    return state.snapshot;
  }
}

export async function retryProjectHost(): Promise<void> {
  // An explicit tap ends the "a repair is running" assumption. Without this, a
  // repair whose restart never reports back would keep every later Retry
  // short-circuited back into the same spinner.
  if (state.phase === "recovering") {
    setState({ ...state, phase: "takeover" });
  }
  const snapshot = await diagnose();
  applySnapshot(snapshot, { retriesExhausted: snapshot != null && snapshot.state !== "ready" });
}

export async function recoverProjectHost(): Promise<void> {
  const send = sendCommand;
  const owner = boundClient;
  setState({ phase: "recovering", snapshot: state.snapshot, recovery: state.recovery });
  if (!send) {
    applySnapshot(state.snapshot, { retriesExhausted: true });
    return;
  }
  try {
    const raw = await send(SYNC_HOST_RECOVER_ACTION, {});
    if (owner !== boundClient) return;
    const result = parseSyncHostRecoveryResult(raw);
    if (result) {
      // One emit, not two. Computing the phase first keeps a restart from
      // flashing the takeover card at the user in the middle of its own repair.
      const phase: ProjectHostUiPhase = result.status === "restarting"
        ? "recovering"
        : result.ok && result.snapshot.state === "ready"
          ? "ready"
          : "takeover";
      setState({ phase, snapshot: result.snapshot, recovery: result });
      return;
    }
    applySnapshot(parseSyncHostReadinessSnapshot(raw), { retriesExhausted: true });
  } catch (error) {
    if (owner !== boundClient) return;
    // The repair restarts this machine, so losing the socket — or being told
    // it is still starting — is expected. Hold the progress screen and let the
    // reconnect hello report what actually happened.
    const details = readHostUnavailableDetails(error);
    if (isProjectHostTransportDrop(error) || details?.reason === "starting") return;
    applySnapshot(
      parseSyncHostReadinessSnapshot(details?.snapshot) ?? state.snapshot,
      { retriesExhausted: true },
    );
  }
}
