import { LEDGER_WORKER_TIMEOUT_MS } from "../usage/usageLedgerWorkerClient";
import { clampPluginInvokeTimeoutMs } from "../../../shared/plugins/sockets";

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

/**
 * A cold simulator launch is boot (90s) + xcodebuild (600s) + install (180s)
 * + launch (60s) = 930s worst case; 17 min keeps headroom above that sum.
 */
export const IOS_SIMULATOR_LAUNCH_TIMEOUT_MS = 17 * 60_000;

/**
 * Preview Lab drives Xcode's preview toolchain, which compiles the target
 * before it can render a single frame — the same build cost as a launch.
 */
export const IOS_SIMULATOR_PREVIEW_TIMEOUT_MS = 10 * 60_000;

/**
 * The innermost budgets on the remote path: the JSON-RPC transport carrying
 * these actions to a paired/SSH runtime, whose daemon runs the very same
 * xcodebuild and Xcode preview toolchain a local one does. Without entries
 * here the transport fell back to `RuntimeRpcClient`'s 600s default — for a
 * launch that is shorter than xcodebuild's own 600s allowance alone, so a
 * remote cold launch reported "Remote ADE service timed out" while the build
 * was still running. Both stay below the IPC budgets above them so the chain
 * expires monotonically outward (transport < IPC) instead of racing and
 * surfacing an opaque IPC timeout in place of the transport's legible reason.
 */
export const IOS_SIMULATOR_LAUNCH_REMOTE_TRANSPORT_TIMEOUT_MS =
  IOS_SIMULATOR_LAUNCH_TIMEOUT_MS - 30_000;
export const IOS_SIMULATOR_PREVIEW_REMOTE_TRANSPORT_TIMEOUT_MS =
  IOS_SIMULATOR_PREVIEW_TIMEOUT_MS - 30_000;
export const LOCAL_RUNTIME_ACTION_TIMEOUT_MS = 30_000;
export const LOCAL_RUNTIME_FILE_ACTION_TIMEOUT_MS = 8_000;
export const LOCAL_RUNTIME_SYNC_TIMEOUT_MS = 30_000;
export const LOCAL_RUNTIME_ACTION_REGISTRY_TIMEOUT_MS = 30_000;
export const LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS = 2_000;
/**
 * `runtime.activitySummary` counts running turns from memory, so this is not a
 * work budget — it is the bound on a stuck poll. Without it the call inherits
 * `RuntimeRpcClient`'s ten-minute default, and `keepAwakeService` (which polls
 * every 5s and skips a pass while one is in flight) would keep the machine's
 * wake lock held for up to ten minutes after the user chose "Never". Kept under
 * that poll interval so a wedged call cannot stack passes either.
 */
export const LOCAL_RUNTIME_ACTIVITY_SUMMARY_TIMEOUT_MS = 4_000;
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
  // Installing a plugin is a `git clone` over the network followed by a
  // manifest read, on the same reasoning as `lane.delete`: the daemon runs it
  // to completion regardless, so a client budget shorter than the work reports
  // a failure for an install that then appears in the roster anyway. A cold
  // clone of a repository with history is minutes, not seconds.
  ["plugin.install", 4 * 60_000],
  // A plugin handler is third-party code, and the child supervisor already
  // bounds it: 20s waiting for a cold child's `ready` frame plus 60s on the
  // handler itself. This budget has to outlive BOTH, or a first invoke — the
  // one that pays for the spawn — reports an opaque IPC timeout instead of the
  // supervisor's own typed `plugin_timeout`, and the user learns nothing about
  // which half was slow.
  ["plugin.invoke", 90_000],
  // See IOS_SIMULATOR_LAUNCH_TIMEOUT_MS. The 30s default reported "Remote ADE
  // service timed out" while the daemon kept building, so the session surfaced
  // minutes later with no error to explain it.
  ["ios_simulator.launch", IOS_SIMULATOR_LAUNCH_TIMEOUT_MS],
  // See IOS_SIMULATOR_PREVIEW_TIMEOUT_MS.
  ["ios_simulator.renderPreview", IOS_SIMULATOR_PREVIEW_TIMEOUT_MS],
  ["ios_simulator.renderCurrentPreview", IOS_SIMULATOR_PREVIEW_TIMEOUT_MS],
  ["ios_simulator.ensurePreviewWorkspace", IOS_SIMULATOR_PREVIEW_TIMEOUT_MS],
]);

export function longRunningLocalRuntimeActionTimeoutMs(
  actionKey: string,
): number | null {
  return LONG_RUNNING_LOCAL_RUNTIME_ACTION_TIMEOUTS.get(actionKey) ?? null;
}

/**
 * `plugin.invoke`'s budget when the call names one of its own.
 *
 * A contributed `composer-action` may record or transcribe for minutes by
 * design, and the desktop's plugin calls take THIS route whenever a project
 * runtime is bound — so a fixed entry here would cut a recording off however
 * generous the direct IPC channel was. The hint is clamped (it crossed the
 * preload boundary) and keeps the same headroom over the child's budget that
 * the fixed entry had, so the supervisor's typed `plugin_timeout` still wins
 * the race and the user learns which half was slow.
 */
function pluginInvokeActionTimeoutMs(args: unknown): number | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const hint = clampPluginInvokeTimeoutMs((args as Record<string, unknown>).timeoutMs);
  return hint === null ? null : hint + PLUGIN_INVOKE_ACTION_HEADROOM_MS;
}

/** Spawn grace plus delivery margin — see the `plugin.invoke` entry above. */
const PLUGIN_INVOKE_ACTION_HEADROOM_MS = 30_000;

export function localRuntimeActionTimeoutMs(
  domain: string,
  action: string,
  args?: unknown,
): number {
  const actionKey = `${domain}.${action}`;
  if (actionKey === "plugin.invoke") {
    const named = pluginInvokeActionTimeoutMs(args);
    if (named !== null) return named;
  }
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
  args?: unknown,
): number {
  return localRuntimeCallIpcTimeoutMs(localRuntimeActionTimeoutMs(domain, action, args));
}
