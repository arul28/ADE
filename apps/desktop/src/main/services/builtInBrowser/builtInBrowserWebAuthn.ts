import { BrowserWindow, app, dialog, session } from "electron";
import type { SelectWebauthnAccountDetails, Session, WebAuthnAccount } from "electron";
import type { Logger } from "../logging/logger";
import {
  BUILT_IN_BROWSER_PARTITION,
  BUILT_IN_BROWSER_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
} from "./builtInBrowserConstants";

let configured = false;
const configuredSessions = new WeakSet<Session>();

function shouldConfigureTouchIdWebAuthn(): boolean {
  const value = process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN?.trim().toLowerCase();
  if (value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  return app.isPackaged;
}

export function configureBuiltInBrowserWebAuthn(args: {
  getLogger?: () => Logger | null;
} = {}): void {
  if (configured) return;
  configured = true;

  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };

  if (process.platform === "darwin" && shouldConfigureTouchIdWebAuthn()) {
    try {
      app.configureWebAuthn({
        touchID: {
          keychainAccessGroup: BUILT_IN_BROWSER_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
        },
      });
      logger()?.info("built_in_browser.webauthn_configured", {
        keychainAccessGroup: BUILT_IN_BROWSER_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
      });
    } catch (error) {
      logger()?.warn("built_in_browser.webauthn_configure_failed", {
        err: error instanceof Error ? error.message : String(error),
        keychainAccessGroup: BUILT_IN_BROWSER_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
      });
    }
  } else if (process.platform === "darwin") {
    logger()?.debug("built_in_browser.webauthn_touchid_disabled", {
      reason: "missing_provisioned_keychain_access_group",
      keychainAccessGroup: BUILT_IN_BROWSER_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
    });
  }

  const browserSession = session.fromPartition(BUILT_IN_BROWSER_PARTITION);
  configureBuiltInBrowserSessionWebAuthn(browserSession, logger);
}

export function configureBuiltInBrowserSessionWebAuthn(
  browserSession: Session,
  logger: () => Logger | null,
): void {
  if (configuredSessions.has(browserSession)) return;
  configuredSessions.add(browserSession);
  browserSession.on("select-webauthn-account", (_event, details, callback) => {
    void selectWebAuthnAccount(details, logger).then(
      (credentialId) => callback(credentialId),
      (error) => {
        logger()?.warn("built_in_browser.webauthn_account_select_failed", {
          err: error instanceof Error ? error.message : String(error),
          relyingPartyId: details.relyingPartyId,
        });
        callback(null);
      },
    );
  });
}

async function selectWebAuthnAccount(
  details: SelectWebauthnAccountDetails,
  logger: () => Logger | null,
): Promise<string | null> {
  if (details.accounts.length === 0) return null;
  if (details.accounts.length === 1) return details.accounts[0].credentialId;

  const buttons = details.accounts.map(formatWebAuthnAccountLabel).concat("Cancel");
  const cancelId = buttons.length - 1;
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
  const options = {
    type: "question" as const,
    buttons,
    defaultId: 0,
    cancelId,
    noLink: true,
    message: `Choose a passkey for ${details.relyingPartyId}`,
    detail: "The site returned more than one matching passkey.",
  };
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  const account = details.accounts[result.response];
  if (!account) {
    logger()?.debug("built_in_browser.webauthn_account_select_cancelled", {
      relyingPartyId: details.relyingPartyId,
    });
    return null;
  }
  return account.credentialId;
}

function formatWebAuthnAccountLabel(account: WebAuthnAccount, index: number): string {
  const name = account.name?.trim() ?? "";
  const displayName = account.displayName?.trim() ?? "";
  const primary = displayName || name || `Account ${index + 1}`;
  const secondary = name && name !== primary ? ` (${name})` : "";
  return truncateLabel(`${primary}${secondary}`);
}

function truncateLabel(value: string): string {
  const maxLength = 80;
  const suffix = "...";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}
