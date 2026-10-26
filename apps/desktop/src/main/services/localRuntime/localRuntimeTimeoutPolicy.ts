import { DEMO_RECORDING_STOP_TIMEOUT_MS } from "../../../shared/demoVideo/demoContract";
import { LEDGER_WORKER_TIMEOUT_MS } from "../usage/usageLedgerWorkerClient";
import { WINDOWS_DESKTOP_TYPE_MAX_TIMEOUT_MS } from "../../../shared/types/macDesktop";
import { LANE_GIT_WRITE_ACTION_TIMEOUT_MS } from "../git/gitTimeouts";
import {
  ARCHIVE_DELETE_TIMEOUT_MS,
  ARCHIVE_RESTORE_TIMEOUT_MS,
  CHAT_CANCEL_LAUNCH_TIMEOUT_MS,
  LANE_ENV_SETUP_TIMEOUT_MS,
} from "../lanes/laneActionTimeouts";

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

/**
 * How long the desktop lets a runtime it spawns take to start answering: the
 * cold-start allowance `connectSpawnedRuntime` polls within. Windows is longer
 * because its spawn (process start, tsx transform, SQLite init) is slower.
 * Every machine-scope connect budget below is derived from this, so a
 * platform's connect allowance and its read budgets cannot drift apart.
 */
export function localRuntimeStartupConnectMaxMs(platform: NodeJS.Platform): number {
  return platform === "win32" ? 30_000 : 10_000;
}
export const LOCAL_RUNTIME_STARTUP_CONNECT_MAX_MS = localRuntimeStartupConnectMaxMs(process.platform);

/**
 * A CLI run from source boots through tsx (4-6 s idle on Node 24, 10-20 s on a
 * loaded CI runner), so it gets the Windows allowance; a bundled `cli.cjs`
 * keeps the platform's shorter one. This is the spawn clock only: the read
 * budgets below stay derived from the platform allowance, so in a from-source
 * session a brain slower than them reads as a degraded snapshot once and the
 * next read joins the same pending connect.
 */
export function localRuntimeSourceCliStartupConnectMaxMs(platform: NodeJS.Platform): number {
  return Math.max(localRuntimeStartupConnectMaxMs(platform), 30_000);
}

/**
 * The longest a machine-scope sync STATUS READ waits for the local runtime
 * before the desktop answers for itself.
 *
 * `sync.getLocalStatus` is the only source for the This-Machine card and the
 * app shell's connection indicator, and the renderer re-reads it on every
 * `sync-status` broadcast. A healthy answer is milliseconds — the whole family
 * is local file work — so the read has no work to wait out, only a wedged
 * runtime to stop waiting on. On the 30s IPC default the two budgets were the
 * same 30s and the IPC timer, which starts first (at handler entry, before the
 * runtime is even connected), always won: it replaced the read's own legible
 * reason with `IPC handler for 'ade.sync.getLocalStatus' timed out after
 * 30000ms` for six users across 1.2.104–1.2.107, so the synthesized
 * machine-only snapshot the handler already builds for an unreachable runtime
 * never got the chance to answer. Bounding the read here restores the chain's
 * invariant —
 * every budget expires monotonically outward, inner before outer. The overall
 * cap below, not this read, is what leaves room under the IPC timer to build
 * and deliver the fallback snapshot.
 * 8s matches LOCAL_RUNTIME_FILE_ACTION_TIMEOUT_MS, the existing budget for
 * "a local runtime read that must not hold its caller".
 *
 * This budget is the RPC transport's clock, and it starts only once the
 * connection is up: `callSync` awaits `connect()` before it sends, so a cold
 * runtime start (up to 10s on macOS, 30s on Windows) never spends this budget.
 * Counting connect against it produced a false "listener not bound" card and
 * a degraded reading on every cold start.
 *
 * The whole handler is still capped at LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS,
 * which covers connect. A read that loses either race lands in the
 * already-designed degraded state (buildMachineOnlySyncSnapshot), whose
 * `degradedReason` tells the renderer's shared reader to back off and retry —
 * never in a snapshot that claims the machine is healthy or reachable.
 */
