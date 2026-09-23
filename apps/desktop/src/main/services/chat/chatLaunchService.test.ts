import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentChatEventEnvelope,
  ChatLaunchArgs,
  ChatLaunchEvent,
  ChatLaunchSnapshot,
  LaneEnvInitEvent,
  LaneEnvInitProgress,
  LaneSummary,
} from "../../../shared/types";
import type { AdeCardPayload } from "../../../shared/adeCard";
import type { LaneCreateRuntimeOptions } from "../lanes/laneService";
import { createChatLaunchService, type ChatLaunchServiceDeps } from "./chatLaunchService";
import { buildLaneSetupCard } from "../../../shared/chatLaunch";

const LAUNCH_ID = "6f1c2a4e-1b2c-4d5e-8f90-123456789abc";
const LANE_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function laneSummary(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: LANE_ID,
    name: "fix-flaky-test",
    branchRef: "ade/1a2b3c4d",
    baseRef: "origin/main",
    worktreePath: "/tmp/project/.ade/worktrees/fix-flaky-test-0a1b2c3d",
    ...overrides,
  } as LaneSummary;
}

function chatArgs(overrides: Partial<ChatLaunchArgs> = {}): ChatLaunchArgs {
  return {
    kind: "chat",
    mode: "foreground",
    launchId: LAUNCH_ID,
    laneId: LANE_ID,
    laneName: "fix-flaky-test",
    prompt: "fix the flaky test",
    originClientId: "window-1",
    chat: {
      create: { provider: "codex", model: "openai/gpt-5.6-sol", modelId: "openai/gpt-5.6-sol" },
      message: { text: "fix the flaky test" },
    },
    ...overrides,
  };
}

type Harness = ReturnType<typeof createHarness>;

function createHarness(options: {
  hasEnvironment?: boolean;
  templateName?: string | null;
  localBase?: boolean;
} = {}) {
  const launchesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-launch-"));
  const events: ChatLaunchEvent[] = [];
  const chatSubscribers = new Set<(event: AgentChatEventEnvelope) => void>();
  const envListeners = new Set<(event: LaneEnvInitEvent) => void>();
  const cards: AdeCardPayload[] = [];
  const laneCreate = deferred<LaneSummary>();
  let laneCreateOptions: LaneCreateRuntimeOptions | undefined;
  const environment = deferred<LaneEnvInitProgress>();
  const calls: string[] = [];

  const deps: ChatLaunchServiceDeps = {
    launchesDir,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    laneService: {
      create: vi.fn(async (_args, opts) => {
        calls.push("lane.create");
        laneCreateOptions = opts;
        return laneCreate.promise;
      }),
      delete: vi.fn(async () => {
        calls.push("lane.delete");
      }),
      cleanupReservedWorktree: vi.fn(async () => {
        calls.push("lane.cleanupReserved");
      }),
    },
    agentChatService: {
      createSession: vi.fn(async (args) => {
        calls.push(`chat.create:${args.laneId}:${args.sessionId}`);
        return { id: args.sessionId } as never;
      }),
      sendMessage: vi.fn(async (args: { sessionId: string; text: string }) => {
        calls.push(`chat.send:${args.text}`);
        for (const subscriber of chatSubscribers) {
          subscriber({ sessionId: args.sessionId, timestamp: new Date().toISOString(), event: { type: "user_message", text: args.text } } as never);
        }
      }),
      deleteSession: vi.fn(async () => {
        calls.push("chat.delete");
      }),
      emitAdeCard: vi.fn(async ({ card }) => {
        cards.push(card);
      }),
      subscribeToEvents: (callback) => {
        chatSubscribers.add(callback);
        return () => chatSubscribers.delete(callback);
      },
      generateAutoLaneIdentity: vi.fn(async () => ({
        laneTitle: "Fix flaky login test",
        branchFragment: "fix-flaky-login-test",
        source: "ai" as const,
        laneRenameOutcome: "renamed" as const,
        branchRenameOutcome: "renamed" as const,
        branchRef: "ade/fix-flaky-login-test",
      })),
    },
    usesLocalLaneBase: () => options.localBase === true,
    resolveBase: vi.fn(async () => ({ baseRef: "origin/main", fetch: "ok" as const })),
    resolveCommit: vi.fn(async () => "807fb2cac0ffee"),
    planEnvironment: () => ({
      hasEnvironment: options.hasEnvironment === true,
      templateId: options.templateName ? "tpl-1" : null,
      templateName: options.templateName ?? null,
    }),
    runEnvironment: vi.fn(async () => {
      calls.push("env.run");
      return environment.promise;
    }),
    onEnvironmentEvent: (listener) => {
      envListeners.add(listener);
      return () => envListeners.delete(listener);
    },
    abortEnvironment: vi.fn(),
    onOutcome: vi.fn(),
    emit: (event) => events.push(event),
  };
  const service = createChatLaunchService(deps);

  const latest = (): ChatLaunchSnapshot => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]!;
      if (event.type === "launch-updated") return event.launch;
    }
    throw new Error("no snapshot yet");
  };
  const waitFor = async (predicate: (snapshot: ChatLaunchSnapshot) => boolean) => {
    await vi.waitFor(() => {
      expect(predicate(latest())).toBe(true);
    });
  };

  return {
    service,
    deps,
    events,
    cards,
    calls,
    laneCreate,
    environment,
    envListeners,
    launchesDir,
    latest,
    waitFor,
    get laneCreateOptions() {
      return laneCreateOptions;
    },
  };
}

