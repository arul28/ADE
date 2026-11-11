import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { app, BrowserWindow, ipcMain, powerMonitor } from "electron";
import {
  cloudKindLabel,
  cloudStillStartingMessage,
  CLOUD_MADE_BY_CHAT_METADATA,
  type CloudAccountState,
  type CloudAgentLimits,
  type CloudShapeId,
  isCloudInstanceId,
  cloudMachineState,
  type CloudCreateMachineArgs,
  type CloudCreateProgress,
  type CloudMachineActionArgs,
  type CloudMachineActionKind,
  type CloudMachineActionResult,
  type CloudMachinesResult,
  type CloudOpenCheckoutResult,
  type CloudStatus,
} from "../../../shared/adeCloud";
import {
  type CloudReadyClaim,
  type CloudReadyProjectSettings,
  type CloudReadyStatus,
} from "../../../shared/cloudReady";
import { type CloudSignInStatus } from "../../../shared/cloudSignIns";
import { IPC } from "../../../shared/ipc";
import { cloudMachineEnv, type CloudSignInVaults } from "./cloudSignInStore";
import type { AdeAccountMachinesResult } from "../../../shared/types/account";
import { getSignedInAccountAccessToken } from "../../../../../ade-cli/src/services/account/accountAuthService";
import {
  getSharedAccountAuthService,
  getSharedAccountDirectoryBaseUrl,
} from "../../../../../ade-cli/src/services/account/sharedAccountAuthService";
import { EncryptedFileCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { resolveMachineAdeLayout } from "../../../../../ade-cli/src/services/projects/machineLayout";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import {
  cloudAccessDepsFor,
  cloudAccessEnabled,
  cloudNoProviderSentence,
  cloudVaultFromBridge,
  getCloudProvider,
  knownCloudProvider,
  readCloudStatus,
  requireCloudProvider,
  watchCloudAccessForSkills,
  type CloudAccessDeps,
} from "./cloudAccess";
import { createCloudMachine, type CloudMachineCreatorDeps } from "./cloudMachineCreator";
import { openCloudApprovalWindow } from "./cloudApprovalWindow";
import { createCloudMachines } from "./cloudMachines";
import type { CloudProvider } from "./cloudProvider";
import { claimCloudReadyMachine, releaseCloudReadyMachine } from "./cloudReadyClaim";
import { createCloudReadyKeeper } from "./cloudReadyMachines";
import { setCloudAsleepCheck, setCloudRestChanged, setCloudUpdateBlocker, setCloudWakeForUse } from "./cloudWakeHook";
import { startCloudSleepWatch } from "./cloudSleepWatch";
import { setCloudDesktopActions } from "./cloudDesktopActions";
import { copyCloudMachine, moveCloudMachine, type CloudCopyDeps } from "./cloudMachineCopy";
import { reconnectCloudMachine } from "./cloudReconnect";
import {
  CLOUD_AGENT_LIMITS_VAULT_KEY,
  createCloudAgentLimitsStore,
  cloudInstanceForMachine,
  wakeCloudMachineForUse,
} from "./cloudSleep";
import { CLOUD_READY_VAULT_KEY, createCloudReadySettingsStore } from "./cloudReadySettings";
import { openExternalUrl } from "../shared/externalLinks";
import { getErrorMessage } from "../shared/utils";
import { normalizeAppPackageChannel } from "../../../shared/packageChannel";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { createCloudPendingCreateStore, sweepCloudPendingCreates } from "./cloudPendingCreates";

type Logger = {
  info(event: string, meta?: Record<string, unknown>): void;
  warn(event: string, meta?: Record<string, unknown>): void;
};

/**
 * ADE Cloud in Settings and the machine picker.
 *
 * No pin anywhere: cloud access is account-wide (the account vault answers the same
 * on every computer), and making a box acts on the account's cloud machines and the
 * ADE account, never on a lane, chat or another machine. The new box's own
 * actions afterwards go through the machine list like any other computer.
 */
/** Every open window, skipping one that is closing right now (the next send reaches the rest). */
function sendToAllWindows(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Closing mid-send.
    }
  }
}

/** Set while the app is up: re-asks ADE Cloud's access after a sign-in or sign-out. */
let recheckCloudAccess: (() => void) | null = null;

/** The ADE account on this computer changed: ask the server again, and tell every window if the answer moved. */
export function cloudAccountChanged(): void {
  recheckCloudAccess?.();
}

