import { describe, expect, it } from "vitest";
import { IPC } from "../../../shared/ipc";
import { ipcInvokeTimeoutMs } from "./ipcTimeouts";

describe("ipcInvokeTimeoutMs", () => {
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
