import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  AGENT37_DEFAULT_TEMPLATE,
  agent37StillStartingMessage,
  describeAgent37TemplateStatus,
  AGENT37_MADE_BY_CHAT_METADATA,
  agent37CapReachedMessage,
  type Agent37Budget,
  type Agent37ShapeId,
  isAgent37InstanceId,
  type Agent37CreateMachineArgs,
  type Agent37CreateProgress,
  type Agent37MachineActionArgs,
  type Agent37MachineActionKind,
  type Agent37MachineActionResult,
  type Agent37MachinesResult,
  type Agent37ReadyClaim,
  type Agent37ReadyProjectSettings,
  type Agent37ReadyStatus,
  type Agent37Status,
  type Agent37TemplateStatus,
} from "../../../shared/agent37";
import { IPC } from "../../../shared/ipc";
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
  agent37VaultFromBridge,
  readAgent37Status,
  removeAgent37Key,
  readAgent37Key,
  requireAgent37Client,
  saveAgent37Key,
  type Agent37CredentialDeps,
} from "./agent37Credential";
import {
  createAgent37Machine,
  type Agent37ApprovalMode,
  type Agent37ApprovalWindowResult,
} from "./agent37MachineCreator";
import { createAgent37Client } from "./agent37Client";
import { createAgent37Machines } from "./agent37Machines";
import { claimAgent37ReadyMachine, releaseAgent37ReadyMachine } from "./agent37ReadyClaim";
import { createAgent37ReadyKeeper } from "./agent37ReadyMachines";
import { setAgent37WakeForUse } from "./agent37WakeHook";
import { startAgent37MoneyWatch } from "./agent37MoneyWatch";
import { setAgent37DesktopActions } from "./agent37DesktopActions";
import { copyAgent37Machine, moveAgent37Machine, type Agent37CopyDeps } from "./agent37MachineCopy";
import {
  AGENT37_BUDGET_VAULT_KEY,
  createAgent37BudgetStore,
  wakeAgent37MachineForUse,
} from "./agent37Sleep";
import { AGENT37_READY_VAULT_KEY, createAgent37ReadySettingsStore } from "./agent37ReadySettings";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import {
  createAgent37PendingCreateStore,
  readAgent37BoxSignedIn,
  reconcileAgent37PendingCreate,
  type Agent37PendingCreate,
  type Agent37PendingCreateStore,
} from "./agent37PendingCreates";
import {
  createAgent37TemplateBuilder,
  type Agent37TemplateBuildRecord,
  type Agent37TemplateContextFiles,
  type Agent37TemplateRecordStore,
} from "./agent37TemplateBuilder";
import { BUILT_IN_BROWSER_PARTITION } from "../builtInBrowser/builtInBrowserConstants";
import { normalizeAppPackageChannel } from "../../../shared/packageChannel";

type Logger = {
  info(event: string, meta?: Record<string, unknown>): void;
  warn(event: string, meta?: Record<string, unknown>): void;
};

/** How long the private sign-in window waits before it shows itself to the person. */
const APPROVAL_SHOW_AFTER_MS = 6_000;
const APPROVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Opens the one-time sign-in link in a private, in-memory session (nothing it
 * signs in to outlives the window) and waits for `/device/callback`.
 *
 * The window starts hidden. If the sign-in has not reached the callback a few
 * seconds after its last page change, the page is waiting on the person (a
 * consent screen), so the window is shown, named after the box, and is the one
 * confirmation they give. ADE never clicks anything on it.
 */
