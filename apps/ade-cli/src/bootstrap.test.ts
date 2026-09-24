import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBuffer, type BufferedEvent } from "./eventBuffer";
import { spawnSync } from "node:child_process";
import {
  bindIosSimulatorReleaseOnChatEnd,
  createAdeRuntime,
  createHeadlessAdeCliAgentEnv,
  emitRuntimePrCardsForChanges,
  inferAgentSkillsRootForCliEntry,
} from "./bootstrap";
import { adeCliShimDirName } from "./services/runtime/adeCliShim";
import { createPrEventFanout } from "./prEventFanout";
import { isSourceCheckoutRuntimeModule } from "./runtimePackaging";
import type { PrCardChange } from "../../desktop/src/main/services/prs/prChatCards";
import {
  ADE_AGENT_SKILLS_DIRS_ENV,
  ADE_BUNDLED_AGENT_SKILLS_DIR_ENV,
  splitAdeAgentSkillRoots,
} from "../../desktop/src/shared/agentSkillRoots";
import { createTestDirectoryLink, removeTestTree } from "./test/filesystem";

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-bootstrap-skills-"));
  tempRoots.push(root);
  return root;
}

function writeFile(filePath: string, contents = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function writeSkillsManifest(skillsRoot: string): void {
  writeFile(
    path.join(skillsRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "ade", skills: "./" }),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    await removeTestTree(root);
  }
});

describe("createAdeRuntime dispose", () => {
  /** Live resources (timers, sockets, pipes, child processes, watchers), by kind. */
  function liveResources(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const kind of process.getActiveResourcesInfo()) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    return counts;
  }

  /** Kinds with more live resources now than in `baseline`. */
  function leakedSince(baseline: Map<string, number>): string[] {
    return [...liveResources()]
      .filter(([kind, count]) => count > (baseline.get(kind) ?? 0))
      .map(([kind, count]) => `${kind} x${count - (baseline.get(kind) ?? 0)}`);
  }

  async function buildRuntime(runtimeProfile: "embedded" | "chat" | "full") {
    const projectRoot = makeTempRoot();
    return await createAdeRuntime({
      projectRoot,
      workspaceRoot: projectRoot,
      runtimeProfile,
      chatRuntime: "headless-stub",
    });
  }

  // A runtime that outlives its dispose keeps the database handle and every
  // started service alive; the sync-host retry loop builds one per attempt.
  it.each(["embedded", "chat", "full"] as const)(
    "releases the database and everything a %s runtime started",
    async (runtimeProfile) => {
      vi.stubEnv("ADE_HOME", makeTempRoot());
      // The first runtime in a process also creates process-wide state (module
      // caches and their timers) that later runtimes share, so measure the second.
      (await buildRuntime(runtimeProfile)).dispose();
      const before = liveResources();

      const runtime = await buildRuntime(runtimeProfile);
      expect(leakedSince(before)).not.toEqual([]);
      runtime.dispose();

      expect(() => runtime.db.getJson("probe")).toThrow(/not open/);
      await vi.waitFor(() => expect(leakedSince(before)).toEqual([]), { timeout: 10_000 });
    },
    30_000,
  );
});

describe("bindIosSimulatorReleaseOnChatEnd", () => {
  it("does not register a chat-end simulator release on the headless chat stub", () => {
    const releaseIfOwnedBy = vi.fn().mockResolvedValue(undefined);

    expect(bindIosSimulatorReleaseOnChatEnd({
      agentChatService: {},
      iosSimulatorService: { releaseIfOwnedBy },
      logger: { debug: vi.fn() },
    })).toBe(false);
    expect(releaseIfOwnedBy).not.toHaveBeenCalled();
  });

  it("registers a release listener when the agent chat service supports it", async () => {
    const listeners: Array<(sessionId: string) => void> = [];
    const releaseIfOwnedBy = vi.fn().mockResolvedValue(undefined);
    const agentChatService = {
      registerChatSessionEndedListener(listener: (sessionId: string) => void) {
        listeners.push(listener);
      },
    };

    expect(bindIosSimulatorReleaseOnChatEnd({
      agentChatService,
      iosSimulatorService: { releaseIfOwnedBy },
      logger: { debug: vi.fn() },
    })).toBe(true);
    expect(listeners).toHaveLength(1);
    listeners[0]!("chat-1");
    await Promise.resolve();
    expect(releaseIfOwnedBy).toHaveBeenCalledWith("chat-1");
  });
});

