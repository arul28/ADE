/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentChatCrossMachineHandoffOptionsResult,
  AgentChatCrossMachineHandoffRecord,
  AgentChatPreviewCrossMachineHandoffResult,
  AgentChatStartCrossMachineHandoffArgs,
  OpenProjectBinding,
} from "../../../shared/types";
import { CrossMachineHandoffModal } from "./CrossMachineHandoffModal";

const remotePin: OpenProjectBinding = {
  kind: "remote",
  key: "remote:source:project-1",
  targetId: "source",
  runtimeName: "Source Mac",
  projectId: "project-1",
  rootPath: "/work/project",
  displayName: "Project",
};

const onlineMachine = {
  machineKey: "machine-studio",
  name: "Studio",
  online: true,
  unavailableReason: null,
  hasRepository: true,
};
const offlineMachine = {
  machineKey: "machine-offline",
  name: "Offline Mac",
  online: false,
  unavailableReason: "Offline",
  hasRepository: true,
};
const noBlockers: AgentChatCrossMachineHandoffOptionsResult["blockers"] = [];

function optionsResult(
  overrides: Partial<AgentChatCrossMachineHandoffOptionsResult> = {},
): AgentChatCrossMachineHandoffOptionsResult {
  return {
    machines: [onlineMachine, offlineMachine],
    blockers: noBlockers,
    changes: { unpushedCommits: 1, changedFiles: 2 },
    current: null,
    ...overrides,
  };
}

function previewResult(
  overrides: Partial<AgentChatPreviewCrossMachineHandoffResult> = {},
): AgentChatPreviewCrossMachineHandoffResult {
  return {
    machineKey: onlineMachine.machineKey,
    machineName: onlineMachine.name,
    hasRepository: true,
    preflight: {
      providerAuthorized: true,
      modelAvailable: true,
      remoteBranchHeadSha: "abc123",
      existingLaneId: null,
      blockingErrors: [],
      warnings: [],
      forkHandoffSupport: { supported: true },
      gitBundleSupport: true,
    },
    ...overrides,
  };
}