export const LOCAL_RUNTIME_SYNC_STATUS_READ_TIMEOUT_MS = 8_000;

/**
 * Slack the overall cap keeps above connect + read. It covers the service
 * probe that runs before a spawn (about 2.1s on Windows) and the bookkeeping
 * around it. 7s is exactly what the macOS cap already carried above its 10s
 * connect and 8s read, so macOS keeps its 25s value.
 */
export const LOCAL_RUNTIME_SYNC_STATUS_CAP_SLACK_MS = 7_000;

/**
 * Headroom the renderer's IPC timer for `sync.getLocalStatus` keeps above the
 * overall cap, for building the fallback snapshot and delivering it.
 */
export const LOCAL_RUNTIME_SYNC_STATUS_FALLBACK_HEADROOM_MS = 5_000;

/**
 * The firm cap on one machine-scope sync status read, connect included: the
 * platform's cold-start allowance, plus the read budget, plus slack.
 *
 * The handler's own fallback answer, not the opaque IPC timeout, must be what
 * the renderer sees, so the IPC timer sits above this (see below). The cap used
 * to be a fixed 25s, which cut off a Windows cold start (up to 30s to connect,
 * then the read) that would have succeeded. macOS is unchanged. On Windows a
 * runtime that never answers now reads as degraded after 45s instead of 25s.
 * That is the cost of letting a slow but healthy start finish.
 *
 * This derives from the spawn path's allowance. A runtime reached through the
 * service repair path (`tryRepairServiceConnection`) can take longer to come
 * up, and a read that loses that race gets the same degraded snapshot. Its
 * `degradedReason` makes the renderer back off and retry, and the next read
 * awaits the same pending connect, so the card recovers when the runtime does.
 */
export function localRuntimeSyncStatusOverallTimeoutMs(platform: NodeJS.Platform): number {
  return localRuntimeStartupConnectMaxMs(platform)
    + LOCAL_RUNTIME_SYNC_STATUS_READ_TIMEOUT_MS
    + LOCAL_RUNTIME_SYNC_STATUS_CAP_SLACK_MS;
}
export const LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS =
  localRuntimeSyncStatusOverallTimeoutMs(process.platform);

/** The renderer's IPC timer for `sync.getLocalStatus`, above the overall cap. */
export function localRuntimeSyncStatusIpcTimeoutMs(platform: NodeJS.Platform): number {
  return localRuntimeSyncStatusOverallTimeoutMs(platform)
    + LOCAL_RUNTIME_SYNC_STATUS_FALLBACK_HEADROOM_MS;
}
export const LOCAL_RUNTIME_SYNC_STATUS_IPC_TIMEOUT_MS =
  localRuntimeSyncStatusIpcTimeoutMs(process.platform);
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
 * A machine update downloads a full build before it restarts, so the normal
 * call timeout is far too short. Fifteen minutes covers a slow link without
 * leaving the request open forever.
 */
export const REMOTE_MACHINE_UPDATE_TIMEOUT_MS = 15 * 60_000;
/** The renderer's timer outlives the update call, so the machine's own answer wins. */
export const REMOTE_MACHINE_UPDATE_IPC_TIMEOUT_MS = REMOTE_MACHINE_UPDATE_TIMEOUT_MS + 30_000;
/**
 * Windows types one character at a time, so a long `type` outlives the 30 s
 * default. The brain's own driver budget is capped at
 * `WINDOWS_DESKTOP_TYPE_MAX_TIMEOUT_MS`; the caller waits a little longer so
 * the brain's own answer arrives first.
 */
export const WINDOWS_DESKTOP_TYPE_TIMEOUT_MS = WINDOWS_DESKTOP_TYPE_MAX_TIMEOUT_MS + 15_000;
export const WINDOWS_DESKTOP_TYPE_REMOTE_TRANSPORT_TIMEOUT_MS = WINDOWS_DESKTOP_TYPE_TIMEOUT_MS + 15_000;

