/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeDiagnosticsPanel } from "./RuntimeDiagnosticsPanel";
import type { LaneHealthCheck, RuntimeDiagnosticsEvent } from "../../../shared/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHealthy(laneId = "lane-1"): LaneHealthCheck {
  return {
    laneId,
    status: "healthy",
    processAlive: true,
    portResponding: true,
    proxyRouteActive: true,
    fallbackMode: false,
    lastCheckedAt: new Date().toISOString(),
    issues: [],
  };
}

function makeUnhealthy(laneId = "lane-1"): LaneHealthCheck {
  return {
    laneId,
    status: "unhealthy",
    processAlive: false,
    portResponding: false,
    proxyRouteActive: true,
    fallbackMode: false,
    lastCheckedAt: new Date().toISOString(),
    issues: [
      {
        type: "port-unresponsive",
        message: "Port 3000 is not responding. The dev server may not be running.",
        actionLabel: "Check dev server",
      },
    ],
  };
}

function makeProxyIssue(laneId = "lane-1"): LaneHealthCheck {
  return {
    laneId,
    status: "degraded",
    processAlive: true,
    portResponding: true,
    proxyRouteActive: false,
    fallbackMode: false,
    lastCheckedAt: new Date().toISOString(),
    issues: [
      {
        type: "proxy-route-missing",
        message: "No proxy route registered for this lane. Enable fallback to keep working on the direct port.",
        actionLabel: "Enable fallback",
        actionType: "enable-fallback",
      },
    ],
  };
}

function makeFallback(laneId = "lane-1"): LaneHealthCheck {
  return {
    laneId,
    status: "degraded",
    processAlive: false,
    portResponding: false,
    proxyRouteActive: false,
    fallbackMode: true,
    lastCheckedAt: new Date().toISOString(),
    issues: [
      {
        type: "port-unresponsive",
        message: "Port 3000 is not responding.",
      },
    ],
  };
}

function setupWindowAde(overrides: Record<string, any> = {}) {
  (window as any).ade = {
    lanes: {
      diagnosticsGetLaneHealth: vi.fn(async () => null),
      diagnosticsRunHealthCheck: vi.fn(async () => makeHealthy()),
      diagnosticsActivateFallback: vi.fn(async () => undefined),
      diagnosticsDeactivateFallback: vi.fn(async () => undefined),
      proxyStart: vi.fn(async () => makeHealthy()),
      onDiagnosticsEvent: vi.fn(
        (_cb: (event: RuntimeDiagnosticsEvent) => void) => () => undefined,
      ),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("RuntimeDiagnosticsPanel", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("shows loading state initially", () => {
    setupWindowAde({
      // Return a promise that never resolves during this test
      diagnosticsGetLaneHealth: vi.fn(() => new Promise(() => {})),
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    expect(screen.getByText("Loading diagnostics...")).toBeTruthy();
  });

  it("displays healthy status when lane is healthy", async () => {
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => makeHealthy()),
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("Healthy")).toBeTruthy();
    });

    expect(screen.getByText("HEALTHY")).toBeTruthy();
  });

  it("displays unhealthy status with issues", async () => {
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => makeUnhealthy()),
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("Unhealthy")).toBeTruthy();
    });

    expect(screen.getByText("UNHEALTHY")).toBeTruthy();
    // Issues section should be present
    expect(screen.getByText("Issues (1)")).toBeTruthy();
  });

  it("shows fallback mode banner when active", async () => {
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => makeFallback()),
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(
        screen.getByText(/Fallback mode active/)
      ).toBeTruthy();
    });

    expect(screen.getByText("DEACTIVATE")).toBeTruthy();
  });

  it("run health check button triggers check", async () => {
    const runCheck = vi.fn(async () => makeHealthy());
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => makeHealthy()),
      diagnosticsRunHealthCheck: runCheck,
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("RUN HEALTH CHECK")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("RUN HEALTH CHECK"));

    await waitFor(() => {
      expect(runCheck).toHaveBeenCalledWith({ laneId: "lane-1" });
    });
  });

  it("runs an initial health check when the cache is empty", async () => {
    const runCheck = vi.fn(async () => makeHealthy());
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => null),
      diagnosticsRunHealthCheck: runCheck,
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(runCheck).toHaveBeenCalledWith({ laneId: "lane-1" });
    });
    expect(screen.getByText("Healthy")).toBeTruthy();
  });

  it("shows collapsible issues section", async () => {
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => makeUnhealthy()),
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("Issues (1)")).toBeTruthy();
    });

    // Issues are collapsed by default — the message should not be visible
    expect(
      screen.queryByText("Port 3000 is not responding. The dev server may not be running.")
    ).toBeNull();

    // Click to expand
    fireEvent.click(screen.getByText("Issues (1)"));

    await waitFor(() => {
      expect(
        screen.getByText("Port 3000 is not responding. The dev server may not be running.")
      ).toBeTruthy();
    });
  });

  it("displays check indicators for process, port, proxy", async () => {
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => makeHealthy()),
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("Process")).toBeTruthy();
    });

    expect(screen.getByText("Port")).toBeTruthy();
    expect(screen.getByText("Proxy")).toBeTruthy();
    expect(screen.getByText("alive")).toBeTruthy();
    expect(screen.getByText("responding")).toBeTruthy();
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("unsubscribes from events on unmount", async () => {
    const unsubFn = vi.fn();
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => makeHealthy()),
      onDiagnosticsEvent: vi.fn(() => unsubFn),
    });

    const { unmount } = render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("Healthy")).toBeTruthy();
    });

    unmount();

    expect(unsubFn).toHaveBeenCalledTimes(1);
  });

  it("updates fallback UI from diagnostics events", async () => {
    const diagnosticsListenerRef: {
      current?: (event: RuntimeDiagnosticsEvent) => void;
    } = {};
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => makeFallback()),
      onDiagnosticsEvent: vi.fn((cb: (event: RuntimeDiagnosticsEvent) => void) => {
        diagnosticsListenerRef.current = cb;
        return () => undefined;
      }),
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText(/Fallback mode active/)).toBeTruthy();
    });

    if (!diagnosticsListenerRef.current) {
      throw new Error("expected diagnostics listener to be registered");
    }
    diagnosticsListenerRef.current({
      type: "fallback-deactivated",
      laneId: "lane-1",
      health: makeHealthy(),
    });

    await waitFor(() => {
      expect(screen.queryByText(/Fallback mode active/)).toBeNull();
    });
  });

  it("renders and executes supported issue actions", async () => {
    const activateFallback = vi.fn(async () => undefined);
    const runCheck = vi.fn(async () => makeFallback());
    setupWindowAde({
      diagnosticsGetLaneHealth: vi.fn(async () => makeProxyIssue()),
      diagnosticsActivateFallback: activateFallback,
      diagnosticsRunHealthCheck: runCheck,
    });

    render(<RuntimeDiagnosticsPanel laneId="lane-1" />);

    await waitFor(() => {
      expect(screen.getByText("Issues (1)")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Issues (1)"));

    await waitFor(() => {
      expect(screen.getByText("Enable fallback")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Enable fallback"));

    await waitFor(() => {
      expect(activateFallback).toHaveBeenCalledWith({ laneId: "lane-1" });
      expect(runCheck).toHaveBeenCalledWith({ laneId: "lane-1" });
    });
  });
});
