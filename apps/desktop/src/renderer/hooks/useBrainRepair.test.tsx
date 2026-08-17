/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AdeAccountSessionRepairResult } from "../../shared/types/account";
import { useBrainRepair } from "./useBrainRepair";

afterEach(() => {
  cleanup();
  delete (window as { ade?: unknown }).ade;
});

function stubBridge(bridge: {
  repairSession?: () => Promise<AdeAccountSessionRepairResult>;
  restartBackgroundService?: () => Promise<void>;
}): void {
  (window as { ade?: unknown }).ade = {
    account: bridge.repairSession ? { repairSession: bridge.repairSession } : {},
    app: bridge.restartBackgroundService
      ? { restartBackgroundService: bridge.restartBackgroundService }
      : {},
  };
}

async function runRepair(result: { current: ReturnType<typeof useBrainRepair> }) {
  await act(async () => {
    result.current.run();
  });
  await waitFor(() => expect(result.current.pending).toBe(false));
}

describe("useBrainRepair", () => {
  it("repairs the stored sign-in rather than only restarting the service", async () => {
    // The control is offered for exactly one condition — the stored session
    // could not be read — and restarting the service cannot fix that: the
    // replacement process reads the same unreadable file.
    const repairSession = vi.fn(async () => ({
      outcome: "repaired" as const,
      readable: true,
      recoveredKeys: 1,
      brainRestarted: true,
    }));
    const restartBackgroundService = vi.fn(async () => {});
    stubBridge({ repairSession, restartBackgroundService });

    const { result } = renderHook(() => useBrainRepair());
    await runRepair(result);

    expect(repairSession).toHaveBeenCalledTimes(1);
    expect(restartBackgroundService).not.toHaveBeenCalled();
    expect(result.current.notice).toEqual({ tone: "ok", text: "Fixed — your sign-in is back." });
  });

  it("warns when the credential repair succeeds but the background service does not restart", async () => {
    // The two halves are reported separately for a reason. Calling this "fixed"
    // while the service is still down describes half the outcome.
    stubBridge({
      repairSession: async () => ({
        outcome: "repaired",
        readable: true,
        recoveredKeys: 1,
        brainRestarted: false,
      }),
    });

    const { result } = renderHook(() => useBrainRepair());
    await runRepair(result);

    expect(result.current.notice?.tone).toBe("warn");
    expect(result.current.notice?.text).toContain("didn't come back");
    expect(result.current.error).toBeNull();
  });

  it("says to sign in again only when nothing on this computer can open the store", async () => {
    stubBridge({
      repairSession: async () => ({
        outcome: "sign_in_required",
        readable: false,
        recoveredKeys: 0,
        brainRestarted: true,
      }),
    });

    const { result } = renderHook(() => useBrainRepair());
    await runRepair(result);

    expect(result.current.notice).toEqual({
      tone: "warn",
      text: "Your sign-in can't be read on this computer. Sign in again.",
    });
  });

  it("falls back to a bare restart on a preload without the repair route", async () => {
    // `repairSession` is optional on the bridge; an older preload must keep the
    // button working rather than losing it.
    const restartBackgroundService = vi.fn(async () => {});
    stubBridge({ restartBackgroundService });

    const { result } = renderHook(() => useBrainRepair());
    expect(result.current.available).toBe(true);
    await runRepair(result);

    expect(restartBackgroundService).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it("reports a thrown repair through error, not through a success notice", async () => {
    stubBridge({
      repairSession: async () => {
        throw new Error("repair exploded");
      },
    });

    const { result } = renderHook(() => useBrainRepair());
    await runRepair(result);

    expect(result.current.error).toContain("repair exploded");
    expect(result.current.notice).toBeNull();
  });
});
