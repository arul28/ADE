import { BrowserWindow, dialog } from "electron";
import type {
  AuthInfo,
  BrowserWindowConstructorOptions,
  Certificate,
  LoginAuthenticationResponseDetails,
  WebContents,
} from "electron";
import type { Logger } from "../logging/logger";

type AgentIdentity = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

type HttpAuthCredentials = {
  username: string;
  password: string;
};

type HttpAuthPrompt = (input: {
  parent: BrowserWindow | null;
  details: LoginAuthenticationResponseDetails;
  authInfo: AuthInfo;
}) => Promise<HttpAuthCredentials | null>;

type ClientCertificatePrompt = (input: {
  parent: BrowserWindow | null;
  url: string;
  certificates: Certificate[];
}) => Promise<Certificate | null>;

export function configureBuiltInBrowserAuthentication(args: {
  webContents: WebContents;
  resolveParentWindow: () => BrowserWindow | null;
  getAgentIdentity: () => AgentIdentity | null;
  recordAuthenticatedOrigin: (url: string, identity: AgentIdentity | null) => void;
  getLogger?: () => Logger | null;
  promptHttpAuth?: HttpAuthPrompt;
  promptClientCertificate?: ClientCertificatePrompt;
}): void {
  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };

  args.webContents.on("login", (event, details, authInfo, callback) => {
    event.preventDefault();
    const identity = args.getAgentIdentity();
    const origin = safeOrigin(details.url);
    logger()?.info("built_in_browser.http_auth_requested", {
      origin,
      isProxy: authInfo.isProxy,
      scheme: authInfo.scheme,
      realmPresent: Boolean(authInfo.realm?.trim()),
    });
    void (args.promptHttpAuth ?? showHttpAuthPrompt)({
      parent: args.resolveParentWindow(),
      details,
      authInfo,
    }).then((credentials) => {
      if (!credentials) {
        logger()?.info("built_in_browser.http_auth_cancelled", { origin, isProxy: authInfo.isProxy });
        callback();
        return;
      }
      if (!authInfo.isProxy) args.recordAuthenticatedOrigin(details.url, identity);
      logger()?.info("built_in_browser.http_auth_submitted", { origin, isProxy: authInfo.isProxy });
      callback(credentials.username, credentials.password);
    }).catch((error) => {
      logger()?.warn("built_in_browser.http_auth_prompt_failed", {
        origin,
        isProxy: authInfo.isProxy,
        error: error instanceof Error ? error.message : String(error),
      });
      callback();
    });
  });

  args.webContents.on("select-client-certificate", (event, url, certificates, callback) => {
    event.preventDefault();
    const identity = args.getAgentIdentity();
    const origin = safeOrigin(url);
    logger()?.info("built_in_browser.client_certificate_requested", {
      origin,
      certificateCount: certificates.length,
    });
    void (args.promptClientCertificate ?? showClientCertificatePrompt)({
      parent: args.resolveParentWindow(),
      url,
      certificates,
    }).then((certificate) => {
      if (!certificate || !certificates.includes(certificate)) {
        logger()?.info("built_in_browser.client_certificate_cancelled", { origin });
        (callback as (selected?: Certificate) => void)();
        return;
      }
      args.recordAuthenticatedOrigin(url, identity);
      logger()?.info("built_in_browser.client_certificate_selected", { origin });
      callback(certificate);
    }).catch((error) => {
      logger()?.warn("built_in_browser.client_certificate_prompt_failed", {
        origin,
        error: error instanceof Error ? error.message : String(error),
      });
      (callback as (selected?: Certificate) => void)();
    });
  });
}

