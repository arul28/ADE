import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain, powerMonitor } from "electron";
import {
  cloudKindLabel,
  cloudMadeByMetadata,
  type CloudAccountState,
  type CloudAgentLimits,
  type CloudShapeId,
  isCloudInstanceId,
  cloudMachineState,
  type CloudCreateProgress,
  type CloudMachineActionArgs,
  type CloudMachineActionKind,
  type CloudMachineActionResult,
  type CloudMachinesResult,
  type CloudOpenCheckoutResult,
  type CloudStatus,
  type CloudInviteRedeemOutcome,
} from "../../../shared/adeCloud";
import { type CloudSignInStatus } from "../../../shared/cloudSignIns";
import { IPC } from "../../../shared/ipc";
import { readCloudSignInEnd, type CloudSignInEndList, type CloudSignInSettingRead } from "./cloudSignInEndWarning";
import type { CloudSignInEnd } from "../../../shared/cloudSignIns";
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
import { setCloudAsleepCheck, setCloudRestChanged, setCloudUpdateBlocker, setCloudWakeForUse } from "./cloudWakeHook";
import { startCloudSleepWatch } from "./cloudSleepWatch";
import { setCloudDesktopActions } from "./cloudDesktopActions";
import { copyCloudMachine, moveCloudMachine, type CloudCopyDeps } from "./cloudMachineCopy";
import { reconnectCloudMachine } from "./cloudReconnect";
import { sendToAllWindows } from "./broadcast";
import {
  CLOUD_AGENT_LIMITS_VAULT_KEY,
  createCloudAgentLimitsStore,
  cloudInstanceForMachine,
  wakeCloudMachineForUse,
} from "./cloudSleep";
import { openExternalUrl } from "../shared/externalLinks";
import { getErrorMessage } from "../shared/utils";
import { normalizeAppPackageChannel } from "../../../shared/packageChannel";
import { createCloudPendingCreateStore, sweepCloudPendingCreates } from "./cloudPendingCreates";
import { createLaneFollower } from "./cloudLaneFollow";
import type { MachineConnector } from "../machines/machineConnector";

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

/** Set while the app is up: re-asks ADE Cloud's access after a sign-in or sign-out. */
let recheckCloudAccess: (() => void) | null = null;

/** The ADE account on this computer changed: ask the server again, and tell every window if the answer moved. */
export function cloudAccountChanged(): void {
  recheckCloudAccess?.();
}

