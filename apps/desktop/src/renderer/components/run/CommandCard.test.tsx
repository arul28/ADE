// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandCard } from "./CommandCard";
import type { LaneSummary, ProcessDefinition, ProcessGroupDefinition, ProcessRuntime } from "../../../shared/types";

afterEach(cleanup);

const laneStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false };

const stubLane: LaneSummary = {
  id: "lane-a",
  name: "Primary lane",
  laneType: "primary",
  baseRef: "main",
  branchRef: "main",
  worktreePath: "/tmp/wt",
  parentLaneId: null,
  childCount: 0,
  stackDepth: 0,
  parentStatus: null,
  isEditProtected: false,
  status: laneStatus,
  color: null,
  icon: null,
  tags: [],
  createdAt: "2020-01-01T00:00:00.000Z",
};

const baseDefinition: ProcessDefinition = {
  id: "proc-1",
  name: "Dev server",
  command: ["npm", "run", "dev"],
  cwd: ".",
  env: {},
  groupIds: [],
  autostart: false,
  restart: "never",
  gracefulShutdownMs: 7000,
  dependsOn: [],
  readiness: { type: "none" },
};

const groups: ProcessGroupDefinition[] = [];

function makeRuntime(overrides: Partial<ProcessRuntime> = {}): ProcessRuntime {
  return {
    runId: "run-xyz",
    laneId: "lane-a",
    processId: "proc-1",
    status: "stopped",
    readiness: "unknown",
    pid: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    lastExitCode: null,
    lastEndedAt: null,
    uptimeMs: null,
    ports: [],
    logPath: null,
    updatedAt: "2026-04-28T12:00:00.000Z",
    ...overrides,
  };
}

describe("CommandCard", () => {
  it("shows runtime footer with ended time when the process is not active", () => {
    const runtime = makeRuntime({
      status: "exited",
      lastExitCode: 0,
      lastEndedAt: "2026-04-28T14:05:00.000Z",
      uptimeMs: null,
    });
    const { container } = render(
      <CommandCard
        definition={baseDefinition}
        lanes={[stubLane]}
        groups={groups}
        selectedLaneId="lane-a"
        runtimes={[runtime]}
        onSelectLane={vi.fn()}
        onRun={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const runtimeFoot = container.querySelector('[data-tour="run.commandRuntime"]');
    expect(runtimeFoot).not.toBeNull();
    const footText = runtimeFoot!.textContent ?? "";
    expect(footText).toContain("Runtime");
    expect(footText).toContain("Primary lane");
    expect(footText).toContain("Ended");
    expect(screen.getAllByText("exited:0").length).toBeGreaterThanOrEqual(1);
    expect(footText).toContain("Uptime");
    expect(footText).toContain("—");
  });

  it("shows uptime and per-run force-stop when a run is active", () => {
    const onKillRuntime = vi.fn();
    const onRun = vi.fn();
    const runtime = makeRuntime({
      status: "running",
      uptimeMs: 90_000,
      startedAt: "2026-04-28T14:00:00.000Z",
    });
    render(
      <CommandCard
        definition={baseDefinition}
        lanes={[stubLane]}
        groups={groups}
        selectedLaneId="lane-a"
        runtimes={[runtime]}
        onSelectLane={vi.fn()}
        onRun={onRun}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onKillRuntime={onKillRuntime}
      />,
    );
    expect(screen.getByText(/Uptime\s+1m 30s/)).toBeTruthy();
    expect(screen.getByText(/Ended\s+—/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Run$/i }));
    expect(onRun).toHaveBeenCalledWith("proc-1");
    fireEvent.click(screen.getByRole("button", { name: /Force stop run run-xyz/ }));
    expect(onKillRuntime).toHaveBeenCalledWith(runtime);
  });

  it("enables Run and calls onRun when no active runtime", () => {
    const onRun = vi.fn();
    const runtime = makeRuntime({
      status: "exited",
      lastExitCode: 0,
      lastEndedAt: "2026-04-28T14:05:00.000Z",
    });
    render(
      <CommandCard
        definition={baseDefinition}
        lanes={[stubLane]}
        groups={groups}
        selectedLaneId="lane-a"
        runtimes={[runtime]}
        onSelectLane={vi.fn()}
        onRun={onRun}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    const runBtn = screen.getByRole("button", { name: /^Run$/i }) as HTMLButtonElement;
    expect(runBtn.disabled).toBe(false);
    fireEvent.click(runBtn);
    expect(onRun).toHaveBeenCalledWith("proc-1");
  });

  it("shows empty runtime copy when there is no runtime for the lane", () => {
    render(
      <CommandCard
        definition={baseDefinition}
        lanes={[stubLane]}
        groups={groups}
        selectedLaneId="lane-a"
        runtimes={[]}
        onSelectLane={vi.fn()}
        onRun={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("No runs on this lane yet.")).toBeTruthy();
  });
});
