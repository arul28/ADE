/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CrossMachineHandoffModal } from "./CrossMachineHandoffModal";

const SOURCE_SHA = "1234567890abcdef1234567890abcdef12345678";

describe("CrossMachineHandoffModal", () => {
  const prepareCrossMachineHandoff = vi.fn();
  const validateCrossMachineSource = vi.fn();
  const markCrossMachineHandoff = vi.fn();
  const callAction = vi.fn();

  beforeEach(() => {
    prepareCrossMachineHandoff.mockResolvedValue({
      capsule: {
        version: 1,
        handoffId: "handoff-ui-1",
        createdAt: "2026-07-10T12:00:00.000Z",
        source: {
          machineName: "Source Mac",
          sessionId: "session-1",
          provider: "codex",
          model: "gpt-5.5",
          title: "Handoff UI",
          laneName: "Feature lane",
          branchRef: "feature/handoff",
          headSha: SOURCE_SHA,
          originUrl: "https://github.com/example/ade.git",
        },
        target: { targetModelId: "openai/gpt-5.5" },
        brief: "## Current goal\n- Finish the handoff UI.",
        artifacts: { fileChanges: [], commands: [], errors: [] },
        linearIssues: [],
        continuationPrompt: "Continue from the handoff brief.",
      },
      capsuleFingerprint: "a".repeat(64),
      usedFallbackSummary: false,
      sanitizedSensitiveContext: false,
    });
    validateCrossMachineSource.mockResolvedValue(undefined);
    markCrossMachineHandoff.mockResolvedValue(undefined);
    callAction
      .mockResolvedValueOnce({
        result: {
          providerAuthorized: true,
          modelAvailable: true,
          remoteBranchHeadSha: SOURCE_SHA,
          existingLaneId: null,
          blockingErrors: [],
          warnings: [],
        },
      })
      .mockResolvedValueOnce({
        result: {
          handoffId: "handoff-ui-1",
          laneId: "remote-lane-1",
          session: {
            id: "remote-session-1",
            laneId: "remote-lane-1",
            provider: "codex",
            model: "gpt-5.5",
            status: "active",
            createdAt: "2026-07-10T12:00:00.000Z",
            lastActivityAt: "2026-07-10T12:00:00.000Z",
          },
          reusedLane: false,
          reusedSession: false,
        },
      });

    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        lanes: {
          list: vi.fn().mockResolvedValue([{
            id: "lane-1",
            name: "Feature lane",
            laneType: "worktree",
            branchRef: "feature/handoff",
            worktreePath: "/repo/lane",
            status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
          }]),
        },
        git: {
          getSyncStatus: vi.fn().mockResolvedValue({
            hasUpstream: true,
            upstreamState: "tracking",
            upstreamRef: "origin/feature/handoff",
            ahead: 0,
            behind: 0,
            diverged: false,
            recommendedAction: "none",
          }),
          getOriginRemote: vi.fn().mockResolvedValue({
            remoteUrl: "git@github.com:example/ade.git",
            branch: "feature/handoff",
          }),
          push: vi.fn().mockResolvedValue({ message: "pushed" }),
        },
        agentChat: { prepareCrossMachineHandoff, validateCrossMachineSource, markCrossMachineHandoff },
        remoteRuntime: {
          onConnectionSnapshotChanged: vi.fn().mockReturnValue(() => {}),
          getConnectionSnapshot: vi.fn().mockResolvedValue({
            connectedCount: 2,
            updatedAt: Date.now(),
            connections: [
              {
                target: { id: "machine-1", name: "Studio", hostname: "studio.local" },
                state: "connected",
                arch: "arm64",
                version: "1.2.3",
                route: { kind: "tailnet", endpoint: "100.64.0.2" },
                capabilities: { projects: true, machineProjects: { handoffStoragePreflight: true } },
                projects: [],
                lastError: null,
                lastAttemptedAt: Date.now(),
                connectedAt: Date.now(),
              },
              {
                target: { id: "machine-old", name: "Old Mac", hostname: "old.local" },
                state: "connected",
                arch: "arm64",
                version: "0.9.0",
                capabilities: { projects: true, machineProjects: {} },
                projects: [],
                lastError: null,
                lastAttemptedAt: Date.now(),
                connectedAt: Date.now(),
              },
            ],
          }),
          listProjects: vi.fn().mockResolvedValue([{
            projectId: "remote-project-1",
            rootPath: "/Users/test/Projects/ade",
            displayName: "ADE",
            gitOriginUrl: "https://github.com/example/ade.git",
            addedAt: Date.now(),
            lastOpenedAt: Date.now(),
          }]),
          callAction,
          getDefaultParentDir: vi.fn(),
          getHandoffStoragePreflight: vi.fn(),
          cloneProject: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows only compatible connected machines and completes an existing-repo handoff", async () => {
    const onFinished = vi.fn();
    render(
      <CrossMachineHandoffModal
        open
        sourceSessionId="session-1"
        sourceLaneId="lane-1"
        target={{ targetModelId: "openai/gpt-5.5" }}
        turnActive={false}
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={onFinished}
      />,
    );

    expect(await screen.findByText("Studio")).toBeTruthy();
    expect(screen.queryByText("Old Mac")).toBeNull();
    expect(screen.getByText(/1 connected machine needs an ADE update/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /review destination/i }));
    expect(await screen.findByText(/Ready to continue on Studio/i)).toBeTruthy();
    expect(screen.getByText(/feature\/handoff · 1234567890/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /send and continue/i }));
    expect(await screen.findByText("Handoff complete")).toBeTruthy();
    expect(prepareCrossMachineHandoff).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "session-1",
      targetModelId: "openai/gpt-5.5",
    }));
    expect(callAction).toHaveBeenNthCalledWith(
      2,
      "machine-1",
      "remote-project-1",
      expect.objectContaining({
        action: "acceptCrossMachineHandoff",
        requiredRouteKind: "tailnet",
      }),
    );
    expect(validateCrossMachineSource).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "session-1",
      capsuleFingerprint: "a".repeat(64),
    }));
    await waitFor(() => expect(markCrossMachineHandoff).toHaveBeenCalled());
    expect(onFinished).toHaveBeenCalledTimes(1);
  });

  it("reconciles a repository clone whose success response was lost during disconnect", async () => {
    const recoveredProject = {
      projectId: "remote-project-recovered",
      rootPath: "/Users/test/Projects/ade",
      displayName: "ADE",
      gitOriginUrl: "https://github.com/example/ade.git",
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    vi.mocked(window.ade.remoteRuntime.listProjects)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([recoveredProject]);
    vi.mocked(window.ade.remoteRuntime.getDefaultParentDir).mockResolvedValue("/Users/test/Projects");
    vi.mocked(window.ade.remoteRuntime.getHandoffStoragePreflight).mockResolvedValue({
      parentDir: "/Users/test/Projects",
      targetPath: "/Users/test/Projects/ade",
      freeBytes: 20 * 1024 * 1024 * 1024,
      requiredBytes: 1024 * 1024 * 1024,
      hasEnoughSpace: true,
      targetExists: false,
      blockingErrors: [],
      warnings: [],
    });
    vi.mocked(window.ade.remoteRuntime.cloneProject).mockRejectedValue(
      new Error("Connection was interrupted before ADE could confirm the clone result."),
    );

    render(
      <CrossMachineHandoffModal
        open
        sourceSessionId="session-1"
        sourceLaneId="lane-1"
        target={{ targetModelId: "openai/gpt-5.5" }}
        turnActive={false}
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /review destination/i }));
    expect(await screen.findByText(/Clone on Studio/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /clone repository/i }));

    expect(await screen.findByText(/Ready to continue on Studio/i)).toBeTruthy();
    expect(window.ade.remoteRuntime.cloneProject).toHaveBeenCalledWith(
      "machine-1",
      expect.objectContaining({
        url: "https://github.com/example/ade.git",
        parentDir: "/Users/test/Projects",
      }),
      { credentialMode: "destination_only" },
    );
    expect(window.ade.remoteRuntime.listProjects).toHaveBeenCalledTimes(2);
    expect(callAction).toHaveBeenCalledWith(
      "machine-1",
      "remote-project-recovered",
      expect.objectContaining({ action: "preflightCrossMachineDestination" }),
    );
  });
});
