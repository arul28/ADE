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
    callAction.mockReset();
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
    const onModelChange = vi.fn();
    render(
      <CrossMachineHandoffModal
        open
        sourceSessionId="session-1"
        sourceLaneId="lane-1"
        target={{ targetModelId: "openai/gpt-5.5" }}
        modelId="openai/gpt-5.5"
        onModelChange={onModelChange}
        availableModelIds={["openai/gpt-5.5"]}
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
    expect(screen.getByText("Model for the new chat")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/Ready to continue on Studio/i)).toBeTruthy();
    expect(screen.getByText(/feature\/handoff · 1234567890/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /send chat/i }));
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

    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
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

  const ACCEPT_RESULT = {
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
  };

  function preflightResult(overrides: Record<string, unknown> = {}) {
    return {
      providerAuthorized: true,
      modelAvailable: true,
      remoteBranchHeadSha: SOURCE_SHA,
      existingLaneId: null,
      blockingErrors: [],
      warnings: [],
      ...overrides,
    };
  }

  // Fork capsules echo the requested mode so the modal's "what gets sent" copy
  // and fork gating reflect the real payload.
  function stubPrepareByMode() {
    prepareCrossMachineHandoff.mockReset();
    prepareCrossMachineHandoff.mockImplementation(async (args: { mode?: "brief" | "fork" }) => ({
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
        mode: args.mode ?? "brief",
      },
      capsuleFingerprint: "a".repeat(64),
      usedFallbackSummary: false,
      sanitizedSensitiveContext: false,
    }));
  }

  it("defaults to fork and passes mode + sourceProvider into the destination preflight", async () => {
    stubPrepareByMode();
    callAction.mockReset();
    callAction.mockImplementation(async (_target: string, _project: string, payload: { action: string; args: { mode?: string } }) => {
      if (payload.action === "preflightCrossMachineDestination") {
        return { result: preflightResult({ forkHandoffSupport: { supported: true } }) };
      }
      return { result: ACCEPT_RESULT };
    });

    render(
      <CrossMachineHandoffModal
        open
        sourceSessionId="session-1"
        sourceLaneId="lane-1"
        sourceProvider="codex"
        target={{ targetModelId: "openai/gpt-5.5" }}
        modelId="openai/gpt-5.5"
        onModelChange={vi.fn()}
        availableModelIds={["openai/gpt-5.5"]}
        forkAvailableModelIds={["openai/gpt-5.5"]}
        turnActive={false}
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/Ready to continue on Studio/i)).toBeTruthy();
    expect(screen.getByText(/Sent: the full conversation history/i)).toBeTruthy();

    expect(prepareCrossMachineHandoff).toHaveBeenCalledWith(expect.objectContaining({ mode: "fork" }));
    expect(callAction).toHaveBeenNthCalledWith(
      1,
      "machine-1",
      "remote-project-1",
      expect.objectContaining({
        action: "preflightCrossMachineDestination",
        args: expect.objectContaining({ mode: "fork", sourceProvider: "codex" }),
      }),
    );

    // Send payload path is unchanged: only capsule + fingerprint travel.
    fireEvent.click(screen.getByRole("button", { name: /send chat/i }));
    expect(await screen.findByText("Handoff complete")).toBeTruthy();
    expect(callAction).toHaveBeenNthCalledWith(
      2,
      "machine-1",
      "remote-project-1",
      expect.objectContaining({
        action: "acceptCrossMachineHandoff",
        args: { capsule: expect.objectContaining({ mode: "fork" }), capsuleFingerprint: "a".repeat(64) },
      }),
    );
  });

  it("disables fork for a provider that can't fork history", async () => {
    render(
      <CrossMachineHandoffModal
        open
        sourceSessionId="session-1"
        sourceLaneId="lane-1"
        sourceProvider="cursor"
        target={{ targetModelId: "openai/gpt-5.5" }}
        modelId="openai/gpt-5.5"
        onModelChange={vi.fn()}
        availableModelIds={["openai/gpt-5.5"]}
        turnActive={false}
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={vi.fn()}
      />,
    );

    const forkButton = await screen.findByRole("button", { name: /^fork$/i });
    expect(forkButton).toHaveProperty("disabled", true);
    expect(screen.getByText(/Cursor can't fork chat history/i)).toBeTruthy();
  });

  it("offers a one-click brief when the destination is too old to fork", async () => {
    stubPrepareByMode();
    callAction.mockReset();
    callAction.mockImplementation(async (_target: string, _project: string, payload: { action: string; args: { mode?: string } }) => {
      if (payload.action === "preflightCrossMachineDestination") {
        // Older destination: forkHandoffSupport field is absent entirely.
        return { result: preflightResult() };
      }
      return { result: ACCEPT_RESULT };
    });

    render(
      <CrossMachineHandoffModal
        open
        sourceSessionId="session-1"
        sourceLaneId="lane-1"
        sourceProvider="codex"
        target={{ targetModelId: "openai/gpt-5.5" }}
        modelId="openai/gpt-5.5"
        onModelChange={vi.fn()}
        availableModelIds={["openai/gpt-5.5"]}
        forkAvailableModelIds={["openai/gpt-5.5"]}
        turnActive={false}
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/needs an ADE update for fork handoff/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /send as brief instead/i }));
    await waitFor(() =>
      expect(prepareCrossMachineHandoff).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "brief" })),
    );
    expect(await screen.findByText(/Sent: a short summary of this chat/i)).toBeTruthy();
    // The second preflight ran in brief mode.
    expect(callAction).toHaveBeenLastCalledWith(
      "machine-1",
      "remote-project-1",
      expect.objectContaining({
        action: "preflightCrossMachineDestination",
        args: expect.objectContaining({ mode: "brief" }),
      }),
    );
  });

  it("falls back to a brief when the source history is too large to fork", async () => {
    prepareCrossMachineHandoff.mockReset();
    prepareCrossMachineHandoff
      .mockRejectedValueOnce(new Error("This chat's history is too large to send as a fork."))
      .mockResolvedValueOnce({
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
          brief: "## Current goal\n- Finish.",
          artifacts: { fileChanges: [], commands: [], errors: [] },
          linearIssues: [],
          continuationPrompt: "Continue.",
          mode: "brief",
        },
        capsuleFingerprint: "a".repeat(64),
        usedFallbackSummary: false,
        sanitizedSensitiveContext: false,
      });
    callAction.mockReset();
    callAction.mockImplementation(async (_target: string, _project: string, payload: { action: string }) => {
      if (payload.action === "preflightCrossMachineDestination") return { result: preflightResult() };
      return { result: ACCEPT_RESULT };
    });

    render(
      <CrossMachineHandoffModal
        open
        sourceSessionId="session-1"
        sourceLaneId="lane-1"
        sourceProvider="codex"
        target={{ targetModelId: "openai/gpt-5.5" }}
        modelId="openai/gpt-5.5"
        onModelChange={vi.fn()}
        availableModelIds={["openai/gpt-5.5"]}
        forkAvailableModelIds={["openai/gpt-5.5"]}
        turnActive={false}
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/history is too big to send/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /send as brief instead/i }));
    expect(await screen.findByText(/Ready to continue on Studio/i)).toBeTruthy();
    expect(prepareCrossMachineHandoff).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "brief" }));
  });

  it("falls back to a brief when the provider session file can't be forked", async () => {
    prepareCrossMachineHandoff.mockReset();
    prepareCrossMachineHandoff
      .mockRejectedValueOnce(new Error("This Codex rollout is compressed and can't be forked."))
      .mockResolvedValueOnce({
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
          brief: "## Current goal\n- Finish.",
          artifacts: { fileChanges: [], commands: [], errors: [] },
          linearIssues: [],
          continuationPrompt: "Continue.",
          mode: "brief",
        },
        capsuleFingerprint: "a".repeat(64),
        usedFallbackSummary: false,
        sanitizedSensitiveContext: false,
      });
    callAction.mockReset();
    callAction.mockImplementation(async (_target: string, _project: string, payload: { action: string }) => {
      if (payload.action === "preflightCrossMachineDestination") return { result: preflightResult() };
      return { result: ACCEPT_RESULT };
    });

    render(
      <CrossMachineHandoffModal
        open
        sourceSessionId="session-1"
        sourceLaneId="lane-1"
        sourceProvider="codex"
        target={{ targetModelId: "openai/gpt-5.5" }}
        modelId="openai/gpt-5.5"
        onModelChange={vi.fn()}
        availableModelIds={["openai/gpt-5.5"]}
        forkAvailableModelIds={["openai/gpt-5.5"]}
        turnActive={false}
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/history can't be forked/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /send as brief instead/i }));
    expect(await screen.findByText(/Ready to continue on Studio/i)).toBeTruthy();
    expect(prepareCrossMachineHandoff).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "brief" }));
  });

  it("finishes the accepted handoff when marking the source chat fails", async () => {
    const onFinished = vi.fn();
    markCrossMachineHandoff.mockRejectedValueOnce(new Error("source marker unavailable"));

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

    fireEvent.click(await screen.findByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/Ready to continue on Studio/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /send chat/i }));

    expect(await screen.findByText("Handoff complete")).toBeTruthy();
    expect(screen.getByText(/destination succeeded, but ADE could not mark the source chat/i)).toBeTruthy();
    expect(screen.getByText(/source marker unavailable/i)).toBeTruthy();
    expect(onFinished).toHaveBeenCalledTimes(1);
  });
});
