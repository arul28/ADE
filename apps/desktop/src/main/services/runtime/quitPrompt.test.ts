import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc";
import type { LocalRuntimeStatus, QuitPromptRequest, UpdateInterruptedChat } from "../../../shared/types";

/**
 * Quitting ADE and stopping its background service, through the real IPC
 * handlers. Electron is faked at its boundary: the window, its webContents,
 * the native message box, and `ipcMain`.
 */
const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  showMessageBox: vi.fn(),
  windows: [] as unknown[],
}));

vi.mock("electron", () => ({
  app: { isPackaged: false },
  BrowserWindow: {
    fromWebContents: (wc: { window?: unknown }) => wc.window ?? null,
    getFocusedWindow: () => electron.windows[0] ?? null,
    getAllWindows: () => electron.windows,
  },
  dialog: { showMessageBox: electron.showMessageBox },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, fn),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => void) => electron.listeners.set(channel, fn),
  },
}));

const { createQuitPrompt } = await import("./quitPrompt");
const { registerBackgroundServiceControls } = await import("./backgroundServiceControls");

const RENDERER_URL = "http://localhost:5199/work";
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function fakeWindow() {
  const contents = Object.assign(new EventEmitter(), {
    id: 7,
    send: vi.fn(),
    isLoading: () => false,
    isCrashed: () => false,
    isDestroyed: () => false,
    getURL: () => RENDERER_URL,
    window: undefined as unknown,
  });
  const win = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  });
  contents.window = win;
  electron.windows = [win];
  const event = { sender: contents, senderFrame: { url: RENDERER_URL } };
  return { win, contents, event };
}

const status = (mode: LocalRuntimeStatus["runtimeMode"]): LocalRuntimeStatus =>
  ({ runtimeMode: mode, appFallback: mode === "app_fallback" ? { reason: "service_not_running", since: "t" } : null }) as LocalRuntimeStatus;

const chat = (sessionId: string): UpdateInterruptedChat => ({ sessionId, title: sessionId, projectName: "ADE" });

