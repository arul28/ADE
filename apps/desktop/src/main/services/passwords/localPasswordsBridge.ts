import { ipcMain, type WebContents } from "electron";
import type { PasswordPasskeySecret } from "../../../shared/types/passwords";
import { BUILT_IN_BROWSER_LOGIN_SUBMITTED_CHANNEL, type BuiltInBrowserLoginSubmission } from "../../../shared/types/builtInBrowserLoginCapture";
import { BUILT_IN_BROWSER_WEBAUTHN_CANCEL_CHANNEL, BUILT_IN_BROWSER_WEBAUTHN_CHANNEL, type WebAuthnPageAnswer } from "../../../shared/types/builtInBrowserPasskeys";
import type { BuiltInBrowserPasswordsAccess } from "../builtInBrowser/builtInBrowserService";
import { answerWebAuthnRequest, parseWebAuthnPageRequest, type PasskeyPasswordsAccess } from "../builtInBrowser/builtInBrowserPasskeys";
import { checkPerson, chooseAccount } from "./personCheck";

/**
 * Passwords for desktop main: this computer's brain, account-wide, through the
 * machine route `passwords.call` (no project needed). The values a fill needs
 * come back only here, into main; nothing on this path reaches a renderer.
 */
export type LocalPasswordsAccess = BuiltInBrowserPasswordsAccess & PasskeyPasswordsAccess;

export function createLocalPasswordsAccess(callAction: (action: string, args: Record<string, unknown>) => Promise<unknown>): LocalPasswordsAccess {
  const rows = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);
  return {
    loginsForPage: async (pageUrl, options) => rows(await callAction("loginsForPage", { pageUrl, exactOrigin: options?.exactOrigin === true })),
    resolveForFill: async (input) => {
      const value = await callAction("resolveForFill", input);
      return value && typeof value === "object" ? value as { username: string; password: string; code: string | null } : null;
    },
    sync: async () => {
      await callAction("sync", {});
    },
    enabled: async () => {
      const status = await callAction("status", {});
      return Boolean(status && typeof status === "object" && (status as { enabled?: unknown }).enabled === true);
    },
    saveLogin: async (input) => {
      const saved = await callAction("saveLogin", input);
      return saved && typeof saved === "object" && typeof (saved as { id?: unknown }).id === "string" ? { id: (saved as { id: string }).id } : null;
    },
    recordUse: (input) => callAction("recordUse", { ...input, kind: "login" }),
    passkeysForRp: async (rpId) => rows<PasswordPasskeySecret & { id: string }>(await callAction("passkeysForRp", { rpId })),
    savePasskey: (input) => callAction("savePasskey", input),
  };
}

/**
 * The browser tab preload's two Passwords messages:
 * - a login form the person sent (offer to save it), and
 * - a page's WebAuthn call (answer it with a saved passkey, or fall back).
 * Only a browser tab's own frames are answered; the origin is the asking
 * frame's, from Electron, never anything the page sends.
 */
export function registerBrowserTabPasswordsIpc(deps: {
  passwords: LocalPasswordsAccess;
  isBrowserTab: (contents: WebContents) => boolean;
  onLoginSubmitted: (contents: WebContents, mainFrame: boolean, submission: BuiltInBrowserLoginSubmission) => void;
}): void {
  ipcMain.on(BUILT_IN_BROWSER_LOGIN_SUBMITTED_CHANNEL, (event, payload: unknown) => {
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    if (!record) return;
    const text = (value: unknown) => (typeof value === "string" && value.length <= 1024 ? value : null);
    deps.onLoginSubmitted(
      event.sender,
      event.senderFrame != null && event.senderFrame === event.sender.mainFrame,
      { username: text(record.username), password: text(record.password) },
    );
  });

  // Requests still being answered, and those a tab gave up on (its
  // AbortSignal or timeout), by tab and request id.
  const inFlight = new Set<string>();
  const cancelled = new Set<string>();
  const requestKey = (contents: WebContents, requestId: unknown) => (typeof requestId === "string" && requestId.length <= 128 ? `${contents.id}:${requestId}` : null);
  ipcMain.on(BUILT_IN_BROWSER_WEBAUTHN_CANCEL_CHANNEL, (event, requestId: unknown) => {
    const key = requestKey(event.sender, requestId);
    if (key && inFlight.has(key)) cancelled.add(key);
  });

  ipcMain.handle(BUILT_IN_BROWSER_WEBAUTHN_CHANNEL, async (event, payload: unknown, requestId: unknown): Promise<WebAuthnPageAnswer> => {
    if (!deps.isBrowserTab(event.sender)) return { fallback: true };
    const request = parseWebAuthnPageRequest(payload);
    const frameOrigin = event.senderFrame?.origin ?? "";
    const topOrigin = event.sender.mainFrame?.origin ?? "";
    if (!request || !frameOrigin || frameOrigin === "null") return { fallback: true };
    const key = requestKey(event.sender, requestId);
    if (key) inFlight.add(key);
    try {
      return await answerWebAuthnRequest({
        request,
        frameOrigin,
        topOrigin,
        checkPerson,
        chooseAccount,
        cancelled: () => key !== null && cancelled.has(key),
        passwords: deps.passwords,
      });
    } finally {
      if (key) {
        inFlight.delete(key);
        cancelled.delete(key);
      }
    }
  });
}
