import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, WebContents } from "electron";
import {
  createBuiltInBrowserPermissionController,
  shouldAllowGoogleAuthPermissionCheck,
  shouldAllowGoogleAuthPermissionRequest,
} from "./builtInBrowserPermissions";

vi.mock("electron", () => ({
  dialog: { showMessageBox: vi.fn() },
}));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function permissionPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-permissions-"));
  tempDirs.push(dir);
  return path.join(dir, "permissions.json");
}

function fakeSession() {
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

describe("builtInBrowserPermissions", () => {
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
    const firstSession = fakeSession();
    controller.configureSession(firstSession.session);

    await expect(firstSession.request(webContents, "notifications")).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(controller.list()).toMatchObject([{
      permission: "notifications",
      origin: "https://example.com",
      decision: "allow",
    }]);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

    const restored = createBuiltInBrowserPermissionController({
      filePath,
      isManagedWebContents: () => true,
      resolveParentWindow: () => null,
      prompt: vi.fn(async () => ({ granted: false, remember: false })),
    });
    const restoredSession = fakeSession();
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
    const session = fakeSession();
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
    const session = fakeSession();
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
    const session = fakeSession();
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
    const session = fakeSession();
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
