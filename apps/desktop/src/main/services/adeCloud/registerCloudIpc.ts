import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  CLOUD_DEFAULT_TEMPLATE,
  cloudStillStartingMessage,
  CLOUD_MADE_BY_CHAT_METADATA,
  cloudCapReachedMessage,
  type CloudBudget,
  type CloudShapeId,
  isCloudInstanceId,
  type CloudCreateMachineArgs,
  type CloudCreateProgress,
  type CloudMachineActionArgs,
  type CloudMachineActionKind,
  type CloudMachineActionResult,
  type CloudMachinesResult,
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
  cloudVaultFromBridge,
  getCloudProvider,
  readCloudStatus,
  requireCloudProvider,
  type CloudAccessDeps,
} from "./cloudAccess";
import { createCloudMachine } from "./cloudMachineCreator";
import { openCloudApprovalWindow } from "./cloudApprovalWindow";
import { createCloudMachines } from "./cloudMachines";
import { claimCloudReadyMachine, releaseCloudReadyMachine } from "./cloudReadyClaim";
import { createCloudReadyKeeper } from "./cloudReadyMachines";
import { setCloudUpdateBlocker, setCloudWakeForUse } from "./cloudWakeHook";
import { startCloudMoneyWatch } from "./cloudMoneyWatch";
import { setCloudDesktopActions } from "./cloudDesktopActions";
import { copyCloudMachine, moveCloudMachine, type CloudCopyDeps } from "./cloudMachineCopy";
import { reconnectCloudMachine } from "./cloudReconnect";
import {
  CLOUD_BUDGET_VAULT_KEY,
  createCloudBudgetStore,
  cloudInstanceForMachine,
  wakeCloudMachineForUse,
} from "./cloudSleep";
import { CLOUD_READY_VAULT_KEY, createCloudReadySettingsStore } from "./cloudReadySettings";
import { normalizeAppPackageChannel } from "../../../shared/packageChannel";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { createCloudPendingCreateStore, sweepCloudPendingCreates } from "./cloudPendingCreates";

type Logger = {
  info(event: string, meta?: Record<string, unknown>): void;
  warn(event: string, meta?: Record<string, unknown>): void;
};

