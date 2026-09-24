/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneLinearIssue } from "../../../shared/types";
import type { BatchLaunchItemState } from "../../lib/linearBatchLaunch";
import { defaultNativeControls } from "../../lib/nativeLaunchControls";
import { SessionLaunchModelControls } from "../shared/SessionLaunchModelControls";
import { BatchLaunchStatusToast } from "./BatchLaunchStatusToast";
import { ToastStack } from "./toast/ToastStack";
import { dismissToast, getToasts } from "./toast/toastStore";

afterEach(() => {
  cleanup();
  for (const toast of getToasts()) dismissToast(toast.id);
});

vi.mock("../shared/ModelPicker/ModelPicker", () => ({
  ModelPicker: ({
    fastMode,
    fastModeSupported,
    onFastModeChange,
    onChange,
  }: {
    fastMode: boolean;
    fastModeSupported: boolean;
    onFastModeChange: (next: boolean) => void;
    onChange: (modelId: string, options?: { fastMode: boolean }) => void;
  }) => (
    <>
      {fastModeSupported ? (
        <button
          type="button"
          aria-label="Fast mode"
          aria-pressed={fastMode}
          onClick={() => onFastModeChange(!fastMode)}
        >
          Fast
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Choose another model in Fast mode"
        onClick={() => onChange("openai/gpt-5.5", { fastMode: true })}
      >
        Choose fast model
      </button>
    </>
  ),
}));

vi.mock("../shared/ModelPicker/ReasoningEffortPicker", () => ({
  ReasoningEffortPicker: () => null,
}));

function issue(id: string, identifier: string): LaneLinearIssue {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    url: null,
    projectId: "project-1",
    projectSlug: "core",
    teamId: "team-1",
    teamKey: "ENG",
    stateId: "state-1",
    stateName: "Todo",
    stateType: "unstarted",
    priority: 2,
    priorityLabel: "normal",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
  };
}

function state(
  id: string,
  identifier: string,
  patch: Partial<BatchLaunchItemState>,
): BatchLaunchItemState {
  return {
    issue: issue(id, identifier),
    status: "done",
    laneId: `lane-${id}`,
    sessionId: `session-${id}`,
    error: null,
    ...patch,
  };
}

describe("LinearQuickViewButton batch-launch UI", () => {
  it("renders one canonical Fast control and routes its update", () => {
    const onChange = vi.fn();
    render(
      <SessionLaunchModelControls
        config={{
          modelId: "anthropic/claude-opus-4-8",
          reasoningEffort: null,
          fastMode: false,
          sessionType: "chat",
          nativeControls: defaultNativeControls(),
        }}
        onChange={onChange}
        showSessionType={false}
      />,
    );

    const fastControls = screen.getAllByRole("button", { name: "Fast mode" });
    expect(fastControls).toHaveLength(1);
    fireEvent.click(fastControls[0]!);
    expect(onChange).toHaveBeenCalledWith({ fastMode: true });
  });

  it("routes a model and Fast selection as one atomic patch", () => {
    const onChange = vi.fn();
    render(
      <SessionLaunchModelControls
        config={{
          modelId: "anthropic/claude-opus-4-8",
          reasoningEffort: null,
          fastMode: false,
          sessionType: "chat",
          nativeControls: defaultNativeControls(),
        }}
        onChange={onChange}
        showSessionType={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose another model in Fast mode" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      modelId: "openai/gpt-5.5",
      fastMode: true,
    });
  });

  it("keeps created sessions with kickoff errors openable and out of Retry failed", () => {
    const onDismiss = vi.fn();
    render(
      <>
      <ToastStack />
      <BatchLaunchStatusToast
        states={new Map([
          ["ready", state("ready", "ENG-1", {})],
          ["attention", state("attention", "ENG-2", {
            status: "agent-error",
            error: "Claude login required",
          })],
          ["failed", state("failed", "ENG-3", {
            status: "failed",
            laneId: null,
            sessionId: null,
            error: "Lane creation failed",
          })],
        ])}
        onRetryFailed={vi.fn()}
        onDismiss={onDismiss}
        onOpenLane={vi.fn()}
      />
      </>,
    );

    expect(screen.getByText("1 ready · 1 failed · 1 needs attention")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry 1 failed" })).toBeTruthy();
    expect((screen.getByTitle("Claude login required") as HTMLButtonElement).disabled).toBe(false);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("renders into the shared toast stack, retries without closing, and closes through onDismiss", () => {
    const onDismiss = vi.fn();
    const onRetryFailed = vi.fn();
    render(
      <>
        <ToastStack />
        <BatchLaunchStatusToast
          states={new Map([
            ["failed", state("failed", "ENG-3", { status: "failed", laneId: null, sessionId: null, error: "boom" })],
          ])}
          onRetryFailed={onRetryFailed}
          onDismiss={onDismiss}
          onOpenLane={vi.fn()}
        />
      </>,
    );

    expect(getToasts()).toHaveLength(1);
    expect(screen.getByTestId("batch-launch-rows")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry 1 failed" }));
    expect(onRetryFailed).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /^Dismiss/ }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("auto-dismisses a fully successful batch after the short beat", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(
        <BatchLaunchStatusToast
          states={new Map([["ready", state("ready", "ENG-1", {})]])}
          onRetryFailed={vi.fn()}
          onDismiss={onDismiss}
          onOpenLane={vi.fn()}
        />,
      );
      vi.advanceTimersByTime(3199);
      expect(onDismiss).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
