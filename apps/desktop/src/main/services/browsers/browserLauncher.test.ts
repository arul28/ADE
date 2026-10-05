import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, execFileMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}));

// This launcher only reads the command detection already resolved; finding a
// browser is the other module's contract and its own test file's subject.
vi.mock("./browserDetection", () => ({
  detectBrowsersCached: async () => [],
  // `safari` stands in for a browser that vanished between the menu being
  // drawn and the row being clicked: detection found it, the launch cannot.
  resolveDetectedBrowserCommand: (target: string) =>
    target === "safari" ? null : "/Applications/Google Chrome.app",
}));

import { openUrlInBrowser } from "./browserLauncher";

/**
 * What the launcher promises the menu that called it: a closed set of
 * destinations, and a failure it can show instead of closing as if it worked.
 */

const realPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.clearAllMocks();
});

beforeEach(() => {
  // The spawn branch is the one that reports failures; pin it so the case runs
  // the same way on every host.
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
});

type FakeChild = {
  once: (event: string, listener: (arg?: unknown) => void) => FakeChild;
  unref: ReturnType<typeof vi.fn>;
  emit: (event: string, arg?: unknown) => void;
};

/** A child process stub that fires the one event the launcher is waiting on. */
function fakeChild(): FakeChild {
  const listeners = new Map<string, Array<(arg?: unknown) => void>>();
  const child: FakeChild = {
    once(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return child;
    },
    unref: vi.fn(),
    emit(event, arg) {
      for (const listener of listeners.get(event) ?? []) listener(arg);
    },
  };
  return child;
}

describe("openUrlInBrowser", () => {
  // The renderer sends a catalog id and a URL, never a command; both halves of
  // that promise are enforced here, before anything is launched.
  it.each([
    ["a URL the OS opener is not allowed to take", "file:///etc/passwd", "chrome"],
    ["a browser id that is not one ADE knows", "https://example.test/docs", "not-a-browser"],
  ])("refuses %s", async (_label, url, browserId) => {
    await expect(openUrlInBrowser(url, browserId)).rejects.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // macOS never spawns the browser itself: it hands the URL to `/usr/bin/open`
  // by absolute path, which is the branch the reviewers of this file flagged as
  // untested and the one ADE's own machines run.
  it("opens through the absolute helper on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null);
      return {};
    });

    await expect(openUrlInBrowser("https://example.test/docs", "chrome")).resolves.toBeUndefined();

    expect(execFileMock).toHaveBeenCalledWith(
      "/usr/bin/open",
      ["-a", "/Applications/Google Chrome.app", "https://example.test/docs"],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("reports a macOS handoff the OS refused", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error("open: no such application"));
      return {};
    });

    await expect(openUrlInBrowser("https://example.test/docs", "chrome"))
      .rejects.toThrow(/no such application/);
  });

  it("reports a browser that detection can no longer find", async () => {
    // The 30-second detection cache can expire between the menu rendering and
    // the click, so a browser uninstalled in that window lands here.
    await expect(openUrlInBrowser("https://example.test/docs", "safari"))
      .rejects.toThrow(/not installed/);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("hands the resolved executable the URL, then lets go of the process", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const opening = openUrlInBrowser("https://example.test/docs", "chrome");
    // The launcher awaits detection first, so the child is only wired up once
    // spawn has been reached — wait for that rather than racing it.
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.emit("spawn");

    await expect(opening).resolves.toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith(
      "/Applications/Google Chrome.app",
      ["https://example.test/docs"],
      expect.objectContaining({ detached: true }),
    );
    // The browser outlives ADE; the child must not hold the app open.
    expect(child.unref).toHaveBeenCalled();
  });

  it("reports a browser that could not be started", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const opening = openUrlInBrowser("https://example.test/docs", "chrome");
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled());
    child.emit("error", new Error("spawn chrome ENOENT"));

    // The menu closes on a resolved promise, so a launch that never happened
    // has to reject or the failure is invisible.
    await expect(opening).rejects.toThrow(/ENOENT/);
    expect(child.unref).not.toHaveBeenCalled();
  });
});
