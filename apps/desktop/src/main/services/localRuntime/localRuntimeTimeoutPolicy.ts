import { DEMO_RECORDING_STOP_TIMEOUT_MS } from "../../../shared/demoVideo/demoContract";
import { LEDGER_WORKER_TIMEOUT_MS } from "../usage/usageLedgerWorkerClient";
import { WINDOWS_DESKTOP_TYPE_MAX_TIMEOUT_MS } from "../../../shared/types/macDesktop";
import { ACP_PROVIDER_UPDATE_RUN_BUDGET_MS } from "../ai/acpProviderUpdate";

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
 * ADE's one-click update of a provider CLI runs an npm or vendor install, then
 * re-reads the version. On the 30s default the renderer reported a failure
 * while the install went on, and "Try again" could start a second install
 * against the same CLI. Each budget outward is longer than the one inside it.
 */
export const ACP_PROVIDER_UPDATE_REMOTE_TRANSPORT_TIMEOUT_MS = ACP_PROVIDER_UPDATE_RUN_BUDGET_MS + 10_000;
export const ACP_PROVIDER_UPDATE_TIMEOUT_MS = ACP_PROVIDER_UPDATE_RUN_BUDGET_MS + 20_000;

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
 * Device lifecycle: create makes a new device (`simctl create`, 120s), delete
 * shuts the device down (60s) then deletes it (120s), start waits on
 * `simctl bootstatus` (90s), stop shuts down (60s). Without a budget of its own
 * each ran on the 30s default, so the renderer rejected while the device was
 * still provisioning/booting.
 */
export const IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS = 4 * 60_000;

/**
 * `runTests` runs `xcodebuild test`, which the service bounds at 2 hours; the
 * margin covers the device boot before it and the log read after it.
 */
export const IOS_SIMULATOR_RUN_TESTS_TIMEOUT_MS = 2 * 60 * 60_000 + 5 * 60_000;

/** The cleanup pass may delete several devices, each up to 120s, plus power-offs. */
export const IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS = 15 * 60_000;

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
export const IOS_SIMULATOR_RUN_TESTS_REMOTE_TRANSPORT_TIMEOUT_MS =
  IOS_SIMULATOR_RUN_TESTS_TIMEOUT_MS - 30_000;
export const IOS_SIMULATOR_DEVICE_CLEANUP_REMOTE_TRANSPORT_TIMEOUT_MS =
  IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS - 30_000;
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

export { DEMO_RECORDING_STOP_TIMEOUT_MS };

/**
 * Windows Desktop actions that wait on a person at the Windows PC: the UAC
 * prompt of setup, the Windows password dialog, and Windows' own sign-in
 * window of a private screen (the driver allows that 160 s). On the 30 s
 * default the pane reported "Remote ADE service timed out" while Windows was
 * still waiting for the password, and the start looked frozen.
 */
export const WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS = 180_000;
/** The remote transport outlives the brain's own budget for the same action. */
export const WINDOWS_DESKTOP_INTERACTIVE_REMOTE_TRANSPORT_TIMEOUT_MS = 195_000;
/** The renderer's timer outlives the transport, so the real reason wins. */
export const WINDOWS_DESKTOP_INTERACTIVE_IPC_TIMEOUT_MS = 210_000;
/**
 * Windows types one character at a time, so a long `type` outlives the 30 s
 * default. The brain's own driver budget is capped at
 * `WINDOWS_DESKTOP_TYPE_MAX_TIMEOUT_MS`; the caller waits a little longer so
 * the brain's own answer arrives first.
 */
export const WINDOWS_DESKTOP_TYPE_TIMEOUT_MS = WINDOWS_DESKTOP_TYPE_MAX_TIMEOUT_MS + 15_000;
export const WINDOWS_DESKTOP_TYPE_REMOTE_TRANSPORT_TIMEOUT_MS = WINDOWS_DESKTOP_TYPE_TIMEOUT_MS + 15_000;

