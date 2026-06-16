import { describe, expect, it } from "vitest";
import { IPC } from "../../../shared/ipc";
import { ipcInvokeTimeoutMs } from "./ipcTimeouts";

describe("ipcInvokeTimeoutMs", () => {
  it("uses the lane delete budget for runtime-backed lane delete actions", () => {
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "delete", args: { laneId: "lane-1" } },
    }])).toBe(4 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "lane", action: "delete", args: { laneId: "lane-1" } },
    }])).toBe(4 * 60_000);
  });

  it("gives ordinary local runtime calls enough time to bind a cold project", () => {
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "list" },
    }])).toBe(150_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction)).toBe(150_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallSync)).toBe(150_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeListActionRegistry)).toBe(150_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeStreamEvents)).toBe(150_000);
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
    }])).toBe(2 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "ios_simulator", action: "renderCurrentPreview", args: {} },
    }])).toBe(2 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.remoteRuntimeCallAction, [{
      id: "target-1",
      projectId: "project-1",
      request: { domain: "ios_simulator", action: "resolvePreviewMatch", args: {} },
    }])).toBe(2 * 60_000);
  });

  it("extends lane creation timeouts on direct and local runtime paths", () => {
    expect(ipcInvokeTimeoutMs(IPC.lanesCreate)).toBe(4 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "create", args: {} },
    }])).toBe(4 * 60_000);
    expect(ipcInvokeTimeoutMs(IPC.localRuntimeCallAction, [{
      request: { domain: "lane", action: "createChild", args: {} },
    }])).toBe(4 * 60_000);
  });
});
