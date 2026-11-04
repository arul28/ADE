import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import {
  AGENT37_DEFAULT_TEMPLATE,
  agent37StillStartingMessage,
  describeAgent37TemplateStatus,
  type Agent37CreateMachineArgs,
  type Agent37CreateProgress,
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
import {
  createAgent37PendingCreateStore,
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
        .catch(() => undefined);
    });
    win.on("closed", () => finish("closed"));
    if (args.signal.aborted) {
      finish("cancelled");
      return;
    }
    args.signal.addEventListener("abort", () => finish("cancelled"), { once: true });
    void win.loadURL(args.url).catch(() => undefined);
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
export function registerAgent37Ipc(args: {
  vaultBridge: Parameters<typeof agent37VaultFromBridge>[0];
  listAccountMachines: () => Promise<AdeAccountMachinesResult>;
  renameMachine: (machineKey: string, name: string) => Promise<unknown>;
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
  };
  const getAccountToken = () => getSignedInAccountAccessToken(account());
  const directoryBaseUrl = () => {
    try {
      return getSharedAccountDirectoryBaseUrl() || null;
    } catch {
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
    onStatus: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
        try {
          win.webContents.send(IPC.agent37TemplateStatus, status);
        } catch {
          // A window closing right now; the next status reaches the rest.
        }
      }
    },
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

  ipcMain.handle(IPC.agent37GetStatus, async (event): Promise<Agent37Status | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37GetStatus)) return null;
    return await readAgent37Status(credentials);
  });

  ipcMain.handle(IPC.agent37SaveKey, async (event, arg: { apiKey?: unknown }): Promise<Agent37Status | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37SaveKey)) return null;
    const status = await saveAgent37Key(credentials, typeof arg?.apiKey === "string" ? arg.apiKey : "");
    // A new key may be a new workspace: forget what the old one said, then check.
    builder.reset();
    void builder.ensure();
    return status;
  });

  ipcMain.handle(IPC.agent37RemoveKey, async (event): Promise<Agent37Status | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37RemoveKey)) return null;
    let status: Agent37Status;
    try {
      status = await removeAgent37Key(credentials);
    } catch (error) {
      // Still connected; the renderer shows why and offers to try again.
      logger.warn("agent37.disconnect_failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    builder.reset();
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

  const creates = new Map<string, AbortController>();

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
        {
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
        },
        requestId,
        arg?.machine as Agent37CreateMachineArgs,
        send,
        controller.signal,
      ).then(
        (result) => send({
          requestId,
          stage: "done",
          message: result.joined
            ? `${result.name} is ready.`
            : result.machineKey
              ? agent37StillStartingMessage(result.name)
              : `${result.name} is signed in but still starting. It will appear under Your computers; connect it from there when it's ready.`,
          instanceId: result.instanceId,
          result,
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("agent37.create_machine_failed", { error: message });
          send({ requestId, stage: "failed", message, error: message });
        },
      ).finally(() => {
        creates.delete(requestId);
        if (!sender.isDestroyed()) sender.removeListener("destroyed", onSenderGone);
      });
      return { started: true };
    },
  );
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
  if (/\balpha\b/i.test(app.getName()) || process.env.ADE_PACKAGE_CHANNEL?.trim().toLowerCase() === "alpha") return null;
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

function parseBuildRecord(raw: string | null | undefined): Agent37TemplateBuildRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Agent37TemplateBuildRecord>;
    if (parsed?.v !== 1 || typeof parsed.template !== "string" || typeof parsed.buildId !== "string") return null;
    if (typeof parsed.startedAt !== "number" || typeof parsed.adeVersion !== "string" || typeof parsed.contextHash !== "string") return null;
    return { v: 1, template: parsed.template, buildId: parsed.buildId, startedAt: parsed.startedAt, adeVersion: parsed.adeVersion, contextHash: parsed.contextHash, by: typeof parsed.by === "string" ? parsed.by : null };
  } catch {
    return null;
  }
}

/**
 * The build-in-flight record: in the account vault, so every computer on the
 * account sees it, and on this computer when the vault can't be reached.
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
        const record = parseBuildRecord(got.value);
        if (record) return record;
      }
      return parseBuildRecord(local("read", () => machineStore().getSync(TEMPLATE_BUILD_MACHINE_KEY), null));
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
  const isSignedIn = async (instanceId: string): Promise<boolean> => {
    const auth = await client.exec(instanceId, "timeout 20 ade auth status --json 2>/dev/null", { timeoutMs: 40_000 }).catch((error: unknown) => {
      logger.warn("agent37.half_made_box_auth_read_failed", { instanceId, error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    return auth?.exitCode === 0 && /"signedIn"\s*:\s*true/.test(auth.stdout);
  };
  for (const record of leftover) {
    const result = await reconcileAgent37PendingCreate(client, record, { store: pending, logger, sleep, isSignedIn });
    logger.info("agent37.pending_create_reconciled", {
      requestId: record.requestId,
      resolved: result.resolved,
      deleted: result.deleted,
      kept: result.kept,
      unresolved: result.unresolved,
    });
  }
}