describe("headless ADE CLI agent skill roots", () => {
  it("keeps a cwd-discovered catalog root untrusted and clears an inherited bundle marker", () => {
    const root = makeTempRoot();
    const repositorySkills = path.join(root, "apps", "desktop", "resources", "agent-skills");
    writeSkillsManifest(repositorySkills);

    const inferred = inferAgentSkillsRootForCliEntry(null, {
      cwd: root,
      resourcesPath: null,
    });
    const env = createHeadlessAdeCliAgentEnv({
      ADE_BUNDLED_AGENT_SKILLS_DIR: repositorySkills,
    }, {
      cliEntry: null,
      cwd: root,
      resourcesPath: null,
    });

    expect(inferred).toEqual({
      catalogRoot: repositorySkills,
      bundledRoot: null,
    });
    expect(splitAdeAgentSkillRoots(env[ADE_AGENT_SKILLS_DIRS_ENV])).toContain(repositorySkills);
    expect(env[ADE_BUNDLED_AGENT_SKILLS_DIR_ENV]).toBeUndefined();
  });

  it("trusts canonical source-checkout and CLI-adjacent bundles", () => {
    const sourceRoot = makeTempRoot();
    const sourceCli = path.join(sourceRoot, "apps", "ade-cli", "src", "cli.ts");
    const sourceSkills = path.join(sourceRoot, "apps", "desktop", "resources", "agent-skills");
    writeFile(sourceCli, "export {};\n");
    writeSkillsManifest(sourceSkills);

    const packagedRoot = makeTempRoot();
    const packagedCli = path.join(packagedRoot, "Resources", "ade-cli", "cli.cjs");
    const packagedSkills = path.join(packagedRoot, "Resources", "agent-skills");
    writeFile(packagedCli, "module.exports = {};\n");
    writeSkillsManifest(packagedSkills);

    expect(inferAgentSkillsRootForCliEntry(sourceCli, {
      cwd: path.join(sourceRoot, "elsewhere"),
      resourcesPath: null,
    })).toEqual({
      catalogRoot: fs.realpathSync(sourceSkills),
      bundledRoot: fs.realpathSync(sourceSkills),
    });
    expect(inferAgentSkillsRootForCliEntry(packagedCli, {
      cwd: path.join(packagedRoot, "elsewhere"),
      resourcesPath: null,
    })).toEqual({
      catalogRoot: fs.realpathSync(packagedSkills),
      bundledRoot: fs.realpathSync(packagedSkills),
    });
    expect(createHeadlessAdeCliAgentEnv({
      ADE_BUNDLED_AGENT_SKILLS_DIR: "/inherited/untrusted-skills",
    }, {
      cliEntry: null,
      cwd: path.join(packagedRoot, "elsewhere"),
      resourcesPath: path.join(packagedRoot, "Resources"),
    })[ADE_BUNDLED_AGENT_SKILLS_DIR_ENV]).toBe(fs.realpathSync(packagedSkills));
  });

  it("rejects package-resource and source bundle symlinks that escape their boundaries", () => {
    const packagedRoot = makeTempRoot();
    const resourcesPath = path.join(packagedRoot, "Resources");
    const externalSkills = path.join(packagedRoot, "external-skills");
    fs.mkdirSync(resourcesPath, { recursive: true });
    writeSkillsManifest(externalSkills);
    createTestDirectoryLink(externalSkills, path.join(resourcesPath, "agent-skills"));

    const sourceRoot = makeTempRoot();
    const sourceExternalRoot = makeTempRoot();
    const sourceCli = path.join(sourceRoot, "apps", "ade-cli", "dist", "cli.cjs");
    const sourceSkills = path.join(sourceRoot, "apps", "desktop", "resources", "agent-skills");
    const sourceExternalSkills = path.join(sourceExternalRoot, "external-skills");
    writeFile(sourceCli, "module.exports = {};\n");
    writeSkillsManifest(sourceExternalSkills);
    fs.mkdirSync(path.dirname(sourceSkills), { recursive: true });
    createTestDirectoryLink(sourceExternalSkills, sourceSkills);

    expect(inferAgentSkillsRootForCliEntry(null, {
      cwd: path.join(packagedRoot, "elsewhere"),
      resourcesPath,
    }).bundledRoot).toBeNull();
    expect(inferAgentSkillsRootForCliEntry(sourceCli, {
      cwd: path.join(sourceRoot, "elsewhere"),
      resourcesPath: null,
    }).bundledRoot).toBeNull();
  });
});

