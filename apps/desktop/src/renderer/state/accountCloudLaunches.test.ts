/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { refreshAccountCloudLaunches, retryAccountCloudLaunch, startAccountCloudChat, useAccountCloudLaunches } from "./accountCloudLaunches";
import { refreshAccountProjectList } from "./accountProjectListClient";
import { CloudApiError } from "../../shared/cloudApiClient";

const originalAde = globalThis.window.ade;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  globalThis.window.ade = originalAde;
});

/** The web app's bridge to the account server, one account at a time. */
describe("account cloud launches across an account change", () => {
  it("drops the last account's launches and messages, and ignores a read the last account started", async () => {
    let userId = "user-a";
    const reads = new Map<string, Promise<{ launches: Array<{ launchId: string; projectOrigin: string }> }>>([
      ["user-a", Promise.resolve({ launches: [{ launchId: "launch-a", projectOrigin: "github.com/acme/app" }] })],
    ]);
    const slowB = deferred<{ launches: Array<{ launchId: string; projectOrigin: string }> }>();
    reads.set("user-b", slowB.promise);
    reads.set("user-c", Promise.resolve({ launches: [] }));
    const status = vi.fn(async (launchId: string) => ({ launchId, state: "running", sessionId: "chat-a", stages: [], updatedAt: 1 }));
    const messages = vi.fn(async () => ({
      messages: [{ messageId: "m1", seq: 1, text: "user A's private message", provider: null, modelId: null, state: "delivered", sessionId: "chat-a", error: null, createdAt: 1, updatedAt: 1 }],
    }));
    globalThis.window.ade = {
      cloudLaunches: { start: vi.fn(), active: vi.fn(() => reads.get(userId)!), status, messages },
      account: { status: vi.fn(async () => ({ userId })) },
      project: { accountList: vi.fn(async () => ({ state: "ready", projects: [] })) },
    } as unknown as typeof window.ade;

    await refreshAccountProjectList({ force: true });
    const { result } = renderHook(() => useAccountCloudLaunches());
    await waitFor(() => expect(result.current.entries[0]?.messages[0]?.text).toBe("user A's private message"));

    // Another account signs in here: nothing of the last one stays on screen.
    userId = "user-b";
    await refreshAccountProjectList({ force: true });
    await waitFor(() => expect(result.current.entries).toEqual([]));
    expect(result.current.known).toBe(false);

    // A third account before B's read came back: B's late answer lands nowhere.
    userId = "user-c";
    await refreshAccountProjectList({ force: true });
    await waitFor(() => expect(result.current.known).toBe(true));
    slowB.resolve({ launches: [{ launchId: "launch-b", projectOrigin: "github.com/acme/app" }] });
    // Run every pending microtask (the late read's continuation) before looking.
    await new Promise((flushed) => setTimeout(flushed, 0));
    expect(result.current.entries).toEqual([]);
    expect(status).not.toHaveBeenCalledWith("launch-b");
  });
});