export function registerCloudIpc(args: {
  vaultBridge: Parameters<typeof cloudVaultFromBridge>[0];
  listAccountMachines: () => Promise<AdeAccountMachinesResult>;
  renameMachine: (machineKey: string, name: string) => Promise<unknown>;
  /** Takes a machine off the ADE account (what Delete box does once the box is gone). */
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  /** Forgets this desktop's saved connections to a machine a move deleted (the remote connection service). */
  forgetMachineConnections?: (machine: { machineKey: string | null; instanceId: string }) => void;
  /** Ready machines: the per-project switch, each prepare's outcome, picker claims (analytics; coarse outcome only). */
  recordReady?: (outcome: "enabled" | "disabled" | "completed" | "failed" | "ready_picker") => void;
  /** One coarse product fact per finished create (analytics; never the box or the error). */
  recordMachineCreate?: (outcome: "completed" | "partial" | "cancelled" | "failed") => void;
  /** One coarse product fact per box action that worked (analytics; never the box). */
  recordMachineAction?: (action: CloudMachineActionKind | "copy" | "move" | "reconnect" | "push_all_work") => void;
  /** One coarse fact per plan decision (analytics; never an amount). */
  recordPlan?: (outcome: "plan_checkout" | "plan_portal" | "extra_on" | "extra_off") => void;
  /**
   * A `cloud` action on this computer's brain. Sign-ins for cloud machines
   * run there: a PTY can't start from this process in a packaged app.
   */
  brainAction: (action: string, actionArgs?: Record<string, unknown>) => Promise<unknown>;
  logger: Logger;
}): {
  machineCreatorDeps: CloudMachineCreatorDeps;
  machines: ReturnType<typeof createCloudMachines>;
  copyDeps: CloudCopyDeps;
  client: () => Promise<CloudProvider>;
} {
  const { logger } = args;
  const account = () => getSharedAccountAuthService();
  let machineStore: EncryptedFileCredentialStore | null = null;
  const getMachineStore = () => (machineStore ??= new EncryptedFileCredentialStore({ secretsDir: resolveMachineAdeLayout().secretsDir }));
  const getAccountToken = () => getSignedInAccountAccessToken(account());
  const credentials: CloudAccessDeps = cloudAccessDepsFor({
    account,
    directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl(),
    deviceName: () => hostname(),
    runningVersion: () => app.getVersion(),
    logger,
    onDirectoryUnavailable: (error) => logger.warn("cloud.account_directory_unavailable", { error: getErrorMessage(error) }),
  });
  const directoryBaseUrl = credentials.directoryBaseUrl;

  // The one answer that decides whether ADE Cloud exists in this app. No poll:
  // asked when a window opens or takes focus, and on a sign-in or sign-out;
  // its cache keeps that to the server at most every 10 minutes.
  let lastAccess: boolean | null = null;
  const readAccess = async (): Promise<boolean> => {
    const enabled = await cloudAccessEnabled(credentials).catch((error: unknown) => {
      logger.warn("cloud.access_read_failed", { error: getErrorMessage(error) });
      return false;
    });
    if (lastAccess !== null && lastAccess !== enabled) sendToAllWindows(IPC.cloudStatusChanged);
    lastAccess = enabled;
    return enabled;
  };
  recheckCloudAccess = () => void readAccess();
  watchCloudAccessForSkills(credentials);

  const pendingCreates = createCloudPendingCreateStore(getMachineStore, logger);
  // Read now, before any create of this session can add to it.
  const leftoverCreates = pendingCreates.list();
  // Off the boot path: delete any machine a quit left half-made.
  const startupTimer = setTimeout(() => {
    // Which machines are cloud computers, so wake and rest work before anyone
    // opens the Connections pane. Nothing is read without ADE Cloud access.
    void machines.loadKnownMachines();
    void (async () => {
      if (!leftoverCreates.length) return;
      const provider = await getCloudProvider(credentials);
      if (provider) await sweepCloudPendingCreates(provider, leftoverCreates, pendingCreates, logger);
    })().catch((error: unknown) => logger.warn("cloud.startup_check_failed", { error: getErrorMessage(error) }));
  }, STARTUP_CHECK_DELAY_MS);
  startupTimer.unref?.();

  // Sign-ins for cloud machines (cloudSignInActions.ts): kept in the
  // account, given to every new machine, and run on this computer's brain.
  // Account-wide, so no pin: the brain here is the one with this browser.
  const cloudSignInVaults: CloudSignInVaults = (vaultKey) =>
    (credentials.signedIn() ? cloudVaultFromBridge(args.vaultBridge, vaultKey) : null);
  const cloudSignIn = async (action: string, actionArgs?: Record<string, unknown>): Promise<CloudSignInStatus> => {
    const status = await args.brainAction(action, actionArgs) as CloudSignInStatus;
    // Every window shows the card; the one that acted already has the answer.
    if (action !== "cloud_sign_in_status") sendToAllWindows(IPC.cloudSignInChanged);
    return status;
  };
  const cloudSignInHandlers: Array<[string, string, (arg: Record<string, unknown> | undefined) => Record<string, unknown> | undefined]> = [
    [IPC.cloudSignInStatus, "cloud_sign_in_status", () => undefined],
    [IPC.cloudSignInClaudeStart, "cloud_sign_in_start", () => undefined],
    [IPC.cloudSignInClaudeCode, "cloud_sign_in_code", (arg) => ({ code: typeof arg?.code === "string" ? arg.code : "" })],
    [IPC.cloudSignInClaudeCancel, "cloud_sign_in_cancel", () => undefined],
    [IPC.cloudSignInSaveKey, "cloud_sign_in_save_key", (arg) => ({ id: arg?.id, key: arg?.key })],
    [IPC.cloudSignInRemove, "cloud_sign_in_remove", (arg) => ({ id: arg?.id })],
  ];
  for (const [channel, action, toArgs] of cloudSignInHandlers) {
    ipcMain.handle(channel, async (event, arg?: Record<string, unknown>): Promise<CloudSignInStatus | null> => {
      if (!isTrustedAdeRendererSenderOrWarn(event, logger, channel)) return null;
      return await cloudSignIn(action, toArgs(arg));
    });
  }

  const machineCreatorDeps: CloudMachineCreatorDeps = {
    client: () => requireCloudProvider(credentials),
    getAccountToken,
    directoryBaseUrl,
    listAccountMachines: args.listAccountMachines,
    renameMachine: args.renameMachine,
    approveInWindow: (window) => openCloudApprovalWindow(window, logger),
    machineEnv: () => cloudMachineEnv(cloudSignInVaults, logger),
    minAdeVersion: releasedAdeVersion,
    pendingCreates,
    logger,
  };

  const agentLimits = createCloudAgentLimitsStore({
    vault: () => (credentials.signedIn() ? cloudVaultFromBridge(args.vaultBridge, CLOUD_AGENT_LIMITS_VAULT_KEY) : null),
    machineStore: getMachineStore,
    logger,
  });

  const savedClient = () => getCloudProvider(credentials);

  // Ready machines: prepared here (the sign-in needs this app's window),
  // claimed here or by any brain. The choice is the account's.
  const readyKeeper = createCloudReadyKeeper({
    client: savedClient,
    settings: createCloudReadySettingsStore({
      vault: () => (credentials.signedIn() ? cloudVaultFromBridge(args.vaultBridge, CLOUD_READY_VAULT_KEY) : null),
      machineStore: getMachineStore,
      logger,
    }),
    createMachine: (requestId, machine, onProgress, options) =>
      createCloudMachine(machineCreatorDeps, requestId, machine, onProgress, options),
    removeAccountMachine: args.removeAccountMachine,
    // This computer and this app's data folder: a development copy beside the installed one is another preparer.
    preparerId: readyPreparerId(logger),
    currentAdeVersion: releasedAdeVersion,
    // Declared below; first called after the startup delay.
    account: () => machines.account(),
    onStatus: (status) => sendToAllWindows(IPC.cloudReadyStatusChanged, status),
    onPrepared: (outcome) => args.recordReady?.(outcome),
    logger,
  });
  // After the template check, off the boot path; it reads every couple of minutes only while a project is on.
  readyKeeper.start(STARTUP_CHECK_DELAY_MS + 10_000);
  // A prepare cut short by a quit deletes its machine on the way out (best
  // effort); what a quit still leaves, this copy deletes at its next start.
  app.once("will-quit", () => readyKeeper.stop());

  const machines = createCloudMachines({
    whyNoClient: () => cloudNoProviderSentence(credentials),
    client: savedClient,
    // A miss refreshes the known computers only on a known yes to access.
    knownClient: () => knownCloudProvider(credentials),
    removeAccountMachine: args.removeAccountMachine,
    logger,
  });
  // Off the list this asks nothing: access is read at sign-in and on focus only.
  startCloudSleepWatch({ client: async () => knownCloudProvider(credentials), logger, firstPassDelayMs: STARTUP_CHECK_DELAY_MS + 30_000 });
  // Remote connections wake a sleeping box the person is about to use. Only a
  // machine known as a cloud box is looked up (`knowsBox`: at most one bounded
  // read for an unknown one), so a Connect to a laptop barely waits.
  setCloudWakeForUse(async (target) => {
    const machineKey = target.pairedMachine?.machineKey?.trim();
    if (!machineKey || !(await machines.knowsBox(machineKey))) return false;
    const client = await savedClient().catch(() => null);
    if (!client) return false;
    const result = await wakeCloudMachineForUse(client, { machineKey, hostname: target.hostname }, { logger }).catch((error: unknown) => {
      logger.warn("cloud.wake_for_use_failed", { error: getErrorMessage(error) });
      return null;
    });
    if (!result) return false;
    if (result.state === "refused") throw new Error(result.message);
    if (result.state === "woken") sendToAllWindows(IPC.cloudStatusChanged);
    return result.state === "woken";
  });

  // A call to a sleeping computer times out on a relay tunnel that still looks
  // open. One bounded read of the account's computers says whether that is why.
  setCloudAsleepCheck((target) => {
    const machineKey = target.pairedMachine?.machineKey?.trim();
    if (!machineKey) return null;
    return (async () => {
      // Not a cloud computer: null, so the caller takes the normal failure path.
      if (!(await machines.knowsBox(machineKey))) return null;
      // A read `knowsBox` just made is fresh enough: no second read in a row.
      let instances = machines.recentInstances(5_000);
      if (!instances) {
        const client = await savedClient();
        if (!client) return false;
        instances = await Promise.race([
          client.listInstances(),
          new Promise<null>((resolve) => { setTimeout(() => resolve(null), 5_000).unref?.(); }),
        ]);
      }
      const instance = instances ? cloudInstanceForMachine(instances, machineKey, target.hostname) : null;
      if (!instance) return false;
      const state = cloudMachineState(instance.status);
      return state === "asleep" || state === "stopped" || state === "stopping";
    })().catch((error: unknown) => {
      logger.warn("cloud.asleep_check_failed", { error: getErrorMessage(error) });
      return false;
    });
  });

  // A rest starts or ends with no cloud action and no wake, so nothing else
  // tells the windows: a gate shown while the computer was awake kept saying
  // "running". One event per change; the windows read the list again.
  setCloudRestChanged(() => sendToAllWindows(IPC.cloudStatusChanged));

  // A computer whose ADE start script can't restart on an update would install
  // the update and keep running the old ADE. Asked before the update goes out,
  // so the card says so at once and points at Update this computer.
  setCloudUpdateBlocker(async (target) => {
    const machineKey = target.pairedMachine?.machineKey?.trim();
    if (!machineKey || !(await machines.knowsBox(machineKey))) return null;
    let probe: { exitCode: number } | null = null;
    let instance: ReturnType<typeof cloudInstanceForMachine> = null;
    try {
      const client = await savedClient();
      if (!client) return null;
      instance = cloudInstanceForMachine(await client.listInstances(), machineKey, target.hostname);
      if (!instance || instance.status !== "running") return null;
      probe = await client.exec(instance.id, CLOUD_ENTRYPOINT_SUPERVISOR_PROBE, { timeoutMs: 15_000 });
    } catch (error) {
      // Unknown is not "blocked": the update goes out, and the computer's own
      // ADE refuses it there if it can't take it.
      logger.warn("cloud.update_blocker_check_failed", { error: getErrorMessage(error) });
      return null;
    }
    if (probe.exitCode !== 1) return null;
    logger.info("cloud.update_blocked_needs_update", { instanceId: instance.id });
    return "This computer needs updating before ADE can update it. Choose Update this computer in its menu.";
  });

  // Account-level, so no pin: every computer answers the same for this account.
  ipcMain.handle(IPC.cloudGetAccess, async (event): Promise<{ enabled: boolean }> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudGetAccess)) return { enabled: false };
    return { enabled: await readAccess() };
  });

  ipcMain.handle(IPC.cloudGetStatus, async (event): Promise<CloudStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudGetStatus)) return null;
    return await readCloudStatus(credentials);
  });

  ipcMain.handle(IPC.cloudListMachines, async (event): Promise<CloudMachinesResult | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudListMachines)) return null;
    return await machines.list();
  });

  ipcMain.handle(IPC.cloudMachineAction, async (event, arg: CloudMachineActionArgs): Promise<CloudMachineActionResult | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudMachineAction)) return null;
    const result = await machines.run(arg);
    if (result.ok) {
      args.recordMachineAction?.(arg.action);
      // The box count moved: Settings and the picker read again.
      sendToAllWindows(IPC.cloudStatusChanged);
    }
    return result;
  });

  ipcMain.handle(IPC.cloudGetAgentLimits, async (event): Promise<CloudAgentLimits | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudGetAgentLimits)) return null;
    return await agentLimits.read();
  });

  ipcMain.handle(IPC.cloudSetAgentLimits, async (event, arg: { limits?: Partial<CloudAgentLimits> }): Promise<CloudAgentLimits | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSetAgentLimits)) return null;
    const current = await agentLimits.read();
    const saved = await agentLimits.write({ ...current, ...(arg?.limits ?? {}) });
    logger.info("cloud.agent_limits_set", { unattendedSpend: saved.unattendedSpend, machinesPerDay: saved.machinesPerDay });
    sendToAllWindows(IPC.cloudStatusChanged);
    return saved;
  });

  /** The server's one sentence, so the renderer shows it without an error class name in front. */
  const billingCall = async <T,>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  };

  // Account-level like the rest of this file: the plan is the account's, so no pin.
  ipcMain.handle(IPC.cloudSetExtraHours, async (event, arg: { enabled?: unknown }): Promise<CloudAccountState | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSetExtraHours)) return null;
    const account = await billingCall(async () => (await requireCloudProvider(credentials)).setExtraHours(arg?.enabled === true));
    logger.info("cloud.extra_hours_set", { enabled: arg?.enabled === true });
    if (account) args.recordPlan?.(arg?.enabled === true ? "extra_on" : "extra_off");
    sendToAllWindows(IPC.cloudStatusChanged);
    return account;
  });

  // Account-level: extra disk is the account's, shared by all its computers, so no pin.
  ipcMain.handle(IPC.cloudSetExtraDisk, async (event, arg: { enabled?: unknown; monthlyLimitUsd?: unknown }): Promise<CloudAccountState | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSetExtraDisk)) return null;
    const limit = arg?.monthlyLimitUsd;
    const choice = arg?.enabled === true
      ? { enabled: true as const, monthlyLimitUsd: typeof limit === "number" && Number.isInteger(limit) ? limit : 0 }
      : { enabled: false as const };
    const account = await billingCall(async () => (await requireCloudProvider(credentials)).setExtraDisk(choice));
    logger.info("cloud.extra_disk_set", { enabled: choice.enabled });
    sendToAllWindows(IPC.cloudStatusChanged);
    return account;
  });

  /**
   * Opens Stripe's checkout for a plan in the person's browser. On a paid
   * account asking for its other plan, the server changes the plan itself
   * and nothing opens. Account-level, so no pin.
   */
  ipcMain.handle(IPC.cloudOpenCheckout, async (event, arg?: { plan?: unknown }): Promise<CloudOpenCheckoutResult> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudOpenCheckout)) return { opened: false };
    const plan = arg?.plan === "pro" || arg?.plan === "plus" ? arg.plan : undefined;
    const result = await billingCall(async () => (await requireCloudProvider(credentials)).billingCheckout(plan));
    if (result.url == null) {
      logger.info("cloud.plan_changed", { change: result.change });
      sendToAllWindows(IPC.cloudStatusChanged);
      return { opened: false, change: result.change };
    }
    await openExternalUrl(result.url);
    args.recordPlan?.("plan_checkout");
    return { opened: true };
  });

  // "Still watching": the window is in front and the person moved or typed
  // lately. The system's idle time covers what the renderer can't see (a
  // browser view, a remote desktop); a window in front keeps it about this app.
  ipcMain.handle(IPC.cloudPersonIsHere, (event): boolean => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudPersonIsHere)) return false;
    const window = BrowserWindow.fromWebContents(event.sender);
    return Boolean(window?.isFocused()) && powerMonitor.getSystemIdleTime() < PERSON_ACTIVE_WITHIN_S;
  });

  ipcMain.handle(IPC.cloudPushAllWork, async (event, arg: { instanceId?: unknown }): Promise<CloudMachineActionResult> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudPushAllWork)) return { ok: false, blocker: null, message: "ADE can't do that from here." };
    const instanceId = typeof arg?.instanceId === "string" ? arg.instanceId.trim() : "";
    if (!isCloudInstanceId(instanceId)) return { ok: false, blocker: null, message: "ADE doesn't know that computer." };
    const result = await machines.pushAllWork(instanceId);
    if (result.ok) args.recordMachineAction?.("push_all_work");
    sendToAllWindows(IPC.cloudStatusChanged);
    return result;
  });

  ipcMain.handle(IPC.cloudOpenBillingPortal, async (event): Promise<{ opened: boolean }> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudOpenBillingPortal)) return { opened: false };
    const { url } = await billingCall(async () => (await requireCloudProvider(credentials)).billingPortal());
    await openExternalUrl(url);
    args.recordPlan?.("plan_portal");
    return { opened: true };
  });

  /** A project's identity from the renderer, normalized like every stored one. */
  const requireReadyIdentity = (value: unknown): string => {
    const identity = normalizeGitRemoteIdentity(typeof value === "string" ? value : null);
    if (!identity) throw new Error("Which project?");
    return identity;
  };

  ipcMain.handle(IPC.cloudReadyStatus, async (event): Promise<CloudReadyStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudReadyStatus)) return null;
    return await readyKeeper.refresh();
  });

  ipcMain.handle(IPC.cloudReadySetProject, async (event, arg: { settings?: Partial<CloudReadyProjectSettings> }): Promise<CloudReadyStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudReadySetProject)) return null;
    const wasOn = readyKeeper.status().projects.some((project) => project.settings.identity === normalizeGitRemoteIdentity(arg?.settings?.identity));
    const status = await readyKeeper.setProject(arg?.settings ?? {});
    if (!wasOn) args.recordReady?.("enabled");
    return status;
  });

  ipcMain.handle(IPC.cloudReadyRemoveProject, async (event, arg: { identity?: unknown }): Promise<CloudReadyStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudReadyRemoveProject)) return null;
    const status = await readyKeeper.removeProject(requireReadyIdentity(arg?.identity));
    args.recordReady?.("disabled");
    return status;
  });

  ipcMain.handle(IPC.cloudReadyRetry, async (event, arg: { identity?: unknown }): Promise<CloudReadyStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudReadyRetry)) return null;
    return await readyKeeper.retry(requireReadyIdentity(arg?.identity));
  });

  ipcMain.handle(IPC.cloudReadyClaim, async (event, arg: { originUrl?: unknown }): Promise<CloudReadyClaim | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudReadyClaim)) return null;
    const identity = normalizeGitRemoteIdentity(typeof arg?.originUrl === "string" ? arg.originUrl : null);
    if (!identity) throw new Error("This project has no git origin, so it has no ready machine.");
    const claim = await claimCloudReadyMachine(await requireCloudProvider(credentials), identity, { logger });
    args.recordReady?.("ready_picker");
    // The pool is one short: make the next one.
    void readyKeeper.refresh();
    sendToAllWindows(IPC.cloudStatusChanged);
    return claim;
  });

  ipcMain.handle(IPC.cloudReadyRelease, async (event, arg: { instanceId?: unknown; claimToken?: unknown }): Promise<{ released: boolean } | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudReadyRelease)) return null;
    const instanceId = typeof arg?.instanceId === "string" ? arg.instanceId.trim() : "";
    const claimToken = typeof arg?.claimToken === "string" ? arg.claimToken : "";
    if (!isCloudInstanceId(instanceId) || !claimToken) return { released: false };
    const released = await releaseCloudReadyMachine(await requireCloudProvider(credentials), instanceId, claimToken, { logger });
    if (released) void readyKeeper.refresh();
    return { released };
  });

  const creates = new Map<string, AbortController>();

  const copyDeps: CloudCopyDeps = {
    ...machineCreatorDeps,
    removeAccountMachine: args.removeAccountMachine,
    // Every move this desktop runs (its menu, and the CLI or an agent over the
    // desktop bridge) forgets the deleted source's connection here.
    ...(args.forgetMachineConnections ? { forgetMachineConnections: args.forgetMachineConnections } : {}),
  };
  // The CLI and agents make, copy and move machines through this app (the
  // new machine signs in through its approval window), over the desktop bridge.
  setCloudDesktopActions({
    create: async (machine) => {
      const { madeByChat, ...shape } = machine;
      const result = await createCloudMachine(machineCreatorDeps, randomUUID(), shape, () => undefined, {
        ...(madeByChat ? { metadata: { [CLOUD_MADE_BY_CHAT_METADATA]: madeByChat } } : {}),
      });
      args.recordMachineCreate?.(result.joined ? "completed" : "partial");
      sendToAllWindows(IPC.cloudStatusChanged);
      return result;
    },
    copy: async (input) => {
      const result = await copyCloudMachine(copyDeps, input, () => undefined);
      sendToAllWindows(IPC.cloudStatusChanged);
      return result;
    },
    move: async (input) => {
      const result = await moveCloudMachine(copyDeps, input, () => undefined);
      sendToAllWindows(IPC.cloudStatusChanged);
      return result;
    },
    readyRefresh: () => readyKeeper.refresh(),
  });

  /**
   * A copy or move from the machine card: answers at once and reports like a
   * create (`cloudCreateProgress`, ending in done or failed), since a fork
   * or a move runs for minutes. Stopped when the window that asked goes away.
   */
  const startLongAction = (
    event: Electron.IpcMainInvokeEvent,
    requestId: string,
    run: (signal: AbortSignal, send: (progress: CloudCreateProgress) => void) => Promise<{ message: string; result?: CloudCreateProgress["result"] }>,
  ) => {
    if (creates.has(requestId)) return { started: true };
    const sender = event.sender;
    const controller = new AbortController();
    creates.set(requestId, controller);
    const onSenderGone = () => controller.abort();
    sender.once("destroyed", onSenderGone);
    const send = (progress: CloudCreateProgress) => {
      if (sender.isDestroyed()) return;
      try {
        sender.send(IPC.cloudCreateProgress, { ...progress, requestId });
      } catch {
        // The window closed mid-action.
      }
    };
    void run(controller.signal, send).then(
      (done) => send({ requestId, stage: "done", message: done.message, ...(done.result ? { result: done.result } : {}) }),
      (error: unknown) => {
        const message = getErrorMessage(error);
        logger.warn("cloud.long_action_failed", { error: message });
        send({ requestId, stage: "failed", message, error: message });
      },
    ).finally(() => {
      creates.delete(requestId);
      if (!sender.isDestroyed()) sender.removeListener("destroyed", onSenderGone);
      sendToAllWindows(IPC.cloudStatusChanged);
    });
    return { started: true };
  };

  ipcMain.handle(IPC.cloudCopyMachine, async (event, arg: { requestId?: unknown; instanceId?: unknown; name?: unknown; shape?: unknown }) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudCopyMachine)) return { started: false };
    const instanceId = typeof arg?.instanceId === "string" ? arg.instanceId.trim() : "";
    if (!isCloudInstanceId(instanceId)) throw new Error("ADE doesn't know that computer.");
    const requestId = typeof arg?.requestId === "string" && arg.requestId ? arg.requestId : randomUUID();
    return startLongAction(event, requestId, async (signal, send) => {
      const result = await copyCloudMachine(copyDeps, {
        instanceId,
        requestId,
        name: typeof arg?.name === "string" ? arg.name : null,
        shape: typeof arg?.shape === "string" ? arg.shape as CloudShapeId : null,
      }, send, { signal });
      args.recordMachineAction?.("copy");
      return { message: `${result.name} is ready: a copy with the same files.`, result };
    });
  });

  ipcMain.handle(IPC.cloudMoveMachine, async (event, arg: { requestId?: unknown; instanceId?: unknown; machineKey?: unknown; to?: unknown; shape?: unknown }) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudMoveMachine)) return { started: false };
    const instanceId = typeof arg?.instanceId === "string" ? arg.instanceId.trim() : "";
    if (!isCloudInstanceId(instanceId)) throw new Error("ADE doesn't know that computer.");
    if (arg?.to !== "vm" && arg?.to !== "box") throw new Error("Move it to a standard or a full computer.");
    const to = arg.to;
    const requestId = typeof arg?.requestId === "string" && arg.requestId ? arg.requestId : randomUUID();
    return startLongAction(event, requestId, async (signal, send) => {
      const result = await moveCloudMachine(copyDeps, {
        instanceId,
        requestId,
        to,
        machineKey: typeof arg?.machineKey === "string" ? arg.machineKey : null,
        shape: typeof arg?.shape === "string" ? arg.shape as CloudShapeId : null,
      }, send, { signal });
      args.recordMachineAction?.("move");
      return {
        message: result.sourceDeleted
          ? `${result.name} is now a ${cloudKindLabel(to)}, with all its files.`
          : `${result.name} has all its files on the new ${cloudKindLabel(to)}. ADE couldn't delete the old one; delete it from its card.`,
        result,
      };
    });
  });

  ipcMain.handle(IPC.cloudReconnectMachine, async (event, arg: { requestId?: unknown; instanceId?: unknown }) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudReconnectMachine)) return { started: false };
    const instanceId = typeof arg?.instanceId === "string" ? arg.instanceId.trim() : "";
    if (!isCloudInstanceId(instanceId)) throw new Error("ADE doesn't know that computer.");
    const requestId = typeof arg?.requestId === "string" && arg.requestId ? arg.requestId : randomUUID();
    return startLongAction(event, requestId, async (signal, send) => {
      const result = await reconnectCloudMachine(machineCreatorDeps, { instanceId, requestId }, send, { signal });
      args.recordMachineAction?.("reconnect");
      return {
        message: result.joined ? `${result.name} is back in ADE.` : `${result.name} is signed in again. It shows up in a minute.`,
        result,
      };
    });
  });

  ipcMain.handle(IPC.cloudCancelCreate, async (event, arg: { requestId?: unknown }): Promise<{ cancelled: boolean }> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudCancelCreate)) return { cancelled: false };
    const controller = typeof arg?.requestId === "string" ? creates.get(arg.requestId) : undefined;
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  });

  ipcMain.handle(
    IPC.cloudCreateMachine,
    async (event, arg: { requestId?: unknown; machine?: CloudCreateMachineArgs }): Promise<{ started: boolean }> => {
      if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudCreateMachine)) return { started: false };
      const requestId = typeof arg?.requestId === "string" && arg.requestId ? arg.requestId : randomUUID();
      if (creates.has(requestId)) return { started: true };
      const sender = event.sender;
      const controller = new AbortController();
      creates.set(requestId, controller);
      // The window that asked went away (closed, reloaded): nobody is waiting
      // for this box, so stop and delete it rather than leave it using hours.
      const onSenderGone = () => controller.abort();
      sender.once("destroyed", onSenderGone);
      const send = (progress: CloudCreateProgress) => {
        if (sender.isDestroyed()) return;
        try {
          sender.send(IPC.cloudCreateProgress, progress);
        } catch {
          // The window closed mid-create; the abort above cleans up.
        }
      };
      void createCloudMachine(
        machineCreatorDeps,
        requestId,
        arg?.machine as CloudCreateMachineArgs,
        send,
        { signal: controller.signal },
      ).then(
        (result) => {
          args.recordMachineCreate?.(result.joined ? "completed" : "partial");
          send({
          requestId,
          stage: "done",
          message: result.joined
            ? result.renamed
              ? `${result.name} is ready.`
              : `Your new machine is ready. ADE couldn't name it "${result.name}"; rename it from its row under Your computers.`
            : result.machineKey
              ? cloudStillStartingMessage(result.name)
              : `${result.name} is signed in but still starting. It will appear under Your computers; connect it from there when it's ready.`,
          instanceId: result.instanceId,
          result,
          });
        },
        (error: unknown) => {
          const message = getErrorMessage(error);
          args.recordMachineCreate?.(controller.signal.aborted ? "cancelled" : "failed");
          logger.warn("cloud.create_machine_failed", { error: message });
          send({ requestId, stage: "failed", message, error: message });
        },
      ).finally(() => {
        creates.delete(requestId);
        if (!sender.isDestroyed()) sender.removeListener("destroyed", onSenderGone);
        // A box was made (or made and deleted): the machine list reads again.
        sendToAllWindows(IPC.cloudStatusChanged);
      });
      return { started: true };
    },
  );

  // The ADE Cloud lane launch makes its computer with these same pieces.
  return { machineCreatorDeps, machines, copyDeps, client: () => requireCloudProvider(credentials) };
}

