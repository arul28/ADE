import { LEDGER_WORKER_TIMEOUT_MS } from "../usage/usageLedgerWorkerClient";

export const LOCAL_RUNTIME_PROJECT_TIMEOUT_MS = 120_000;

/**
 * A user pressing Refresh on the Usage page runs the isolated ledger worker,
 * whose own ceiling is `LEDGER_WORKER_TIMEOUT_MS`. Every budget in front of it
 * must outlive it, or the renderer reports a failure for a scan the daemon is
 * still running to a successful finish — and the page discards the numbers it
 * already had. The margin covers result serialisation on top of the worker.
 */
export const USAGE_REFRESH_HISTORY_TIMEOUT_MS = LEDGER_WORKER_TIMEOUT_MS + 30_000;

/**
 * The innermost budget on the remote path: the JSON-RPC transport carrying
 * `usage.refreshHistory` to a paired/SSH runtime, whose daemon runs the very
 * same ledger worker. It must outlive `LEDGER_WORKER_TIMEOUT_MS` and still
 * expire before the renderer's IPC budget above it, so the chain stays
 * monotonically increasing outward (transport < IPC) rather than racing.
 * Without an entry here the transport falls back to `RuntimeRpcClient`'s
 * 600s default — a clock that starts before the daemon dispatches, so it
 * expired at or before the worker's own ceiling.
 */
export const USAGE_REFRESH_HISTORY_REMOTE_TRANSPORT_TIMEOUT_MS =
  LEDGER_WORKER_TIMEOUT_MS + 15_000;
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

/**
 * A Pi sign-in blocks on a human completing an OAuth or device-code flow, which
 * `piAuthService` bounds at 10 minutes. The transport budget has to outlive
 * that, or the renderer reports failure while the daemon is still signing in.
 */
export const PI_LOGIN_IPC_TIMEOUT_MS = 11 * 60_000;

/**
 * Cursor.auth.login() polls the browser handshake for ~20 minutes. The
 * transport budget has to outlive that, or the renderer reports failure while
 * the daemon is still waiting on the browser.
 */
export const CURSOR_LOGIN_IPC_TIMEOUT_MS = 21 * 60_000;

const LONG_RUNNING_LOCAL_RUNTIME_ACTION_TIMEOUTS: ReadonlyMap<string, number> = new Map([
  ["ai.piLoginStart", PI_LOGIN_IPC_TIMEOUT_MS],
  ["ai.cursorAuthLogin", CURSOR_LOGIN_IPC_TIMEOUT_MS],
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
  // Cursor Cloud open-chat hydrates conversation + boots a worker + attaches
  // the live stream. The 30s default fired while Cursor's VM was still
  // installing, so the renderer reported failure on the draft pane while the
  // daemon later created an empty session (ADE-122 class).
  ["ai.openCursorCloudChat", 120_000],
  ["ai.createCursorCloudRun", 120_000],
  // See USAGE_REFRESH_HISTORY_TIMEOUT_MS: in runtime-backed (production) mode
  // the Usage page's Refresh reaches the ledger worker through this action.
  ["usage.refreshHistory", USAGE_REFRESH_HISTORY_TIMEOUT_MS],
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
