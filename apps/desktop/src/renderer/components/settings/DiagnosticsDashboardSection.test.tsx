/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiagnosticsDashboardSection } from "./DiagnosticsDashboardSection";
import type { OpenCodeRuntimeSnapshot, RuntimeDiagnosticsStatus } from "../../../shared/types";

function buildDiagnosticsStatus(): RuntimeDiagnosticsStatus {
  return {
    lanes: [
      {
        laneId: "lane-1",
        status: "healthy",
        issues: [],
        lastCheckedAt: "2026-04-08T12:00:00.000Z",
        fallbackMode: false,
        processAlive: true,
        portResponding: true,
        respondingPort: 3000,
        proxyRouteActive: true,
      },
    ],
    proxyRunning: true,
    proxyPort: 5173,
    totalRoutes: 1,
    activeConflicts: 0,
    fallbackLanes: [],
  };
}

function buildOpenCodeSnapshot(overrides: Partial<OpenCodeRuntimeSnapshot> = {}): OpenCodeRuntimeSnapshot {
  return {
    sharedCount: 1,
    dedicatedCount: 0,
    entries: [],
    ...overrides,
  };
}

describe("DiagnosticsDashboardSection", () => {
  const originalAde = globalThis.window.ade;

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("shows the unavailable state when the OpenCode snapshot cannot be fetched", async () => {
    const diagnosticsGetStatus = vi.fn().mockResolvedValue(buildDiagnosticsStatus());
    const getOpenCodeRuntimeDiagnostics = vi.fn().mockRejectedValue(new Error("unavailable"));

    globalThis.window.ade = {
      lanes: {
        diagnosticsGetStatus,
        diagnosticsRunFullCheck: vi.fn().mockResolvedValue(undefined),
        onDiagnosticsEvent: vi.fn(() => () => undefined),
      },
      ai: {
        getOpenCodeRuntimeDiagnostics,
      },
    } as any;

    render(<DiagnosticsDashboardSection />);

    expect(await screen.findByText("OpenCode diagnostics unavailable.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry OpenCode diagnostics" })).toBeTruthy();
  });

  it("ignores stale OpenCode polling snapshots that arrive out of order", async () => {
    vi.useFakeTimers();
    const diagnosticsGetStatus = vi.fn().mockResolvedValue(buildDiagnosticsStatus());
    const initialSnapshot = buildOpenCodeSnapshot({
      sharedCount: 1,
      dedicatedCount: 0,
    });
    const nextSnapshot = buildOpenCodeSnapshot({
      sharedCount: 7,
      dedicatedCount: 3,
      entries: [
        {
          id: "entry-2",
          key: "chat-session-2",
          leaseKind: "shared",
          ownerKind: "chat",
          ownerId: "session-2",
          configFingerprint: "fingerprint-b",
          url: "http://localhost:4096",
          busy: true,
          refCount: 2,
          startedAt: 2,
          lastUsedAt: 4,
        },
      ],
    });
    let resolveSlowSnapshot!: (snapshot: OpenCodeRuntimeSnapshot) => void;
    const slowSnapshot = new Promise<OpenCodeRuntimeSnapshot>((resolve) => {
      resolveSlowSnapshot = resolve;
    });
    const getOpenCodeRuntimeDiagnostics = vi.fn()
      .mockResolvedValueOnce(initialSnapshot)
      .mockImplementationOnce(() => slowSnapshot)
      .mockResolvedValueOnce(nextSnapshot);

    globalThis.window.ade = {
      lanes: {
        diagnosticsGetStatus,
        diagnosticsRunFullCheck: vi.fn().mockResolvedValue(undefined),
        onDiagnosticsEvent: vi.fn(() => () => undefined),
      },
      ai: {
        getOpenCodeRuntimeDiagnostics,
      },
    } as any;

    render(<DiagnosticsDashboardSection />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(within(screen.getByText("OpenCode dedicated").parentElement as HTMLElement).getByText("0")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(within(screen.getByText("OpenCode dedicated").parentElement as HTMLElement).getByText("3")).toBeTruthy();

    await act(async () => {
      resolveSlowSnapshot(initialSnapshot);
      await Promise.resolve();
    });

    expect(within(screen.getByText("OpenCode dedicated").parentElement as HTMLElement).getByText("3")).toBeTruthy();
  });
});
