import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuthInfo,
  Certificate,
  LoginAuthenticationResponseDetails,
  Session,
  WebContents,
} from "electron";
import { JsonRpcClient } from "../../../../../ade-cli/src/tuiClient/jsonRpcClient";
import { createBuiltInBrowserDesktopBridgeClient } from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeClient";
import {
  BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM,
  BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM,
} from "../../../../../ade-cli/src/services/builtInBrowser/desktopBridgeMethods";
import {
  issueBuiltInBrowserActorCapability,
  resetBuiltInBrowserActorCapabilitiesForTest,
  revokeBuiltInBrowserActorCapability,
  resolveBuiltInBrowserActorCapability,
} from "./builtInBrowserActorCapabilities";
import { createBuiltInBrowserAgentAccessController } from "./builtInBrowserAgentAccess";
import { configureBuiltInBrowserAuthentication } from "./builtInBrowserAuthentication";
import { isAllowedNavigationUrl, normalizeBrowserUrl } from "./builtInBrowserNavigation";
import {
  createBuiltInBrowserPermissionController,
  shouldAllowGoogleAuthPermissionCheck,
  shouldAllowGoogleAuthPermissionRequest,
} from "./builtInBrowserPermissions";
import { startBuiltInBrowserDesktopBridgeServer } from "./desktopBridgeServer";
import type { Logger } from "../logging/logger";
import type { BuiltInBrowserService } from "./builtInBrowserService";

const fakes = vi.hoisted(() => {
  type WebAuthnAccount = {
    credentialId: string;
    displayName?: string;
    name?: string;
  };
  type WebAuthnDetails = {
    relyingPartyId: string;
    accounts: WebAuthnAccount[];
  };
  type WebAuthnHandler = (
    event: unknown,
    details: WebAuthnDetails,
    callback: (credentialId?: string | null) => void,
  ) => void;

  const handlers: Record<string, WebAuthnHandler[]> = {};
  const parentWindow = { id: 1 };
  const fakeSession = {
    on: vi.fn((event: string, handler: WebAuthnHandler) => {
      (handlers[event] ??= []).push(handler);
    }),
  };

  return {
    handlers,
    parentWindow,
    app: {
      configureWebAuthn: vi.fn(),
      isPackaged: false,
    },
    session: {
      fromPartition: vi.fn(() => fakeSession),
    },
    dialog: {
      showMessageBox: vi.fn(async () => ({ response: 0 })),
    },
    BrowserWindow: {
      getFocusedWindow: vi.fn(() => null),
      getAllWindows: vi.fn(() => [parentWindow]),
    },
    reset: () => {
      for (const key of Object.keys(handlers)) delete handlers[key];
      fakeSession.on.mockClear();
      fakes.app.configureWebAuthn.mockReset();
      fakes.app.isPackaged = false;
      fakes.session.fromPartition.mockClear();
      fakes.dialog.showMessageBox.mockReset();
      fakes.dialog.showMessageBox.mockResolvedValue({ response: 0 });
      fakes.BrowserWindow.getFocusedWindow.mockReset();
      fakes.BrowserWindow.getFocusedWindow.mockReturnValue(null);
      fakes.BrowserWindow.getAllWindows.mockReset();
      fakes.BrowserWindow.getAllWindows.mockReturnValue([parentWindow]);
    },
  };
});