export function openAgent37ApprovalWindow(
  args: { url: string; mode: Agent37ApprovalMode; title: string; signal: AbortSignal; onNeedsPerson: () => void },
  logger: Logger,
): Promise<Agent37ApprovalWindowResult> {
  const win = new BrowserWindow({
    show: false,
    width: 540,
    height: 720,
    title: args.title,
    autoHideMenuBar: true,
    webPreferences: {
      // A ticket signs in on its own, so it gets a throwaway session. The
      // approval page needs the person's existing ADE sign-in, which lives in
      // ADE's own browser.
      partition: args.mode === "ticket" ? `agent37-sign-in-${randomUUID()}` : BUILT_IN_BROWSER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Keep the box's name in the title bar, whatever the page calls itself.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  return new Promise((resolve) => {
    let settled = false;
    let shown = false;
    let showTimer: NodeJS.Timeout | null = null;
    const finish = (result: Agent37ApprovalWindowResult) => {
      if (settled) return;
      settled = true;
      if (showTimer) clearTimeout(showTimer);
      clearTimeout(timeout);
      if (!win.isDestroyed()) win.destroy();
      logger.info("agent37.approval_window_finished", { result, shown });
      resolve(result);
    };
    const timeout = setTimeout(() => finish("timed_out"), APPROVAL_TIMEOUT_MS);
    const armShow = () => {
      if (shown || settled) return;
      if (showTimer) clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        if (settled || win.isDestroyed()) return;
        shown = true;
        win.show();
        win.focus();
        args.onNeedsPerson();
      }, APPROVAL_SHOW_AFTER_MS);
    };
    const pageAt = (url: string): { host: string; path: string } | null => {
      try {
        const parsed = new URL(url);
        return { host: parsed.host, path: parsed.pathname };
      } catch {
        return null;
      }
    };
    win.webContents.on("did-navigate", (_event, url) => {
      const page = pageAt(url);
      // Host and path only: query strings here carry one-time tickets and codes.
      logger.info("agent37.approval_window_page", { host: page?.host ?? null, path: page?.path ?? null });
      armShow();
    });
    win.webContents.on("did-finish-load", () => {
      const page = pageAt(win.webContents.getURL());
      if (page?.path !== "/device/callback") return;
      void win.webContents
        .executeJavaScript("document.title + ' ' + (document.body ? document.body.innerText : '')", true)
        .then((text: unknown) => {
          if (typeof text === "string" && /signed in/i.test(text)) {
            finish("signed_in");
          } else {
            // The callback answered with a failure page; let the person read it.
            if (!shown && !win.isDestroyed()) {
              shown = true;
              win.show();
              args.onNeedsPerson();
            }
          }
        })
        .catch((error: unknown) => {
          // The window closed under the read, or the page would not answer.
          // The window's close or timeout still settles the flow.
          logger.warn("agent37.approval_window_read_failed", { error: error instanceof Error ? error.name : "unknown" });
        });
    });
    win.on("closed", () => finish("closed"));
    if (args.signal.aborted) {
      finish("cancelled");
      return;
    }
    args.signal.addEventListener("abort", () => finish("cancelled"), { once: true });
    // Never the message: Electron puts the URL, a one-time sign-in ticket, in it.
    void win.loadURL(args.url).catch((error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      logger.warn("agent37.approval_window_load_failed", { code: typeof code === "string" ? code : null });
    });
    if (args.mode === "browser") {
      // The approval page always needs the person: show it at once.
      shown = true;
      win.show();
      win.focus();
      args.onNeedsPerson();
    } else {
      armShow();
    }
  });
}

