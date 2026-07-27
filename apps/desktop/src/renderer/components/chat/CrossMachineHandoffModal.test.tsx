/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CrossMachineHandoffModal } from "./CrossMachineHandoffModal";
import { getPermissionOptions } from "../shared/permissionOptions";
import {
  branchRowDetail,
  branchRowState,
  forkFallbackReasonForPrepareError,
  PERMISSION_MODE_ICONS,
  PERMISSION_SAFETY_TONES,
  repoReadinessLabel,
  type SourceCheck,
} from "./crossMachineHandoffPresentation";

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
          pull: vi.fn().mockResolvedValue({ message: "pulled" }),
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
    expect(screen.getByText("The new chat")).toBeTruthy();

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

  it.each([
    [
      "an interrupted connection",
      "Remote ADE service connection was interrupted before ADE could confirm the action result. "
        + "ADE could not reconnect to the machine; check the destination before retrying the action.",
    ],
    [
      "a request timeout",
      "Remote ADE service timed out waiting for method ade/actions/call (180000ms).",
    ],
  ])("reports %s as still completing instead of a hard failure", async (_case, failureMessage) => {
    callAction.mockReset();
    callAction.mockImplementation(async (
      _target: string,
      _project: string,
      payload: { action: string },
    ) => {
      if (payload.action === "preflightCrossMachineDestination") {
        return { result: preflightResult() };
      }
      throw new Error(failureMessage);
    });

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
    expect(await screen.findByText(/Ready to continue on Studio/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /send chat/i }));

    const notice = await screen.findByText(/lost confirmation from the destination/i);
    expect(notice.textContent).toMatch(/new chat may still appear there/i);
    expect(notice.className).toContain("text-amber");
    expect(screen.queryByText(failureMessage)).toBeNull();
    expect(screen.getByRole("button", { name: /send chat/i })).toHaveProperty("disabled", false);
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
      sanitizedSensitiveContext: true,
    }));
  }

  it("defaults to fork and passes mode + sourceProvider into the destination preflight", async () => {
    stubPrepareByMode();
    vi.mocked(window.ade.remoteRuntime.getConnectionSnapshot).mockResolvedValue({
      connectedCount: 1,
      updatedAt: Date.now(),
      connections: [{
        target: {
          id: "machine-1",
          name: "Studio",
          hostname: "studio.local",
          sshUser: null,
          port: null,
          sshKeyPath: null,
          lastSeenArch: "arm64",
          runtimeBinaryVersion: "1.2.3",
          lastConnectedAt: Date.now(),
        },
        state: "connected",
        arch: "arm64",
        version: "1.2.3",
        route: { kind: "lan", endpoint: "studio.local" },
        capabilities: { projects: true, machineProjects: { handoffStoragePreflight: true } },
        projects: [],
        lastError: null,
        lastAttemptedAt: Date.now(),
        connectedAt: Date.now(),
      }],
    });
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
    expect(screen.getByText(/history is sent exactly as recorded — anything pasted into this conversation is included/i)).toBeTruthy();
    expect(screen.getByText("ADE removed secret-shaped values from your note.")).toBeTruthy();
    expect(screen.getByTestId("insecure-consent-review").textContent).toBe(
      "This connection is authenticated but not end-to-end encrypted. The full chat history is sent exactly as recorded.",
    );

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
    fireEvent.click(screen.getByRole("checkbox"));
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

  /**
   * Regression: a branch that was pushed but 2 commits *behind* origin pushed a
   * blocker into the list, disabled Continue, and rendered none of it — three
   * green check rows above a dead button, with no way to learn why.
   */
  it("names a behind branch and offers the pull instead of silently disabling Continue", async () => {
    (window as any).ade.git.getSyncStatus.mockResolvedValue({
      hasUpstream: true,
      upstreamState: "tracking",
      upstreamRef: "origin/feature/handoff",
      ahead: 0,
      behind: 2,
      diverged: false,
      recommendedAction: "pull",
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
        turnActive={false}
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={vi.fn()}
      />,
    );

    expect(await screen.findByText(/2 commits behind origin/i)).toBeTruthy();
    const continueButton = screen.getByRole("button", { name: /^continue/i });
    expect(continueButton).toHaveProperty("disabled", true);
    // The reason has to reach the user, not just the disabled attribute.
    expect(continueButton.getAttribute("title")).toMatch(/behind origin/i);

    fireEvent.click(screen.getByRole("button", { name: /update branch/i }));
    await waitFor(() => expect((window as any).ade.git.pull).toHaveBeenCalledWith({ laneId: "lane-1" }));
  });

  /**
   * Regression: the blocker list and two standalone panels rendered the same
   * blocker and the same fix button twice, with different disabled behavior on
   * each copy. Every blocker must reach the user exactly once.
   */
  it("renders each blocker and its fix exactly once", async () => {
    (window as any).ade.git.getSyncStatus.mockResolvedValue({
      hasUpstream: false,
      upstreamState: "missing",
      upstreamRef: null,
      ahead: 2,
      behind: 0,
      diverged: false,
      recommendedAction: "push",
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
        turnActive
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={vi.fn()}
      />,
    );

    expect(await screen.findAllByRole("button", { name: /publish branch/i })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /stop current response/i })).toHaveLength(1);
  });

  it("blocks a diverged branch without offering a one-click fix", async () => {
    (window as any).ade.git.getSyncStatus.mockResolvedValue({
      hasUpstream: true,
      upstreamState: "tracking",
      upstreamRef: "origin/feature/handoff",
      ahead: 3,
      behind: 2,
      diverged: true,
      recommendedAction: "force_push_lease",
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
        turnActive={false}
        awaitingInput={false}
        onStopTurn={vi.fn()}
        onClose={vi.fn()}
        onFinished={vi.fn()}
      />,
    );

    expect(await screen.findByText(/has diverged from origin/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^continue/i })).toHaveProperty("disabled", true);
    // Choosing merge-vs-rebase for the user is exactly what this flow must not do.
    expect(screen.queryByRole("button", { name: /update branch/i })).toBeNull();
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

  it("refuses cross-machine fork for Droid instead of offering a tab that throws", async () => {
    stubPrepareByMode();
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
        sourceProvider="droid"
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

    expect((await screen.findByRole("button", { name: /^brief$/i })).getAttribute("aria-pressed")).toBe("true");
    // Droid can fork locally but never onto another machine — its session index
    // is machine-local. The tab used to stay enabled and throw on confirm.
    expect(screen.getByRole("button", { name: /^fork$/i })).toHaveProperty("disabled", true);
    expect(screen.getByText(/can't fork chat history/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(prepareCrossMachineHandoff).toHaveBeenCalledWith(expect.objectContaining({ mode: "brief" })));
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

function check(overrides: Partial<SourceCheck> = {}): SourceCheck {
  return {
    lane: null,
    sync: {
      hasUpstream: true,
      upstreamState: "tracking",
      upstreamRef: "origin/main",
      ahead: 0,
      behind: 0,
      diverged: false,
      recommendedAction: "none",
    },
    originUrl: "git@github.com:arul28/ade.git",
    branch: "main",
    needsPush: false,
    blockingErrors: [],
    warnings: [],
    ...overrides,
  };
}

describe("branch row", () => {
  /**
   * Regression: the row read only the push direction, so a branch that was fully
   * pushed but two commits behind rendered a green "main is pushed" — while that
   * same state silently disabled Continue.
   */
  it("reports a behind branch as an error, not as pushed", () => {
    const behind = check({ sync: { ...check().sync!, behind: 2, recommendedAction: "pull" } });
    expect(branchRowDetail(behind)).toBe("main is 2 commits behind origin");
    expect(branchRowState(behind)).toBe("error");
  });

  it("uses the singular for one commit", () => {
    const behind = check({ sync: { ...check().sync!, behind: 1 } });
    expect(branchRowDetail(behind)).toContain("1 commit behind");
  });

  it("reports divergence distinctly from being behind", () => {
    const diverged = check({ sync: { ...check().sync!, ahead: 3, behind: 2, diverged: true } });
    expect(branchRowDetail(diverged)).toBe("main has diverged from origin");
    expect(branchRowState(diverged)).toBe("error");
  });

  it("warns rather than errors when the branch merely needs pushing", () => {
    expect(branchRowState(check({ needsPush: true }))).toBe("warn");
  });

  it("is only green when the branch is genuinely in sync", () => {
    expect(branchRowDetail(check())).toBe("main is pushed and up to date");
    expect(branchRowState(check())).toBe("ok");
  });
});

describe("permission lookups", () => {
  /**
   * Regression: these were typed `Record<string, …>` with invented key names, so
   * every lookup fell through to a default and the whole permission row rendered
   * grey while the composer's rendered green/amber/red. Keying on the real
   * unions makes a missing key a compile error; this asserts the values too.
   */
  it("covers every safety level a permission option can carry", () => {
    const families = ["anthropic", "openai", "factory", "cursor", "google"];
    const safeties = new Set(
      families.flatMap((family) => getPermissionOptions({ family, isCliWrapped: true }))
        .map((option) => option.safety),
    );
    expect(safeties.size).toBeGreaterThan(1);
    for (const safety of safeties) {
      expect(PERMISSION_SAFETY_TONES[safety]).toBeTruthy();
    }
  });

  it("keeps the danger tier visually distinct from the safe one", () => {
    expect(PERMISSION_SAFETY_TONES.safe).toBe("green");
    expect(PERMISSION_SAFETY_TONES["full-auto"]).toBe("red");
    expect(PERMISSION_SAFETY_TONES.danger).toBe("red");
    expect(PERMISSION_SAFETY_TONES.safe).not.toBe(PERMISSION_SAFETY_TONES.danger);
  });

  it("maps every permission mode to an icon", () => {
    const families = ["anthropic", "openai", "factory", "cursor", "google"];
    for (const family of families) {
      for (const option of getPermissionOptions({ family, isCliWrapped: true })) {
        expect(PERMISSION_MODE_ICONS[option.value]).toBeTruthy();
      }
    }
  });
});

describe("repoReadinessLabel", () => {
  it("says nothing for states it has not resolved", () => {
    // An unanswered question is not worth a row.
    expect(repoReadinessLabel("checking")).toBeNull();
    expect(repoReadinessLabel("unknown")).toBeNull();
    expect(repoReadinessLabel(undefined)).toBeNull();
  });

  it("distinguishes a present repository from one that must be cloned", () => {
    expect(repoReadinessLabel("present")).toBe("repo ready");
    expect(repoReadinessLabel("absent")).toBe("will clone the repo");
  });
});

describe("forkFallbackReasonForPrepareError", () => {
  /**
   * `/quality` gate item: this classifies a service error by matching its
   * *message* across an IPC boundary, so a copy edit on the throwing side
   * silently turns the one-click brief fallback into a dead end. Pinning the
   * three shapes the service actually throws at least makes that break loud
   * here until the errors carry a code.
   */
  it("recognizes each cause the service can throw for an unforkable chat", () => {
    expect(forkFallbackReasonForPrepareError(
      "This chat's history is too large to fork across machines. Send it as a brief instead.",
    )).toMatch(/too big to send/i);
    expect(forkFallbackReasonForPrepareError(
      "This Codex rollout can't be forked across machines.",
    )).toMatch(/can't be forked/i);
    expect(forkFallbackReasonForPrepareError(
      "Droid sessions aren't portable between machines yet. Use a brief handoff instead.",
    )).toMatch(/can't move between machines/i);
  });

  it("returns null for an unrelated failure so it is surfaced as a real error", () => {
    expect(forkFallbackReasonForPrepareError("Network unreachable")).toBeNull();
  });
});