const harnesses: Harness[] = [];
function harness(options?: Parameters<typeof createHarness>[0]): Harness {
  const created = createHarness(options);
  harnesses.push(created);
  return created;
}

beforeEach(() => {
  harnesses.length = 0;
});

afterEach(() => {
  for (const entry of harnesses) {
    entry.service.dispose();
    fs.rmSync(entry.launchesDir, { recursive: true, force: true });
  }
});

describe("chatLaunchService", () => {
  it("returns a running snapshot at once with only the stages true for this launch", async () => {
    const h = harness();
    const snapshot = await h.service.start(chatArgs());
    expect(snapshot.phase).toBe("running");
    expect(snapshot.sessionId).toBe(LAUNCH_ID);
    expect(snapshot.laneId).toBe(LANE_ID);
    expect(snapshot.stages.map((stage) => stage.id)).toEqual(["fetch", "checkout", "agent"]);
    expect(snapshot.prompt.text).toBe("fix the flaky test");
  });

  it("omits the fetch stage when the project branches from the local base", async () => {
    const h = harness({ localBase: true, hasEnvironment: true, templateName: "Web app" });
    const snapshot = await h.service.start(chatArgs());
    expect(snapshot.stages.map((stage) => stage.id)).toEqual(["checkout", "environment", "agent"]);
    expect(snapshot.templateName).toBe("Web app");
  });

  it("walks fetch → checkout (with live %) → agent, creating the chat under the reserved ids", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await h.waitFor((snapshot) => snapshot.stages[0]?.status === "done");
    expect(h.latest().stages[0]?.detail).toBe("origin/main at 807fb2c");
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    expect(h.laneCreateOptions?.laneId).toBe(LANE_ID);

    h.laneCreateOptions?.onCheckoutProgress?.({ percent: 62, completed: 62, total: 100 });
    await h.waitFor((snapshot) => snapshot.stages[1]?.percent === 62);

    h.laneCreate.resolve(laneSummary());
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    const done = h.latest();
    expect(done.laneCreated && done.sessionCreated && done.agentStarted).toBe(true);
    expect(h.calls).toContain(`chat.create:${LANE_ID}:${LAUNCH_ID}`);
    expect(h.calls).toContain("chat.send:fix the flaky test");
  });

  it("emits the lane_setup transcript card once the opening message lands", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    await vi.waitFor(() => expect(h.cards.length).toBeGreaterThan(0));
    const card = h.cards.at(-1)!;
    expect(card.cardId).toBe(`lane-setup:${LAUNCH_ID}`);
    expect(card.variant).toBe("lane_setup");
    expect(card.rows?.map((row) => row.text)).toEqual(["Fetch base branch", "Check out files", "Start agent"]);
    // Readers match rows by stage id, never by the English label.
    expect(card.rows?.map((row) => row.key)).toEqual(["fetch", "checkout", "agent"]);
  });

  it("is idempotent per launchId", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    const again = await h.service.start(chatArgs({ prompt: "different" }));
    expect(again.prompt.text).toBe("fix the flaky test");
    await vi.waitFor(() => expect(h.deps.laneService.create).toHaveBeenCalled());
    expect(h.deps.laneService.create).toHaveBeenCalledTimes(1);
  });

  it("mirrors environment steps, fails on a failed step, and Start anyway continues to the agent", async () => {
    const h = harness({ hasEnvironment: true, templateName: "Web app" });
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await vi.waitFor(() => expect(h.calls).toContain("env.run"));

    const running: LaneEnvInitProgress = {
      laneId: LANE_ID,
      startedAt: new Date().toISOString(),
      overallStatus: "running",
      steps: [{ kind: "setup-script", label: "Run setup script (1 command(s))", status: "running" }],
    };
    for (const listener of h.envListeners) listener({ type: "lane-env-init", progress: running });
    await h.waitFor((snapshot) => snapshot.stages.find((stage) => stage.id === "environment")?.steps?.[0]?.status === "running");

    h.environment.resolve({
      ...running,
      overallStatus: "failed",
      steps: [{ kind: "setup-script", label: "Run setup script (1 command(s))", status: "failed", error: "exit 1" }],
    });
    await h.waitFor((snapshot) => snapshot.phase === "failed");
    expect(h.latest().error).toContain("exit 1");
    expect(h.calls.some((call) => call.startsWith("chat.create"))).toBe(false);

    await h.service.startNow({ launchId: LAUNCH_ID });
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    expect(h.latest().stages.find((stage) => stage.id === "environment")?.status).toBe("warning");
    expect(h.calls.some((call) => call.startsWith("chat.create"))).toBe(true);
  });

  it("Start now starts the agent while the environment keeps running", async () => {
    const h = harness({ hasEnvironment: true, templateName: "Web app" });
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await vi.waitFor(() => expect(h.calls).toContain("env.run"));

    await h.service.startNow({ launchId: LAUNCH_ID });
    await h.waitFor((snapshot) => snapshot.agentStarted);
    expect(h.latest().phase).toBe("running");

    h.environment.resolve({
      laneId: LANE_ID,
      startedAt: new Date().toISOString(),
      overallStatus: "completed",
      steps: [{ kind: "dependencies", label: "Install dependencies (1 command(s))", status: "completed" }],
    });
    await h.waitFor((snapshot) => snapshot.phase === "completed");
  });

  it("a late environment failure after Start now ends as a warning, never a clean setup", async () => {
    const h = harness({ hasEnvironment: true, templateName: "Web app" });
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await vi.waitFor(() => expect(h.calls).toContain("env.run"));
    await h.service.startNow({ launchId: LAUNCH_ID });
    await h.waitFor((snapshot) => snapshot.agentStarted);
    h.environment.resolve({
      laneId: LANE_ID,
      startedAt: new Date().toISOString(),
      overallStatus: "failed",
      steps: [{ kind: "dependencies", label: "Install dependencies (1 command(s))", status: "failed", error: "npm ERR" }],
    });
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    const environment = h.latest().stages.find((stage) => stage.id === "environment");
    expect(environment?.status).toBe("warning");
    expect(environment?.error).toContain("npm ERR");
    const card = buildLaneSetupCard(h.latest(), Date.now());
    expect(card.title).toMatch(/^Lane set up with warnings/);
    expect(card.rows?.find((row) => row.key === "environment")?.tone).toBe("warning");
    // An older host may have recorded the stage as failed: a completed launch
    // still reads as warnings (its agent runs), and the card settles.
    const legacy = { ...h.latest(), stages: h.latest().stages.map((stage) => (stage.id === "environment" ? { ...stage, status: "failed" as const } : stage)) };
    const legacyCard = buildLaneSetupCard(legacy, Date.now());
    expect(legacyCard.title).toMatch(/^Lane set up with warnings/);
    expect(legacyCard.state).toBe("terminal");
  });

  it("an environment failure while the Start-now send is still in flight never shows a failed stage", async () => {
    const h = harness({ hasEnvironment: true, templateName: "Web app" });
    const send = deferred<void>();
    vi.mocked(h.deps.agentChatService.sendMessage).mockImplementationOnce(async () => send.promise);
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await vi.waitFor(() => expect(h.calls).toContain("env.run"));
    await h.service.startNow({ launchId: LAUNCH_ID });
    await vi.waitFor(() => expect(h.deps.agentChatService.sendMessage).toHaveBeenCalled());

    const before = h.events.length;
    h.environment.resolve({
      laneId: LANE_ID,
      startedAt: new Date().toISOString(),
      overallStatus: "failed",
      steps: [{ kind: "dependencies", label: "Install dependencies (1 command(s))", status: "failed", error: "npm ERR" }],
    });
    await h.waitFor((snapshot) => snapshot.stages.find((stage) => stage.id === "environment")?.status === "warning");
    expect(h.latest().agentStarted).toBe(false);
    send.resolve();
    await h.waitFor((snapshot) => snapshot.phase === "completed");

    const published = h.events.slice(before).flatMap((event) => (event.type === "launch-updated" ? [event.launch] : []));
    expect(published.some((snapshot) => snapshot.phase === "failed")).toBe(false);
    expect(published.some((snapshot) => snapshot.stages.some((stage) => stage.status === "failed"))).toBe(false);
    expect(buildLaneSetupCard(h.latest(), Date.now()).title).toMatch(/^Lane set up with warnings/);
  });

  it("drops the environment stage when nothing applies to the new lane", async () => {
    const h = harness({ hasEnvironment: true });
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    h.environment.resolve({ laneId: LANE_ID, startedAt: "", overallStatus: "completed", steps: [] });
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    expect(h.latest().stages.map((stage) => stage.id)).toEqual(["fetch", "checkout", "agent"]);
  });

  it("fails the checkout stage and retries from it", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.reject(new Error("fatal: invalid reference"));
    await h.waitFor((snapshot) => snapshot.phase === "failed");
    expect(h.latest().stages.find((stage) => stage.id === "checkout")?.error).toContain("invalid reference");

    expect(h.calls).not.toContain("lane.cleanupReserved");

    (h.deps.laneService.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(laneSummary());
    await h.service.retry({ launchId: LAUNCH_ID });
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    // The retry clears what the failed checkout left at the reserved path first.
    expect(h.deps.laneService.cleanupReservedWorktree).toHaveBeenCalledWith({ laneId: LANE_ID, name: "fix-flaky-test" });
    const cleanupOrder = (h.deps.laneService.cleanupReservedWorktree as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!;
    const createOrders = (h.deps.laneService.create as ReturnType<typeof vi.fn>).mock.invocationCallOrder;
    expect(cleanupOrder).toBeGreaterThan(createOrders[0]!);
    expect(cleanupOrder).toBeLessThan(createOrders[1]!);
  });

  it("queues messages typed during setup and sends them after the opening message", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await h.service.queueMessage({ launchId: LAUNCH_ID, text: "also check CI" });
    expect(h.latest().queuedMessages).toHaveLength(1);
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await h.waitFor((snapshot) => snapshot.phase === "completed" && snapshot.queuedMessages.length === 0);
    expect(h.calls.filter((call) => call.startsWith("chat.send"))).toEqual([
      "chat.send:fix the flaky test",
      "chat.send:also check CI",
    ]);
  });

  it("cancel aborts the checkout, and fully deletes a created chat and lane", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    const signal = h.laneCreateOptions?.signal;
    const cancelled = h.service.cancel({ launchId: LAUNCH_ID });
    expect(signal?.aborted).toBe(true);
    h.laneCreate.reject(new Error("git was cancelled"));
    const result = await cancelled;
    expect(result?.phase).toBe("cancelled");
    expect(h.calls).not.toContain("lane.delete");

    // Chat created, opening message still in flight: cancel deletes both.
    const h2 = harness();
    const opening = deferred<void>();
    const send = h2.deps.agentChatService.sendMessage as ReturnType<typeof vi.fn>;
    send.mockImplementationOnce(async () => opening.promise);
    await h2.service.start(chatArgs());
    await vi.waitFor(() => expect(h2.laneCreateOptions).toBeDefined());
    h2.laneCreate.resolve(laneSummary());
    await h2.waitFor((snapshot) => snapshot.sessionCreated);
    const cancelling = h2.service.cancel({ launchId: LAUNCH_ID });
    opening.resolve();
    await cancelling;
    expect(h2.calls).toContain("chat.delete");
    expect(h2.calls).toContain("lane.delete");
    expect(h2.deps.laneService.delete).toHaveBeenCalledWith(expect.objectContaining({
      laneId: LANE_ID,
      deleteBranch: true,
      deleteRemoteBranch: true,
      force: true,
    }));
    expect(h2.latest().phase).toBe("cancelled");
  });

  it("cancel during the environment stage kills the running setup before deleting the lane", async () => {
    const h = harness({ hasEnvironment: true, templateName: "Slow setup" });
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await vi.waitFor(() => expect(h.calls).toContain("env.run"));
    const cancelled = await h.service.cancel({ launchId: LAUNCH_ID });
    expect(cancelled?.phase).toBe("cancelled");
    expect(h.deps.abortEnvironment).toHaveBeenCalledWith({ laneId: LANE_ID, worktreePath: laneSummary().worktreePath });
    expect(h.calls).toContain("lane.delete");
    expect(h.calls.some((call) => call.startsWith("chat.create"))).toBe(false);
  });

  it("CLI launches stop at awaiting-client and complete when the client reports its session", async () => {
    const h = harness();
    await h.service.start(chatArgs({ kind: "cli", chat: undefined }));
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await h.waitFor((snapshot) => snapshot.phase === "awaiting-client");
    expect(h.latest().stages.at(-1)?.status).toBe("running");
    expect(h.deps.agentChatService.createSession).not.toHaveBeenCalled();

    await h.service.completeClient({ launchId: LAUNCH_ID, sessionId: "pty-session-1" });
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    expect(h.latest().sessionId).toBe("pty-session-1");
  });

  it("marks a launch interrupted by a restart as failed, with the lane state intact", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await h.waitFor((snapshot) => snapshot.stages[0]?.status === "done");
    h.service.dispose();

    const events: ChatLaunchEvent[] = [];
    const reloaded = createChatLaunchService({ ...h.deps, emit: (event) => events.push(event) });
    const snapshot = reloaded.get({ launchId: LAUNCH_ID });
    expect(snapshot?.phase).toBe("failed");
    expect(snapshot?.error).toMatch(/interrupted/i);
    reloaded.dispose();
  });

  it("the interrupted snapshot outranks every snapshot clients saw before the restart", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    // Progress publishes are not persisted, so the file's sequence lags these.
    for (const percent of [10, 20, 30, 40]) {
      h.laneCreateOptions?.onCheckoutProgress?.({ percent, completed: percent, total: 100 });
      await h.waitFor((snapshot) => snapshot.stages[1]?.percent === percent);
      await new Promise((resolve) => setTimeout(resolve, 130));
    }
    const lastSeen = h.latest().sequence;
    h.service.dispose();

    const reloaded = createChatLaunchService({ ...h.deps, emit: () => {} });
    const snapshot = reloaded.get({ launchId: LAUNCH_ID });
    expect(snapshot?.phase).toBe("failed");
    expect(snapshot!.sequence).toBeGreaterThan(lastSeen);
    reloaded.dispose();
  });

  it("Retry after Start now reuses the in-flight environment instead of running it twice", async () => {
    const h = harness({ hasEnvironment: true, templateName: "Web app" });
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await vi.waitFor(() => expect(h.calls).toContain("env.run"));

    (h.deps.agentChatService.createSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("provider offline"));
    await h.service.startNow({ launchId: LAUNCH_ID });
    await h.waitFor((snapshot) => snapshot.phase === "failed");
    expect(h.latest().stages.find((stage) => stage.id === "agent")?.error).toContain("provider offline");

    await h.service.retry({ launchId: LAUNCH_ID });
    await h.waitFor((snapshot) => snapshot.agentStarted);
    h.environment.resolve({
      laneId: LANE_ID,
      startedAt: new Date().toISOString(),
      overallStatus: "completed",
      steps: [{ kind: "dependencies", label: "Install dependencies (1 command(s))", status: "completed" }],
    });
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    expect(h.deps.runEnvironment).toHaveBeenCalledTimes(1);
  });

  it("keeps a queued message whose delivery failed, marks it, and redelivers it in order", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await h.service.queueMessage({ launchId: LAUNCH_ID, text: "also check CI" });
    const send = h.deps.agentChatService.sendMessage as ReturnType<typeof vi.fn>;
    const realSend = send.getMockImplementation()!;
    send.mockImplementation(async (args: { text: string }, ...rest: unknown[]) => {
      if (args.text === "also check CI" && !h.calls.includes("failed-once")) {
        h.calls.push("failed-once");
        throw new Error("chat busy");
      }
      return realSend(args as never, ...(rest as []));
    });
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());

    await h.waitFor((snapshot) => snapshot.phase === "completed" && snapshot.queuedMessages[0]?.deliveryError === "chat busy");
    expect(h.latest().queuedMessages.map((message) => message.text)).toEqual(["also check CI"]);

    // A new message queues behind the undelivered one and retries the queue now.
    await h.service.queueMessage({ launchId: LAUNCH_ID, text: "and the docs" });
    await h.waitFor((snapshot) => snapshot.queuedMessages.length === 0);
    expect(h.calls.filter((call) => call.startsWith("chat.send"))).toEqual([
      "chat.send:fix the flaky test",
      "chat.send:also check CI",
      "chat.send:and the docs",
    ]);
  });

  it("reports each outcome once per launch for analytics (failed, then completed after retry)", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.reject(new Error("fatal: invalid reference"));
    await h.waitFor((snapshot) => snapshot.phase === "failed");
    (h.deps.laneService.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce(laneSummary());
    await h.service.retry({ launchId: LAUNCH_ID });
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    const outcomes = (h.deps.onOutcome as ReturnType<typeof vi.fn>).mock.calls.map(([args]) => args);
    expect(outcomes).toEqual([
      { outcome: "failed", provider: "codex" },
      { outcome: "completed", provider: "codex" },
    ]);
  });

  it("drops queued messages with a clear error once the chat itself is gone, so the launch can expire", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await h.service.queueMessage({ launchId: LAUNCH_ID, text: "also check CI" });
    const send = h.deps.agentChatService.sendMessage as ReturnType<typeof vi.fn>;
    const realSend = send.getMockImplementation()!;
    send.mockImplementation(async (args: { text: string }, ...rest: unknown[]) => {
      if (args.text === "also check CI") throw new Error(`Chat session '${LAUNCH_ID}' was not found.`);
      return realSend(args as never, ...(rest as []));
    });
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await h.waitFor((snapshot) => snapshot.phase === "completed" && snapshot.queuedMessages.length === 0 && Boolean(snapshot.error));
    expect(h.latest().error).toMatch(/chat was deleted/i);
  });

  it("auto-picks an empty chat model through the injected resolver before creating the chat", async () => {
    const h = harness();
    h.deps.resolveChatCreate = vi.fn(async (create) => ({ ...create, model: "openai/picked", modelId: "openai/picked" }));
    const service = createChatLaunchService(h.deps);
    const launchId = "7a1c2a4e-1b2c-4d5e-8f90-123456789abc";
    try {
      await service.start(chatArgs({
        launchId,
        chat: { create: { provider: "codex", model: "" }, message: { text: "fix the flaky test" } },
      }));
      await expect(service.start(chatArgs({ launchId, chat: { create: { provider: "" as never, model: "" }, message: { text: "x" } } })))
        .resolves.toMatchObject({ launchId });
      await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
      h.laneCreate.resolve(laneSummary());
      await vi.waitFor(() => expect(h.deps.agentChatService.createSession).toHaveBeenCalledWith(expect.objectContaining({ model: "openai/picked", sessionId: launchId })));
    } finally {
      service.dispose();
    }
  });

  it("cancel waits for the pipeline and deletes a lane whose checkout finished after the abort", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    const cancelled = h.service.cancel({ launchId: LAUNCH_ID });
    // git finished the checkout just as the abort landed: the lane exists.
    h.laneCreate.resolve(laneSummary());
    const result = await cancelled;
    expect(result?.phase).toBe("cancelled");
    expect(result?.laneCreated).toBe(false);
    expect(h.calls).toContain("lane.delete");
    expect(h.calls.some((call) => call.startsWith("chat.create"))).toBe(false);
  });

  it("cleans up what a pipeline creates after cancel's wait ran out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      await h.service.start(chatArgs());
      await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
      const cancelled = h.service.cancel({ launchId: LAUNCH_ID });
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await cancelled;
      expect(result?.phase).toBe("cancelled");
      expect(h.calls).not.toContain("lane.delete");

      h.laneCreate.resolve(laneSummary());
      await vi.waitFor(() => expect(h.calls).toContain("lane.delete"));
      await vi.waitFor(() => expect(h.latest().laneCreated).toBe(false));
    } finally {
      vi.useRealTimers();
    }
  });

  it("queueMessage throws for an unknown launch instead of returning null", async () => {
    const h = harness();
    await expect(h.service.queueMessage({ launchId: LAUNCH_ID, text: "hello" }))
      .rejects.toThrow(`Launch not found: ${LAUNCH_ID}`);
  });

  it("cancel refuses once the agent started; a cancelled launch stays a no-op", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.laneCreate.resolve(laneSummary());
    await h.waitFor((snapshot) => snapshot.phase === "completed");
    await expect(h.service.cancel({ launchId: LAUNCH_ID }))
      .rejects.toThrow("This chat already started — delete its lane from the lane menu instead.");
    expect(h.calls).not.toContain("lane.delete");
    expect(h.calls).not.toContain("chat.delete");

    const h2 = harness();
    await h2.service.start(chatArgs());
    await vi.waitFor(() => expect(h2.laneCreateOptions).toBeDefined());
    h2.laneCreate.reject(new Error("fatal: invalid reference"));
    await h2.waitFor((snapshot) => snapshot.phase === "failed");
    // Failed before the agent started: cancel is allowed, and repeatable.
    expect((await h2.service.cancel({ launchId: LAUNCH_ID }))?.phase).toBe("cancelled");
    expect((await h2.service.cancel({ launchId: LAUNCH_ID }))?.phase).toBe("cancelled");
  });

  it("a cancelled launch drops its queued messages and still expires", async () => {
    const h = harness();
    const service = createChatLaunchService({ ...h.deps, finishedRetentionMs: 20 });
    try {
      await service.start(chatArgs());
      await service.queueMessage({ launchId: LAUNCH_ID, text: "also check CI" });
      await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
      const cancelling = service.cancel({ launchId: LAUNCH_ID });
      h.laneCreate.reject(new Error("git was cancelled"));
      const cancelled = await cancelling;
      expect(cancelled?.queuedMessages).toEqual([]);
      await vi.waitFor(() => expect(h.events).toContainEqual({ type: "launch-removed", launchId: LAUNCH_ID }));
      expect(service.get({ launchId: LAUNCH_ID })).toBeNull();
    } finally {
      service.dispose();
    }
  });

  it("after dispose, late pipeline work neither publishes nor re-arms timers", async () => {
    const h = harness();
    await h.service.start(chatArgs());
    await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
    h.service.dispose();
    const seen = h.events.length;
    h.laneCreateOptions?.onCheckoutProgress?.({ percent: 50, completed: 50, total: 100 });
    h.laneCreate.resolve(laneSummary());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.events.length).toBe(seen);
    expect(h.deps.agentChatService.createSession).not.toHaveBeenCalled();
  });

  describe("a checkout interrupted after its lane row landed (ADE restarted mid-create)", () => {
    async function interrupted() {
      const h = harness();
      await h.service.start(chatArgs());
      await vi.waitFor(() => expect(h.laneCreateOptions).toBeDefined());
      h.service.dispose();
      const findLaneIdentity = vi.fn(() => laneSummary());
      const events: ChatLaunchEvent[] = [];
      const reloaded = createChatLaunchService({
        ...h.deps,
        laneService: { ...h.deps.laneService, findLaneIdentity },
        emit: (event) => events.push(event),
      });
      const latest = () => {
        const last = events.filter((event) => event.type === "launch-updated").at(-1);
        return last?.type === "launch-updated" ? last.launch : null;
      };
      return { h, reloaded, findLaneIdentity, latest };
    }

    it("Retry adopts the existing lane instead of failing on the reserved id", async () => {
      const { h, reloaded, latest } = await interrupted();
      try {
        expect(reloaded.get({ launchId: LAUNCH_ID })?.phase).toBe("failed");
        await reloaded.retry({ launchId: LAUNCH_ID });
        await vi.waitFor(() => expect(latest()?.phase).toBe("completed"));
        const done = latest()!;
        expect(done.laneCreated).toBe(true);
        expect(done.worktreePath).toBe(laneSummary().worktreePath);
        expect(done.stages.find((stage) => stage.id === "checkout")?.status).toBe("done");
        expect(h.deps.laneService.create).toHaveBeenCalledTimes(1);
        expect(h.deps.laneService.cleanupReservedWorktree).not.toHaveBeenCalled();
        expect(h.deps.agentChatService.createSession).toHaveBeenCalledWith(expect.objectContaining({ laneId: LANE_ID }));
      } finally {
        reloaded.dispose();
      }
    });

    it("Cancel deletes the lane even though the record never saw it created", async () => {
      const { h, reloaded } = await interrupted();
      try {
        const cancelled = await reloaded.cancel({ launchId: LAUNCH_ID });
        expect(cancelled?.phase).toBe("cancelled");
        expect(h.deps.laneService.delete).toHaveBeenCalledWith(expect.objectContaining({ laneId: LANE_ID, force: true }));
      } finally {
        reloaded.dispose();
      }
    });
  });
});