/**
 * Agent37 in Settings and the machine picker.
 *
 * No pin anywhere: the key is account-wide (the account vault answers the same
 * on every computer), and making a box acts on the Agent37 workspace and the
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

export function registerAgent37Ipc(args: {
  vaultBridge: Parameters<typeof agent37VaultFromBridge>[0];
  listAccountMachines: () => Promise<AdeAccountMachinesResult>;
  renameMachine: (machineKey: string, name: string) => Promise<unknown>;
  /** Takes a machine off the ADE account (what Delete box does once the box is gone). */
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  /** Ready machines: the per-project switch, each prepare's outcome, picker claims (analytics; coarse outcome only). */
  recordReady?: (outcome: "enabled" | "disabled" | "completed" | "failed" | "ready_picker") => void;
  /** One coarse product fact per finished create (analytics; never the box or the error). */
  recordMachineCreate?: (outcome: "completed" | "partial" | "cancelled" | "failed") => void;
  /** One coarse product fact per box action that worked (analytics; never the box). */
  recordMachineAction?: (action: Agent37MachineActionKind | "copy" | "move") => void;
  logger: Logger;
}): void {
  const { logger } = args;
  const account = () => getSharedAccountAuthService();
  let machineStore: EncryptedFileCredentialStore | null = null;
  const getMachineStore = () => (machineStore ??= new EncryptedFileCredentialStore({ secretsDir: resolveMachineAdeLayout().secretsDir }));
  const credentials: Agent37CredentialDeps = {
    vault: () => agent37VaultFromBridge(args.vaultBridge),
    // The shared credential file, so the brain's connect card reads a key
    // saved here while signed out, and the other way round.
    machineStore: getMachineStore,
    signedIn: () => account().getStatus().signedIn === true,
    logger,
  };
  const getAccountToken = () => getSignedInAccountAccessToken(account());
  const directoryBaseUrl = () => {
    try {
      return getSharedAccountDirectoryBaseUrl() || null;
    } catch (error) {
      logger.warn("agent37.account_directory_unavailable", { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  };
  // A trial template (`ade-a1-test`) for development and live checks.
  const templateName = () => process.env.ADE_AGENT37_TEMPLATE?.trim() || AGENT37_DEFAULT_TEMPLATE;

  const builder = createAgent37TemplateBuilder({
    client: async () => {
      const saved = await readAgent37Key(credentials);
      return saved ? createAgent37Client({ apiKey: saved.key }) : null;
    },
    templateName,
    adeVersion: releasedAdeVersion(),
    readContext: readAgent37TemplateContext,
    records: templateBuildRecords(args.vaultBridge, credentials, getMachineStore, logger),
    machineLabel: os.hostname(),
    onStatus: (status) => sendToAllWindows(IPC.agent37TemplateStatus, status),
    logger,
  });

  const pendingCreates = createAgent37PendingCreateStore(getMachineStore, logger);
  // Read now, before any create of this session can add to it.
  const leftoverCreates = pendingCreates.list();
  // Off the boot path: re-check the template (resuming a build cut short by a
  // quit) and delete any box a quit left half-made.
  const startupTimer = setTimeout(() => {
    void (async () => {
      const saved = await readAgent37Key(credentials).catch((error: unknown) => {
        logger.warn("agent37.startup_key_read_failed", { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      if (!saved) return;
      void builder.ensure();
      if (leftoverCreates.length) {
        await sweepPendingCreates(createAgent37Client({ apiKey: saved.key }), leftoverCreates, pendingCreates, logger);
      }
    })().catch((error: unknown) => logger.warn("agent37.startup_check_failed", { error: error instanceof Error ? error.message : String(error) }));
  }, STARTUP_CHECK_DELAY_MS);
  startupTimer.unref?.();

  const machineCreatorDeps: Parameters<typeof createAgent37Machine>[0] = {
    client: () => requireAgent37Client(credentials),
    getAccountToken,
    directoryBaseUrl,
    listAccountMachines: args.listAccountMachines,
    renameMachine: args.renameMachine,
    approveInWindow: (window) => openAgent37ApprovalWindow(window, logger),
    templateName,
    templateNotReady: () => {
      const template = builder.status();
      if (template.template !== templateName() || template.usable) return null;
      if (template.state === "building" || template.state === "failed") return describeAgent37TemplateStatus(template);
      return null;
    },
    onTemplateMissing: () => void builder.ensure(),
    pendingCreates,
    logger,
  };

  const budget = createAgent37BudgetStore({
    vault: () => (credentials.signedIn() ? agent37VaultFromBridge(args.vaultBridge, AGENT37_BUDGET_VAULT_KEY) : null),
    machineStore: getMachineStore,
    logger,
  });

  const savedClient = async () => {
    const saved = await readAgent37Key(credentials);
    return saved ? createAgent37Client({ apiKey: saved.key }) : null;
  };

  // Ready machines: prepared here (the sign-in needs this app's window),
  // claimed here or by any brain. The choice is the account's.
  const readyKeeper = createAgent37ReadyKeeper({
    client: savedClient,
    settings: createAgent37ReadySettingsStore({
      vault: () => (credentials.signedIn() ? agent37VaultFromBridge(args.vaultBridge, AGENT37_READY_VAULT_KEY) : null),
      machineStore: getMachineStore,
      logger,
    }),
    createMachine: (requestId, machine, onProgress, options) =>
      createAgent37Machine(machineCreatorDeps, requestId, machine, onProgress, options),
    removeAccountMachine: args.removeAccountMachine,
    // This computer and this app's data folder: a development copy beside the installed one is another preparer.
    preparerId: readyPreparerId(logger),
    templateAdeVersion: () => {
      const template = builder.status();
      return template.template === templateName() && template.state === "ready" ? template.adeVersion : null;
    },
    // Declared below; first called after the startup delay.
    spending: () => machines.spending(),
    onStatus: (status) => sendToAllWindows(IPC.agent37ReadyStatusChanged, status),
    onPrepared: (outcome) => args.recordReady?.(outcome),
    logger,
  });
  // After the template check, off the boot path; it reads every couple of minutes only while a project is on.
  readyKeeper.start(STARTUP_CHECK_DELAY_MS + 10_000);
  // A prepare cut short by a quit deletes its machine on the way out (best
  // effort); what a quit still leaves, this copy deletes at its next start.
  app.once("will-quit", () => readyKeeper.stop());

  const machines = createAgent37Machines({
    client: savedClient,
    removeAccountMachine: args.removeAccountMachine,
    readBudget: () => budget.read(),
    logger,
  });
  startAgent37MoneyWatch({ client: savedClient, machines, logger, firstPassDelayMs: STARTUP_CHECK_DELAY_MS + 30_000 });
  // Remote connections wake a sleeping box the person is about to use. Only a
  // machine the machine list showed as an Agent 37 box is looked up, so a
  // Connect to a laptop never waits on Agent 37.
  setAgent37WakeForUse(async (target) => {
    const machineKey = target.pairedMachine?.machineKey?.trim();
    if (!machineKey || !machines.isKnownBox(machineKey)) return false;
    const client = await savedClient().catch(() => null);
    if (!client) return false;
    const result = await wakeAgent37MachineForUse(client, { machineKey, hostname: target.hostname }, {
      spending: () => machines.spending(),
      logger,
    }).catch((error: unknown) => {
      logger.warn("agent37.wake_for_use_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (!result) return false;
    if (result.state === "refused") throw new Error(result.message);
    if (result.state === "woken") sendToAllWindows(IPC.agent37StatusChanged);
    return result.state === "woken";
  });

  ipcMain.handle(IPC.agent37GetStatus, async (event): Promise<Agent37Status | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37GetStatus)) return null;
    return await readAgent37Status(credentials);
  });

  ipcMain.handle(IPC.agent37SaveKey, async (event, arg: { apiKey?: unknown }): Promise<Agent37Status | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37SaveKey)) return null;
    const status = await saveAgent37Key(credentials, typeof arg?.apiKey === "string" ? arg.apiKey : "");
    // A new key may be a new workspace: forget what the old one said, then check.
    builder.reset();
    machines.resetUsage();
    void builder.ensure();
    sendToAllWindows(IPC.agent37StatusChanged);
    return status;
  });

  ipcMain.handle(IPC.agent37RemoveKey, async (event): Promise<Agent37Status | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37RemoveKey)) return null;
    let status: Agent37Status;
    try {
      status = await removeAgent37Key(credentials, logger);
    } catch (error) {
      // Still connected; the renderer shows why and offers to try again.
      logger.warn("agent37.disconnect_failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    builder.reset();
    machines.resetUsage();
    sendToAllWindows(IPC.agent37StatusChanged);
    return status;
  });

  ipcMain.handle(IPC.agent37GetTemplateStatus, async (event): Promise<Agent37TemplateStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37GetTemplateStatus)) return null;
    // Nothing checked yet in this session (or the key was just reconnected elsewhere): check now.
    if (builder.status().state === "idle") void builder.ensure();
    return builder.status();
  });

  ipcMain.handle(IPC.agent37RetryTemplate, async (event): Promise<Agent37TemplateStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37RetryTemplate)) return null;
    void builder.retry();
    return builder.status();
  });

  ipcMain.handle(IPC.agent37ListMachines, async (event): Promise<Agent37MachinesResult | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37ListMachines)) return null;
    return await machines.list();
  });

  ipcMain.handle(IPC.agent37MachineAction, async (event, arg: Agent37MachineActionArgs): Promise<Agent37MachineActionResult | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37MachineAction)) return null;
    const result = await machines.run(arg);
    if (result.ok) {
      args.recordMachineAction?.(arg.action);
      // The wallet and the box count moved: Settings and the picker read again.
      sendToAllWindows(IPC.agent37StatusChanged);
    }
    return result;
  });

  ipcMain.handle(IPC.agent37GetBudget, async (event): Promise<Agent37Budget | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37GetBudget)) return null;
    return await budget.read();
  });

  ipcMain.handle(IPC.agent37SetBudget, async (event, arg: { budget?: Agent37Budget }): Promise<Agent37Budget | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37SetBudget)) return null;
    const raw = arg?.budget?.monthlyCapUsd;
    const saved = await budget.write({ monthlyCapUsd: typeof raw === "number" ? raw : null });
    logger.info("agent37.budget_set", { capped: saved.monthlyCapUsd != null });
    sendToAllWindows(IPC.agent37StatusChanged);
    return saved;
  });

  ipcMain.handle(IPC.agent37WakeMachine, async (event, arg: { machineKey?: unknown; hostname?: unknown }) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37WakeMachine)) return null;
    const machineKey = typeof arg?.machineKey === "string" ? arg.machineKey.trim() : "";
    if (!machineKey) return { state: "not_agent37" as const };
    const client = await savedClient();
    if (!client) return { state: "not_agent37" as const };
    const result = await wakeAgent37MachineForUse(client, {
      machineKey,
      hostname: typeof arg?.hostname === "string" ? arg.hostname : null,
    }, { spending: () => machines.spending(), logger });
    if (result.state === "woken") sendToAllWindows(IPC.agent37StatusChanged);
    return result;
  });

  /** A project's identity from the renderer, normalized like every stored one. */
  const requireReadyIdentity = (value: unknown): string => {
    const identity = normalizeGitRemoteIdentity(typeof value === "string" ? value : null);
    if (!identity) throw new Error("Which project?");
    return identity;
  };

  ipcMain.handle(IPC.agent37ReadyStatus, async (event): Promise<Agent37ReadyStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37ReadyStatus)) return null;
    return await readyKeeper.refresh();
  });

  ipcMain.handle(IPC.agent37ReadySetProject, async (event, arg: { settings?: Partial<Agent37ReadyProjectSettings> }): Promise<Agent37ReadyStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37ReadySetProject)) return null;
    const wasOn = readyKeeper.status().projects.some((project) => project.settings.identity === normalizeGitRemoteIdentity(arg?.settings?.identity));
    const status = await readyKeeper.setProject(arg?.settings ?? {});
    if (!wasOn) args.recordReady?.("enabled");
    return status;
  });

  ipcMain.handle(IPC.agent37ReadyRemoveProject, async (event, arg: { identity?: unknown }): Promise<Agent37ReadyStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37ReadyRemoveProject)) return null;
    const status = await readyKeeper.removeProject(requireReadyIdentity(arg?.identity));
    args.recordReady?.("disabled");
    return status;
  });

  ipcMain.handle(IPC.agent37ReadyRetry, async (event, arg: { identity?: unknown }): Promise<Agent37ReadyStatus | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37ReadyRetry)) return null;
    return await readyKeeper.retry(requireReadyIdentity(arg?.identity));
  });

  ipcMain.handle(IPC.agent37ReadyClaim, async (event, arg: { originUrl?: unknown }): Promise<Agent37ReadyClaim | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37ReadyClaim)) return null;
    const identity = normalizeGitRemoteIdentity(typeof arg?.originUrl === "string" ? arg.originUrl : null);
    if (!identity) throw new Error("This project has no git origin, so it has no ready machine.");
    const claim = await claimAgent37ReadyMachine(await requireAgent37Client(credentials), identity, { logger, spending: () => machines.spending() });
    args.recordReady?.("ready_picker");
    // The pool is one short: make the next one.
    void readyKeeper.refresh();
    sendToAllWindows(IPC.agent37StatusChanged);
    return claim;
  });

  ipcMain.handle(IPC.agent37ReadyRelease, async (event, arg: { instanceId?: unknown; claimToken?: unknown }): Promise<{ released: boolean } | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37ReadyRelease)) return null;
    const instanceId = typeof arg?.instanceId === "string" ? arg.instanceId.trim() : "";
    const claimToken = typeof arg?.claimToken === "string" ? arg.claimToken : "";
    if (!isAgent37InstanceId(instanceId) || !claimToken) return { released: false };
    const released = await releaseAgent37ReadyMachine(await requireAgent37Client(credentials), instanceId, claimToken, { logger });
    if (released) void readyKeeper.refresh();
    return { released };
  });

  const creates = new Map<string, AbortController>();

  const copyDeps: Agent37CopyDeps = {
    ...machineCreatorDeps,
    spending: () => machines.spending(),
    removeAccountMachine: args.removeAccountMachine,
  };
  // The CLI and agents make, copy and move machines through this app (the
  // new machine signs in through its approval window), over the desktop bridge.
  setAgent37DesktopActions({
    create: async (machine) => {
      const month = await machines.spending().catch(() => null);
      if (month?.capReached) throw new Error(agent37CapReachedMessage(month));
      const { madeByChat, ...shape } = machine;
      const result = await createAgent37Machine(machineCreatorDeps, randomUUID(), shape, () => undefined, {
        ...(madeByChat ? { metadata: { [AGENT37_MADE_BY_CHAT_METADATA]: madeByChat } } : {}),
      });
      args.recordMachineCreate?.(result.joined ? "completed" : "partial");
      sendToAllWindows(IPC.agent37StatusChanged);
      return result;
    },
    copy: async (input) => {
      const result = await copyAgent37Machine(copyDeps, input, () => undefined);
      sendToAllWindows(IPC.agent37StatusChanged);
      return result;
    },
    move: async (input) => {
      const result = await moveAgent37Machine(copyDeps, input, () => undefined);
      sendToAllWindows(IPC.agent37StatusChanged);
      return result;
    },
    readyRefresh: () => readyKeeper.refresh(),
  });

  /**
   * A copy or move from the machine card: answers at once and reports like a
   * create (`agent37CreateProgress`, ending in done or failed), since a fork
   * or a move runs for minutes. Stopped when the window that asked goes away.
   */
  const startLongAction = (
    event: Electron.IpcMainInvokeEvent,
    requestId: string,
    run: (signal: AbortSignal, send: (progress: Agent37CreateProgress) => void) => Promise<{ message: string; result?: Agent37CreateProgress["result"] }>,
  ) => {
    if (creates.has(requestId)) return { started: true };
    const sender = event.sender;
    const controller = new AbortController();
    creates.set(requestId, controller);
    const onSenderGone = () => controller.abort();
    sender.once("destroyed", onSenderGone);
    const send = (progress: Agent37CreateProgress) => {
      if (sender.isDestroyed()) return;
      try {
        sender.send(IPC.agent37CreateProgress, { ...progress, requestId });
      } catch {
        // The window closed mid-action.
      }
    };
    void run(controller.signal, send).then(
      (done) => send({ requestId, stage: "done", message: done.message, ...(done.result ? { result: done.result } : {}) }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("agent37.long_action_failed", { error: message });
        send({ requestId, stage: "failed", message, error: message });
      },
    ).finally(() => {
      creates.delete(requestId);
      if (!sender.isDestroyed()) sender.removeListener("destroyed", onSenderGone);
      sendToAllWindows(IPC.agent37StatusChanged);
    });
    return { started: true };
  };

  ipcMain.handle(IPC.agent37CopyMachine, async (event, arg: { requestId?: unknown; instanceId?: unknown; name?: unknown; shape?: unknown }) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37CopyMachine)) return { started: false };
    const instanceId = typeof arg?.instanceId === "string" ? arg.instanceId.trim() : "";
    if (!isAgent37InstanceId(instanceId)) throw new Error("ADE doesn't know that box.");
    const requestId = typeof arg?.requestId === "string" && arg.requestId ? arg.requestId : randomUUID();
    return startLongAction(event, requestId, async (signal, send) => {
      const result = await copyAgent37Machine(copyDeps, {
        instanceId,
        requestId,
        name: typeof arg?.name === "string" ? arg.name : null,
        shape: typeof arg?.shape === "string" ? arg.shape as Agent37ShapeId : null,
      }, send, { signal });
      args.recordMachineAction?.("copy");
      return { message: `${result.name} is ready: a copy with the same files.`, result };
    });
  });

  ipcMain.handle(IPC.agent37MoveMachine, async (event, arg: { requestId?: unknown; instanceId?: unknown; machineKey?: unknown; to?: unknown; shape?: unknown }) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37MoveMachine)) return { started: false };
    const instanceId = typeof arg?.instanceId === "string" ? arg.instanceId.trim() : "";
    if (!isAgent37InstanceId(instanceId)) throw new Error("ADE doesn't know that box.");
    if (arg?.to !== "vm" && arg?.to !== "box") throw new Error("Move it to a box or a VM.");
    const to = arg.to;
    const requestId = typeof arg?.requestId === "string" && arg.requestId ? arg.requestId : randomUUID();
    return startLongAction(event, requestId, async (signal, send) => {
      const result = await moveAgent37Machine(copyDeps, {
        instanceId,
        requestId,
        to,
        machineKey: typeof arg?.machineKey === "string" ? arg.machineKey : null,
        shape: typeof arg?.shape === "string" ? arg.shape as Agent37ShapeId : null,
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

  ipcMain.handle(IPC.agent37CancelCreate, async (event, arg: { requestId?: unknown }): Promise<{ cancelled: boolean }> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37CancelCreate)) return { cancelled: false };
    const controller = typeof arg?.requestId === "string" ? creates.get(arg.requestId) : undefined;
    if (!controller) return { cancelled: false };
    controller.abort();
    return { cancelled: true };
  });

  ipcMain.handle(
    IPC.agent37CreateMachine,
    async (event, arg: { requestId?: unknown; machine?: Agent37CreateMachineArgs }): Promise<{ started: boolean }> => {
      if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37CreateMachine)) return { started: false };
      const requestId = typeof arg?.requestId === "string" && arg.requestId ? arg.requestId : randomUUID();
      if (creates.has(requestId)) return { started: true };
      const sender = event.sender;
      const controller = new AbortController();
      creates.set(requestId, controller);
      // The window that asked went away (closed, reloaded): nobody is waiting
      // for this box, so stop and delete it rather than leave it billing.
      const onSenderGone = () => controller.abort();
      sender.once("destroyed", onSenderGone);
      const send = (progress: Agent37CreateProgress) => {
        if (sender.isDestroyed()) return;
        try {
          sender.send(IPC.agent37CreateProgress, progress);
        } catch {
          // The window closed mid-create; the abort above cleans up.
        }
      };
      void createAgent37Machine(
        machineCreatorDeps,
        requestId,
        arg?.machine as Agent37CreateMachineArgs,
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
              ? agent37StillStartingMessage(result.name)
              : `${result.name} is signed in but still starting. It will appear under Your computers; connect it from there when it's ready.`,
          instanceId: result.instanceId,
          result,
          });
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          args.recordMachineCreate?.(controller.signal.aborted ? "cancelled" : "failed");
          logger.warn("agent37.create_machine_failed", { error: message });
          send({ requestId, stage: "failed", message, error: message });
        },
      ).finally(() => {
        creates.delete(requestId);
        if (!sender.isDestroyed()) sender.removeListener("destroyed", onSenderGone);
        // A box was made (or made and deleted): the machine list and the
        // wallet read again.
        sendToAllWindows(IPC.agent37StatusChanged);
      });
      return { started: true };
    },
  );
}