describe("ade CLI shim names the brain that wrote it", () => {
  it.skipIf(process.platform === "win32")("reaches the brain's socket from a stripped env, and yields to a caller's", () => {
    const root = makeTempRoot();
    const fakeCli = path.join(root, "fake cli");
    writeFile(fakeCli, '#!/bin/sh\nprintf "%s|%s|%s" "${ADE_HOME:-}" "${ADE_RUNTIME_SOCKET_PATH:-}" "$*"\n');
    fs.chmodSync(fakeCli, 0o755);
    const brain = { socketPath: path.join(root, "brain dir", "ade.sock"), adeHome: path.join(root, ".ade-alpha") };
    const env = createHeadlessAdeCliAgentEnv({ PATH: "/usr/bin:/bin" }, { cliEntry: fakeCli, cwd: root, resourcesPath: null, brain });
    const shim = env.ADE_CLI_PATH!;
    try {
      expect(path.basename(path.dirname(shim))).toBe(adeCliShimDirName(fakeCli, process.execPath, brain));
      const run = (callerEnv: NodeJS.ProcessEnv) =>
        spawnSync(shim, ["apple", "status"], { env: { PATH: "/usr/bin:/bin", ...callerEnv }, encoding: "utf8" }).stdout;
      expect(run({})).toBe(`${brain.adeHome}|${brain.socketPath}|apple status`);
      expect(run({ ADE_RUNTIME_SOCKET_PATH: "/tmp/mine.sock" })).toBe("|/tmp/mine.sock|apple status");
      expect(run({ ADE_HOME: "/Users/a/.ade" })).toBe("/Users/a/.ade||apple status");
    } finally {
      fs.rmSync(path.dirname(shim), { recursive: true, force: true });
    }
  });
});

describe("emitRuntimePrCardsForChanges", () => {
  it("emits PR cards through the daemon-owned chat service", async () => {
    const change = {
      pr: {
        id: "pr-1",
        laneId: "lane-1",
        githubPrNumber: 42,
        repoOwner: "acme",
        repoName: "ade",
        baseBranch: "main",
        headSha: "abc123",
        state: "open",
        checksStatus: "passing",
        reviewStatus: "none",
        mergeConflicts: false,
        behindBaseBy: 0,
      },
      previousState: "open",
      previousChecksStatus: "pending",
      previousReviewStatus: "none",
      previousMergeConflicts: false,
      previousBehindBaseBy: 0,
    } as PrCardChange;
    const emitAdeCard = vi.fn().mockResolvedValue(undefined);

    await emitRuntimePrCardsForChanges({
      changes: [change],
      dataSource: {
        getActionRuns: vi.fn().mockResolvedValue([]),
        getChecks: vi.fn().mockResolvedValue([]),
        getReviews: vi.fn().mockResolvedValue([]),
        getReviewThreads: vi.fn().mockResolvedValue([]),
      },
      chat: {
        listSessions: vi.fn().mockResolvedValue([{
          sessionId: "chat-1",
          laneId: "lane-1",
          surface: "work",
          archivedAt: null,
          lastActivityAt: "2026-07-27T18:00:00.000Z",
        }]),
        emitAdeCard,
      },
      logger: { warn: vi.fn() },
    });

    expect(emitAdeCard).toHaveBeenCalledTimes(1);
    expect(emitAdeCard).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "chat-1",
      card: expect.objectContaining({
        variant: "pr_ci",
        state: "terminal",
        navTarget: expect.objectContaining({ kind: "pr", detailTab: "checks" }),
      }),
    }));
  });
});

describe("isSourceCheckoutRuntimeModule", () => {
  it.each([
    "/Users/developer/ADE/apps/ade-cli/src/bootstrap.ts",
    "/Users/developer/ADE/apps/ade-cli/dist/cli.cjs",
    "/Users/developer/ADE/apps/ade-cli/dist/bootstrap.cjs",
    "/Users/developer/ADE/apps/desktop/dist/main/main.cjs",
  ])("classifies a source-checkout module as development: %s", (modulePath) => {
    expect(isSourceCheckoutRuntimeModule(modulePath)).toBe(true);
  });

  it.each([
    "/Applications/ADE.app/Contents/Resources/app.asar/dist/main/main.cjs",
    "/Applications/ADE.app/Contents/Resources/ade-cli/cli.cjs",
  ])("classifies a packaged module as packaged: %s", (modulePath) => {
    expect(isSourceCheckoutRuntimeModule(modulePath)).toBe(false);
  });
});

