import { randomUUID } from "node:crypto";
import { BrowserWindow, ipcMain } from "electron";
import type {
  Agent37CreateMachineArgs,
  Agent37CreateProgress,
  Agent37Status,
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
  requireAgent37Client,
  saveAgent37Key,
  type Agent37CredentialDeps,
} from "./agent37Credential";
import {
  createAgent37Machine,
  type Agent37ApprovalMode,
  type Agent37ApprovalWindowResult,
} from "./agent37MachineCreator";
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
  const credentials: Agent37CredentialDeps = {
    vault: () => agent37VaultFromBridge(args.vaultBridge),
    // The shared credential file, so the brain's connect card reads a key
    // saved here while signed out, and the other way round.
    machineStore: () => (machineStore ??= new EncryptedFileCredentialStore({ secretsDir: resolveMachineAdeLayout().secretsDir })),
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

  ipcMain.handle(IPC.agent37GetStatus, async (event): Promise<Agent37Status | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37GetStatus)) return null;
    return await readAgent37Status(credentials);
  });

  ipcMain.handle(IPC.agent37SaveKey, async (event, arg: { apiKey?: unknown }): Promise<Agent37Status | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37SaveKey)) return null;
    return await saveAgent37Key(credentials, typeof arg?.apiKey === "string" ? arg.apiKey : "");
  });

  ipcMain.handle(IPC.agent37RemoveKey, async (event): Promise<Agent37Status | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37RemoveKey)) return null;
    return await removeAgent37Key(credentials);
  });

  ipcMain.handle(
    IPC.agent37CreateMachine,
    async (event, arg: { requestId?: unknown; machine?: Agent37CreateMachineArgs }): Promise<{ started: boolean }> => {
      if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.agent37CreateMachine)) return { started: false };
      const requestId = typeof arg?.requestId === "string" && arg.requestId ? arg.requestId : randomUUID();
      const sender = event.sender;
      const send = (progress: Agent37CreateProgress) => {
        if (sender.isDestroyed()) return;
        try {
          sender.send(IPC.agent37CreateProgress, progress);
        } catch {
          // The window closed mid-create; the box is still made or cleaned up.
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
          // A trial template (`ade-a1-test`) for development and live checks.
          templateName: () => process.env.ADE_AGENT37_TEMPLATE?.trim() || "",
          logger,
        },
        requestId,
        arg?.machine as Agent37CreateMachineArgs,
        send,
      ).then(
        (result) => send({
          requestId,
          stage: "done",
          message: result.machineKey ? `${result.name} is ready.` : `${result.name} is signed in. It shows up in your computers in a moment.`,
          instanceId: result.instanceId,
          result,
        }),
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("agent37.create_machine_failed", { error: message });
          send({ requestId, stage: "failed", message, error: message });
        },
      );
      return { started: true };
    },
  );
}
