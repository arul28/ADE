import { MCP_SIGN_IN_TIMEOUT_MS } from "../mcp/mcpOAuth";
import { IPC } from "../../../shared/ipc";
import { isReplaySafeAdeAction } from "../../../shared/adeActionAccess";
import {
  localRuntimeActionIpcTimeoutMs,
  longRunningLocalRuntimeActionTimeoutMs,
  LOCAL_RUNTIME_IPC_ACTION_REGISTRY_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_EVENT_POLL_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS,
  LOCAL_RUNTIME_SYNC_STATUS_IPC_TIMEOUT_MS,
  PI_LOGIN_IPC_TIMEOUT_MS,
  CURSOR_LOGIN_IPC_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_SYNC_TIMEOUT_MS,
  USAGE_REFRESH_HISTORY_TIMEOUT_MS,
  IOS_SIMULATOR_LAUNCH_TIMEOUT_MS,
  IOS_SIMULATOR_PREVIEW_TIMEOUT_MS,
  IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS,
  IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS,
  WINDOWS_DESKTOP_INTERACTIVE_IPC_TIMEOUT_MS,
  REMOTE_MACHINE_UPDATE_IPC_TIMEOUT_MS,
} from "../localRuntime/localRuntimeTimeoutPolicy";
import { DEMO_RECORDING_STOP_TIMEOUT_MS } from "../../../shared/demoVideo/demoContract";
import { builtInBrowserRemoteCallDoneTimeoutMs } from "../../../shared/types/builtInBrowserRemote";
import { PROJECT_REPAIR_IPC_TIMEOUT_MS } from "../../../../../ade-cli/src/serviceManager/runtimeServiceBudgets";
import { DISK_USAGE_TIMEOUT_MS } from "../../../../../ade-cli/src/services/projects/projectMove/moveCopy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * The `{ request: { domain, action } }` payload every runtime `callAction`
 * invoke carries, read off the raw IPC arguments.
 *
 * One decoder for every reader of that shape — the timeout policy below and the
 * failure telemetry in `registerIpc` — because they all describe the same call
 * and a reader that disagreed about what a well-formed request looks like would
 * silently attribute a timeout to one action and its failure to another.
 * `action` is optional: a payload naming only a domain is still enough to
 * attribute a failure, and callers that need to route on the action check it.
 */
export function readRuntimeActionRequest(
  args: readonly unknown[],
): { domain: string; action?: string } | null {
  const payload = args[0];
  const request = isRecord(payload) && isRecord(payload.request) ? payload.request : null;
  const domain = typeof request?.domain === "string" ? request.domain.trim() : "";
  if (!domain) return null;
  const action = typeof request?.action === "string" ? request.action.trim() : "";
  return { domain, ...(action ? { action } : {}) };
}

