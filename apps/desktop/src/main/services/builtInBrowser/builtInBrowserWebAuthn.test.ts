import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

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

async function loadModule() {
  vi.resetModules();
  return import("./builtInBrowserWebAuthn");
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const originalTouchIdWebAuthnEnv = process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN;

describe("configureBuiltInBrowserWebAuthn", () => {
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
    const { configureBuiltInBrowserWebAuthn } = await loadModule();

    configureBuiltInBrowserWebAuthn();
    configureBuiltInBrowserWebAuthn();

    expect(fakes.session.fromPartition).toHaveBeenCalledTimes(1);
    expect(fakes.session.fromPartition).toHaveBeenCalledWith("persist:ade-browser");
    expect(fakes.handlers["select-webauthn-account"]).toHaveLength(1);
    expect(fakes.app.configureWebAuthn).not.toHaveBeenCalled();
  });

  it("configures Touch ID WebAuthn when explicitly enabled", async () => {
    process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN = "1";
    const { configureBuiltInBrowserWebAuthn } = await loadModule();

    configureBuiltInBrowserWebAuthn();

    if (process.platform === "darwin") {
      expect(fakes.app.configureWebAuthn).toHaveBeenCalledWith({
        touchID: { keychainAccessGroup: "VQ372F39G6.com.ade.desktop.webauthn" },
      });
    } else {
      expect(fakes.app.configureWebAuthn).not.toHaveBeenCalled();
    }
  });

  it("ships the matching macOS keychain access-group entitlement", () => {
    const entitlementPath = fileURLToPath(new URL(
      "../../../../build/entitlements.mac.plist",
      import.meta.url,
    ));
    const entitlements = fs.readFileSync(entitlementPath, "utf8");

    expect(entitlements).toContain("<key>keychain-access-groups</key>");
    expect(entitlements).toContain("<string>VQ372F39G6.com.ade.desktop.webauthn</string>");
  });

  it("configures Touch ID WebAuthn by default in packaged macOS builds", async () => {
    fakes.app.isPackaged = true;
    const { configureBuiltInBrowserWebAuthn } = await loadModule();

    configureBuiltInBrowserWebAuthn();

    if (process.platform === "darwin") {
      expect(fakes.app.configureWebAuthn).toHaveBeenCalledWith({
        touchID: { keychainAccessGroup: "VQ372F39G6.com.ade.desktop.webauthn" },
      });
    } else {
      expect(fakes.app.configureWebAuthn).not.toHaveBeenCalled();
    }
  });

  it("lets packaged builds disable Touch ID WebAuthn with an env override", async () => {
    fakes.app.isPackaged = true;
    process.env.ADE_ENABLE_TOUCH_ID_WEBAUTHN = "0";
    const { configureBuiltInBrowserWebAuthn } = await loadModule();

    configureBuiltInBrowserWebAuthn();

    expect(fakes.app.configureWebAuthn).not.toHaveBeenCalled();
  });

  it("selects the only returned passkey without prompting", async () => {
    const { configureBuiltInBrowserWebAuthn } = await loadModule();
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
    const { configureBuiltInBrowserWebAuthn } = await loadModule();
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
    const { configureBuiltInBrowserWebAuthn } = await loadModule();
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