const LONG_RUNNING_LOCAL_RUNTIME_ACTION_TIMEOUTS: ReadonlyMap<string, number> = new Map([
  ["ai.piLoginStart", PI_LOGIN_IPC_TIMEOUT_MS],
  ["ai.cursorAuthLogin", CURSOR_LOGIN_IPC_TIMEOUT_MS],
  // See ACP_PROVIDER_UPDATE_TIMEOUT_MS.
  ["ai.acpProviderUpdate", ACP_PROVIDER_UPDATE_TIMEOUT_MS],
  // Lane deletion can legitimately include a 60s worktree removal followed by
  // a 45s remote-branch deletion. The old 30s client budget reported failure
  // while the daemon kept mutating state to a successful completion.
  ["lane.delete", 4 * 60_000],
  // Cancelling a new-lane launch waits out an in-flight checkout, then fully
  // deletes the chat and the lane (worktree + local and remote branch).
  ["chat.cancelLaunch", 5 * 60_000],
  ["lane.archive", 120_000],
  // A GitHub Stack merge polls GitHub for up to 20s, then cleans up each
  // merged PR. The 30s default reported a failure while the merge went on.
  ["pr.land", 120_000],
  ["lane.unarchive", 120_000],
  // Archive restore/delete walk a batch one item at a time, and a lane in the
  // batch can take as long as `lane.unarchive` / `lane.delete` on its own.
  ["archive.restore", 10 * 60_000],
  ["archive.delete", 15 * 60_000],
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
  // An issue with pictures runs `gh issue create --attach` (up to 120s), then
  // a PATCH, a read and a sub-issue link. Timing out first would report a
  // failure while the issue is created, and a retry would file it twice.
  ["github.createIssue", 180_000],
  // Up to 10 MB of picture bytes to Linear's storage.
  ["linear_issue_tracker.uploadFile", 120_000],
  // See USAGE_REFRESH_HISTORY_TIMEOUT_MS: in runtime-backed (production) mode
  // the Usage page's Refresh reaches the ledger worker through this action.
  ["usage.refreshHistory", USAGE_REFRESH_HISTORY_TIMEOUT_MS],
  // See IOS_SIMULATOR_LAUNCH_TIMEOUT_MS. The 30s default reported "Remote ADE
  // service timed out" while the daemon kept building, so the session surfaced
  // minutes later with no error to explain it.
  ["ios_simulator.launch", IOS_SIMULATOR_LAUNCH_TIMEOUT_MS],
  // See IOS_SIMULATOR_PREVIEW_TIMEOUT_MS.
  ["ios_simulator.renderPreview", IOS_SIMULATOR_PREVIEW_TIMEOUT_MS],
  ["ios_simulator.renderCurrentPreview", IOS_SIMULATOR_PREVIEW_TIMEOUT_MS],
  ["ios_simulator.ensurePreviewWorkspace", IOS_SIMULATOR_PREVIEW_TIMEOUT_MS],
  // See IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS.
  ["ios_simulator.deviceStart", IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS],
  ["ios_simulator.deviceStop", IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS],
  ["ios_simulator.deviceCreate", IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS],
  ["ios_simulator.deviceDelete", IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS],
  ["ios_simulator.deviceDetach", IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS],
  ["ios_simulator.deviceCleanup", IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS],
  // See IOS_SIMULATOR_RUN_TESTS_TIMEOUT_MS.
  ["ios_simulator.runTests", IOS_SIMULATOR_RUN_TESTS_TIMEOUT_MS],
  // See DEMO_RECORDING_STOP_TIMEOUT_MS.
  ["mac_desktop.stopRecording", DEMO_RECORDING_STOP_TIMEOUT_MS],
  // See WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS.
  ["mac_desktop.start", WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS],
  ["mac_desktop.setupWindows", WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS],
  ["mac_desktop.takeoverWindows", WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS],
  ["mac_desktop.useSharedDesktop", WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS],
  // Waits on the user's answer to the shared-seat card, then the start.
  ["mac_desktop.requestSharedDesktop", WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS],
  // See WINDOWS_DESKTOP_TYPE_TIMEOUT_MS.
  ["mac_desktop.type", WINDOWS_DESKTOP_TYPE_TIMEOUT_MS],
  ["app_control.stopRecording", DEMO_RECORDING_STOP_TIMEOUT_MS],
  ["built_in_browser.stopRecording", DEMO_RECORDING_STOP_TIMEOUT_MS],
  ["ios_simulator.recordStop", DEMO_RECORDING_STOP_TIMEOUT_MS],
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
