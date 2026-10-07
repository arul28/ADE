import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../logging/logger";
import { CdpClient } from "../shared/cdpClient";
import { createUserBrowserAttachService } from "./userBrowserAttachService";

/**
 * The browser's end of the DevTools socket: one page target the user is
 * looking at. `CdpClient.connect` is the WebSocket to the user's browser, the
 * only boundary faked here; discovery reads a real DevToolsActivePort file.
 */
function fakeBrowserConnection(tab: { targetId: string; title: string; url: string }) {
  let closed = false;
  const send = async (method: string): Promise<unknown> => {
    if (closed) throw new Error("CDP connection closed.");
    if (method === "Target.getTargets") return { targetInfos: [{ type: "page", ...tab }] };
    if (method === "Target.attachToTarget") return { sessionId: `session-${tab.targetId}` };
    if (method === "Runtime.evaluate") return { result: { value: { visible: true, focused: true } } };
    return {};
  };
  const channel = { send, on: () => () => {} };
  const client = {
    ...channel,
    session: () => channel,
    onClose: () => () => {},
    isClosed: () => closed,
    close: async () => { closed = true; },
  };
  return { client: client as unknown as CdpClient, isClosed: () => closed };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const tempDirs: string[] = [];

function chromeProfileWithDebugging(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-user-browser-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "9222\n/devtools/browser/abc-123\n");
  return dir;
}

function createService() {
  return createUserBrowserAttachService({
    projectRoot: os.tmpdir(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger,
    machineName: () => "Test Mac",
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("userBrowserAttachService attach lifecycle", () => {
  it("a detach while the attach waits on the browser's prompt leaves the chat on ADE's browser", async () => {
    const userDataDir = chromeProfileWithDebugging();
    const connected = deferred<CdpClient>();
    const connect = vi.spyOn(CdpClient, "connect").mockReturnValue(connected.promise);
    const service = createService();

    const attaching = service.attach({ chatSessionId: "chat-1", userDataDir });
    await vi.waitFor(() => expect(connect).toHaveBeenCalledWith("ws://127.0.0.1:9222/devtools/browser/abc-123", expect.anything()));

    const detached = await service.detach({ chatSessionId: "chat-1" });
    expect(detached.detached).toBe(true);

    // The user clicks Allow only after the chat gave up.
    const browser = fakeBrowserConnection({ targetId: "t-1", title: "Inbox", url: "https://mail.test/" });
    connected.resolve(browser.client);
    await expect(attaching).rejects.toThrow(/cancelled/i);

    expect(service.routes("chat-1", "navigate")).toBe(false);
    expect((await service.status({ chatSessionId: "chat-1" })).attached).toBe(false);
    expect(browser.isClosed()).toBe(true);
  });

  it("a newer attach supersedes an older one that is still waiting", async () => {
    const userDataDir = chromeProfileWithDebugging();
    const first = deferred<CdpClient>();
    const second = deferred<CdpClient>();
    vi.spyOn(CdpClient, "connect").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const service = createService();

    const older = service.attach({ chatSessionId: "chat-1", userDataDir });
    await vi.waitFor(() => expect(CdpClient.connect).toHaveBeenCalledTimes(1));
    const newer = service.attach({ chatSessionId: "chat-1", userDataDir });
    await vi.waitFor(() => expect(CdpClient.connect).toHaveBeenCalledTimes(2));

    const newerBrowser = fakeBrowserConnection({ targetId: "t-new", title: "Docs", url: "https://docs.test/" });
    second.resolve(newerBrowser.client);
    await expect(newer).resolves.toMatchObject({ attached: true, tab: { targetId: "t-new" } });

    const olderBrowser = fakeBrowserConnection({ targetId: "t-old", title: "Inbox", url: "https://mail.test/" });
    first.resolve(olderBrowser.client);
    await expect(older).rejects.toThrow(/cancelled/i);

    // The newer attachment survives the older one's late answer.
    expect(olderBrowser.isClosed()).toBe(true);
    expect(newerBrowser.isClosed()).toBe(false);
    expect(service.routes("chat-1", "navigate")).toBe(true);
    expect((await service.status({ chatSessionId: "chat-1" })).tab?.targetId).toBe("t-new");
    service.dispose();
  });
});
