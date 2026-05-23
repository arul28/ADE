/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../../../shared/ipc";
import { createOrchestrationBridge } from "../../../preload/orchestrationBridge";
import type {
  OrchestrationEventPayload,
  OrchestrationManifest,
} from "../../../shared/types/orchestration";
import {
  OrchestrationPanel,
  ORCHESTRATION_PANEL_PLAN_TEST_ID,
  ORCHESTRATION_PANEL_TEST_ID,
} from "./OrchestrationPanel";

vi.mock("../../lib/openExternal", () => ({
  openUrlInAdeBrowser: vi.fn(),
}));

function makeManifest(overrides: Partial<OrchestrationManifest> = {}): OrchestrationManifest {
  return {
    version: 1,
    runId: "run-1",
    laneId: "lane-1",
    bundlePath: "/tmp/run-1",
    etag: "etag-1",
    serverGeneration: 1,
    createdAt: "2026-05-22T00:00:00.000Z",
    updatedAt: "2026-05-22T00:00:00.000Z",
    title: "Preload canary run",
    goalSummary: "Verify renderer bridge wiring",
    currentPhase: "planning",
    phases: [
      { id: "planning", title: "Planning", status: "active" },
      { id: "developing", title: "Developing", status: "pending" },
      { id: "validating", title: "Validating", status: "pending" },
    ],
    agents: [],
    tasks: [],
    validationStrategy: { steps: [], checklist: [] },
    modelRouting: {},
    assets: [],
    decisions: [],
    userOverrides: [],
    leadState: {},
    history: [],
    ...overrides,
  };
}

describe("OrchestrationPanel preload integration", () => {
  beforeEach(() => {
    delete (window as any).ade;
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  it("uses the real preload orchestration bridge for bundle reads and events", async () => {
    const manifest = makeManifest();
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const invoke = vi.fn(async (channel: string, args?: unknown) => {
      if (channel === IPC.orchestrationBundleRead) {
        return {
          manifest,
          planMd: "# Initial plan\n\nWaiting for event.",
          etag: manifest.etag,
        };
      }
      if (channel === IPC.orchestrationSubscribe || channel === IPC.orchestrationUnsubscribe) {
        return undefined;
      }
      throw new Error(`unexpected invoke: ${channel} ${JSON.stringify(args)}`);
    });
    const on = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const bucket = listeners.get(channel) ?? new Set();
      bucket.add(listener);
      listeners.set(channel, bucket);
      return undefined;
    });
    const removeListener = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener);
      return undefined;
    });

    (window as any).ade = {
      orchestration: createOrchestrationBridge({ invoke, on, removeListener }),
    };

    expect((window as any).ade?.orchestration?.bundleRead).toEqual(expect.any(Function));
    expect((window as any).ade?.orchestration?.subscribe).toEqual(expect.any(Function));

    render(
      <OrchestrationPanel
        runId="run-1"
        laneId="lane-1"
        laneName="main"
      />,
    );

    await screen.findByTestId(ORCHESTRATION_PANEL_TEST_ID);
    expect(invoke).toHaveBeenCalledWith(IPC.orchestrationBundleRead, {
      runId: "run-1",
      laneId: "lane-1",
    });
    expect(on).toHaveBeenCalledWith(IPC.orchestrationEvent, expect.any(Function));
    expect(invoke).toHaveBeenCalledWith(IPC.orchestrationSubscribe, {
      runId: "run-1",
      laneId: "lane-1",
    });

    const event: OrchestrationEventPayload = {
      runId: "run-1",
      kind: "plan",
      etag: "etag-2",
      planMd: "# Updated plan\n\nFrom preload event.",
    };
    for (const listener of listeners.get(IPC.orchestrationEvent) ?? []) {
      listener({}, event);
    }

    const plan = await screen.findByTestId(ORCHESTRATION_PANEL_PLAN_TEST_ID);
    await waitFor(() => expect(plan.textContent ?? "").toMatch(/From preload event/));
  });
});
