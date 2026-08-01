/* @vitest-environment jsdom */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/appStore";
import { useCtoAttention } from "./useCtoAttention";

function Harness() {
  useCtoAttention();
  return null;
}

describe("useCtoAttention", () => {
  const originalAde = globalThis.window.ade;

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    globalThis.window.ade = originalAde;
    useAppStore.setState({
      project: null,
      projectBinding: null,
      showWelcome: true,
      ctoAttention: { status: "idle", awaitingInput: false, since: null },
    });
  });

  it("retains the last known badge state when the host reports unknown", async () => {
    const waiting = {
      status: "awaiting-input" as const,
      awaitingInput: true,
      since: "2026-08-01T12:00:00.000Z",
    };
    const getAttention = vi.fn()
      .mockResolvedValueOnce(waiting)
      .mockResolvedValueOnce({ status: "unknown", awaitingInput: false, since: null });
    globalThis.window.ade = {
      ...(originalAde ?? {}),
      agentChat: {
        ...((originalAde as { agentChat?: object })?.agentChat ?? {}),
        onEvent: vi.fn(() => () => undefined),
      },
      cto: {
        ...((originalAde as { cto?: object })?.cto ?? {}),
        getAttention,
      },
    } as never;
    useAppStore.setState({
      project: { rootPath: "/repo", displayName: "Repo", baseRef: "main" },
      projectBinding: null,
      showWelcome: false,
      ctoAttention: { status: "idle", awaitingInput: false, since: null },
    });

    render(<Harness />);
    await waitFor(() => expect(useAppStore.getState().ctoAttention).toEqual(waiting));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(getAttention).toHaveBeenCalledTimes(2));
    expect(useAppStore.getState().ctoAttention).toEqual(waiting);
  });
});
