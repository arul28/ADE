import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserRemoteCall } from "../../shared/types/builtInBrowserRemote";

/**
 * This desktop answering the browser commands of a chat on another machine.
 * The contract: a command runs here at most once, and only when the daemon
 * that sent it still wants it here. A command the daemon already ran on its
 * own machine (it gave up waiting for "taken") must not run again here, or a
 * click or a form submit happens in two browsers.
 */

const THIS_DESKTOP = "desktop-studio";

type Fakes = {
  emit: (call: BuiltInBrowserRemoteCall) => void;
  claimRemoteRequest: ReturnType<typeof vi.fn>;
  replyRemoteCall: ReturnType<typeof vi.fn>;
  runRemoteAgentCall: ReturnType<typeof vi.fn>;
};

function installBrowserApi(overrides: Partial<Omit<Fakes, "emit">> = {}): Fakes {
  let listener: ((call: BuiltInBrowserRemoteCall) => void) | null = null;
  const fakes = {
    claimRemoteRequest: vi.fn(async () => ({ claimed: true })),
    replyRemoteCall: vi.fn(async () => ({ ok: true })),
    runRemoteAgentCall: vi.fn(async () => ({ ok: true, result: { title: "Example" }, files: [], machineName: "studio" })),
    ...overrides,
  };
  (globalThis as unknown as { window: unknown }).window = {
    ade: {
      app: { desktopClientId: THIS_DESKTOP },
      builtInBrowser: {
        ...fakes,
        onRemoteCall: vi.fn((cb: (call: BuiltInBrowserRemoteCall) => void) => {
          listener = cb;
          return () => {
            listener = null;
          };
        }),
      },
    },
  };
  return {
    ...fakes,
    emit: (call) => {
      if (!listener) throw new Error("no remote-call subscription");
      listener(call);
    },
  };
}

const binding = { kind: "remote", key: "remote:windows-pc:project-a", targetId: "windows-pc", projectId: "project-a" } as never;

function call(overrides: Partial<BuiltInBrowserRemoteCall> = {}): BuiltInBrowserRemoteCall {
  return {
    requestId: "bbc-1",
    method: "click",
    input: { tabId: "tab-1", ref: "e3", projectRoot: "C:\\\\work\\\\project-a" },
    chatSessionId: "chat-pc",
    laneId: "lane-pc",
    requestedAt: "2026-10-13T00:00:00.000Z",
    targetClientId: THIS_DESKTOP,
    ...overrides,
  };
}

/** Every promise chain the event started has settled (no wall clock). */
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

async function serve() {
  const { serveRemoteBrowserCalls } = await import("./remoteBrowserCallHost");
  serveRemoteBrowserCalls(binding, { chatSessionId: "chat-pc", laneId: "lane-pc", projectRoot: "/Users/me/project-a" });
}

describe("remoteBrowserCallHost", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("runs a command for a chat it serves, as that chat, in this window's project, and answers taken then done", async () => {
    const fakes = installBrowserApi();
    await serve();
    fakes.emit(call());

    await vi.waitFor(() => expect(fakes.replyRemoteCall).toHaveBeenCalledTimes(2));
    expect(fakes.runRemoteAgentCall).toHaveBeenCalledTimes(1);
    const input = fakes.runRemoteAgentCall.mock.calls[0]![0].input;
    expect(input).toMatchObject({ chatSessionId: "chat-pc", laneId: "lane-pc", projectRoot: "/Users/me/project-a", tabId: "tab-1" });
    const [taken, done] = fakes.replyRemoteCall.mock.calls.map(([reply]) => reply);
    expect(taken).toMatchObject({ requestId: "bbc-1", clientId: THIS_DESKTOP, phase: "taken" });
    expect(done).toMatchObject({ requestId: "bbc-1", clientId: THIS_DESKTOP, phase: "done", ok: true, result: { title: "Example" } });
    expect(fakes.replyRemoteCall.mock.calls[0]![1]).toBe(binding);
  });

  it.each([
    { name: "the daemon refused the taken reply", overrides: { replyRemoteCall: vi.fn(async () => ({ ok: false })) } },
    { name: "the taken reply could not be sent", overrides: { replyRemoteCall: vi.fn(async () => { throw new Error("offline"); }) } },
    { name: "another window of this desktop claimed it", overrides: { claimRemoteRequest: vi.fn(async () => ({ claimed: false })) } },
    { name: "the claim itself failed", overrides: { claimRemoteRequest: vi.fn(async () => { throw new Error("ipc"); }) } },
  ])("runs nothing when $name", async ({ overrides }) => {
    const fakes = installBrowserApi(overrides);
    await serve();
    fakes.emit(call());

    await drain();
    expect(fakes.claimRemoteRequest).toHaveBeenCalledTimes(1);
    expect(fakes.runRemoteAgentCall).not.toHaveBeenCalled();
    expect(fakes.replyRemoteCall.mock.calls.filter(([reply]) => reply.phase === "done")).toHaveLength(0);
  });

  it.each([
    { name: "a command addressed to another desktop", overrides: { targetClientId: "desktop-laptop" } },
    { name: "a command for a chat this desktop never showed", overrides: { chatSessionId: "chat-other" } },
  ])("ignores $name", async ({ overrides }) => {
    const fakes = installBrowserApi();
    await serve();
    fakes.emit(call(overrides));
    await drain();
    expect(fakes.claimRemoteRequest).not.toHaveBeenCalled();
    expect(fakes.runRemoteAgentCall).not.toHaveBeenCalled();
    expect(fakes.replyRemoteCall).not.toHaveBeenCalled();
  });

  it("runs a replayed command once", async () => {
    const fakes = installBrowserApi();
    await serve();
    fakes.emit(call());
    fakes.emit(call());
    await vi.waitFor(() => expect(fakes.replyRemoteCall).toHaveBeenCalledTimes(2));
    expect(fakes.claimRemoteRequest).toHaveBeenCalledTimes(1);
    expect(fakes.runRemoteAgentCall).toHaveBeenCalledTimes(1);
  });
});
