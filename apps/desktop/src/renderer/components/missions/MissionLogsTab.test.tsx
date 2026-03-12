/* @vitest-environment jsdom */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MissionLogsTab } from "./MissionLogsTab";

const getMissionLogs = vi.fn();
const exportMissionLogs = vi.fn();
const scrollIntoView = vi.fn();

describe("MissionLogsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        orchestrator: {
          getMissionLogs,
          exportMissionLogs,
        },
      },
    });
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    getMissionLogs.mockImplementation(async (args: { channels: string[] }) => {
      const interventionEntries = args.channels.length === 1 && args.channels[0] === "interventions";
      return {
        total: 1,
        nextCursor: null,
        entries: interventionEntries
          ? [
              {
                id: "log-1",
                at: "2026-03-12T10:00:00.000Z",
                channel: "interventions",
                level: "warning",
                title: "Focused intervention",
                message: "Planner failed before producing a plan artifact.",
                interventionId: "intervention-1",
                stepKey: "planning-worker",
              },
            ]
          : [
              {
                id: "log-2",
                at: "2026-03-12T09:59:00.000Z",
                channel: "timeline",
                level: "info",
                title: "Timeline entry",
                message: "Mission started.",
                interventionId: null,
                stepKey: null,
              },
            ],
      };
    });
    exportMissionLogs.mockResolvedValue({
      bundlePath: "/tmp/log-bundle.zip",
      manifest: { entryCount: 1 },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("switches to intervention logs, keeps focus visible, and acknowledges the focus handoff", async () => {
    const onFocusHandled = vi.fn();

    render(
      <MissionLogsTab
        missionId="mission-1"
        runId="run-1"
        focusInterventionId="intervention-1"
        onFocusHandled={onFocusHandled}
      />
    );

    await waitFor(() => expect(getMissionLogs).toHaveBeenCalled());
    await waitFor(() => expect(onFocusHandled).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(
        getMissionLogs.mock.calls.some(
          ([args]) => Array.isArray(args.channels) && args.channels.length === 1 && args.channels[0] === "interventions",
        ),
      ).toBe(true),
    );

    const focusedTitle = await screen.findByText("Focused intervention");
    expect(focusedTitle).toBeTruthy();
    expect(scrollIntoView).toHaveBeenCalled();

    const highlightedRow = focusedTitle.parentElement;
    expect(highlightedRow?.getAttribute("style") ?? "").toContain("background");
  });
});
