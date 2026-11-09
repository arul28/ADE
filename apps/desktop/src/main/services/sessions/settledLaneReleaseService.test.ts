import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { setSessionLifecycleSettings } from "./sessionLifecycleSettings";
import { createSettledLaneReleaseService, SETTLED_LANE_RELEASE_DELAY_MS } from "./settledLaneReleaseService";

const T0 = Date.parse("2026-11-09T12:00:00.000Z");
const AFTER_WAIT = T0 + SETTLED_LANE_RELEASE_DELAY_MS + 1;
const SETTLED_AT = new Date(T0).toISOString();

function chat(overrides: Partial<TerminalSessionSummary> & { id: string }): TerminalSessionSummary {
  return { laneId: "lane-1", toolType: "claude-chat", archivedAt: null, endedAt: null, settledAt: null, settleOverride: null, ...overrides } as TerminalSessionSummary;
}

function memoryDb() {
  const values = new Map<string, unknown>();
  return {
    getJson: <T,>(key: string) => (values.has(key) ? (values.get(key) as T) : null),
    setJson: (key: string, value: unknown) => void values.set(key, value),
  };
}

function setup(page: TerminalSessionSummary[], db = memoryDb(), lane: () => TerminalSessionSummary[] = () => page) {
  const steps = {
    stopDevServers: vi.fn(async (_laneId: string, _chatIds: ReadonlySet<string>): Promise<{ released: string[] }> => ({ released: [":3000"] })),
    powerOffAppleDevices: vi.fn(async () => ({ released: [] as string[] })),
    stopAndroidEmulators: vi.fn(async () => ({ released: [] as string[] })),
    releaseMacDesktop: vi.fn(async () => ({ released: [] as string[] })),
  };
  const notify = vi.fn();
  const start = (now: number) => createSettledLaneReleaseService({
    ...steps,
    db,
    listSessions: () => page,
    listLaneSessions: lane,
    notify,
    now: () => now,
    everyMs: 3_600_000,
  });
  return { steps, notify, db, start };
}

describe("settled lane release", () => {
  let home: string;
  const previousHome = process.env.ADE_HOME;

  const turnOn = (db: ReturnType<typeof memoryDb>) => setSessionLifecycleSettings({
    db,
    settings: { autoSettleLaneSessionsOnPrMerge: true, releaseLaneResourcesOnSettle: true },
    currentPrs: [],
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-settled-release-"));
    process.env.ADE_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ADE_HOME;
    else process.env.ADE_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { name: "the setting is off", on: false, page: [chat({ id: "a", settledAt: SETTLED_AT })], at: AFTER_WAIT },
    { name: "the wait has not passed", on: true, page: [chat({ id: "a", settledAt: SETTLED_AT })], at: AFTER_WAIT - 2 },
    { name: "another chat is active", on: true, page: [chat({ id: "a", settledAt: SETTLED_AT }), chat({ id: "b" })], at: AFTER_WAIT },
    { name: "a keep-active pin outranks an old settle", on: true, page: [chat({ id: "a", settledAt: SETTLED_AT, settleOverride: "active" })], at: AFTER_WAIT },
    {
      name: "an active chat sits past the listing page",
      on: true,
      page: [chat({ id: "a", settledAt: SETTLED_AT })],
      lane: [chat({ id: "a", settledAt: SETTLED_AT }), chat({ id: "old-active" })],
      at: AFTER_WAIT,
    },
  ])("stops nothing when $name", async ({ on, page, lane, at }) => {
    const { steps, notify, db, start } = setup(page, memoryDb(), () => lane ?? page);
    if (on) turnOn(db);
    const service = start(at);
    await service.sweep();
    service.dispose();
    expect(steps.stopDevServers).not.toHaveBeenCalled();
    expect(steps.powerOffAppleDevices).not.toHaveBeenCalled();
    expect(steps.stopAndroidEmulators).not.toHaveBeenCalled();
    expect(steps.releaseMacDesktop).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("times a pinned chat from when it was first seen, across a restart, and releases once", async () => {
    const page = [chat({ id: "settled", settledAt: SETTLED_AT }), chat({ id: "pinned", settleOverride: "settled" })];
    const { steps, notify, db, start } = setup(page);
    turnOn(db);

    const first = start(T0);
    await first.sweep();
    first.dispose();
    expect(steps.stopDevServers).not.toHaveBeenCalled();

    const restarted = start(AFTER_WAIT);
    await restarted.sweep();
    await restarted.sweep();
    restarted.dispose();
    expect(steps.stopDevServers).toHaveBeenCalledTimes(1);
    expect([...steps.stopDevServers.mock.calls[0]![1]].sort()).toEqual(["pinned", "settled"]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("retries a failed step on a later sweep, and a chat waking during it keeps the rest", async () => {
    const settled = [chat({ id: "a", settledAt: SETTLED_AT })];
    let awake = false;
    const { steps, db, start } = setup(settled, memoryDb(), () => (awake ? [chat({ id: "a" })] : settled));
    turnOn(db);
    steps.stopDevServers.mockRejectedValueOnce(new Error("port scan failed"));
    const service = start(AFTER_WAIT);

    await service.sweep();
    expect(steps.stopDevServers).toHaveBeenCalledTimes(1);
    expect(steps.powerOffAppleDevices).toHaveBeenCalledTimes(1);

    steps.stopDevServers.mockImplementationOnce(async () => {
      awake = true;
      return { released: [] };
    });
    await service.sweep();
    service.dispose();
    expect(steps.stopDevServers).toHaveBeenCalledTimes(2);
    expect(steps.powerOffAppleDevices).toHaveBeenCalledTimes(1);
    expect(steps.releaseMacDesktop).toHaveBeenCalledTimes(1);
  });
});