export function registerCloudIpc(args: {
  /** `list` reads the account's pass store for the end warning (`cloudSignInEndWarning.ts`). */
  vaultBridge: Parameters<typeof cloudVaultFromBridge>[0] & { list?: CloudSignInEndList };
  /** The account setting `providerLogins.cloud`, for the end warning's keys (only keys on for ADE Cloud). */
  readCloudSignInSetting?: CloudSignInSettingRead;
  listAccountMachines: () => Promise<AdeAccountMachinesResult>;
  renameMachine: (machineKey: string, name: string) => Promise<unknown>;
  /** Takes a machine off the ADE account (what Delete box does once the box is gone). */
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  /** Forgets this desktop's saved connections to a machine a move deleted (the remote connection service). */
  forgetMachineConnections?: (machine: { machineKey: string | null; instanceId: string }) => void;
  /** Contract C2: reaches any machine of the account by key (`machines/machineConnector.ts`). */
  machineConnector?: () => MachineConnector | null;
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
  // The end warning's fact (`cloudSignInEndWarning.ts`), from the local pass store, only
  // while ADE Cloud is on. A window asks on open and on focus, so one answer
  // serves a minute; a pass write here (an approve, a remove) drops it at once.
  const SIGN_IN_END_FRESH_MS = 60_000;
  let signInEndMemo: { at: number; value: CloudSignInEnd | null } | null = null;
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
  // account vault, which each cloud computer's brain reads, and run on this
  // computer's brain. Account-wide, so no pin: the brain here is the one with this browser.
  const cloudSignIn = async (action: string, actionArgs?: Record<string, unknown>): Promise<CloudSignInStatus> => {
    const status = await args.brainAction(action, actionArgs) as CloudSignInStatus;
    // Every window shows the card; the one that acted already has the answer.
    if (action !== "cloud_sign_in_status") {
      signInEndMemo = null;
      sendToAllWindows(IPC.cloudSignInChanged);
    }
    return status;
  };
  const shortString = (value: unknown): string | null =>
    (typeof value === "string" && value.length <= 320 ? value : null);
  const cloudSignInHandlers: Array<[string, string, (arg: Record<string, unknown> | undefined) => Record<string, unknown> | undefined]> = [
    [IPC.cloudSignInStatus, "cloud_sign_in_status", () => undefined],
    // Only short strings pass; the action checks the email shape and that a
    // Renew names a pass of this account.
    [IPC.cloudSignInClaudeStart, "cloud_sign_in_start", (arg) => ({
      forEmail: shortString(arg?.forEmail),
      renewKey: shortString(arg?.renewKey),
      labelEmail: shortString(arg?.labelEmail),
    })],
    [IPC.cloudSignInClaudeCode, "cloud_sign_in_code", (arg) => ({ code: typeof arg?.code === "string" ? arg.code : "" })],
    [IPC.cloudSignInClaudeKeep, "cloud_sign_in_keep", () => undefined],
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


  // Contract C3: a lane follows its computer (cloudLaneFollow.ts). It reads
  // nothing of its own: every good read of the account's computers reaches it.
  let readMachinesNow: () => Promise<boolean> = async () => false;
  const laneFollower = createLaneFollower({
    readNow: () => readMachinesNow(),
    connector: () => args.machineConnector?.() ?? null,
    forgetMachine: (machine) => args.forgetMachineConnections?.(machine),
    statePath: path.join(app.getPath("userData"), "cloud-lane-computers.json"),
    emit: (move) => sendToAllWindows(IPC.cloudLaneMoved, move),
    logger,
  });
  const machines = createCloudMachines({
    whyNoClient: () => cloudNoProviderSentence(credentials),
    client: savedClient,
    // A miss refreshes the known computers only on a known yes to access.
    knownClient: () => knownCloudProvider(credentials),
    removeAccountMachine: args.removeAccountMachine,
    onInstancesRead: (instances) => laneFollower.note(instances),
    logger,
  });
  readMachinesNow = async () => (await machines.list()).state === "ok";
  ipcMain.handle(IPC.cloudLaneComputer, async (event, raw: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudLaneComputer)) return null;
    const laneId = raw && typeof raw === "object" && typeof (raw as { laneId?: unknown }).laneId === "string" ? (raw as { laneId: string }).laneId : "";
    return await laneFollower.laneComputer(laneId);
  });
  ipcMain.handle(IPC.cloudFollowLane, async (event, raw: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudFollowLane)) throw new Error("ADE can't do that from here.");
    const request = raw && typeof raw === "object" ? raw as { laneId?: unknown; connect?: unknown } : {};
    return await laneFollower.follow(typeof request.laneId === "string" ? request.laneId : "", { connect: request.connect !== false });
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

  const readSignInEnd = async (): Promise<CloudSignInEnd | null> => {
    const list = args.vaultBridge.list?.bind(args.vaultBridge);
    if (!list || !credentials.signedIn()) return null;
    const now = Date.now();
    if (signInEndMemo && now - signInEndMemo.at < SIGN_IN_END_FRESH_MS) return signInEndMemo.value;
    const value = await readCloudSignInEnd(list, { now, readSetting: args.readCloudSignInSetting, logger }).catch((error: unknown) => {
      logger.warn("cloud.pass_end_read_failed", { error: getErrorMessage(error) });
      return null;
    });
    signInEndMemo = { at: now, value };
    return value;
  };

  // Account-level, so no pin: every computer answers the same for this account.
  ipcMain.handle(IPC.cloudGetAccess, async (event): Promise<{ enabled: boolean; signInEnd?: CloudSignInEnd | null }> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudGetAccess)) return { enabled: false };
    const enabled = await readAccess();
    // Off: no pass read at all.
    if (!enabled) return { enabled };
    return { enabled, signInEnd: await readSignInEnd() };
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

  // Account-level, so no pin: an account has one referrer, whichever computer asks.
  // The invite link itself rides the account read (`CloudAccountState.referral`).
  ipcMain.handle(IPC.cloudRedeemInvite, async (event, arg: { code?: unknown }): Promise<CloudInviteRedeemOutcome> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudRedeemInvite)) return { ok: false, reason: "unavailable", message: "ADE can't do that from here." };
    const code = typeof arg?.code === "string" ? arg.code : "";
    try {
      const outcome = await machines.redeemInvite(code);
      if (outcome.ok) sendToAllWindows(IPC.cloudStatusChanged);
      return outcome;
    } catch (error) {
      return { ok: false, reason: "unavailable", message: getErrorMessage(error) };
    }
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
      return { opened: false, change: result.change, ...(result.cleanup ? { cleanup: result.cleanup } : {}) };
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
      const { madeByChat, madeByAgent, ...shape } = machine;
      const madeBy = cloudMadeByMetadata({ madeByChat, madeByAgent });
      const result = await createCloudMachine(machineCreatorDeps, randomUUID(), shape, () => undefined, {
        ...(Object.keys(madeBy).length ? { metadata: madeBy } : {}),
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