const RUNTIME_ACTION_CHANNEL: Record<string, Record<string, string>> = {
  ai: {
    piLoginStart: IPC.aiPiLoginStart,
    cursorAuthLogin: IPC.aiCursorAuthLogin,
  },
  lane: {
    create: IPC.lanesCreate,
    importBranch: IPC.lanesImportBranch,
    switchBranch: IPC.lanesSwitchBranch,
    unarchive: IPC.lanesUnarchive,
    archiveAndReclaim: IPC.lanesArchiveAndReclaim,
    archive: IPC.lanesArchive,
    delete: IPC.lanesDelete,
    initEnv: IPC.lanesInitEnv,
    applyTemplate: IPC.lanesApplyTemplate,
  },
  ios_simulator: {
    // A remote runtime builds with the same xcodebuild as a local one, so a
    // cold launch or preview render needs the same budget whichever runtime
    // answers it. Without these the remote path fell through to 30s and
    // reported a timeout while the build was still running. This map only sets
    // the renderer→main IPC timer; the transport budget underneath it lives in
    // remoteConnectionPool's LONG_RUNNING_REMOTE_RUNTIME_ACTION_TIMEOUTS.
    launch: IPC.iosSimulatorLaunch,
    // Device lifecycle (boot/clone/shutdown/delete) also runs the same simctl
    // work whether local or remote; see IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS.
    deviceStart: IPC.iosSimulatorDeviceStart,
    deviceStop: IPC.iosSimulatorDeviceStop,
    deviceCreate: IPC.iosSimulatorDeviceCreate,
    deviceDelete: IPC.iosSimulatorDeviceDelete,
    deviceDetach: IPC.iosSimulatorDeviceDetach,
    deviceCleanup: IPC.iosSimulatorDeviceCleanup,
    runtimeDelete: IPC.iosSimulatorRuntimeDelete,
    duoAppStoreScreenshots: IPC.iosSimulatorDuoAppStoreScreenshots,
    addDuoSkill: IPC.iosSimulatorAddDuoSkill,
    attachRenderProof: IPC.iosSimulatorAttachRenderProof,
    runtimePrune: IPC.iosSimulatorRuntimePrune,
    xcodeRunFirstLaunch: IPC.iosSimulatorXcodeRunFirstLaunch,
    resolvePreviewMatch: IPC.iosSimulatorResolvePreviewMatch,
    ensurePreviewWorkspace: IPC.iosSimulatorEnsurePreviewWorkspace,
    renderCurrentPreview: IPC.iosSimulatorRenderCurrentPreview,
    renderPreview: IPC.iosSimulatorRenderPreview,
  },
  chat: {
    handoffSession: IPC.agentChatHandoff,
    prepareCrossMachineHandoff: IPC.agentChatPrepareCrossMachineHandoff,
    startSideChat: IPC.agentChatStartSideChat,
  },
  // A GitHub Stack merge polls GitHub, then cleans up each merged PR,
  // whichever runtime answers it.
  pr: {
    land: IPC.prsLand,
    createLaneFromPrBranch: IPC.prsCreateLaneFromPrBranch,
  },
  // A remote runtime runs the same ledger worker as a local one, so the Usage
  // page's Refresh needs the same budget whichever runtime answers it.
  usage: {
    refreshHistory: IPC.usageRefreshHistory,
  },
  // Windows Desktop actions that wait on a person at the Windows PC; see
  // WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS.
  mac_desktop: {
    start: IPC.macDesktopStart,
    setupWindows: IPC.macDesktopSetupWindows,
    takeoverWindows: IPC.macDesktopTakeoverWindows,
    useSharedDesktop: IPC.macDesktopUseSharedDesktop,
  },
};

const REMOTE_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 10 * 60_000;
const REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS = 75_000;

function runtimeActionTimeoutMs(args: readonly unknown[]): number | null {
  const request = readRuntimeActionRequest(args);
  if (!request?.action) return null;
  const channel = RUNTIME_ACTION_CHANNEL[request.domain]?.[request.action];
  if (channel) return ipcInvokeTimeoutMs(channel);
  // An action with a long budget and no IPC twin (chat.cancelLaunch, say) gets
  // the same renderer budget on a remote machine as on this one.
  return longRunningLocalRuntimeActionTimeoutMs(`${request.domain}.${request.action}`) === null
    ? null
    : localRuntimeActionIpcTimeoutMs(request.domain, request.action);
}

function retryableRemoteActionTimeoutMs(args: readonly unknown[]): number | null {
  const request = readRuntimeActionRequest(args);
  if (!request?.action) return null;
  return isReplaySafeAdeAction(request.domain, request.action)
    ? REMOTE_RUNTIME_RETRYABLE_ACTION_TIMEOUT_MS
    : null;
}

