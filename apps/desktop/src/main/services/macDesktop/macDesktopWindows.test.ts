import { describe, expect, it, vi } from "vitest";
import { createMacDesktopWindows, type MacDesktopWindowsDeps } from "./macDesktopWindows";

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as MacDesktopWindowsDeps["logger"];

type UnparkReply = { releasedWindowIds: number[]; handedOverPid: number | null };

function harness(options: {
  unpark?: (windowId: number) => Promise<UnparkReply | void>;
  windowAction?: (action: string) => Promise<{ minimized?: boolean }>;
  owned?: number[];
} = {}) {
  const owned = options.owned ?? [11, 12];
  const released: number[] = [];
  const unwatched: number[] = [];
  const unpark = vi.fn(async ({ windowId }: { windowId: number; laneId?: string }): Promise<UnparkReply> => {
    const reply = options.unpark ? await options.unpark(windowId) : undefined;
    return reply ?? { releasedWindowIds: [windowId], handedOverPid: null };
  });
  const windowAction = vi.fn(async ({ action }: { laneId: string; windowId: number; action: string }) =>
    options.windowAction ? options.windowAction(action) : {});
  const windows = createMacDesktopWindows({
    logger: silentLogger,
    isDarwin: true,
    emit: vi.fn(),
    ensureProvider: async () => ({
      unpark,
      listWindows: async () => [],
      windowAction,
    }) as unknown as Awaited<ReturnType<MacDesktopWindowsDeps["ensureProvider"]>>,
    activeProvider: () => null,
    requireDisplay: vi.fn(),
    assertPermission: vi.fn(),
    ownership: {
      laneForWindow: (windowId: number) => owned.includes(windowId) ? "lane-a" : null,
      listWindowRecords: () => owned.map((windowId) => ({ windowId, laneId: "lane-a" })),
      releaseWindow: (windowId: number) => {
        if (!owned.includes(windowId)) return null;
        released.push(windowId);
        return { windowId, laneId: "lane-a" };
      },
      unwatchLaunch: (pid: number) => { unwatched.push(pid); return true; },
      touchDisplay: vi.fn(),
    } as unknown as MacDesktopWindowsDeps["ownership"],
  });
  return { windows, unpark, released, unwatched };
}

describe("releaseWindow", () => {
  it("reports a release that moved nothing instead of returning a quiet zero", async () => {
    // Every failure used to go to a debug line and the caller got
    // `{released: 0}`, so Release was indistinguishable from a button wired to
    // nothing — which is exactly how it looked to the person pressing it.
    const { windows } = harness({ unpark: async () => { throw new Error("window is gone"); } });
    await expect(windows.releaseWindow({ laneId: "lane-a", windowId: 11 }))
      .rejects.toThrow(/window is gone/);
  });

  it("stays quiet when there was nothing on the desktop to release", async () => {
    const { windows } = harness({ owned: [] });
    await expect(windows.releaseWindow({ laneId: "lane-a" })).resolves.toEqual({ released: 0 });
  });

  it("releases what it can and does not throw when one of several fails", async () => {
    let calls = 0;
    const { windows, released } = harness({
      unpark: async () => {
        calls += 1;
        if (calls === 1) throw new Error("first one is gone");
      },
    });
    await expect(windows.releaseWindow({ laneId: "lane-a" })).resolves.toEqual({ released: 1 });
    expect(released).toEqual([12]);
  });

  it("hands a launched app over whole: every window it had leaves the lane, and stop never quits it", async () => {
    // Releasing one Safari window used to drop only that window. The lane kept
    // watching the app, parked its next window, and stop still quit it.
    const { windows, unpark, released, unwatched } = harness({
      owned: [11, 12, 13],
      unpark: async (windowId) => (windowId === 11
        ? { releasedWindowIds: [11, 12], handedOverPid: 73002 }
        : { releasedWindowIds: [windowId], handedOverPid: null }),
    });
    await expect(windows.releaseWindow({ laneId: "lane-a" })).resolves.toEqual({ released: 3 });
    // 12 went with 11, so the driver is not asked for it again.
    expect(unpark.mock.calls.map(([args]) => args.windowId)).toEqual([11, 13]);
    // Every unpark names the lane, so the driver can refuse another lane's window.
    expect(unpark.mock.calls.map(([args]) => args.laneId)).toEqual(["lane-a", "lane-a"]);
    expect(released).toEqual([11, 12, 13]);
    expect(unwatched).toEqual([73002]);
  });
});

describe("windowAction", () => {
  it("does not report a minimize as successful when the driver says it stayed open", async () => {
    const { windows } = harness({ windowAction: async () => ({ minimized: false }) });

    await expect(windows.windowAction({ laneId: "lane-a", windowId: 11 }, "minimize"))
      .rejects.toMatchObject({ code: "WINDOWS_DESKTOP_WINDOW_ACTION_FAILED" });
  });

  it("accepts minimize replies from drivers that do not report the result yet", async () => {
    const { windows } = harness({ windowAction: async () => ({}) });

    await expect(windows.windowAction({ laneId: "lane-a", windowId: 11 }, "minimize"))
      .resolves.toMatchObject({ laneId: "lane-a", windowId: 11, action: "minimize" });
  });
});