/** Lets the prompt's awaited probes settle; no wall-clock wait. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

let dir = "";
let statePath = "";

beforeEach(() => {
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5199");
  electron.handlers.clear();
  electron.listeners.clear();
  electron.showMessageBox.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-quit-prompt-"));
  statePath = path.join(dir, "ade-state.json");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("quit prompt", () => {
  function setup(overrides: Partial<Parameters<typeof createQuitPrompt>[0]> = {}) {
    let mode: LocalRuntimeStatus["runtimeMode"] = "primary";
    const restartService = vi.fn(async () => { mode = "primary"; });
    const armResume = vi.fn(async (ids: readonly string[]) => ids.map(chat));
    const deps = {
      logger,
      globalStatePath: statePath,
      getRuntimeStatus: () => status(mode),
      collectImpact: async () => ({ connectedPhones: [], interruptedChats: [chat("a")] }),
      collectLiveChats: vi.fn(async (): Promise<UpdateInterruptedChat[] | null> => []),
      restartService,
      armResume,
      ...overrides,
    };
    const prompt = createQuitPrompt(deps);
    return { prompt, restartService, armResume, setMode: (next: LocalRuntimeStatus["runtimeMode"]) => { mode = next; } };
  }

  async function ask(prompt: ReturnType<typeof createQuitPrompt>, relaunch = false) {
    const { win, contents, event } = fakeWindow();
    const confirming = prompt.confirm(win as never, relaunch);
    await settle();
    const request = contents.send.mock.calls.find(([channel]) => channel === IPC.appQuitPrompt)?.[1] as QuitPromptRequest;
    expect(request, "the window was asked").toBeDefined();
    electron.listeners.get(IPC.appQuitPromptShown)?.(event, request.requestId);
    const answer = (choice: string, dontAskAgain = false) =>
      electron.handlers.get(IPC.appAnswerQuitPrompt)?.(event, { requestId: request.requestId, choice, dontAskAgain });
    return { confirming, request, answer, contents, event };
  }

  it("asks in the window, honours the answer, and only that window may answer", async () => {
    const { prompt } = setup();
    const { confirming, request, answer, event } = await ask(prompt);
    expect(request).toMatchObject({ relaunch: false, runningAgents: 1, appOwnedService: null });
    const stranger = { ...event, senderFrame: { url: "https://example.com/" } };
    expect(await electron.handlers.get(IPC.appAnswerQuitPrompt)?.(stranger, { requestId: request.requestId, choice: "quit" })).toBeNull();
    await answer("keep");
    expect(await confirming).toBe(false);
    expect(electron.showMessageBox).not.toHaveBeenCalled();
  });

  it("falls back to the native box when the window reloads mid-question, and Don't ask again then skips it", async () => {
    const { prompt } = setup();
    electron.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: true });
    const { confirming, contents, request } = await ask(prompt);
    contents.emit("did-start-loading");
    expect(await confirming).toBe(true);
    expect(contents.send).toHaveBeenCalledWith(IPC.appQuitPromptDismiss, request.requestId);
    const options = electron.showMessageBox.mock.calls[0]?.at(-1) as Electron.MessageBoxOptions;
    expect(options.buttons).toEqual(["Keep ADE open", "Quit ADE"]);
    expect(options).toMatchObject({ defaultId: 1, cancelId: 0, checkboxChecked: false });
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({ askBeforeQuit: false });

    const { win, contents: next } = fakeWindow();
    expect(await prompt.confirm(win as never, false)).toBe(true);
    expect(next.send).not.toHaveBeenCalled();
  });

  it("always asks when quitting would stop agents, even after Don't ask again", async () => {
    fs.writeFileSync(statePath, JSON.stringify({ askBeforeQuit: false, lastProjectRoot: "/keep/me" }));
    const { prompt, setMode } = setup();
    setMode("app_fallback");
    const { confirming, request, answer } = await ask(prompt);
    expect(request.appOwnedService).toEqual({ repair: "restart" });
    await answer("quit", true);
    expect(await confirming).toBe(true);
    // The owned prompt offers no Don't ask again, and the rest of the file survives.
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toEqual({ askBeforeQuit: false, lastProjectRoot: "/keep/me" });
  });

  it.each([
    {
      name: "a confirmed handover resumes only the chats that stopped",
      live: [[chat("a"), chat("b")], [chat("b")]],
      restart: "ok",
      expected: { repaired: true, resumedChats: 1 },
      armed: ["a"],
    },
    {
      name: "an unknown read after the restart resumes nothing",
      live: [[chat("a")], null],
      restart: "ok",
      expected: { repaired: true, resumedChats: 0 },
      armed: null,
    },
    {
      name: "a failed restart resumes nothing",
      live: [[chat("a")], []],
      restart: "throws",
      expected: { repaired: false, resumedChats: 0 },
      armed: null,
    },
    {
      name: "a restart that leaves the desktop on its own brain resumes nothing",
      live: [[chat("a")], []],
      restart: "stays_fallback",
      expected: { repaired: false, resumedChats: 0 },
      armed: null,
    },
  ])("Repair service: $name", async ({ live, restart, expected, armed }) => {
    const collectLiveChats = vi.fn(async (): Promise<UpdateInterruptedChat[] | null> => null);
    for (const read of live) collectLiveChats.mockResolvedValueOnce(read);
    const { prompt, restartService, armResume, setMode } = setup({ collectLiveChats });
    setMode("app_fallback");
    restartService.mockImplementation(async () => {
      if (restart === "throws") throw new Error("service did not come back");
      if (restart === "ok") setMode("primary");
    });
    const { confirming, answer } = await ask(prompt);
    const repairing = answer("repair");
    expect(prompt.isRepairing()).toBe(true);
    expect(await repairing).toEqual(expected);
    expect(await confirming).toBe(false);
    expect(prompt.isRepairing()).toBe(false);
    if (armed) expect(armResume).toHaveBeenCalledWith(armed);
    else expect(armResume).not.toHaveBeenCalled();
  });
});

describe("Settings → Stop and quit ADE", () => {
  function setup(overrides: Record<string, unknown> = {}) {
    const order: string[] = [];
    let releaseInstall: () => void = () => {};
    const pool = {
      getStatus: () => status("primary"),
      activitySummary: vi.fn(async () => ({ activeAgentTurns: 1, activeWorkSessions: 0, idle: false })),
      beginUpdateWindow: vi.fn(() => { order.push("hold"); }),
      endUpdateWindow: vi.fn(() => { order.push("release"); }),
      waitForServiceInstall: vi.fn(() => new Promise<void>((resolve) => {
        releaseInstall = () => { order.push("install_settled"); resolve(); };
      })),
      uninstallServiceBestEffort: vi.fn(async () => { order.push("uninstall"); }),
    };
    const deps = {
      logger,
      analytics: null,
      manageService: true,
      pool,
      collectLiveChats: vi.fn(async (): Promise<UpdateInterruptedChat[] | null> => [chat("a")]),
      getRunningLaneDeleteLabels: vi.fn(async () => [] as string[]),
      isRepairing: () => false,
      isShuttingDown: () => false,
      shutdown: vi.fn(() => { order.push("shutdown"); }),
      ...overrides,
    };
    registerBackgroundServiceControls(deps as never);
    const { event } = fakeWindow();
    const stop = (request: unknown) => electron.handlers.get(IPC.appStopBackgroundServiceAndQuit)?.(event, request);
    return { deps, pool, order, stop, releaseInstall: () => releaseInstall() };
  }

  const confirmedA = { confirmedSessionIds: ["a"], confirmedOtherProjectsBusy: false };

  it.each([
    { name: "the running chats cannot be read", overrides: { collectLiveChats: async () => null }, request: confirmedA },
    { name: "the machine-wide activity cannot be read", overrides: {}, failActivity: true, request: confirmedA },
    { name: "an agent started after the confirmation", overrides: { collectLiveChats: async () => [chat("a"), chat("b")] }, request: confirmedA },
    { name: "a project that isn't open became busy", overrides: {}, busyProjects: 2, request: confirmedA },
    { name: "a lane delete is running", overrides: { getRunningLaneDeleteLabels: async () => ["ADE"] }, request: confirmedA },
    { name: "a repair is running", overrides: { isRepairing: () => true }, request: confirmedA },
    { name: "ADE is already quitting", overrides: { isShuttingDown: () => true }, request: confirmedA },
    { name: "the request is malformed", overrides: {}, request: { confirmedSessionIds: "a" } },
  ])("refuses and stops nothing when $name", async ({ overrides, failActivity, busyProjects, request }) => {
    const { pool, deps, stop } = setup(overrides);
    if (failActivity) pool.activitySummary.mockRejectedValue(new Error("timed out"));
    if (busyProjects) pool.activitySummary.mockResolvedValue({ activeAgentTurns: busyProjects, activeWorkSessions: 0, idle: false });
    const result = (await stop(request)) as { ok: boolean; message?: string };
    expect(result.ok).toBe(false);
    expect(result.message).toBeTruthy();
    expect(pool.uninstallServiceBestEffort).not.toHaveBeenCalled();
    expect(pool.beginUpdateWindow).not.toHaveBeenCalled();
    expect(deps.shutdown).not.toHaveBeenCalled();
  });

  it("holds repairs, waits out an in-flight install, removes the service, then quits", async () => {
    const { stop, order, releaseInstall, pool } = setup();
    const stopping = stop(confirmedA);
    await settle();
    expect(order).toEqual(["hold"]);
    expect(pool.uninstallServiceBestEffort).not.toHaveBeenCalled();
    releaseInstall();
    expect(await stopping).toEqual({ ok: true });
    expect(order).toEqual(["hold", "install_settled", "uninstall", "shutdown"]);
  });

  it("releases the hold and stays open when removing the service fails", async () => {
    const { stop, order, releaseInstall, pool, deps } = setup();
    pool.uninstallServiceBestEffort.mockRejectedValue(new Error("launchctl failed"));
    const stopping = stop(confirmedA);
    await settle();
    releaseInstall();
    expect(await stopping).toEqual({ ok: false, message: "launchctl failed" });
    expect(order).toEqual(["hold", "install_settled", "release"]);
    expect(deps.shutdown).not.toHaveBeenCalled();
  });
});