export function ipcInvokeTimeoutMs(channel: string, args: readonly unknown[] = []): number {
  if (channel === IPC.localRuntimeCallAction) {
    const request = readRuntimeActionRequest(args);
    return request?.action
      ? localRuntimeActionIpcTimeoutMs(request.domain, request.action)
      : LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS;
  }
  if (channel === IPC.localRuntimeCallSync) return LOCAL_RUNTIME_IPC_SYNC_TIMEOUT_MS;
  // The This-Machine status read. Its handler answers with the degraded
  // snapshot at LOCAL_RUNTIME_SYNC_STATUS_OVERALL_TIMEOUT_MS, so this timer must
  // outlive that answer. On the 30s default a Windows cold start (45s cap) would
  // show the opaque IPC timeout instead.
  if (channel === IPC.syncGetLocalStatus) return LOCAL_RUNTIME_SYNC_STATUS_IPC_TIMEOUT_MS;
  // The project-scoped status read answers the same way at the same cap, after
  // registering the project on a runtime that may still be starting.
  if (channel === IPC.syncGetStatus) return LOCAL_RUNTIME_SYNC_STATUS_IPC_TIMEOUT_MS;
  // Reconnecting forwards to the brain on the same 30s sync budget. On the 30s
  // IPC default the two would expire together and the renderer would render an
  // opaque IPC timeout instead of the brain's legible reason — so this channel
  // gets the same headroom every other brain-forwarding channel has.
  if (channel === IPC.accountRepairMachinePairing) return LOCAL_RUNTIME_IPC_SYNC_TIMEOUT_MS;
  // Starting sync forwards to the brain on the same 30s sync budget. The bridge
  // answers in words at its own deadline (START_SYNC_HOST_DEADLINE_MS in
  // accountBridge.ts), which sits under this ceiling. On the 30s default the
  // renderer showed the opaque IPC timeout instead.
  if (channel === IPC.accountStartSyncHost) return LOCAL_RUNTIME_IPC_SYNC_TIMEOUT_MS;
  if (channel === IPC.localRuntimeListActionRegistry) return LOCAL_RUNTIME_IPC_ACTION_REGISTRY_TIMEOUT_MS;
  if (channel === IPC.localRuntimeStreamEvents) return LOCAL_RUNTIME_IPC_EVENT_POLL_TIMEOUT_MS;
  // A command from an agent on another machine: a `wait` or a sign-in handoff
  // runs for minutes, and the daemon that sent it waits the same budget.
  if (channel === IPC.builtInBrowserRunRemoteAgentCall) {
    const request = args[0] && typeof args[0] === "object" ? args[0] as { method?: unknown; input?: unknown } : {};
    return builtInBrowserRemoteCallDoneTimeoutMs(typeof request.method === "string" ? request.method : "", request.input);
  }
  if (channel === IPC.remoteRuntimeCallAction) {
    const actionTimeoutMs = runtimeActionTimeoutMs(args);
    if (actionTimeoutMs != null) return actionTimeoutMs;
    const retryableActionTimeoutMs = retryableRemoteActionTimeoutMs(args);
    if (retryableActionTimeoutMs != null) return retryableActionTimeoutMs;
    return 30_000;
  }
  switch (channel) {
    // Switching projects can cold-start and bind the local runtime. Keep the
    // renderer's outcome known through setup and result delivery.
    case IPC.projectSwitchToPath:
      return LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS;
    // Awaits the user finishing Pi's own sign-in in a browser.
    case IPC.aiPiLoginStart:
      return PI_LOGIN_IPC_TIMEOUT_MS;
    case IPC.aiCursorAuthLogin:
      return CURSOR_LOGIN_IPC_TIMEOUT_MS;
    // Awaits the user approving an MCP server's sign-in in a browser; the
    // sign-in gives up on its own first, so the renderer hears why.
    case IPC.mcpRegistrySignIn:
      return MCP_SIGN_IN_TIMEOUT_MS + 60_000;
    // Downloads and installs a build on another machine. On the 30s default the
    // renderer reported a timeout while the update was still going.
    case IPC.remoteRuntimeUpdateAndRestart:
      return REMOTE_MACHINE_UPDATE_IPC_TIMEOUT_MS;
    case IPC.remoteRuntimeConnect:
    case IPC.remoteRuntimeListProjects:
    case IPC.remoteRuntimeAddProject:
    case IPC.remoteRuntimeBrowseDirectories:
    case IPC.remoteRuntimeGetProjectDetail:
    // Includes the time the user spends in the native file dialog.
    case IPC.remoteRuntimeChooseProjectIcon:
    case IPC.remoteRuntimeRemoveProjectIcon:
    case IPC.remoteRuntimeGetDefaultParentDir:
    case IPC.remoteRuntimeCreateProject:
    case IPC.remoteRuntimeCloneProject:
    case IPC.remoteRuntimeListMyGitHubRepos:
    case IPC.remoteRuntimeOpenProject:
    case IPC.remoteRuntimeListActionRegistry:
    case IPC.remoteRuntimeCallSync:
    case IPC.remoteRuntimeEnsurePortForward:
    case IPC.remoteRuntimeStreamEvents:
      return REMOTE_RUNTIME_BOOTSTRAP_TIMEOUT_MS;
    case IPC.lanesArchive:
      return 4 * 60_000;
    case IPC.filesDelete:
      return localRuntimeActionIpcTimeoutMs("file", "deletePath");
    // Checkout, `worktree add` and `worktree remove`; see
    // LANE_GIT_WRITE_ACTION_TIMEOUT_MS.
    case IPC.lanesCreate:
      return localRuntimeActionIpcTimeoutMs("lane", "create");
    case IPC.lanesImportBranch:
      return localRuntimeActionIpcTimeoutMs("lane", "importBranch");
    case IPC.lanesSwitchBranch:
      return localRuntimeActionIpcTimeoutMs("lane", "switchBranch");
    // The lane branch picker's switch: the same checkout as lane.switchBranch.
    case IPC.gitCheckoutBranch:
      return localRuntimeActionIpcTimeoutMs("git", "checkoutBranch");
    case IPC.lanesUnarchive:
      return localRuntimeActionIpcTimeoutMs("lane", "unarchive");
    case IPC.lanesArchiveAndReclaim:
      return localRuntimeActionIpcTimeoutMs("lane", "archiveAndReclaim");
    case IPC.lanesDelete:
      return localRuntimeActionIpcTimeoutMs("lane", "delete");
    case IPC.prsCreateLaneFromPrBranch:
      return localRuntimeActionIpcTimeoutMs("pr", "createLaneFromPrBranch");
    // A lane template's installs and setup script; see LANE_ENV_SETUP_TIMEOUT_MS.
    case IPC.lanesInitEnv:
    case IPC.lanesApplyTemplate:
      return localRuntimeActionIpcTimeoutMs("lane", "applyTemplate");
    // Handoff runs an AI brief + session creation + first-message dispatch
    // (and cross-machine prepare additionally packages provider history);
    // it must outlive the daemon-side 120s action timeout so the false
    // "timed out but later succeeded" failure can't reappear via this layer.
    case IPC.agentChatHandoff:
    case IPC.agentChatPrepareCrossMachineHandoff:
    // A side chat forks the provider's history (a Codex fork alone can take
    // 30s) and then sends its first message.
    case IPC.agentChatStartSideChat:
      return 150_000;
    // A brain restart waits through the service install, then for the
    // replacement brain to rebind (20s) and answer a ping (20s). The install
    // leg can be 120s rather than 60s, because a forced restart queues behind
    // an in-flight non-forced install instead of joining it. The renderer must
    // not give up before the main process knows the outcome, or the Repair
    // button reports a failure for a restart that actually succeeded.
    case IPC.appRestartBackgroundService:
    // Repairing the stored sign-in ends in that same brain restart, so it
    // inherits the same budget. On the 30s default the renderer would report a
    // failure for a repair that is still running — the exact mis-report the
    // restart case above exists to prevent.
    case IPC.accountRepairSession:
      return 4 * 60_000;
    // A project move copies the whole project before it answers; a few hundred
    // GB to a USB drive takes far more than the 30s default. Progress arrives
    // on its own channel meanwhile.
    case IPC.projectMoveStart:
    // Deleting the kept original removes the whole old copy before it answers;
    // a 24 GB copy took minutes, and on the 30s default the renderer reported
    // a failure while the delete went on and later succeeded.
    case IPC.projectMoveCleanup:
      return 24 * 60 * 60_000;
    // The checks measure the project with `du`, node_modules included, then
    // search every lane's files for the old path. A project with 35 GB of
    // node_modules across its lanes took 67s to measure, and the 30s default
    // showed a raw IPC timeout instead of the checks. The budget is `du`'s own
    // limit plus five minutes for the steps that follow it.
    case IPC.projectMovePreflight:
      return DISK_USAGE_TIMEOUT_MS + 5 * 60_000;
    // On the 30s default the renderer showed a raw IPC timeout mid-repair.
    case IPC.recoveryRepair:
    // Start fresh closes the project and waits for the background service to
    // drop it; restoring may copy a folder back from another disk's Trash.
    case IPC.recoveryStartFresh:
    case IPC.recoveryRestoreProjectData:
      return PROJECT_REPAIR_IPC_TIMEOUT_MS;
    // A GitHub Stack merge polls GitHub for up to 20s, then cleans up each
    // merged PR. The 30s default reported a failure while the merge went on.
    case IPC.prsLand:
      return 120_000;
    // The Usage page's Refresh runs the isolated ledger worker end to end. On
    // the 30s default the renderer rejected with a raw IPC timeout — and blanked
    // the page — while the daemon kept scanning for another nine minutes.
    case IPC.usageRefreshHistory:
      return USAGE_REFRESH_HISTORY_TIMEOUT_MS;
    // A cold iOS launch is a full xcodebuild plus boot, install and launch. The
    // service's own inner budgets sum to roughly 930s in the worst case, so the
    // IPC timer has to sit above that or the renderer reports a failure for a
    // launch that is still compiling. The remote-runtime path reads its IPC
    // budget from this same case via RUNTIME_ACTION_CHANNEL; the RPC transport
    // it wraps carries its own, shorter budget from remoteConnectionPool.
    case IPC.iosSimulatorLaunch:
      return IOS_SIMULATOR_LAUNCH_TIMEOUT_MS;
    // Boot, clone, shutdown and delete each run simctl work that can outlast
    // the 30s default; on it the renderer rejected while the device was still
    // provisioning. See IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS.
    case IPC.iosSimulatorDeviceStart:
    case IPC.iosSimulatorDeviceStop:
    case IPC.iosSimulatorDeviceCreate:
    case IPC.iosSimulatorDeviceDelete:
    case IPC.iosSimulatorDeviceDetach:
    case IPC.iosSimulatorDuoAppStoreScreenshots:
    case IPC.iosSimulatorAddDuoSkill:
    case IPC.iosSimulatorAttachRenderProof:
      return IOS_SIMULATOR_DEVICE_LIFECYCLE_TIMEOUT_MS;
    // Mapped from the remote `ios_simulator.deviceCleanup` above, but with no
    // case of its own it fell to 30s against a 15 minute cleanup pass.
    case IPC.iosSimulatorDeviceCleanup:
    case IPC.iosSimulatorRuntimeDelete:
    case IPC.iosSimulatorRuntimePrune:
    case IPC.iosSimulatorXcodeRunFirstLaunch:
      return IOS_SIMULATOR_DEVICE_CLEANUP_TIMEOUT_MS;
    // UAC, the Windows password dialog, or Windows' sign-in window may be
    // waiting on a person; see WINDOWS_DESKTOP_INTERACTIVE_TIMEOUT_MS.
    case IPC.macDesktopStart:
    case IPC.macDesktopSetupWindows:
    case IPC.macDesktopTakeoverWindows:
    case IPC.macDesktopUseSharedDesktop:
      return WINDOWS_DESKTOP_INTERACTIVE_IPC_TIMEOUT_MS;
    case IPC.transcriptionTranscribe:
      return 6 * 60_000;
    // The ~464 MB speech model download. On the 30s default the renderer showed
    // a raw IPC timeout while the main process kept downloading; a minute-long
    // download on a fast connection was enough to trip it. The download itself
    // is bounded by its own per-attempt socket timeout and retries.
    case IPC.transcriptionDownloadModel:
      return 60 * 60_000;
    // The agent CLI tools cache is a ~300 MB download; same story as above.
    case IPC.aiEnsureToolsCache:
      return 60 * 60_000;
    // An update check settles only once any download it started is over.
    case IPC.updateCheckForUpdates:
      return 30 * 60_000;
    // Waits on the macOS administrator password dialog (its own 2 minute cap).
    case IPC.appBundleOwnershipFix:
      return 3 * 60_000;
    // `git clone` carries its own 5 minute timeout; sit above it so a slow
    // clone reports its own outcome instead of an IPC timeout mid-clone.
    case IPC.projectClone:
      return 6 * 60_000;
    // Runs the CLI installer, which can wait on a permission prompt.
    case IPC.adeCliInstallForUser:
      return 5 * 60_000;
    // These wait on a native dialog a person may leave open. On the 30s
    // default the renderer reported a failure while the dialog was still up.
    case IPC.projectChooseDirectory:
    case IPC.projectChooseIcon:
    case IPC.projectSecretsChooseEnvFile:
    case IPC.machineResetChooseRescueDir:
    case IPC.historyExportOperations:
      return 10 * 60_000;
    // Dialog, then the same project switch projectSwitchToPath budgets for.
    case IPC.projectOpenRepo:
      return LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS + 10 * 60_000;
    // The reset confirmation is a native dialog. Timing out left it up, and
    // answering it later still reset ADE after the window reported a failure.
    case IPC.machineResetStart:
      return 30 * 60_000;
    // Stopping renders the demo video; see DEMO_RECORDING_STOP_TIMEOUT_MS,
    // which promises every transport carrying a stop waits at least this long.
    // The runtime-action path already does; these are the direct channels.
    case IPC.appControlStopRecording:
    case IPC.builtInBrowserStopRecording:
    case IPC.macDesktopStopRecording:
    case IPC.iosSimulatorRecordStop:
      return DEMO_RECORDING_STOP_TIMEOUT_MS + 30_000;
    // Direct-channel twins of actions the local runtime map already gives a
    // longer budget; without these the same work timed out at 30s whenever a
    // project was not runtime-backed.
    case IPC.agentChatSuggestLaneName:
    case IPC.agentChatGenerateAutoLaneIdentity:
      return 150_000;
    case IPC.githubCreateIssue:
      return 180_000;
    // First-run discovery runs in a child with its own ceiling (60s discover,
    // 30s chat list, `onboardingDiscoveryClient.ts`). The IPC budget outlives
    // it, so a wedged child ends in setup's empty answer, not an IPC timeout.
    case IPC.appDiscoverOnboardingProjects:
      return 75_000;
    case IPC.appListOnboardingProjectChats:
      return 40_000;
    case IPC.archiveRestore:
      return localRuntimeActionIpcTimeoutMs("archive", "restore");
    case IPC.archiveDelete:
      return localRuntimeActionIpcTimeoutMs("archive", "delete");
    // Streams up to 50 MB to a paired host over HTTP. The upload client's own
    // budget is 5 minutes, so on the 30s default the renderer reported a
    // failure — and dropped the pending attachment chip — for an upload that
    // was still in flight. This has to sit above the client's budget so the
    // legible reason wins.
    case IPC.remoteRuntimeUploadChatAttachment:
      return 6 * 60_000;
    // Preview Lab compiles the target before it can render a frame, so these
    // three carry the same 10 minute budget the local runtime map gives them.
    // The remote-runtime path reads its IPC budget from these same cases via
    // RUNTIME_ACTION_CHANNEL, so a shorter budget here reported a timeout for
    // a preview that was still compiling.
    case IPC.iosSimulatorEnsurePreviewWorkspace:
    case IPC.iosSimulatorRenderCurrentPreview:
    case IPC.iosSimulatorRenderPreview:
      return IOS_SIMULATOR_PREVIEW_TIMEOUT_MS;
    case IPC.iosSimulatorListLaunchTargets:
    // `waitMs` may hold it up to 30 s; the outer clock must outlast that.
    case IPC.iosSimulatorGetForegroundApp:
    case IPC.iosSimulatorGetScreenSnapshot:
    case IPC.iosSimulatorInspectPoint:
    case IPC.iosSimulatorSelectPoint:
    case IPC.iosSimulatorGetPreviewCapability:
    case IPC.iosSimulatorListPreviewTargets:
    case IPC.iosSimulatorResolvePreviewMatch:
      return 2 * 60_000;
    case IPC.iosSimulatorOpenPreviewWorkspace:
    case IPC.iosSimulatorScreenshot:
    case IPC.iosSimulatorStartStream:
    case IPC.iosSimulatorStopStream:
    case IPC.iosSimulatorShutdown:
    case IPC.iosSimulatorGetStreamStatus:
    case IPC.iosSimulatorTap:
    case IPC.iosSimulatorPressButton:
    case IPC.iosSimulatorRotate:
    case IPC.iosSimulatorTypeText:
    case IPC.iosSimulatorDrag:
    case IPC.iosSimulatorSwipe:
    case IPC.appControlLaunch:
    case IPC.appControlLaunchInTerminal:
    case IPC.appControlGetSnapshot:
    case IPC.appControlInspectPoint:
    case IPC.appControlSelectPoint:
    case IPC.appControlScreenshot:
    case IPC.appControlConnect:
    case IPC.appControlStop:
    case IPC.appControlFocusWindow:
    case IPC.appControlMinimizeWindow:
    case IPC.appControlClick:
    case IPC.appControlTypeText:
    case IPC.builtInBrowserNavigate:
    case IPC.builtInBrowserCreateTab:
    case IPC.builtInBrowserReload:
    case IPC.builtInBrowserStartInspect:
    case IPC.builtInBrowserStopInspect:
    case IPC.builtInBrowserCaptureScreenshot:
    case IPC.builtInBrowserSelectPoint:
      return 60_000;
    default:
      return 30_000;
  }
}