/**
 * This copy of ADE as a preparer of ready machines: a random id kept in its
 * own data folder, so it survives restarts and a hostname change, and a
 * development copy beside the installed one (another data folder) is another
 * preparer. Unreadable or unwritable, it is a fresh id for this run: then a
 * leftover is cleaned up as stale instead of at once.
 */
function readyPreparerId(logger: Logger): string {
  const file = path.join(app.getPath("userData"), "agent37-ready-preparer-id");
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
    logger.warn("agent37.ready_preparer_id_not_saved", { error: error instanceof Error ? error.message : String(error) });
  }
  return id;
}

/** Long enough that the boot path, the brain and the vault are settled first. */
const STARTUP_CHECK_DELAY_MS = 20_000;

/**
 * The ADE release this app is, for the template to install; null for a build
 * that is not a published release on the default channel (development, alpha),
 * which bakes the newest release and never replaces an existing template.
 */
function releasedAdeVersion(): string | null {
  if (!app.isPackaged) return null;
  // The channel main.ts settles at startup (applyPackagedChannelDefaults), read
  // the same way every other main-process surface reads it.
  if (normalizeAppPackageChannel(process.env.ADE_PACKAGE_CHANNEL) === "alpha") return null;
  const version = app.getVersion().trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

/**
 * `infra/agent37/template`: shipped as the `agent37-template` resource in a
 * packaged app (package.json `extraResources`), read from the checkout in
 * development.
 */
async function readAgent37TemplateContext(): Promise<Agent37TemplateContextFiles> {
  const candidates = [
    ...(typeof process.resourcesPath === "string" ? [path.join(process.resourcesPath, "agent37-template")] : []),
    path.resolve(app.getAppPath(), "..", "..", "infra", "agent37", "template"),
  ];
  for (const dir of candidates) {
    try {
      const [dockerfile, entrypoint] = await Promise.all([
        fs.promises.readFile(path.join(dir, "Dockerfile"), "utf8"),
        fs.promises.readFile(path.join(dir, "ade-entrypoint.sh"), "utf8"),
      ]);
      return { dockerfile, entrypoint };
    } catch {
      // Try the next place.
    }
  }
  throw new Error("this copy of ADE is missing its machine template files. Reinstall ADE.");
}

const TEMPLATE_BUILD_VAULT_KEY = "agent37-template-build";
const TEMPLATE_BUILD_MACHINE_KEY = "agent37.templateBuild.v1";

/** A damaged record reads as none (logged), so it can never stop builds for good. */
function parseBuildRecord(raw: string | null | undefined, logger: Logger): Agent37TemplateBuildRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Agent37TemplateBuildRecord>;
    if (parsed?.v !== 1 || typeof parsed.template !== "string" || typeof parsed.buildId !== "string") return null;
    if (typeof parsed.startedAt !== "number" || typeof parsed.adeVersion !== "string" || typeof parsed.contextHash !== "string") return null;
    return { v: 1, template: parsed.template, buildId: parsed.buildId, startedAt: parsed.startedAt, adeVersion: parsed.adeVersion, contextHash: parsed.contextHash, by: typeof parsed.by === "string" ? parsed.by : null };
  } catch (error) {
    logger.warn("agent37.template_record_unreadable", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * The build-in-flight record: in the account vault, so every computer on the
 * account sees it. Reads use this computer's copy only when there is no
 * account vault (signed out); an unreachable vault is an error, not "none".
 */
function templateBuildRecords(
  bridge: Parameters<typeof agent37VaultFromBridge>[0],
  credentials: Agent37CredentialDeps,
  machineStore: () => EncryptedFileCredentialStore,
  logger: Logger,
): Agent37TemplateRecordStore {
  const vault = () => (credentials.signedIn() ? agent37VaultFromBridge(bridge, TEMPLATE_BUILD_VAULT_KEY) : null);
  const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const local = <T>(what: string, run: () => T, fallback: T): T => {
    try {
      return run();
    } catch (error) {
      logger.warn("agent37.template_record_local_failed", { what, error: errorText(error) });
      return fallback;
    }
  };
  /** Runs a vault write; logs and answers false on a refusal or a throw. */
  const shared = async (what: string, run: () => Promise<boolean>): Promise<void> => {
    const ok = await run().catch((error: unknown) => {
      logger.warn("agent37.template_record_vault_failed", { what, error: errorText(error) });
      return null;
    });
    if (ok === false) logger.warn("agent37.template_record_vault_failed", { what, error: "refused" });
  };
  return {
    async read() {
      const store = vault();
      if (store) {
        // Signed in, the account is the authority. Unreachable is unknown:
        // the caller must not take this computer's copy as the whole answer.
        const got = await store.get().catch((error: unknown) => {
          logger.warn("agent37.template_record_vault_failed", { what: "read", error: errorText(error) });
          return { ok: false as const };
        });
        if (!got.ok) throw new Error("the account vault couldn't be read");
        // The account answered: its record, or its lack of one, is the whole
        // answer. This computer's copy holds our own last write even when the
        // vault refused it, and the builder reads "none" as "our claim did not
        // land"; the copy would hide exactly that.
        return parseBuildRecord(got.value, logger);
      }
      return parseBuildRecord(local("read", () => machineStore().getSync(TEMPLATE_BUILD_MACHINE_KEY), null), logger);
    },
    async write(record) {
      const raw = JSON.stringify(record);
      local("write", () => machineStore().setSync(TEMPLATE_BUILD_MACHINE_KEY, raw), undefined);
      const store = vault();
      if (store) await shared("write", () => store.set(raw));
    },
    async clear() {
      local("clear", () => machineStore().deleteSync(TEMPLATE_BUILD_MACHINE_KEY), undefined);
      const store = vault();
      if (store) await shared("clear", () => store.remove());
    },
  };
}

/**
 * Creates a quit (or a lost answer) left unresolved: a box that never signed
 * in is only a bill, so it is deleted; one that signed in is a real machine
 * and is kept. Records stay until Agent37 confirms, so a failure here is
 * retried at the next start.
 */
async function sweepPendingCreates(
  client: ReturnType<typeof createAgent37Client>,
  leftover: Agent37PendingCreate[],
  pending: Agent37PendingCreateStore,
  logger: Logger,
): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const isSignedIn = (instanceId: string) => readAgent37BoxSignedIn(client, instanceId, logger);
  for (const record of leftover) {
    const result = await reconcileAgent37PendingCreate(client, record, { store: pending, logger, sleep, isSignedIn });
    logger.info("agent37.pending_create_reconciled", {
      requestId: record.requestId,
      resolved: result.resolved,
      deleted: result.deleted,
      kept: result.kept,
      gone: result.gone,
      unresolved: result.unresolved,
    });
  }
}
