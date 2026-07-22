import { describe, expect, it } from "vitest";
import { IPC } from "../../../shared/ipc";
import { ipcInvokeTimeoutMs } from "./ipcTimeouts";
import {
  LOCAL_RUNTIME_ACTION_REGISTRY_TIMEOUT_MS,
  LOCAL_RUNTIME_ACTION_TIMEOUT_MS,
  LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS,
  LOCAL_RUNTIME_FILE_ACTION_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS,
  LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS,
  LOCAL_RUNTIME_IPC_PROJECT_SETUP_MARGIN_MS,
  LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS,
  LOCAL_RUNTIME_PROJECT_TIMEOUT_MS,
  LOCAL_RUNTIME_SYNC_TIMEOUT_MS,
  longRunningLocalRuntimeActionTimeoutMs,
} from "../localRuntime/localRuntimeTimeoutPolicy";

describe("ipcInvokeTimeoutMs", () => {
  it("keeps local lane delete IPC alive through cold setup and the daemon action", () => {
    const innerTimeoutMs = longRunningLocalRuntimeActionTimeoutMs("lane.delete")!;
    const outerTimeoutMs = ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "delete", args: { laneId: "lane-1" } },
    }]);

    expect(innerTimeoutMs).toBe(4 * 60_000);
    expect(outerTimeoutMs).toBe(
      LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS
      + innerTimeoutMs
      + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS,
    );
    // Model the full cold setup allowance (connect + projects.add) followed by
    // the full daemon delete budget. The renderer timer still owns the explicit
    // completion headroom instead of racing the inner timer.
    expect(
      outerTimeoutMs
      - (LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS + innerTimeoutMs),
    ).toBe(LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS);
    expect(LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS).toBe(
      2 * LOCAL_RUNTIME_PROJECT_TIMEOUT_MS + LOCAL_RUNTIME_IPC_PROJECT_SETUP_MARGIN_MS,
    );
    expect(LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS).toBe(270_000);

    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "lane", action: "delete", args: { laneId: "lane-1" } },
    }])).toBe(4 * 60_000);
  });

  it("composes cold setup, daemon action, and headroom for archive and unarchive", () => {
    expect(ipcInvokeTimeoutMs(IPC.lanesArchive)).toBe(4 * 60_000);
    for (const action of ["archive", "unarchive"] as const) {
      const innerTimeoutMs = longRunningLocalRuntimeActionTimeoutMs(`lane.${action}`)!;
      const outerTimeoutMs = ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
        request: { domain: "lane", action, args: { laneId: "lane-1" } },
      }]);
      expect(outerTimeoutMs).toBe(
        LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS
        + innerTimeoutMs
        + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS,
      );
      expect(
        outerTimeoutMs
        - (LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS + innerTimeoutMs),
      ).toBe(LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS);
    }
  });

  it("composes cold setup, the default daemon action, and completion headroom", () => {
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "list" },
    }])).toBe(315_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "file", action: "readFile", args: {} },
    }])).toBe(293_000);
    expect(LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS).toBe(285_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction)).toBe(285_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallSync)).toBe(315_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeListActionRegistry)).toBe(315_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeStreamEvents)).toBe(287_000);
    expect(315_000 - LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS).toBe(
      LOCAL_RUNTIME_ACTION_TIMEOUT_MS + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS,
    );
    expect(293_000 - LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS).toBe(
      LOCAL_RUNTIME_FILE_ACTION_TIMEOUT_MS + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS,
    );
    expect(315_000 - LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS).toBe(
      LOCAL_RUNTIME_SYNC_TIMEOUT_MS + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS,
    );
    expect(315_000 - LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS).toBe(
      LOCAL_RUNTIME_ACTION_REGISTRY_TIMEOUT_MS + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS,
    );
    expect(287_000 - LOCAL_RUNTIME_IPC_PROJECT_SETUP_TIMEOUT_MS).toBe(
      LOCAL_RUNTIME_EVENT_POLL_TIMEOUT_MS + LOCAL_RUNTIME_IPC_COMPLETION_HEADROOM_MS,
    );
  });

  it("keeps project switching on setup plus completion without a daemon call budget", () => {
    expect(ipcInvokeTimeoutMs(IPC.projectSwitchToPath)).toBe(
      LOCAL_RUNTIME_IPC_PROJECT_COMPLETION_TIMEOUT_MS,
    );
    expect(ipcInvokeTimeoutMs(IPC.projectSwitchToPath)).toBe(285_000);
  });

  it("gives retryable remote runtime actions enough time to reconnect", () => {
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "lane", action: "list" },
    }])).toBe(75_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "file", action: "readFile", args: {} },
    }])).toBe(75_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "file", action: "listTreeChildren", args: {} },
    }])).toBe(75_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "file", action: "readFileRange", args: {} },
    }])).toBe(75_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "file", action: "refreshGitDecorations", args: {} },
    }])).toBe(75_000);
  });

  it("keeps ordinary remote runtime actions on the default timeout", () => {
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "chat", action: "sendMessage" },
    }])).toBe(30_000);
  });

  it("lets remote port forwarding include a cold SSH/runtime bind", () => {
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeEnsurePortForward)).toBe(10 * 60_000);
  });

  it("keeps iOS launch on its extended timeout", () => {
    expect(ipcInvokeTimeoutMs(IPC.iosSimulatorLaunch)).toBe(10 * 60_000);
  });

  it("lets transcription run longer than the default invoke ceiling", () => {
    expect(ipcInvokeTimeoutMs(IPC.transcriptionTranscribe)).toBe(6 * 60_000);
  });

  it("extends iOS Preview Lab matching and workspace readiness timeouts", () => {
    expect(ipcInvokeTimeoutMs(IPC.iosSimulatorResolvePreviewMatch)).toBe(2 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.iosSimulatorEnsurePreviewWorkspace)).toBe(2 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.iosSimulatorRenderCurrentPreview)).toBe(2 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "ios_simulator", action: "ensurePreviewWorkspace", args: {} },
    }])).toBe(315_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "ios_simulator", action: "renderCurrentPreview", args: {} },
    }])).toBe(315_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "ios_simulator", action: "resolvePreviewMatch", args: {} },
    }])).toBe(2 * 60_000);
  });

  // ADE-122 regression: a handoff (AI brief + session creation + first-message
  // dispatch, or cross-machine history packaging) got the 30s default on the
  // direct-IPC and remote-runtime paths, fired a false timeout, and then
  // completed anyway as a "surprise" session about a minute later.
  it("extends handoff timeouts on direct, local runtime, and remote runtime paths", () => {
    expect(ipcInvokeTimeoutMs(IPC.agentChatHandoff)).toBe(150_000);
    expect(ipcInvokeTimeoutMs(IPC.agentChatPrepareCrossMachineHandoff)).toBe(150_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "chat", action: "handoffSession", args: {} },
    }])).toBe(150_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "chat", action: "prepareCrossMachineHandoff", args: {} },
    }])).toBe(150_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "chat", action: "handoffSession", args: {} },
    }])).toBe(405_000);
  });

  it("keeps remote lane creation unchanged while composing the local timeout", () => {
    expect(ipcInvokeTimeoutMs(IPC.lanesCreate)).toBe(4 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "lane", action: "create", args: {} },
    }])).toBe(4 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "create", args: {} },
    }])).toBe(315_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "createChild", args: {} },
    }])).toBe(315_000);
  });

  it("composes an unmapped named daemon override for local runtime actions", () => {
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "chat", action: "suggestLaneNameFromPrompt", args: {} },
    }])).toBe(405_000);
  });
});