describe("CrossMachineHandoffModal", () => {
  let getOptions: ReturnType<typeof vi.fn>;
  let previewMove: ReturnType<typeof vi.fn>;
  let startMove: ReturnType<typeof vi.fn>;
  let started: ReturnType<typeof vi.fn>;
  let closed: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getOptions = vi.fn().mockResolvedValue(optionsResult());
    previewMove = vi.fn().mockResolvedValue(previewResult());
    startMove = vi.fn().mockResolvedValue({} as AgentChatCrossMachineHandoffRecord);
    started = vi.fn();
    closed = vi.fn();
    Object.defineProperty(window, "ade", {
      configurable: true,
      value: {
        agentChat: {
          getCrossMachineHandoffOptions: getOptions,
          previewCrossMachineHandoff: previewMove,
          startCrossMachineHandoff: startMove,
        },
      } as unknown as Window["ade"],
    });
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { ade?: unknown }).ade;
    vi.clearAllMocks();
  });

  function renderModal({
    overrides = {},
    target = { targetModelId: "openai/gpt-5.5" },
    sourceProvider = null,
    turnActive = false,
    runtimePin,
  }: {
    overrides?: Partial<React.ComponentProps<typeof CrossMachineHandoffModal>>;
    target?: React.ComponentProps<typeof CrossMachineHandoffModal>["target"];
    sourceProvider?: React.ComponentProps<typeof CrossMachineHandoffModal>["sourceProvider"];
    turnActive?: boolean;
    runtimePin?: OpenProjectBinding;
  } = {}) {
    return render(
      <CrossMachineHandoffModal
        open
        sourceSessionId="chat-1"
        sourceLaneId="lane-1"
        target={target}
        modelId={target.targetModelId}
        onModelChange={vi.fn()}
        sourceProvider={sourceProvider}
        turnActive={turnActive}
        awaitingInput={false}
        onStopTurn={vi.fn().mockResolvedValue(undefined)}
        onClose={closed}
        onStarted={started}
        {...(runtimePin ? { runtimePin } : {})}
        {...overrides}
      />,
    );
  }

  it("loads options, disables offline machines, shows fixes, and clears included-change blockers", async () => {
    getOptions.mockResolvedValue(optionsResult({
      blockers: [{
        id: "unpushed",
        title: "Branch has unpublished work",
        detail: "Publish it or bring it along.",
        clearedByIncludeChanges: true,
        fixHint: null,
      }],
    }));
    renderModal();

    expect(await screen.findByRole("button", { name: /Studio/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Offline Mac/ })).toHaveProperty("disabled", true);
    expect(screen.getByText("Branch has unpublished work")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Publish branch/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Bring them along/ }));

    await waitFor(() => expect(screen.queryByText("Branch has unpublished work")).toBeNull());
    expect(getOptions).toHaveBeenCalledWith({ sourceSessionId: "chat-1" }, null);
  });

  it("reviews the selected machine, model, mode, and include-changes choice", async () => {
    getOptions.mockResolvedValue(optionsResult({
      blockers: [{
        id: "dirty", title: "Working tree has changes", detail: "Bring them along.",
        clearedByIncludeChanges: true, fixHint: null,
      }],
    }));
    renderModal({ sourceProvider: "codex" });
    await screen.findByRole("button", { name: /Studio/ });
    fireEvent.click(screen.getByRole("button", { name: /^Brief$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Bring them along/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));

    await waitFor(() => expect(previewMove).toHaveBeenCalledWith({
      sourceSessionId: "chat-1",
      machine: onlineMachine.machineKey,
      targetModelId: "openai/gpt-5.5",
      mode: "brief",
      includeChanges: true,
    }, null));
    expect(await screen.findByText(/Ready to continue on Studio/)).toBeTruthy();
  });

  it.each([
    ["destination errors", () => previewResult({ preflight: {
      ...previewResult().preflight!, blockingErrors: ["Destination policy blocks this move."],
    } })],
    ["unsupported forks", () => previewResult({ preflight: {
      ...previewResult().preflight!, forkHandoffSupport: { supported: false },
    } })],
    ["unsupported change bundles", () => previewResult({ preflight: {
      ...previewResult().preflight!, gitBundleSupport: false,
    } })],
  ])("blocks Send for %s", async (caseName, makePreview) => {
    previewMove.mockResolvedValue(makePreview());
    if (caseName === "unsupported change bundles") {
      getOptions.mockResolvedValue(optionsResult({
        blockers: [{
          id: "dirty", title: "Working tree has changes", detail: "Bring them along.",
          clearedByIncludeChanges: true, fixHint: null,
        }],
      }));
    }
    renderModal({ sourceProvider: "codex" });
    await screen.findByRole("button", { name: /Studio/ });
    if (caseName === "unsupported change bundles") {
      fireEvent.click(screen.getByRole("button", { name: /Bring them along/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Brief$/ }));
    } else if (caseName === "destination errors") {
      fireEvent.click(screen.getByRole("button", { name: /^Brief$/ }));
    }
    fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));

    const send = await screen.findByRole("button", { name: /Send chat/ });
    expect(send).toHaveProperty("disabled", true);
    expect(startMove).not.toHaveBeenCalled();
  });

  it("asks before cloning a missing repository and starts with clone consent on the pinned brain", async () => {
    getOptions.mockResolvedValue(optionsResult({
      machines: [{ ...onlineMachine, hasRepository: false }],
    }));
    previewMove.mockResolvedValue(previewResult({ hasRepository: false, preflight: null }));
    renderModal({ runtimePin: remotePin });
    await screen.findByRole("button", { name: /Studio/ });
    fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));
    await screen.findByRole("heading", { name: /Clone on Studio/ });
    const cloneButton = screen.getByRole("button", { name: /Clone and send/ });
    expect(cloneButton).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(cloneButton);

    await waitFor(() => expect(startMove).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "chat-1", machine: onlineMachine.machineKey, clone: true,
    }), remotePin));
  });

  it("queues a busy chat when the user chooses Move when this turn ends", async () => {
    renderModal({ turnActive: true });
    await screen.findByRole("button", { name: /Studio/ });
    fireEvent.click(screen.getAllByRole("button", { name: /Move when this turn ends/ })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: /Move when this turn ends/ }));

    await waitFor(() => expect(startMove).toHaveBeenCalledWith(expect.objectContaining({
      sourceSessionId: "chat-1", machine: onlineMachine.machineKey, whenTurnEnds: true,
    }), null));
  });

  it("passes the chosen model and permission settings to the brain", async () => {
    renderModal({
      target: {
        targetModelId: "openai/gpt-5.5",
        reasoningEffort: "high",
        permissionMode: "plan",
        codexApprovalPolicy: "on-request",
      },
    });
    await screen.findByRole("button", { name: /Studio/ });
    fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));
    await screen.findByText(/Ready to continue on Studio/);
    fireEvent.click(screen.getByRole("button", { name: /Send chat/ }));

    await waitFor(() => expect(startMove).toHaveBeenCalledWith(expect.objectContaining({
      targetModelId: "openai/gpt-5.5",
      reasoningEffort: "high",
      permissionMode: "plan",
      codexApprovalPolicy: "on-request",
      sourceSessionId: "chat-1",
      machine: onlineMachine.machineKey,
    } satisfies Partial<AgentChatStartCrossMachineHandoffArgs>), null));
  });

  it("sends preview and start requests through the source chat's runtime pin", async () => {
    renderModal({ runtimePin: remotePin });
    await screen.findByRole("button", { name: /Studio/ });
    fireEvent.click(screen.getByRole("button", { name: /^Continue/ }));
    await screen.findByText(/Ready to continue on Studio/);
    fireEvent.click(screen.getByRole("button", { name: /Send chat/ }));

    await waitFor(() => expect(startMove).toHaveBeenCalledWith(expect.anything(), remotePin));
    expect(previewMove).toHaveBeenCalledWith(expect.anything(), remotePin);
  });
});