/**
 * the provider in Settings and the machine picker.
 *
 * No pin anywhere: the key is account-wide (the account vault answers the same
 * on every computer), and making a box acts on the provider workspace and the
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

export function registerCloudIpc(args: {
  vaultBridge: Parameters<typeof cloudVaultFromBridge>[0];
  listAccountMachines: () => Promise<AdeAccountMachinesResult>;
  renameMachine: (machineKey: string, name: string) => Promise<unknown>;
  /** Takes a machine off the ADE account (what Delete box does once the box is gone). */
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  /** Ready machines: the per-project switch, each prepare's outcome, picker claims (analytics; coarse outcome only). */
  recordReady?: (outcome: "enabled" | "disabled" | "completed" | "failed" | "ready_picker") => void;
  /** One coarse product fact per finished create (analytics; never the box or the error). */
  recordMachineCreate?: (outcome: "completed" | "partial" | "cancelled" | "failed") => void;
  /** One coarse product fact per box action that worked (analytics; never the box). */
  recordMachineAction?: (action: CloudMachineActionKind | "copy" | "move" | "reconnect") => void;
  /**
   * An `cloud` action on this computer's brain. Sign-ins for cloud machines
   * run there: a PTY can't start from this process in a packaged app.
   */
  brainAction: (action: string, actionArgs?: Record<string, unknown>) => Promise<unknown>;
  logger: Logger;
}): void {
  const { logger } = args;
  const account = () => getSharedAccountAuthService();
  let machineStore: EncryptedFileCredentialStore | null = null;
  const getMachineStore = () => (machineStore ??= new EncryptedFileCredentialStore({ secretsDir: resolveMachineAdeLayout().secretsDir }));
  const credentials: CloudAccessDeps = {
    vault: () => cloudVaultFromBridge(args.vaultBridge),
    signedIn: () => account().getStatus().signedIn === true,
    logger,
  };
  const getAccountToken = () => getSignedInAccountAccessToken(account());
  const directoryBaseUrl = () => {
    try {
      return getSharedAccountDirectoryBaseUrl() || null;
    } catch (error) {
      logger.warn("cloud.account_directory_unavailable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  // A trial template (`ade-a1-test`) for development and live checks.
  const templateName = () => process.env.ADE_CLOUD_TEMPLATE?.trim() || CLOUD_DEFAULT_TEMPLATE;

  const pendingCreates = createCloudPendingCreateStore(getMachineStore, logger);
  // Read now, before any create of this session can add to it.
  const leftoverCreates = pendingCreates.list();
  // Off the boot path: delete any machine a quit left half-made.
  const startupTimer = setTimeout(() => {
    void (async () => {
      if (!leftoverCreates.length) return;
      const provider = await getCloudProvider(credentials);
      if (provider) await sweepCloudPendingCreates(provider, leftoverCreates, pendingCreates, logger);
    })().catch((error: unknown) => logger.warn("cloud.startup_check_failed", { error: error instanceof Error ? error.message : String(error) }));
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

  const machineCreatorDeps: Parameters<typeof createCloudMachine>[0] = {
    client: () => requireCloudProvider(credentials),
    getAccountToken,
    directoryBaseUrl,
    listAccountMachines: args.listAccountMachines,
    renameMachine: args.renameMachine,
    approveInWindow: (window) => openCloudApprovalWindow(window, logger),
    templateName,
    machineEnv: () => cloudMachineEnv(cloudSignInVaults, logger),
    minAdeVersion: releasedAdeVersion,
    pendingCreates,
    logger,
  };

  const budget = createCloudBudgetStore({
    vault: () => (credentials.signedIn() ? cloudVaultFromBridge(args.vaultBridge, CLOUD_BUDGET_VAULT_KEY) : null),
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
    spending: () => machines.spending(),
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
    client: savedClient,
    removeAccountMachine: args.removeAccountMachine,
    readBudget: () => budget.read(),
    logger,
  });
  startCloudMoneyWatch({ client: savedClient, machines, logger, firstPassDelayMs: STARTUP_CHECK_DELAY_MS + 30_000 });
  // Remote connections wake a sleeping box the person is about to use. Only a
  // machine the machine list showed as a cloud box is looked up, so a
  // Connect to a laptop never waits on the provider.
  setCloudWakeForUse(async (target) => {
    const machineKey = target.pairedMachine?.machineKey?.trim();
    if (!machineKey || !machines.isKnownBox(machineKey)) return false;
    const client = await savedClient().catch(() => null);
    if (!client) return false;
    const result = await wakeCloudMachineForUse(client, { machineKey, hostname: target.hostname }, {
      spending: () => machines.spending(),
      logger,
    }).catch((error: unknown) => {
      logger.warn("cloud.wake_for_use_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (!result) return false;
    if (result.state === "refused") throw new Error(result.message);
    if (result.state === "woken") sendToAllWindows(IPC.cloudStatusChanged);
    return result.state === "woken";
  });

  // A box from a template older than the entrypoint-supervised one always
  // starts the ADE its image has, so an update installs and then never runs.
  // Asked before the update goes out, so the card says so at once.
  setCloudUpdateBlocker(async (target) => {
    const machineKey = target.pairedMachine?.machineKey?.trim();
    if (!machineKey || !machines.isKnownBox(machineKey)) return null;
    let probe: { exitCode: number } | null = null;
    let instance: ReturnType<typeof cloudInstanceForMachine> = null;
    try {
      const client = await savedClient();
      if (!client) return null;
      instance = cloudInstanceForMachine(await client.listInstances(), machineKey, target.hostname);
      if (!instance || instance.status !== "running") return null;
      probe = await client.exec(instance.id, CLOUD_ENTRYPOINT_SUPERVISOR_PROBE, { timeoutMs: 15_000 });
    } catch (error) {
      // Unknown is not "blocked": the update goes out, and the box's own ADE
      // refuses it there if its template is too old.
      logger.warn("cloud.update_blocker_check_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
    if (probe.exitCode !== 1) return null;
    logger.info("cloud.update_blocked_old_template", { instanceId: instance.id });
    return "This machine was made from an older ADE machine template, which always starts the ADE it was built with, "
      + "so an update can't take effect on it. Make a new ADE Cloud machine to get the current version, and move your lanes to it. "
      + "A copy keeps the old template.";
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

  ipcMain.handle(IPC.cloudGetBudget, async (event): Promise<CloudBudget | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudGetBudget)) return null;
    return await budget.read();
  });

  ipcMain.handle(IPC.cloudSetBudget, async (event, arg: { budget?: Partial<CloudBudget> }): Promise<CloudBudget | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSetBudget)) return null;
    // Either part may come alone: the cap, or what agents may spend.
    const current = await budget.read();
    const next = arg?.budget ?? {};
    const raw = "monthlyCapUsd" in next ? next.monthlyCapUsd : current.monthlyCapUsd;
    const saved = await budget.write({
      monthlyCapUsd: typeof raw === "number" ? raw : null,
      agents: next.agents ? { ...current.agents, ...next.agents } : current.agents,
    });
    logger.info("cloud.budget_set", { capped: saved.monthlyCapUsd != null, unattendedSpend: saved.agents.unattendedSpend, machinesPerDay: saved.agents.machinesPerDay });
    sendToAllWindows(IPC.cloudStatusChanged);
    return saved;
  });

  ipcMain.handle(IPC.cloudWakeMachine, async (event, arg: { machineKey?: unknown; hostname?: unknown }) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudWakeMachine)) return null;
    const machineKey = typeof arg?.machineKey === "string" ? arg.machineKey.trim() : "";
    if (!machineKey) return { state: "not_cloud" as const };
    const client = await savedClient();
    if (!client) return { state: "not_cloud" as const };
    const result = await wakeCloudMachineForUse(client, {
      machineKey,
      hostname: typeof arg?.hostname === "string" ? arg.hostname : null,
    }, { spending: () => machines.spending(), logger });
    if (result.state === "woken") sendToAllWindows(IPC.cloudStatusChanged);
    return result;
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
    const claim = await claimCloudReadyMachine(await requireCloudProvider(credentials), identity, { logger, spending: () => machines.spending() });
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
    spending: () => machines.spending(),
    removeAccountMachine: args.removeAccountMachine,
  };
  // The CLI and agents make, copy and move machines through this app (the
  // new machine signs in through its approval window), over the desktop bridge.
  setCloudDesktopActions({
    create: async (machine) => {
      const month = await machines.spending().catch(() => null);
      if (month?.capReached) throw new Error(cloudCapReachedMessage(month));
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
        const message = error instanceof Error ? error.message : String(error);
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
    if (!isCloudInstanceId(instanceId)) throw new Error("ADE doesn't know that box.");
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
    if (!isCloudInstanceId(instanceId)) throw new Error("ADE doesn't know that box.");
    if (arg?.to !== "vm" && arg?.to !== "box") throw new Error("Move it to a box or a VM.");
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
          ? `${result.name} is now a ${to === "vm" ? "VM" : "box"}, with all its files.`
          : `${result.name} has all its files on the new ${to === "vm" ? "VM" : "box"}. ADE couldn't delete the old one; delete it from its card.`,
        result,
      };
    });
  });

  ipcMain.handle(IPC.cloudReconnectMachine, async (event, arg: { requestId?: unknown; instanceId?: unknown }) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudReconnectMachine)) return { started: false };
    const instanceId = typeof arg?.instanceId === "string" ? arg.instanceId.trim() : "";
    if (!isCloudInstanceId(instanceId)) throw new Error("ADE doesn't know that box.");
    const requestId = typeof arg?.requestId === "string" && arg.requestId ? arg.requestId : randomUUID();
    return startLongAction(event, requestId, async (signal, send) => {
      const result = await reconnectCloudMachine({ ...machineCreatorDeps, spending: () => machines.spending() }, { instanceId, requestId }, send, { signal });
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
      // for this box, so stop and delete it rather than leave it billing.
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
          const message = error instanceof Error ? error.message : String(error);
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
    logger.warn("cloud.ready_preparer_id_not_saved", { error: error instanceof Error ? error.message : String(error) });
  }
  return id;
}

/** Long enough that the boot path, the brain and the vault are settled first. */
const STARTUP_CHECK_DELAY_MS = 20_000;

/**
 * Exits 0 when the box's entrypoint supervises the brain so that an update can
 * restart it on the new ADE (infra/ade-cloud/template/ade-entrypoint.sh), 1 when
 * it is an older ADE entrypoint, 2 when the box has no ADE entrypoint at all.
 */
const CLOUD_ENTRYPOINT_SUPERVISOR_PROBE = "grep -q 'ADE_BRAIN_SUPERVISOR=entrypoint' /usr/local/bin/ade-entrypoint.sh";
