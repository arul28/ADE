/* @vitest-environment jsdom */

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { OpenProjectBinding } from "../../../shared/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetMacDesktopSupportCache,
  useMacDesktopSupport,
} from "./useMacDesktopSupport";

/**
 * The capability gate follows the FOCUSED CHAT's machine, not the project tab.
 *
 * Both keys are exercised by one hook instance: a Studio chat pinned to a Linux
 * host hides the tool, the local chat on this Mac shows it, and going back to
 * Studio is a cache hit rather than a second round trip.
 */

const studioPin: OpenProjectBinding = {
  kind: "remote",
  key: "remote:target-studio:project-a",
  targetId: "target-studio",
  runtimeName: "Mac Studio",
  projectId: "project-a",
  rootPath: "/repo",
  displayName: "ADE",
};

const getStatus = vi.fn();

beforeEach(() => {
  resetMacDesktopSupportCache();
  getStatus.mockReset();
  (window as unknown as { ade: unknown }).ade = {
    macDesktop: { getStatus },
  };
});

afterEach(() => {
  cleanup();
  resetMacDesktopSupportCache();
  vi.restoreAllMocks();
});

describe("useMacDesktopSupport", () => {
  it("keys the capability per session machine, so focus flips availability", async () => {
    getStatus.mockImplementation(async (_args: unknown, pin: OpenProjectBinding | null) => (
      pin?.key === studioPin.key
        ? { supported: false, unsupportedReason: "The native desktop driver is missing from this ADE installation." }
        : { supported: true, unsupportedReason: null }
    ));

    const { result, rerender } = renderHook(
      ({ pin }: { pin: OpenProjectBinding | null }) =>
        useMacDesktopSupport({ runtimePin: pin, enabled: true }),
      { initialProps: { pin: studioPin as OpenProjectBinding | null } },
    );

    await waitFor(() => expect(result.current?.supported).toBe(false));
    expect(getStatus).toHaveBeenCalledWith({}, studioPin);
    expect(result.current?.reason).toContain("driver is missing");

    // Focus a local chat: a different machine key, so a different answer.
    rerender({ pin: null });
    await waitFor(() => expect(result.current?.supported).toBe(true));
    expect(getStatus).toHaveBeenLastCalledWith({}, null);

    // Back to Studio: the cached answer, no third read.
    rerender({ pin: studioPin });
    await waitFor(() => expect(result.current?.supported).toBe(false));
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("never reads while the Work route is off screen", async () => {
    getStatus.mockResolvedValue({ supported: true, unsupportedReason: null });
    const { result } = renderHook(() =>
      useMacDesktopSupport({ runtimePin: studioPin, enabled: false }));
    expect(result.current).toBeNull();
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("leaves the answer unknown when the host does not answer", async () => {
    // An unreachable host is not a "no": hiding the tool on a failed probe is
    // how a Mac-hosted lane loses its tab for a dropped connection.
    getStatus.mockRejectedValue(new Error("connection closed"));
    const { result } = renderHook(() =>
      useMacDesktopSupport({ runtimePin: studioPin, enabled: true }));
    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });
});