describe("createPrEventFanout", () => {
  const event = {
    type: "prs-updated" as const,
    polledAt: "2026-07-16T00:00:00.000Z",
    prs: [],
  };

  it.each([0, 1])("isolates a failure in sink %i while still calling both sinks", (failingSink) => {
    const calls: string[] = [];
    const runtimeSink = vi.fn(() => {
      calls.push("runtime");
      if (failingSink === 0) throw new Error("runtime failed");
    });
    const searchSink = vi.fn(() => {
      calls.push("search");
      if (failingSink === 1) throw new Error("search failed");
    });
    const emit = createPrEventFanout(runtimeSink, searchSink);

    expect(() => emit(event)).not.toThrow();
    expect(runtimeSink).toHaveBeenCalledWith(event);
    expect(searchSink).toHaveBeenCalledWith(event);
    expect(calls).toEqual(["runtime", "search"]);
  });
});

describe("createEventBuffer", () => {
  it("pushes events and assigns monotonically increasing IDs", () => {
    const buffer = createEventBuffer();

    buffer.push({ timestamp: "2026-03-01T00:00:00Z", category: "orchestrator", payload: { a: 1 } });
    buffer.push({ timestamp: "2026-03-01T00:01:00Z", category: "runtime", payload: { b: 2 } });

    expect(buffer.size()).toBe(2);

    const result = buffer.drain(0);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.id).toBe(1);
    expect(result.events[1]!.id).toBe(2);
    expect(result.events[0]!.category).toBe("orchestrator");
    expect(result.events[1]!.category).toBe("runtime");
    expect(result.nextCursor).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.eventEpoch).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("evicts oldest events when capacity is exceeded", () => {
    const buffer = createEventBuffer(3);

    for (let i = 0; i < 5; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "orchestrator", payload: { i } });
    }

    expect(buffer.size()).toBe(3);

    const result = buffer.drain(0);
    // Should have IDs 3, 4, 5 (the oldest 1, 2 were evicted)
    expect(result.events.map((e) => e.id)).toEqual([3, 4, 5]);
    expect(result.gap).toBe(true);
    expect(result.oldestCursor).toBe(3);
    expect(result.events[0]!.payload).toEqual({ i: 2 });
  });

  it("reports no gap when the next retained event is contiguous with the cursor", () => {
    const buffer = createEventBuffer(3);

    for (let i = 0; i < 5; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "runtime", payload: { i } });
    }

    const result = buffer.drain(2);
    expect(result.events.map((event) => event.id)).toEqual([3, 4, 5]);
    expect(result.gap).toBe(false);
    expect(result.oldestCursor).toBe(3);
  });

  it("evicts by retained byte budget and reports the replay gap", () => {
    const buffer = createEventBuffer(10, { maxBytes: 260, maxEventBytes: 260 });

    for (let i = 0; i < 4; i++) {
      buffer.push({
        timestamp: `2026-03-01T00:0${i}:00Z`,
        category: "pty",
        payload: { data: "x".repeat(90), i },
      });
    }

    const result = buffer.drain(0);
    expect(result.events.length).toBeLessThan(4);
    expect(result.events.at(-1)?.id).toBe(4);
    expect(result.gap).toBe(true);
    expect(result.oldestCursor).toBeGreaterThan(1);
  });

  it("does not retain events larger than the per-event cap but still notifies live subscribers", () => {
    const buffer = createEventBuffer(10, { maxBytes: 1024, maxEventBytes: 64 });
    const seen: BufferedEvent[] = [];
    buffer.subscribe((event) => seen.push(event));

    buffer.push({
      timestamp: "2026-03-01T00:00:00Z",
      category: "pty",
      payload: { data: "x".repeat(200) },
    });

    expect(seen).toHaveLength(1);
    const result = buffer.drain(0);
    expect(result.events).toEqual([]);
    expect(result.gap).toBe(true);
    expect(result.nextCursor).toBe(1);
  });

  it("reports a replay gap when an oversized event is skipped between retained events", () => {
    const buffer = createEventBuffer(10, { maxBytes: 4096, maxEventBytes: 180 });

    buffer.push({ timestamp: "2026-03-01T00:00:00Z", category: "runtime", payload: { data: "small-1" } });
    buffer.push({ timestamp: "2026-03-01T00:00:01Z", category: "runtime", payload: { data: "x".repeat(500) } });
    buffer.push({ timestamp: "2026-03-01T00:00:02Z", category: "runtime", payload: { data: "small-2" } });

    const result = buffer.drain(1);
    expect(result.events.map((event) => event.id)).toEqual([3]);
    expect(result.gap).toBe(true);
    expect(result.oldestCursor).toBe(3);
  });

  it("drains events after cursor", () => {
    const buffer = createEventBuffer();

    for (let i = 0; i < 5; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "dag_mutation", payload: { i } });
    }

    const result = buffer.drain(3);
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.id).toBe(4);
    expect(result.events[1]!.id).toBe(5);
    expect(result.nextCursor).toBe(5);
    expect(result.hasMore).toBe(false);
  });

  it("returns empty result when cursor is at the end", () => {
    const buffer = createEventBuffer();

    buffer.push({ timestamp: "2026-03-01T00:00:00Z", category: "runtime", payload: {} });

    const result = buffer.drain(1);
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe(1);
    expect(result.hasMore).toBe(false);
  });

  it("respects the limit parameter for draining", () => {
    const buffer = createEventBuffer();

    for (let i = 0; i < 10; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "orchestrator", payload: { i } });
    }

    const result = buffer.drain(0, 3);
    expect(result.events).toHaveLength(3);
    expect(result.events[0]!.id).toBe(1);
    expect(result.events[2]!.id).toBe(3);
    expect(result.nextCursor).toBe(3);
    expect(result.hasMore).toBe(true);
  });

  it("clamps limit to range [1, 1000]", () => {
    const buffer = createEventBuffer();

    for (let i = 0; i < 5; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "orchestrator", payload: { i } });
    }

    // Limit of 0 should be clamped to 1
    const resultMin = buffer.drain(0, 0);
    expect(resultMin.events).toHaveLength(1);

    // Limit beyond 1000 should be clamped to 1000
    const resultMax = buffer.drain(0, 9999);
    expect(resultMax.events).toHaveLength(5);
  });

  it("returns correct hasMore when more events exist past the limit", () => {
    const buffer = createEventBuffer();

    for (let i = 0; i < 5; i++) {
      buffer.push({ timestamp: `2026-03-01T00:0${i}:00Z`, category: "runtime", payload: { i } });
    }

    const result1 = buffer.drain(0, 2);
    expect(result1.hasMore).toBe(true);
    expect(result1.nextCursor).toBe(2);

    const result2 = buffer.drain(result1.nextCursor, 10);
    expect(result2.hasMore).toBe(false);
    expect(result2.events).toHaveLength(3);
  });

  it("handles drain on empty buffer", () => {
    const buffer = createEventBuffer();

    const result = buffer.drain(0);
    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("size returns correct count after pushes and evictions", () => {
    const buffer = createEventBuffer(2);

    expect(buffer.size()).toBe(0);
    buffer.push({ timestamp: "t1", category: "orchestrator", payload: {} });
    expect(buffer.size()).toBe(1);
    buffer.push({ timestamp: "t2", category: "orchestrator", payload: {} });
    expect(buffer.size()).toBe(2);
    buffer.push({ timestamp: "t3", category: "orchestrator", payload: {} });
    expect(buffer.size()).toBe(2);
  });

  it("preserves event category and payload through push and drain", () => {
    const buffer = createEventBuffer();
    const categories: BufferedEvent["category"][] = ["orchestrator", "dag_mutation", "runtime", "pty", "cto_voice"];

    for (const category of categories) {
      buffer.push({ timestamp: "t", category, payload: { kind: category } });
    }

    const result = buffer.drain(0);
    expect(result.events).toHaveLength(categories.length);
    for (let i = 0; i < categories.length; i++) {
      expect(result.events[i]!.category).toBe(categories[i]);
      expect(result.events[i]!.payload).toEqual({ kind: categories[i] });
    }
  });

  it("notifies subscribers for newly pushed events until unsubscribed", () => {
    const buffer = createEventBuffer();
    const seen: BufferedEvent[] = [];

    const unsubscribe = buffer.subscribe((event) => seen.push(event));
    buffer.push({ timestamp: "t1", category: "runtime", payload: { n: 1 } });
    unsubscribe();
    buffer.push({ timestamp: "t2", category: "runtime", payload: { n: 2 } });

    expect(seen).toEqual([
      expect.objectContaining({
        id: 1,
        category: "runtime",
        payload: { n: 1 },
      }),
    ]);
  });

  it("keeps notifying subscribers when one listener throws", () => {
    const buffer = createEventBuffer();
    const seen: BufferedEvent[] = [];

    buffer.subscribe(() => {
      throw new Error("listener failed");
    });
    buffer.subscribe((event) => seen.push(event));

    expect(() => {
      buffer.push({ timestamp: "t1", category: "runtime", payload: { n: 1 } });
    }).not.toThrow();
    expect(seen).toEqual([
      expect.objectContaining({
        id: 1,
        category: "runtime",
        payload: { n: 1 },
      }),
    ]);
  });

  /**
   * The drain is one RPC reply. With only a count cap, 200 full-list PR events
   * made an 11.5 MB reply, and a remote desktop's RPC channel closed on every
   * poll.
   */
  it("stops a drain at its byte budget and always returns at least one event", () => {
    const buffer = createEventBuffer(100, { maxBytes: 1024 * 1024, maxEventBytes: 64 * 1024, drainMaxBytes: 25_000 });
    const tiny = createEventBuffer(100, { maxBytes: 1024 * 1024, maxEventBytes: 64 * 1024, drainMaxBytes: 100 });
    for (let i = 0; i < 10; i++) {
      const event = { timestamp: "2026-09-22T18:53:02Z", category: "runtime" as const, payload: { data: "x".repeat(10_000), i } };
      buffer.push(event);
      tiny.push(event);
    }

    const first = buffer.drain(0, 200);
    expect(first.events.map((event) => event.id)).toEqual([1, 2]);
    expect(first.nextCursor).toBe(2);
    expect(first.hasMore).toBe(true);

    const oneOversized = tiny.drain(first.nextCursor, 200);
    expect(oneOversized.events.map((event) => event.id)).toEqual([3]);
    expect(oneOversized.hasMore).toBe(true);

    let cursor = oneOversized.nextCursor;
    const seen = [3];
    for (let guard = 0; guard < 10; guard++) {
      const batch = buffer.drain(cursor, 200);
      seen.push(...batch.events.map((event) => event.id));
      cursor = batch.nextCursor;
      if (!batch.hasMore) break;
    }
    expect(seen).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("caps a default drain at one mebibyte", () => {
    const buffer = createEventBuffer(1000, { maxBytes: 64 * 1024 * 1024 });
    for (let i = 0; i < 60; i++) {
      buffer.push({ timestamp: "2026-09-22T18:53:02Z", category: "runtime", payload: { data: "x".repeat(225_000), i } });
    }

    const result = buffer.drain(0, 200);
    const bytes = Buffer.byteLength(JSON.stringify(result.events), "utf8");
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.hasMore).toBe(true);
  });

  it("filters a drain, moves the cursor past skipped events, and never skips a match past the limit", () => {
    const buffer = createEventBuffer();
    for (let i = 1; i <= 6; i++) {
      buffer.push({ timestamp: "2026-03-01T00:00:00Z", category: i % 2 === 0 ? "pty" : "runtime", payload: { i } });
    }
    const filter = (event: BufferedEvent) => event.category === "pty";

    const first = buffer.drain(0, 2, { filter, maxScan: 20 });
    expect(first.events.map((event) => event.id)).toEqual([2, 4]);
    expect(first.nextCursor).toBe(4);
    expect(first.hasMore).toBe(true);

    const second = buffer.drain(first.nextCursor, 2, { filter, maxScan: 20 });
    expect(second.events.map((event) => event.id)).toEqual([6]);
    expect(second.nextCursor).toBe(6);
    expect(second.hasMore).toBe(false);

    const scanCapped = buffer.drain(0, 1, { filter: (event) => event.category === "orchestrator", maxScan: 3 });
    expect(scanCapped.events).toEqual([]);
    expect(scanCapped.nextCursor).toBe(3);
    expect(scanCapped.hasMore).toBe(true);
  });
});
