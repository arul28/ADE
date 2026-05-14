import { describe, expect, it } from "vitest";
import { IPC } from "../../../shared/ipc";
import { ipcInvokeTimeoutMs } from "./ipcTimeouts";

describe("ipcInvokeTimeoutMs", () => {
  it("uses the lane delete budget for runtime-backed lane delete actions", () => {
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "delete", args: { laneId: "lane-1" } },
    }])).toBe(4 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "lane", action: "delete", args: { laneId: "lane-1" } },
    }])).toBe(4 * 60_000);
  });

  it("keeps ordinary runtime actions on the default timeout", () => {
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "list" },
    }])).toBe(30_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction)).toBe(30_000);
  });

  it("keeps iOS launch timeout separate from macOS VM provisioning", () => {
    expect(ipcInvokeTimeoutMs(IPC.iosSimulatorLaunch)).toBe(10 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.macosVmProvision)).toBe(120 * 60_000);
  });

  it("uses shorter control timeouts for macOS VM actions after provisioning", () => {
    expect(ipcInvokeTimeoutMs(IPC.macosVmStart)).toBe(2 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.macosVmStop)).toBe(2 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.macosVmCaptureScreenshot)).toBe(60_000);
  });
});