vi.mock("electron", () => ({
  app: fakes.app,
  session: fakes.session,
  dialog: fakes.dialog,
  BrowserWindow: fakes.BrowserWindow,
}));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function loadWebAuthnModule() {
  vi.resetModules();
  return import("./builtInBrowserWebAuthn");
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const originalTouchIdWebAuthnEnv = process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN;

describe("built-in browser WebAuthn", () => {
  beforeEach(() => {
    fakes.reset();
    delete process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN;
  });

  afterEach(() => {
    if (originalTouchIdWebAuthnEnv === undefined) {
      delete process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN;
    } else {
      process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN = originalTouchIdWebAuthnEnv;
    }
  });

  it("configures the browser session once", async () => {
    const { configureBuiltInBrowserWebAuthn } = await loadWebAuthnModule();

    configureBuiltInBrowserWebAuthn();
    configureBuiltInBrowserWebAuthn();

    expect(fakes.session.fromPartition).toHaveBeenCalledTimes(1);
    expect(fakes.session.fromPartition).toHaveBeenCalledWith("persist:ade-browser");
    expect(fakes.handlers["select-webauthn-account"]).toHaveLength(1);
    expect(fakes.app.configureWebAuthn).not.toHaveBeenCalled();
  });

  it("configures Touch ID WebAuthn when explicitly enabled", async () => {
    process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN = "1";
    const { configureBuiltInBrowserWebAuthn } = await loadWebAuthnModule();

    configureBuiltInBrowserWebAuthn();

    if (process.platform === "darwin") {
      expect(fakes.app.configureWebAuthn).toHaveBeenCalledWith({
        touchID: { keychainAccessGroup: "VQ372F39G6.com.ade.desktop.webauthn" },
      });
    } else {
      expect(fakes.app.configureWebAuthn).not.toHaveBeenCalled();
    }
  });

  it("does not ship a restricted keychain access-group entitlement without provisioning", () => {
    const entitlementPath = fileURLToPath(new URL(
      "../../../../build/entitlements.mac.plist",
      import.meta.url,
    ));
    const entitlements = fs.readFileSync(entitlementPath, "utf8");

    expect(entitlements).not.toContain("<key>keychain-access-groups</key>");
    expect(entitlements).not.toContain("<string>VQ372F39G6.com.ade.desktop.webauthn</string>");
  });

  it("keeps Touch ID WebAuthn disabled by default in packaged macOS builds", async () => {
    fakes.app.isPackaged = true;
    const { configureBuiltInBrowserWebAuthn } = await loadWebAuthnModule();

    configureBuiltInBrowserWebAuthn();

    expect(fakes.app.configureWebAuthn).not.toHaveBeenCalled();
  });

  it("lets packaged builds disable Touch ID WebAuthn with an env override", async () => {
    fakes.app.isPackaged = true;
    process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN = "0";
    const { configureBuiltInBrowserWebAuthn } = await loadWebAuthnModule();

    configureBuiltInBrowserWebAuthn();

    expect(fakes.app.configureWebAuthn).not.toHaveBeenCalled();
  });

  it("selects the only returned passkey without prompting", async () => {
    const { configureBuiltInBrowserWebAuthn } = await loadWebAuthnModule();
    configureBuiltInBrowserWebAuthn();
    const callback = vi.fn();

    fakes.handlers["select-webauthn-account"][0]({}, {
      relyingPartyId: "example.com",
      accounts: [{ credentialId: "cred-1", displayName: "Alice" }],
    }, callback);
    await flushPromises();

    expect(callback).toHaveBeenCalledWith("cred-1");
    expect(fakes.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("prompts when a site returns multiple discoverable passkeys", async () => {
    const { configureBuiltInBrowserWebAuthn } = await loadWebAuthnModule();
    configureBuiltInBrowserWebAuthn();
    fakes.dialog.showMessageBox.mockResolvedValue({ response: 1 });
    const callback = vi.fn();

    fakes.handlers["select-webauthn-account"][0]({}, {
      relyingPartyId: "example.com",
      accounts: [
        { credentialId: "cred-1", displayName: "Alice", name: "alice@example.com" },
        { credentialId: "cred-2", displayName: "Bob", name: "bob@example.com" },
      ],
    }, callback);
    await flushPromises();

    expect(fakes.dialog.showMessageBox).toHaveBeenCalledWith(
      fakes.parentWindow,
      expect.objectContaining({
        buttons: ["Alice (alice@example.com)", "Bob (bob@example.com)", "Cancel"],
        message: "Choose a passkey for example.com",
      }),
    );
    expect(callback).toHaveBeenCalledWith("cred-2");
  });

  it("cancels the WebAuthn request when the chooser is cancelled", async () => {
    const { configureBuiltInBrowserWebAuthn } = await loadWebAuthnModule();
    configureBuiltInBrowserWebAuthn();
    fakes.dialog.showMessageBox.mockResolvedValue({ response: 2 });
    const callback = vi.fn();

    fakes.handlers["select-webauthn-account"][0]({}, {
      relyingPartyId: "example.com",
      accounts: [
        { credentialId: "cred-1", displayName: "Alice" },
        { credentialId: "cred-2", displayName: "Bob" },
      ],
    }, callback);
    await flushPromises();

    expect(callback).toHaveBeenCalledWith(null);
  });
});

describe("built-in browser actor capabilities", () => {
  beforeEach(() => resetBuiltInBrowserActorCapabilitiesForTest());

  it("mints opaque chat-bound capabilities and ignores caller-supplied scope", () => {
    const token = issueBuiltInBrowserActorCapability({
      chatSessionId: "chat-1",
      laneId: "lane-1",
      projectRoot: "./project",
      tabCollection: null,
    });

    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(resolveBuiltInBrowserActorCapability(token)).toEqual({
      chatSessionId: "chat-1",
      laneId: "lane-1",
      projectRoot: path.resolve("./project"),
      tabCollection: null,
    });
    expect(resolveBuiltInBrowserActorCapability("not-issued")).toBeNull();
  });

  it("rotates a chat capability when its trusted collection scope changes", () => {
    const first = issueBuiltInBrowserActorCapability({
      chatSessionId: "chat-1",
      laneId: "lane-1",
      projectRoot: "/project",
      tabCollection: null,
    });
    const second = issueBuiltInBrowserActorCapability({
      chatSessionId: "chat-1",
      laneId: null,
      projectRoot: "/ignored",
      tabCollection: "personal",
    });

    expect(second).not.toBe(first);
    expect(resolveBuiltInBrowserActorCapability(first)).toBeNull();
    expect(resolveBuiltInBrowserActorCapability(second)).toEqual({
      chatSessionId: "chat-1",
      laneId: null,
      projectRoot: null,
      tabCollection: "personal",
    });
  });

  it("revokes a chat capability when its owning session closes", () => {
    const token = issueBuiltInBrowserActorCapability({
      chatSessionId: "chat-1",
      laneId: "lane-1",
      projectRoot: "/project",
      tabCollection: null,
    });

    revokeBuiltInBrowserActorCapability("chat-1");

    expect(resolveBuiltInBrowserActorCapability(token)).toBeNull();
  });
});

describe("built-in browser navigation policy", () => {
  it("normalizes plain domains to https URLs", () => {
    expect(normalizeBrowserUrl("example.com/path")).toBe("https://example.com/path");
    expect(normalizeBrowserUrl("example.com:3000/path")).toBe("https://example.com:3000/path");
  });

  it("normalizes localhost-like URLs to http", () => {
    expect(normalizeBrowserUrl("localhost:5173/work")).toBe("http://localhost:5173/work");
    expect(normalizeBrowserUrl("127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("allows only http, https, and about:blank navigation", () => {
    expect(isAllowedNavigationUrl("https://example.com")).toBe(true);
    expect(isAllowedNavigationUrl("http://localhost:5173")).toBe(true);
    expect(isAllowedNavigationUrl("about:blank")).toBe(true);
    expect(isAllowedNavigationUrl("file:///tmp/test.html")).toBe(false);
    expect(isAllowedNavigationUrl("about:config")).toBe(false);
  });

  it("rejects unsupported normalized protocols", () => {
    expect(() => normalizeBrowserUrl("file:///tmp/test.html")).toThrow("Unsupported browser URL protocol");
    expect(() => normalizeBrowserUrl("about:config")).toThrow("Only about:blank");
  });
});

describe("built-in browser agent access", () => {
  it("allows unbound humans and local development origins without prompting", async () => {
    const prompt = vi.fn(async () => ({ granted: false }));
    const controller = createBuiltInBrowserAgentAccessController({
      resolveParentWindow: () => null,
      prompt,
    });

    await expect(controller.requireUrlAccess("https://github.com", {}, "test")).resolves.toBeUndefined();
    await expect(controller.requireUrlAccess("http://localhost:5173", { chatSessionId: "chat-1" }, "test"))
      .resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("requires one chat-scoped human approval for every remote origin", async () => {
    const prompt = vi.fn(async () => ({ granted: true }));
    const controller = createBuiltInBrowserAgentAccessController({
      resolveParentWindow: () => null,
      prompt,
    });

    await expect(controller.requireUrlAccess(
      "https://github.com/settings/tokens",
      { laneId: "lane-1", chatSessionId: "chat-1" },
      "navigate",
    )).resolves.toBeUndefined();
    controller.assertUrlAccessSync("https://github.com/settings/tokens", { chatSessionId: "chat-1" });
    expect(() => controller.assertUrlAccessSync(
      "https://github.com/settings/tokens",
      { chatSessionId: "chat-2" },
    )).toThrow(/human-approval check/);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("requires first-use approval before synchronous access to a remote origin", async () => {
    const prompt = vi.fn(async () => ({ granted: true }));
    const controller = createBuiltInBrowserAgentAccessController({
      resolveParentWindow: () => null,
      prompt,
    });
    const identity = { chatSessionId: "chat-1" };

    expect(() => controller.assertUrlAccessSync("https://example.test", identity)).toThrow();
    await expect(controller.requireUrlAccess("https://example.test", identity, "navigate")).resolves.toBeUndefined();
    expect(() => controller.assertUrlAccessSync("https://example.test", identity)).not.toThrow();
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("requires approval for local origins with a remembered privileged permission", async () => {
    const prompt = vi.fn(async () => ({ granted: false }));
    const controller = createBuiltInBrowserAgentAccessController({
      hasAllowedPermissionForOrigin: (origin) => origin === "http://localhost:5173",
      resolveParentWindow: () => null,
      prompt,
    });

    await expect(controller.requireUrlAccess(
      "http://localhost:5173/account",
      { chatSessionId: "chat-1" },
      "navigate",
    )).rejects.toThrow(/Human approval was denied/);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("treats HTTP-authenticated origins as sensitive and grants only the prompting agent", async () => {
    const controller = createBuiltInBrowserAgentAccessController({
      resolveParentWindow: () => null,
      prompt: vi.fn(),
    });
    const owner = { laneId: "lane-1", chatSessionId: "chat-1" };

    controller.recordHumanAuthentication("https://basic.example.com/private", owner);

    expect(() => controller.assertUrlAccessSync("https://basic.example.com/private", owner)).not.toThrow();
    expect(() => controller.assertUrlAccessSync(
      "https://basic.example.com/private",
      { laneId: "lane-1", chatSessionId: "chat-2" },
    )).toThrow(/requires a browser human-approval check/);
  });
});

type AuthenticationListener = (...args: unknown[]) => void;

function createAuthenticationHarness() {
  const listeners = new Map<string, AuthenticationListener>();
  const webContents = {
    on: vi.fn((event: string, listener: AuthenticationListener) => {
      listeners.set(event, listener);
    }),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const recordAuthenticatedOrigin = vi.fn();
  const promptHttpAuth = vi.fn();
  const promptClientCertificate = vi.fn();
  configureBuiltInBrowserAuthentication({
    webContents: webContents as never,
    resolveParentWindow: () => null,
    getAgentIdentity: () => ({ laneId: "lane-1", chatSessionId: "chat-1" }),
    recordAuthenticatedOrigin,
    getLogger: () => logger as never,
    promptHttpAuth,
    promptClientCertificate,
  });
  return {
    listeners,
    logger,
    recordAuthenticatedOrigin,
    promptHttpAuth,
    promptClientCertificate,
  };
}

function authDetails(): LoginAuthenticationResponseDetails {
  return { url: "https://example.com/private" };
}

function authInfo(): AuthInfo {
  return {
    isProxy: false,
    scheme: "basic",
    host: "example.com",
    port: 443,
    realm: "Private",
  };
}

function certificate(subjectName: string): Certificate {
  const principal = {
    commonName: subjectName,
    country: "",
    locality: "",
    organizations: [],
    organizationUnits: [],
    state: "",
  };
  const value = {
    data: "pem",
    fingerprint: `fingerprint-${subjectName}`,
    issuer: principal,
    issuerCert: null as unknown as Certificate,
    issuerName: "ADE Test CA",
    serialNumber: "1",
    subject: principal,
    subjectName,
    validExpiry: 2_000_000_000,
    validStart: 1_000_000_000,
  } satisfies Certificate;
  value.issuerCert = value;
  return value;
}

describe("built-in browser HTTP and client-certificate authentication", () => {
  it("passes HTTP auth credentials directly to Chromium without logging them", async () => {
    const harness = createAuthenticationHarness();
    harness.promptHttpAuth.mockResolvedValue({ username: "alice", password: "top-secret" });
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();

    harness.listeners.get("login")?.(event, authDetails(), authInfo(), callback);
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith("alice", "top-secret");
    expect(harness.recordAuthenticatedOrigin).toHaveBeenCalledWith(
      "https://example.com/private",
      { laneId: "lane-1", chatSessionId: "chat-1" },
    );
    expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain("alice");
    expect(JSON.stringify(harness.logger.info.mock.calls)).not.toContain("top-secret");
  });

  it("cancels HTTP authentication when the human dismisses the prompt", async () => {
    const harness = createAuthenticationHarness();
    harness.promptHttpAuth.mockResolvedValue(null);
    const callback = vi.fn();

    harness.listeners.get("login")?.(
      { preventDefault: vi.fn() },
      authDetails(),
      authInfo(),
      callback,
    );
    await flushPromises();

    expect(callback).toHaveBeenCalledWith();
    expect(harness.recordAuthenticatedOrigin).not.toHaveBeenCalled();
  });

  it("does not treat proxy credentials as site authentication", async () => {
    const harness = createAuthenticationHarness();
    harness.promptHttpAuth.mockResolvedValue({ username: "proxy-user", password: "proxy-pass" });
    const callback = vi.fn();

    harness.listeners.get("login")?.(
      { preventDefault: vi.fn() },
      authDetails(),
      { ...authInfo(), isProxy: true },
      callback,
    );
    await flushPromises();

    expect(callback).toHaveBeenCalledWith("proxy-user", "proxy-pass");
    expect(harness.recordAuthenticatedOrigin).not.toHaveBeenCalled();
  });

  it("uses only a certificate from Electron's offered list", async () => {
    const harness = createAuthenticationHarness();
    const first = certificate("Alice");
    const second = certificate("Bob");
    harness.promptClientCertificate.mockResolvedValue(second);
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();

    harness.listeners.get("select-client-certificate")?.(
      event,
      "https://mtls.example.com/",
      [first, second],
      callback,
    );
    await flushPromises();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(second);
    expect(harness.recordAuthenticatedOrigin).toHaveBeenCalledWith(
      "https://mtls.example.com/",
      { laneId: "lane-1", chatSessionId: "chat-1" },
    );
  });

  it("cancels when a certificate prompt returns an unoffered certificate", async () => {
    const harness = createAuthenticationHarness();
    harness.promptClientCertificate.mockResolvedValue(certificate("Mallory"));
    const callback = vi.fn();

    harness.listeners.get("select-client-certificate")?.(
      { preventDefault: vi.fn() },
      "https://mtls.example.com/",
      [certificate("Alice")],
      callback,
    );
    await flushPromises();

    expect(callback).toHaveBeenCalledWith();
    expect(harness.recordAuthenticatedOrigin).not.toHaveBeenCalled();
  });
});

function permissionPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-permissions-"));
  tempDirs.push(dir);
  return path.join(dir, "permissions.json");
}

function createPermissionSessionHarness() {
  let checkHandler: ((
    webContents: WebContents | null,
    permission: string,
    requestingOrigin: string,
    details: Electron.PermissionCheckHandlerHandlerDetails,
  ) => boolean) | null = null;
  let requestHandler: ((
    webContents: WebContents,
    permission: string,
    callback: (granted: boolean) => void,
    details: Electron.PermissionRequest,
  ) => void) | null = null;
  const session = {
    setPermissionCheckHandler: vi.fn((handler) => {
      checkHandler = handler;
    }),
    setPermissionRequestHandler: vi.fn((handler) => {
      requestHandler = handler;
    }),
  } as unknown as Session;
  return {
    session,
    check: (
      webContents: WebContents | null,
      permission: string,
      origin: string,
      details: Partial<Electron.PermissionCheckHandlerHandlerDetails> = {},
    ): boolean => checkHandler?.(webContents, permission, origin, {
      isMainFrame: details.isMainFrame ?? true,
      ...details,
    }) ?? false,
    request: (
      webContents: WebContents,
      permission: string,
      details: Partial<Electron.PermissionRequest> = {},
    ): Promise<boolean> => new Promise((resolve) => {
      requestHandler?.(webContents, permission, resolve, {
        isMainFrame: details.isMainFrame ?? true,
        requestingUrl: details.requestingUrl ?? webContents.getURL(),
      });
    }),
  };
}

function fakeWebContents(url = "https://example.com/page"): WebContents {
  return { getURL: () => url } as unknown as WebContents;
}

describe("built-in browser permissions", () => {
  it("allows only Google auth storage access without a prompt", () => {
    expect(shouldAllowGoogleAuthPermissionCheck("storage-access", "https://accounts.google.com", {
      requestingUrl: "https://example.com",
      isMainFrame: false,
    })).toBe(true);
    expect(shouldAllowGoogleAuthPermissionCheck("usb", "https://accounts.google.com", {
      requestingUrl: "https://accounts.google.com/signin",
      isMainFrame: true,
    })).toBe(false);
    expect(shouldAllowGoogleAuthPermissionRequest("top-level-storage-access", {
      requestingUrl: "https://accounts.google.com/signin",
    })).toBe(true);
    expect(shouldAllowGoogleAuthPermissionRequest("notifications", {
      requestingUrl: "https://accounts.google.com/signin",
    })).toBe(false);
  });

  it("prompts once, persists an allow decision, and reuses it after restart", async () => {
    const filePath = permissionPath();
    const webContents = fakeWebContents();
    const prompt = vi.fn(async () => ({ granted: true, remember: true }));
    const controller = createBuiltInBrowserPermissionController({
      filePath,
      isManagedWebContents: () => true,
      resolveParentWindow: () => null,
      prompt,
    });
    const firstSession = createPermissionSessionHarness();
    controller.configureSession(firstSession.session);

    await expect(firstSession.request(webContents, "notifications")).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(controller.list()).toMatchObject([{
      permission: "notifications",
      origin: "https://example.com",
      decision: "allow",
    }]);
    expect(controller.hasAllowedDecisionForOrigin("https://example.com/account")).toBe(true);
    expect(controller.hasAllowedDecisionForOrigin("https://other.example.com")).toBe(false);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

    const restored = createBuiltInBrowserPermissionController({
      filePath,
      isManagedWebContents: () => true,
      resolveParentWindow: () => null,
      prompt: vi.fn(async () => ({ granted: false, remember: false })),
    });
    const restoredSession = createPermissionSessionHarness();
    restored.configureSession(restoredSession.session);
    expect(restoredSession.check(webContents, "notifications", "https://example.com")).toBe(true);
    await expect(restoredSession.request(webContents, "notifications")).resolves.toBe(true);
  });

  it("persists block decisions and can clear them per origin", async () => {
    const filePath = permissionPath();
    const webContents = fakeWebContents();
    const prompt = vi.fn(async () => ({ granted: false, remember: true }));
    const controller = createBuiltInBrowserPermissionController({
      filePath,
      isManagedWebContents: () => true,
      resolveParentWindow: () => null,
      prompt,
    });
    const session = createPermissionSessionHarness();
    controller.configureSession(session.session);

    await expect(session.request(webContents, "geolocation")).resolves.toBe(false);
    await expect(session.request(webContents, "geolocation")).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(await controller.clear({ origin: "https://example.com" })).toBe(1);
    expect(controller.list()).toEqual([]);
  });

  it("keeps non-remembered blocks for the process and lets a human clear them", async () => {
    const webContents = fakeWebContents();
    const prompt = vi.fn(async () => ({ granted: false, remember: false }));
    const controller = createBuiltInBrowserPermissionController({
      filePath: permissionPath(),
      isManagedWebContents: () => true,
      resolveParentWindow: () => null,
      prompt,
    });
    const session = createPermissionSessionHarness();
    controller.configureSession(session.session);

    await expect(session.request(webContents, "notifications")).resolves.toBe(false);
    await expect(session.request(webContents, "notifications")).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(controller.list()).toEqual([]);
    expect(await controller.clear({ origin: "https://example.com" })).toBe(1);
    await expect(session.request(webContents, "notifications")).resolves.toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it("denies unmanaged, insecure, and filesystem requests without prompting", async () => {
    const prompt = vi.fn(async () => ({ granted: true, remember: true }));
    const managed = fakeWebContents("http://not-secure.example.com");
    const unmanaged = fakeWebContents();
    const controller = createBuiltInBrowserPermissionController({
      filePath: permissionPath(),
      isManagedWebContents: (candidate) => candidate === managed,
      resolveParentWindow: () => null,
      prompt,
    });
    const session = createPermissionSessionHarness();
    controller.configureSession(session.session);

    await expect(session.request(unmanaged, "notifications")).resolves.toBe(false);
    await expect(session.request(managed, "notifications")).resolves.toBe(false);
    await expect(session.request(fakeWebContents(), "fileSystem")).resolves.toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("scopes media decisions by requested device type", async () => {
    const prompt = vi.fn(async () => ({ granted: true, remember: true }));
    const controller = createBuiltInBrowserPermissionController({
      filePath: permissionPath(),
      isManagedWebContents: () => true,
      resolveParentWindow: () => null,
      prompt,
    });
    const session = createPermissionSessionHarness();
    controller.configureSession(session.session);
    const webContents = fakeWebContents();

    await new Promise<boolean>((resolve) => {
      const handler = vi.mocked(session.session.setPermissionRequestHandler).mock.calls[0]?.[0];
      handler?.(webContents, "media", resolve, {
        isMainFrame: true,
        requestingUrl: webContents.getURL(),
        mediaTypes: ["audio"],
      });
    });
    expect(controller.list()[0]?.permission).toBe("media:audio");
    expect(session.check(webContents, "media", "https://example.com", { mediaType: "video" })).toBe(false);
    expect(session.check(webContents, "media", "https://example.com", { mediaType: "audio" })).toBe(true);
  });
});

function createLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

async function waitForPath(filePath: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForMode(filePath: string, expectedMode: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && (fs.statSync(filePath).mode & 0o777) === expectedMode) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const actual = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : null;
  throw new Error(`Timed out waiting for ${filePath} mode ${expectedMode.toString(8)}; got ${actual?.toString(8) ?? "missing"}`);
}

describe("built-in browser desktop bridge", () => {
  let bridgeTempDir = "";

  beforeEach(() => {
    resetBuiltInBrowserActorCapabilitiesForTest();
    bridgeTempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-bridge-"));
    tempDirs.push(bridgeTempDir);
  });

  it.skipIf(process.platform === "win32")("creates private Unix socket directories and socket files", async () => {
    const socketDir = path.join(bridgeTempDir, "sock");
    fs.mkdirSync(socketDir, { mode: 0o755 });
    fs.chmodSync(socketDir, 0o755);
    const socketPath = path.join(socketDir, "desktop-bridge.sock");
    let server: ReturnType<typeof startBuiltInBrowserDesktopBridgeServer> | null = null;
    try {
      server = startBuiltInBrowserDesktopBridgeServer({
        socketPath,
        service: { getStatus: async () => ({ ok: true }) } as unknown as BuiltInBrowserService,
        logger: createLogger(),
      });
      await waitForPath(socketPath);
      await waitForMode(socketPath, 0o600);

      expect(fs.statSync(socketDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
    } finally {
      server?.dispose();
    }
  });

  it.skipIf(process.platform === "win32")("rejects raw callers and requires an authenticated runtime scope", async () => {
    const socketPath = path.join(bridgeTempDir, "desktop-bridge.sock");
    const navigate = vi.fn(async (input: unknown) => input);
    const server = startBuiltInBrowserDesktopBridgeServer({
      socketPath,
      service: { navigate } as unknown as BuiltInBrowserService,
      logger: createLogger(),
    });
    let client: JsonRpcClient | null = null;
    try {
      await waitForPath(socketPath);
      client = await JsonRpcClient.connect(socketPath);
      await expect(client.request("built_in_browser.navigate", {
        url: "https://example.test",
      })).rejects.toThrow(/bridge authentication failed/);

      await expect(client.request("built_in_browser.authenticate", {
        [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: server.authToken,
      })).resolves.toEqual({ authenticated: true });

      await expect(client.request("built_in_browser.navigate", {
        url: "https://example.test",
        chatSessionId: "chat-trusted",
        projectRoot: "/trusted/project",
        [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: server.authToken,
      })).rejects.toThrow(/issuer-validated chat capability/);

      const actorToken = issueBuiltInBrowserActorCapability({
        chatSessionId: "chat-trusted",
        laneId: "lane-issued",
        projectRoot: "/issued/project",
        tabCollection: null,
      });
      await expect(client.request("built_in_browser.navigate", {
        url: "https://example.test",
        chatSessionId: "chat-other",
        [BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]: actorToken,
        [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: server.authToken,
      })).rejects.toThrow(/issuer-validated chat capability/);
      await expect(client.request("built_in_browser.navigate", {
        url: "https://example.test",
        laneId: "lane-spoofed",
        chatSessionId: "chat-trusted",
        projectRoot: "/spoofed/project",
        force: true,
        [BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]: actorToken,
        [BUILT_IN_BROWSER_BRIDGE_AUTH_PARAM]: server.authToken,
      })).resolves.toMatchObject({
        url: "https://example.test",
        laneId: "lane-issued",
        chatSessionId: "chat-trusted",
        projectRoot: "/issued/project",
        force: false,
      });
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate.mock.calls[0]?.[0]).not.toHaveProperty(BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM);
    } finally {
      client?.close();
      server.dispose();
    }
  });

  it.skipIf(process.platform === "win32")("validates opaque actor capabilities in their issuing desktop process", async () => {
    const socketPath = path.join(bridgeTempDir, "desktop-bridge.sock");
    const navigate = vi.fn(async (input: unknown) => input);
    const server = startBuiltInBrowserDesktopBridgeServer({
      socketPath,
      service: { navigate } as unknown as BuiltInBrowserService,
      logger: createLogger(),
    });
    const client = createBuiltInBrowserDesktopBridgeClient({
      socketPath,
      getAuthToken: () => server.authToken,
      projectRoot: "/trusted/project",
      logger: createLogger(),
    });
    try {
      await waitForPath(socketPath);
      const personalActorToken = issueBuiltInBrowserActorCapability({
        chatSessionId: "chat-personal",
        laneId: null,
        projectRoot: null,
        tabCollection: "personal" as const,
      });
      const personalNavigate = {
        url: "https://example.test",
        chatSessionId: "chat-personal",
        tabCollection: "personal" as const,
        force: true,
        [BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]: personalActorToken,
      };
      await expect(client.navigate(personalNavigate)).resolves.toMatchObject({
        url: "https://example.test",
        chatSessionId: "chat-personal",
        tabCollection: "personal" as const,
        force: false,
      });
      const projectActorToken = issueBuiltInBrowserActorCapability({
        chatSessionId: "chat-project",
        laneId: "lane-project",
        projectRoot: "/issued/project",
        tabCollection: null,
      });
      const projectNavigate = {
        url: "https://project.example.test",
        chatSessionId: "chat-project",
        tabCollection: "personal" as const,
        [BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]: projectActorToken,
      };
      await expect(client.navigate(projectNavigate)).resolves.toMatchObject({
        url: "https://project.example.test",
        chatSessionId: "chat-project",
        laneId: "lane-project",
        projectRoot: "/issued/project",
        force: false,
      });
      expect(navigate).toHaveBeenCalledWith(expect.objectContaining({
        chatSessionId: "chat-personal",
        projectRoot: undefined,
        tabCollection: "personal",
        force: false,
      }));
      expect(navigate).toHaveBeenLastCalledWith(expect.objectContaining({
        chatSessionId: "chat-project",
        projectRoot: "/issued/project",
        tabCollection: undefined,
        force: false,
      }));

      revokeBuiltInBrowserActorCapability("chat-personal");
      const revokedNavigate = {
        url: "https://example.test/revoked",
        chatSessionId: "chat-personal",
        [BUILT_IN_BROWSER_ACTOR_CAPABILITY_PARAM]: personalActorToken,
      };
      await expect(client.navigate(revokedNavigate)).rejects.toThrow(/issuer-validated chat capability/);
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});
