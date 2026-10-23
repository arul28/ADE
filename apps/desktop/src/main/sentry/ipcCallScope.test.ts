import { describe, expect, it } from "vitest";
import { callerReportsFailureParam, isInCapturedIpcCall, runInCapturedIpcCall } from "./ipcCallScope";

describe("ipcCallScope", () => {
  it("flags only the calls an IPC handler makes while it is still in flight", async () => {
    let releasePump!: () => void;
    const pumpRuns = new Promise<void>((resolve) => { releasePump = resolve; });
    let pumpSeen: boolean | null = null;

    const handlerSeen = await runInCapturedIpcCall(async () => {
      // A pump the handler starts and does not wait for, like an event stream.
      void pumpRuns.then(() => { pumpSeen = isInCapturedIpcCall(); });
      await Promise.resolve();
      return callerReportsFailureParam();
    });

    releasePump();
    await pumpRuns;
    await Promise.resolve();

    expect(handlerSeen).toEqual({ callerReportsFailure: true });
    // The handler has returned: nobody will report what the pump does now.
    expect(pumpSeen).toBe(false);
    expect(callerReportsFailureParam()).toEqual({});
  });

  it("closes the scope when the handler throws", async () => {
    let leftOpen: boolean | null = null;
    await expect(runInCapturedIpcCall(async () => {
      setTimeout(() => { leftOpen = isInCapturedIpcCall(); }, 0);
      throw new Error("handler failed");
    })).rejects.toThrow("handler failed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leftOpen).toBe(false);
    expect(isInCapturedIpcCall()).toBe(false);
  });
});
