export const LOCAL_RUNTIME_PROJECT_TIMEOUT_MS = 120_000;
export const LOCAL_RUNTIME_ACTION_TIMEOUT_MS = 30_000;
export const LOCAL_RUNTIME_FILE_ACTION_TIMEOUT_MS = 8_000;
export const LOCAL_RUNTIME_SYNC_TIMEOUT_MS = 30_000;
export const LOCAL_RUNTIME_ACTION_REGISTRY_TIMEOUT_MS = 30_000;
export const LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS = 2_000;
export const LOCAL_RUNTIME_IPC_PROJECT_SETUP_MARGIN_MS = 30_000;
export const LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS = 15_000;
const LOCAL_RUNTIME_IPC_PROJECT_REGISTRATION_TIMEOUT_MS =
  2 * LOCAL_RUNTIME_PROJECT_TIMEOUT_MS;

// Registration can legitimately consume two full attempts. Retain separate
// margin for runtime connection/socket startup around those projects.add calls.
export const LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS =
  LOCAL_RUNTIME_IPC_PROJECT_REGISTRATION_TIMEOUT_MS
  + LOCAL_RUNTIME_IPC_PROJECT_SETUP_MARGIN_MS;
export const LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS =
  LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS
  + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS;

export function localRuntimeCallIpcTimeoutMs(innerTimeoutMs: number): number {
  return LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS
    + innerTimeoutMs
    + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS;
}

export const LOCAL_RUNTIME_IPC_SYNC_TIMEOUT_MS =
  localRuntimeCallIpcTimeoutMs(LOCAL_RUNTIME_SYNC_TIMEOUT_MS);
export const LOCAL_RUNTIME_IPC_ACTION_REGISTRY_TIMEOUT_MS =
  localRuntimeCallIpcTimeoutMs(LOCAL_RUNTIME_ACTION_REGISTRY_TIMEOUT_MS);
export const LOCAL_RUNTIME_IPC_EVENT_POLL_TIMEOUT_MS =
  localRuntimeCallIpcTimeoutMs(LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS);

const LONG_RUNNING_LOCAL_RUNTIME_ACTION_TIMEOUTS: ReadonlyMap<string, number> = new Map([
  // Lane deletion can legitimately include a 60s worktree removal followed by
  // a 45s remote-branch deletion. The old 30s client budget reported failure
  // while the daemon kept mutating state to a successful completion.
  ["lane.delete", 4 * 60_000],
  ["lane.archive", 120_000],
  ["lane.unarchive", 120_000],
  ["chat.suggestLaneNameFromPrompt", 120_000],
  ["chat.generateAutoLaneIdentity", 120_000],
  // Handoff = AI brief generation (bounded at 45s) + session creation +
  // provider dispatch of the first message; the 30s default fired a false
  // timeout while the daemon-side handoff kept running to a late "surprise"
  // success (ADE-122).
  ["chat.handoffSession", 120_000],
  ["chat.prepareCrossMachineHandoff", 120_000],
]);

export function longRunningLocalRuntimeActionTimeoutMs(
  actionKey: string,
): number | null {
  return LONG_RUNNING_LOCAL_RUNTIME_ACTION_TIMEOUTS.get(actionKey) ?? null;
}

export function localRuntimeActionTimeoutMs(
  domain: string,
  action: string,
): number {
  const actionKey = `${domain}.${action}`;
  return longRunningLocalRuntimeActionTimeoutMs(actionKey)
    ?? (domain === "file"
      ? LOCAL_RUNTIME_FILE_ACTION_TIMEOUT_MS
      : LOCAL_RUNTIME_ACTION_TIMEOUT_MS);
}

// The renderer-side IPC timer starts before cold project setup, while the
// daemon action timer starts afterwards. Compose the actual daemon budget for
// every action with setup margin and result-delivery headroom.
export function localRuntimeActionIpcTimeoutMs(
  domain: string,
  action: string,
): number {
  return localRuntimeCallIpcTimeoutMs(localRuntimeActionTimeoutMs(domain, action));
}