/** This app's ADE release, or null for a development build (whose version may not be published). */
function releasedAdeVersion(): string | null {
  if (!app.isPackaged) return null;
  if (normalizeAppPackageChannel(process.env.ADE_PACKAGE_CHANNEL) === "alpha") return null;
  const version = app.getVersion().trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

/**
 * This copy of ADE as a preparer of ready machines: a random id kept in its
 * own data folder, so it survives restarts and a hostname change, and a
 * development copy beside the installed one (another data folder) is another
 * preparer. Unreadable or unwritable, it is a fresh id for this run: then a
 * leftover is cleaned up as stale instead of at once.
 */
function readyPreparerId(logger: Logger): string {
  const file = path.join(app.getPath("userData"), "cloud-ready-preparer-id");
  try {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (/^[a-z0-9-]{8,64}$/.test(saved)) return saved;
  } catch {
    // None yet.
  }
  const id = randomUUID();
  try {
    fs.writeFileSync(file, id, { mode: 0o600 });
  } catch (error) {
    logger.warn("cloud.ready_preparer_id_not_saved", { error: getErrorMessage(error) });
  }
  return id;
}

/** Long enough that the boot path, the brain and the vault are settled first. */
/** Moved or typed within this long counts as here, for "still watching". */
const PERSON_ACTIVE_WITHIN_S = 3 * 60;

const STARTUP_CHECK_DELAY_MS = 20_000;

/**
 * Exits 0 when the box's entrypoint supervises the brain so that an update can
 * restart it on the new ADE (infra/ade-cloud/template/ade-entrypoint.sh), 1 when
 * it is an older ADE entrypoint, 2 when the box has no ADE entrypoint at all.
 */
const CLOUD_ENTRYPOINT_SUPERVISOR_PROBE = "grep -q 'ADE_BRAIN_SUPERVISOR=entrypoint' /usr/local/bin/ade-entrypoint.sh";
