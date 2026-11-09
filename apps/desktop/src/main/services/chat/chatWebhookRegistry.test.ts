import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The network is the boundary: DNS answers a public address, and each POST is
// recorded and answered 200.
const posts: Array<{ url: string; authorization: string | undefined; body: Record<string, unknown> }> = [];
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));
vi.mock("node:https", () => {
  const request = (url: URL, options: { headers: Record<string, string> }, onResponse: (response: { statusCode: number; resume: () => void }) => void) => ({
    on: () => undefined,
    end: (body: string) => {
      posts.push({ url: url.toString(), authorization: options.headers.authorization, body: JSON.parse(body) });
      onResponse({ statusCode: 200, resume: () => undefined });
    },
  });
  return { default: { request } };
});

const { createChatWebhookRegistry } = await import("./chatWebhookRegistry");

const logger = { info: vi.fn(), warn: vi.fn() };

/** One brain's registry on the shared secrets folder, with the chat state it sees. */
function brain(secretsDir: string, opts: { runs: boolean }) {
  const summaries = new Map<string, Record<string, unknown>>();
  const registry = createChatWebhookRegistry({
    logger,
    secretsDir,
    readSummary: async (sessionId) => summaries.get(sessionId) ?? null,
    runsHere: () => opts.runs,
    ownedElsewhere: () => !opts.runs,
  });
  return { registry, summaries };
}

describe("chat webhooks", () => {
  let secretsDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    posts.length = 0;
    secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-webhooks-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(secretsDir, { recursive: true, force: true });
  });

  it("reports a turn that starts and ends between two checks, once, with the bearer key", async () => {
    const { registry, summaries } = brain(secretsDir, { runs: true });
    summaries.set("chat-1", { status: "idle", laneId: "lane-1", title: "Fix the test" });
    await registry.arm({ sessionId: "chat-1", url: "https://hooks.example.com/ade", token: "key-1" });
    await vi.advanceTimersByTimeAsync(300);
    // Idle before any turn ran: nothing finished, nothing to report.
    expect(posts).toHaveLength(0);

    // The turn starts and is already over when the check reads the chat.
    registry.signal("chat-1", { type: "status", turnStatus: "started" });
    await vi.advanceTimersByTimeAsync(300);
    registry.signal("chat-1", { type: "done" });
    await vi.advanceTimersByTimeAsync(300);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: "https://hooks.example.com/ade",
      authorization: "Bearer key-1",
      body: { event: "chat.idle", sessionId: "chat-1", laneId: "lane-1" },
    });
    // The bearer key never leaves the registry through a listing.
    expect(JSON.stringify(await registry.list())).not.toContain("key-1");

    // A turn that fails leaves the chat idle; only its end event says it failed.
    summaries.set("chat-1", { status: "active", laneId: "lane-1" });
    registry.signal("chat-1", { type: "status", turnStatus: "started" });
    await vi.advanceTimersByTimeAsync(300);
    summaries.set("chat-1", { status: "idle", laneId: "lane-1" });
    registry.signal("chat-1", { type: "done", status: "failed" });
    await vi.advanceTimersByTimeAsync(300);
    expect(posts.map((post) => post.body.event)).toEqual(["chat.idle", "chat.failed"]);
    registry.dispose();
  });

  it("drops a webhook another brain on the project cancelled, and never writes it back", async () => {
    const armer = brain(secretsDir, { runs: false });
    const runner = brain(secretsDir, { runs: true });
    runner.summaries.set("chat-2", { status: "active" });
    await armer.registry.arm({ sessionId: "chat-2", url: "https://hooks.example.com/ade" });

    // The brain that runs the chat learns of the webhook through the file.
    runner.registry.signal("chat-2", { type: "status", turnStatus: "started" });
    await vi.advanceTimersByTimeAsync(300);
    expect(await runner.registry.list({ sessionId: "chat-2" })).toHaveLength(1);

    await armer.registry.cancel({ sessionId: "chat-2" });
    runner.summaries.set("chat-2", { status: "idle" });
    await vi.advanceTimersByTimeAsync(1_100);
    runner.registry.signal("chat-2", { type: "done" });
    await vi.advanceTimersByTimeAsync(16_000);

    expect(posts).toHaveLength(0);
    expect(await runner.registry.list({ sessionId: "chat-2" })).toHaveLength(0);
    const onDisk = JSON.parse(fs.readFileSync(path.join(secretsDir, "chat-webhooks.json"), "utf8")) as { hooks: unknown[]; removed: Record<string, number> };
    expect(onDisk.hooks).toHaveLength(0);
    expect(Object.keys(onDisk.removed)).toHaveLength(1);
    armer.registry.dispose();
    runner.registry.dispose();
  });
});