// In a leaf module, so the hosted web client reads the same bounds.
export {
  ARCHIVE_DELETE_TIMEOUT_MS,
  ARCHIVE_RESTORE_TIMEOUT_MS,
  CHAT_CANCEL_LAUNCH_TIMEOUT_MS,
  LANE_ENV_SETUP_REMOTE_TRANSPORT_TIMEOUT_MS,
  LANE_ENV_SETUP_TIMEOUT_MS,
} from "../lanes/laneActionTimeouts";

const LONG_RUNNING_LOCAL_RUNTIME_ACTION_TIMEOUTS: ReadonlyMap<string, number> = new Map([
  ["ai.piLoginStart", PI_LOGIN_IPC_TIMEOUT_MS],
  ["ai.cursorAuthLogin", CURSOR_LOGIN_IPC_TIMEOUT_MS],
  // Lane actions that run a checkout, `worktree add` or `worktree remove`; see
  // LANE_GIT_WRITE_ACTION_TIMEOUT_MS. A shorter budget reported failure while
  // the daemon kept writing the tree to a successful completion.
  ["lane.create", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  ["lane.createChild", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  ["lane.createFromUnstaged", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  ["lane.importBranch", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  ["lane.switchBranch", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  ["git.checkoutBranch", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  ["lane.unarchive", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  ["lane.archiveAndReclaim", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  ["lane.delete", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  ["pr.createLaneFromPrBranch", LANE_GIT_WRITE_ACTION_TIMEOUT_MS],
  // Cancelling a new-lane launch waits out an in-flight checkout, then fully
  // deletes the chat and the lane (worktree + local and remote branch).
  ["chat.cancelLaunch", CHAT_CANCEL_LAUNCH_TIMEOUT_MS],
  ["lane.archive", 120_000],
  // A GitHub Stack merge polls GitHub for up to 20s, then cleans up each
  // merged PR. The 30s default reported a failure while the merge went on.
  ["pr.land", 120_000],
  // See LANE_ENV_SETUP_TIMEOUT_MS.
  ["lane.initEnv", LANE_ENV_SETUP_TIMEOUT_MS],
  ["lane.applyTemplate", LANE_ENV_SETUP_TIMEOUT_MS],
  // Archive restore/delete walk a batch one item at a time, and a lane in the
  // batch can take as long as `lane.unarchive` / `lane.delete` on its own.
  ["archive.restore", ARCHIVE_RESTORE_TIMEOUT_MS],
  ["archive.delete", ARCHIVE_DELETE_TIMEOUT_MS],
  ["chat.suggestLaneNameFromPrompt", 120_000],
  ["chat.generateAutoLaneIdentity", 120_000],
  // Handoff = AI brief generation (bounded at 45s) + session creation +
  // provider dispatch of the first message; the 30s default fired a false
  // timeout while the daemon-side handoff kept running to a late "surprise"
  // success (ADE-122).
  ["chat.handoffSession", 120_000],
  // A side chat forks the provider history (Codex in an ephemeral app-server,
  // up to 30s) and then dispatches its first message.
  ["chat.startSideChat", 120_000],
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
  ["ios_simulator.devicePromote", IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS],
  ["ios_simulator.deviceCleanup", IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS],
  // Removing runtimes shuts down, moves or erases every simulator on them first.
  ["ios_simulator.runtimeDelete", IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS],
  ["ios_simulator.duoAppStoreScreenshots", IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS],
  ["ios_simulator.addDuoSkill", IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS],
  ["ios_simulator.attachRenderProof", IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS],
  // A render folds the Duo per pose and records a turntable.
  ["ios_simulator.requestRender", IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS],
  ["ios_simulator.runtimePrune", IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS],
  ["ios_simulator.xcodeRunFirstLaunch", IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS],
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
  // Waits on the user's answer to the real-input card (withdrawn at 170 s).
  ["mac_desktop.requestInputLease", WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS],
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
