import { describe, expect, it } from "vitest";
import type {
  RemoteRuntimeActionRequest,
  RemoteRuntimeConnectionStatus,
} from "../../../shared/types";
import { updateViaRemoteTerminal } from "./remoteTerminalUpdate";

function stuckWindowsMachine(): RemoteRuntimeConnectionStatus {
  return {
    target: { id: "pc", name: "Gaming PC" } as RemoteRuntimeConnectionStatus["target"],
    state: "connected",
    arch: "win32-x64",
    version: "1.2.112",
    projects: [
      { projectId: "gone", rootPath: "C:\\old\\ADE", displayName: "ADE", addedAt: 1, lastOpenedAt: 9, gitOriginUrl: null, exists: false },
      { projectId: "live", rootPath: "C:\\dev\\ADE", displayName: "ADE", addedAt: 1, lastOpenedAt: 5, gitOriginUrl: null, exists: true },
    ],
    lastError: null,
    lastAttemptedAt: null,
    connectedAt: 1,
  };
}

type SessionRead = { status: string; exitCode?: number; lastOutputPreview?: string } | Error;

/**
 * The paired machine as the update sees it: a lane, a terminal it can open,
 * and the terminal's state on each progress read. An Error read is the call
 * failing; `connected` is whether the paired connection is up at that moment.
 */
async function runUpdate(reads: Array<{ read: SessionRead; connected: boolean }>) {
  const calls: Array<{ projectId: string; request: RemoteRuntimeActionRequest }> = [];
  let readIndex = 0;
  let connected = true;
  let clock = 0;
  const result = await updateViaRemoteTerminal({
    status: stuckWindowsMachine(),
    targetVersion: "1.2.120",
    logger: { info: () => {}, warn: () => {} },
    timeoutMs: 60_000,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    isConnected: () => connected,
    callAction: async (_targetId, projectId, request) => {
      calls.push({ projectId, request });
      if (request.domain === "lane") return { result: [{ id: "lane-1", laneType: "primary" }] } as never;
      if (request.domain === "pty" && request.action === "create") return { result: { sessionId: "s1", ptyId: "p1" } } as never;
      if (request.domain === "pty") return { result: null } as never;
      const next = reads[Math.min(readIndex, reads.length - 1)]!;
      readIndex += 1;
      connected = next.connected;
      if (next.read instanceof Error) throw next.read;
      return { result: { session: next.read } } as never;
    },
  });
  return { result, calls };
}

describe("updateViaRemoteTerminal", () => {
  it.each([
    {
      label: "the updater exits 0 (staged and running detached)",
      reads: [{ read: { status: "running" }, connected: true }, { read: { status: "completed", exitCode: 0 }, connected: true }],
      ok: true,
    },
    {
      label: "the connection drops mid-run (the update stopped the brain)",
      reads: [{ read: new Error("socket closed"), connected: false }],
      ok: true,
    },
    {
      label: "the updater exits non-zero",
      reads: [{ read: { status: "completed", exitCode: 3, lastOutputPreview: "checksum mismatch" }, connected: true }],
      ok: false,
    },
    {
      label: "the machine keeps refusing the progress read while still connected",
      reads: [{ read: new Error("Chat session 's1' was not found"), connected: true }],
      ok: false,
    },
  ])("reports installing only when the update really started: $label", async ({ reads, ok }) => {
    const { result, calls } = await runUpdate(reads);

    expect(result.ok).toBe(ok);
    expect(result.route).toBe("terminal");
    expect(result.pendingVersion).toBe(ok ? "1.2.120" : null);
    if (!ok) expect(result.message).toContain("ade brain update --version 1.2.120");
    // The terminal opens in the checkout that is still on disk, not the most recent stale one.
    const created = calls.find((call) => call.request.domain === "pty" && call.request.action === "create");
    expect(created?.projectId).toBe("live");
    expect(created?.request).toMatchObject({ args: { laneId: "lane-1", tracked: false } });
  });
});