/** The web's first message to a new ADE Cloud chat with images: the server gets the files before the start names them. */
describe("account cloud launch files", () => {
  it("sends every file before the start, names them on it, and never starts without one that failed", async () => {
    const uploads: string[] = [];
    let failOnce = true;
    const uploadFile = vi.fn(async (_launchId: string, fileId: string, bytes: Uint8Array) => {
      if (fileId.startsWith("f1-") && failOnce) {
        failOnce = false;
        throw new Error("the network dropped");
      }
      uploads.push(fileId);
      return { fileId, sizeBytes: bytes.byteLength };
    });
    const start = vi.fn(async (request: { launchId: string }) => ({ launchId: request.launchId, state: "making", stages: [], updatedAt: 1 }));
    globalThis.window.ade = {
      cloudLaunches: { start, uploadFile, active: vi.fn(async () => ({ launches: [] })), status: vi.fn(), messages: vi.fn(async () => ({ messages: [] })) },
      account: { status: vi.fn(async () => ({ userId: "user-a" })) },
      project: { accountList: vi.fn(async () => ({ state: "ready", projects: [] })) },
    } as unknown as typeof window.ade;
    await refreshAccountProjectList({ force: true });
    const { result } = renderHook(() => useAccountCloudLaunches());
    const file = (name: string, text: string) => ({ name, read: async () => ({ bytes: new TextEncoder().encode(text), contentType: "image/png" }) });

    const launchId = await startAccountCloudChat({
      origin: "https://github.com/acme/app", provider: "claude", modelId: "claude-sonnet-5-5", prompt: "look at these",
      files: [file("one.png", "aaaa"), file("two.png", "bb")],
    });

    // The second file couldn't go: no start, and the entry names the file.
    expect(start).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.entries.find((entry) => entry.launchId === launchId)?.startError).toContain("two.png"));

    await retryAccountCloudLaunch(launchId);
    expect(start).toHaveBeenCalledTimes(1);
    const sent = start.mock.calls[0]![0] as unknown as { chat: { attachments: Array<{ name: string; sizeBytes: number; contentType: string }> } };
    expect(sent.chat.attachments.map((entry) => [entry.name, entry.sizeBytes, entry.contentType])).toEqual([["one.png", 4, "image/png"], ["two.png", 2, "image/png"]]);
    expect(uploads.every((fileId) => fileId.endsWith(launchId.slice(0, 8)))).toBe(true);
  });
});

/** A web start whose answer never came: the server may have kept it and makes the computer without the tab. */
describe("account cloud launch whose start answer was lost", () => {
  const noAnswer = new CloudApiError("ADE Cloud did not answer in time. Try again.", "timeout", 0);
  it.each<[string, CloudApiError, "kept" | "missing", { state: string | null; startError: string | null; read: boolean }]>([
    ["a gateway timeout, for a start the server kept: the card follows the launch", new CloudApiError("ADE Cloud had a problem.", "http_524", 524), "kept", { state: "joining", startError: null, read: true }],
    ["no answer, for a start the server kept: the card follows the launch", noAnswer, "kept", { state: "joining", startError: null, read: true }],
    ["no answer, for a start the server never got: its error, with Retry", noAnswer, "missing", { state: null, startError: noAnswer.message, read: true }],
    ["a refusal: its error at once, and nothing is read", new CloudApiError("You're using all 3 of your cloud computers.", "computer_limit", 409), "kept", { state: null, startError: "You're using all 3 of your cloud computers.", read: false }],
  ])("%s", async (_label, error, server, expected) => {
    const status = vi.fn(async (launchId: string) => {
      if (server === "missing") throw new CloudApiError("Not found.", "not_found", 404);
      return { launchId, state: "joining", stages: [], updatedAt: 2 };
    });
    globalThis.window.ade = {
      cloudLaunches: {
        start: vi.fn(async () => { throw error; }),
        active: vi.fn(async () => ({ launches: [] })),
        status,
        messages: vi.fn(async () => ({ messages: [] })),
      },
      account: { status: vi.fn(async () => ({ userId: "user-a" })) },
      project: { accountList: vi.fn(async () => ({ state: "ready", projects: [] })) },
    } as unknown as typeof window.ade;
    await refreshAccountProjectList({ force: true });
    const { result } = renderHook(() => useAccountCloudLaunches());

    const launchId = await startAccountCloudChat({ origin: "https://github.com/acme/app", provider: "claude", modelId: "claude-sonnet-5-5", prompt: "fix it" });
    refreshAccountCloudLaunches();

    const entry = () => result.current.entries.find((candidate) => candidate.launchId === launchId);
    await waitFor(() => expect([entry()?.record?.state ?? null, entry()?.startError ?? null]).toEqual([expected.state, expected.startError]));
    if (expected.read) expect(status).toHaveBeenCalledWith(launchId);
    else expect(status).not.toHaveBeenCalledWith(launchId);
  });
});
