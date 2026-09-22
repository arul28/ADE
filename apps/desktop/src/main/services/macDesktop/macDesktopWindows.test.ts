import { describe, expect, it, vi } from "vitest";
import { createMacDesktopWindows, type MacDesktopWindowsDeps } from "./macDesktopWindows";

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as MacDesktopWindowsDeps["logger"];

function harness(options: { unpark?: () => Promise<void>; owned?: number[] } = {}) {
  const owned = options.owned ?? [11, 12];
  const released: number[] = [];
  const unpark = vi.fn(async () => {
    if (options.unpark) await options.unpark();
  });
  const windows = createMacDesktopWindows({
    logger: silentLogger,
    isDarwin: true,
    emit: vi.fn(),
    ensureProvider: async () => ({
      unpark,
      listWindows: async () => [],
    }) as unknown as Awaited<ReturnType<MacDesktopWindowsDeps["ensureProvider"]>>,
    activeProvider: () => null,
    requireDisplay: vi.fn(),
    assertPermission: vi.fn(),
    ownership: {
      listWindowRecords: () => owned.map((windowId) => ({ windowId, laneId: "lane-a" })),
      releaseWindow: (windowId: number) => { released.push(windowId); },
      touchDisplay: vi.fn(),
    } as unknown as MacDesktopWindowsDeps["ownership"],
  });
  return { windows, unpark, released };
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
});
