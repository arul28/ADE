// @vitest-environment jsdom

import { act, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMissionRunView } from "./useMissionRunView";

const pendingRequests = new Map<string, { resolve: (value: any) => void; reject: (error: unknown) => void }>();
const mockGetRunView = vi.fn((args: { missionId: string; runId: string | null }) => new Promise((resolve, reject) => {
  pendingRequests.set(`${args.missionId}::${args.runId ?? ""}`, { resolve, reject });
}));
const mockSubscribeRunView = vi.fn(() => () => {});
const mockMissionsOnEvent = vi.fn(() => () => {});

function HookProbe({ missionId, runId }: { missionId: string | null; runId: string | null }) {
  const { runView, loading, error } = useMissionRunView(missionId, runId);
  return (
    <div>
      <div data-testid="mission">{runView?.missionId ?? "none"}</div>
      <div data-testid="status">{loading ? "loading" : "idle"}</div>
      <div data-testid="error">{error ?? "none"}</div>
    </div>
  );
}

describe("useMissionRunView", () => {
  beforeEach(() => {
    pendingRequests.clear();
    mockGetRunView.mockClear();
    mockSubscribeRunView.mockClear();
    mockMissionsOnEvent.mockClear();
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        missions: {
          getRunView: mockGetRunView,
          subscribeRunView: mockSubscribeRunView,
          onEvent: mockMissionsOnEvent,
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("ignores stale runView responses after a fast mission switch", async () => {
    const view = render(<HookProbe missionId="m1" runId="r1" />);

    await waitFor(() => expect(mockGetRunView).toHaveBeenCalledWith({ missionId: "m1", runId: "r1" }));
    expect(screen.getByTestId("status").textContent).toBe("loading");

    view.rerender(<HookProbe missionId="m2" runId="r2" />);

    await waitFor(() => expect(mockGetRunView).toHaveBeenCalledWith({ missionId: "m2", runId: "r2" }));
    expect(screen.getByTestId("mission").textContent).toBe("none");

    await act(async () => {
      pendingRequests.get("m1::r1")?.resolve({ missionId: "m1" });
    });

    expect(screen.getByTestId("mission").textContent).toBe("none");
    expect(screen.getByTestId("status").textContent).toBe("loading");

    await act(async () => {
      pendingRequests.get("m2::r2")?.resolve({ missionId: "m2" });
    });

    await waitFor(() => expect(screen.getByTestId("mission").textContent).toBe("m2"));
    expect(screen.getByTestId("status").textContent).toBe("idle");
    expect(screen.getByTestId("error").textContent).toBe("none");
  });
});
