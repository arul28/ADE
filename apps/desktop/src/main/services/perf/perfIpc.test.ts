import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc";

const ipcHandlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>(),
);
const ipcHandleMock = vi.hoisted(() => vi.fn());
const ipcRemoveHandlerMock = vi.hoisted(() => vi.fn());
const aggregateMock = vi.hoisted(() => vi.fn());
const appendEventMock = vi.hoisted(() => vi.fn());
const finishPerfRunMock = vi.hoisted(() => vi.fn());
const getActiveRunMock = vi.hoisted(() => vi.fn());
const isRunActiveMock = vi.hoisted(() => vi.fn());
const stopMetricsSamplerMock = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({
  ipcMain: {
    handle: ipcHandleMock.mockImplementation(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        ipcHandlers.set(channel, handler);
      },
    ),
    removeHandler: ipcRemoveHandlerMock,
  },
}));

vi.mock("./aggregator", () => ({
  aggregate: aggregateMock,
}));

vi.mock("./metricsSampler", () => ({
  stopMetricsSampler: stopMetricsSamplerMock,
}));

vi.mock("./perfLog", () => ({
  appendEvent: appendEventMock,
  finishPerfRun: finishPerfRunMock,
  getActiveRun: getActiveRunMock,
  isRunActive: isRunActiveMock,
}));

import { registerPerfIpcHandlers } from "./perfIpc";

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = ipcHandlers.get(channel);
  if (!registered) throw new Error(`Missing handler for ${channel}`);
  return registered;
}

describe("registerPerfIpcHandlers", () => {
  beforeEach(() => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    registerPerfIpcHandlers();
  });

  it("records manualStep events", () => {
    isRunActiveMock.mockReturnValue(true);

    const result = handler(IPC.perfRecordEvent)({}, {
      kind: "manualStep",
      ts: 123,
      name: "git-actions-stage",
      phase: "start",
    });

    expect(result).toEqual({ ok: true });
    expect(appendEventMock).toHaveBeenCalledWith({
      kind: "manualStep",
      ts: 123,
      name: "git-actions-stage",
      phase: "start",
    });
  });

  it("stops sampling and clears the active run after finalizing", () => {
    const summary = { runId: "run-1" };
    getActiveRunMock.mockReturnValue({ runId: "run-1" });
    aggregateMock.mockReturnValue(summary);

    const result = handler(IPC.perfFinalize)({});

    expect(result).toEqual({ ok: true, summary });
    expect(stopMetricsSamplerMock.mock.invocationCallOrder[0]!).toBeLessThan(
      aggregateMock.mock.invocationCallOrder[0]!,
    );
    expect(finishPerfRunMock).toHaveBeenCalledWith("run-1");
  });
});