async function showHttpAuthPrompt(input: {
  parent: BrowserWindow | null;
  details: LoginAuthenticationResponseDetails;
  authInfo: AuthInfo;
}): Promise<HttpAuthCredentials | null> {
  const origin = safeOrigin(input.details.url) ?? input.authInfo.host;
  const target = input.authInfo.isProxy ? `proxy ${input.authInfo.host}` : origin;
  const realm = input.authInfo.realm?.trim();
  const secure = input.authInfo.isProxy || isSecureUrl(input.details.url);
  const detail = [
    realm ? `Realm: ${realm}` : null,
    secure ? null : "Warning: this connection is not encrypted.",
    "ADE passes these credentials directly to Chromium and does not store or log them.",
  ].filter(Boolean).join("\n");
  const promptWindow = new BrowserWindow(httpAuthWindowOptions(input.parent));
  hardenPromptWindow(promptWindow);
  await promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(httpAuthHtml(target, detail))}`);

  return new Promise<HttpAuthCredentials | null>((resolve) => {
    let settled = false;
    const settle = (result: HttpAuthCredentials | null): void => {
      if (settled) return;
      settled = true;
      resolve(result);
      if (!promptWindow.isDestroyed()) promptWindow.close();
    };
    promptWindow.once("closed", () => settle(null));
    void promptWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const form = document.getElementById("auth-form");
        const cancel = document.getElementById("cancel");
        const username = document.getElementById("username");
        const password = document.getElementById("password");
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          resolve({ username: username.value, password: password.value });
        }, { once: true });
        cancel.addEventListener("click", () => resolve(null), { once: true });
      })
    `, true).then((result: unknown) => settle(normalizeCredentials(result)), () => settle(null));
    promptWindow.show();
    promptWindow.focus();
  });
}

async function showClientCertificatePrompt(input: {
  parent: BrowserWindow | null;
  url: string;
  certificates: Certificate[];
}): Promise<Certificate | null> {
  if (input.certificates.length === 0) return null;
  const buttons = input.certificates.map(formatCertificateLabel).concat("Cancel");
  const cancelId = buttons.length - 1;
  const options = {
    type: "question" as const,
    buttons,
    defaultId: cancelId,
    cancelId,
    noLink: true,
    message: `Choose a client certificate for ${safeOrigin(input.url) ?? "this site"}`,
    detail: "The selected certificate will be shared with this site for the current authentication request.",
  };
  const result = input.parent
    ? await dialog.showMessageBox(input.parent, options)
    : await dialog.showMessageBox(options);
  return input.certificates[result.response] ?? null;
}

function httpAuthWindowOptions(parent: BrowserWindow | null): BrowserWindowConstructorOptions {
  return {
    parent: parent ?? undefined,
    modal: Boolean(parent),
    show: false,
    width: 440,
    height: 330,
    minWidth: 400,
    minHeight: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: "Sign in",
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  };
}

function hardenPromptWindow(promptWindow: BrowserWindow): void {
  promptWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  promptWindow.webContents.on("will-navigate", (event) => event.preventDefault());
}

function httpAuthHtml(target: string, detail: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
    h1 { margin: 0 0 8px; font-size: 20px; }
    p { margin: 0 0 18px; color: GrayText; font-size: 13px; white-space: pre-line; }
    label { display: block; margin: 12px 0 5px; font-size: 13px; font-weight: 600; }
    input { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid GrayText; border-radius: 6px; background: Field; color: FieldText; font: inherit; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
    button { padding: 7px 14px; border-radius: 6px; border: 1px solid GrayText; font: inherit; }
    button[type="submit"] { font-weight: 600; }
  </style>
</head>
<body>
  <h1>Sign in to ${escapeHtml(target)}</h1>
  <p>${escapeHtml(detail)}</p>
  <form id="auth-form">
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password">
    <div class="actions">
      <button id="cancel" type="button">Cancel</button>
      <button type="submit">Sign in</button>
    </div>
  </form>
</body>
</html>`;
}

function normalizeCredentials(value: unknown): HttpAuthCredentials | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.username !== "string" || typeof record.password !== "string") return null;
  return { username: record.username, password: record.password };
}

function formatCertificateLabel(certificate: Certificate, index: number): string {
  const subject = certificate.subjectName?.trim() || `Certificate ${index + 1}`;
  const issuer = certificate.issuerName?.trim();
  return truncateLabel(issuer && issuer !== subject ? `${subject} — ${issuer}` : subject);
}

function truncateLabel(value: string): string {
  const maxLength = 90;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function safeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isSecureUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
