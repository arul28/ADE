import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBuffer, type BufferedEvent } from "./eventBuffer";
import {
  bindIosSimulatorReleaseOnChatEnd,
  createHeadlessAdeCliAgentEnv,
  emitRuntimePrCardsForChanges,
  inferAgentSkillsRootForCliEntry,
  pluginActionRefusalMessage,
  pluginProjectSecretRefusal,
  withoutPluginAuthoredProvenance,
  withPluginCallerProvenance,
} from "./bootstrap";
import { readTrustedAdeCardAuthor } from "../../desktop/src/main/services/chat/adeCardProvenance";
import { readTrustedPluginSessionOwner } from "../../desktop/src/main/services/chat/pluginSessionSetupProvenance";
import { IPC } from "../../desktop/src/shared/ipc";
import {
  ADE_ACTION_ALLOWLIST,
  isAutomationAllowedAdeAction,
} from "../../desktop/src/main/services/adeActions/registry";
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
  for (const root of tempRoots.splice(0)) {
    await removeTestTree(root);
  }
});

describe("createAdeRuntime startup teardown", () => {
  // `createAdeRuntime` builds ~25 services around a native SQLite handle and has
  // no injection seam, so these assertions read the source. They exist because a
  // throw after the database open used to leak the handle and every started
  // service, once per sync-host retry.
  // Line endings are normalized because a Windows checkout writes CRLF, and
  // every anchor below is written against "\n".
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "bootstrap.ts"),
    "utf8",
  ).replace(/\r\n/g, "\n");
  const runtimeFn = source.slice(source.indexOf("export async function createAdeRuntime"));

  /** Index of the first match of `pattern` at or after `from`, or -1. */
  function indexOfPattern(pattern: RegExp, from = 0): number {
    const search = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    search.lastIndex = from;
    const match = search.exec(runtimeFn);
    return match ? match.index : -1;
  }

  // Every anchor below is indentation-insensitive on purpose: the guarded body
  // is reindented whenever the guard moves, and a test that breaks on that is a
  // test about layout, not about the leak.
  const openIndex = runtimeFn.indexOf("clearLastFailure({ kind: \"project\", projectRoot });");
  const tryIndex = indexOfPattern(/\n[ \t]*try \{\n/, openIndex);
  const finallyIndex = indexOfPattern(/\n[ \t]*\} finally \{\n/, tryIndex);
  const guardedBody = runtimeFn.slice(tryIndex, finallyIndex);

  it("guards everything after the database open", () => {
    const firstServiceStart = runtimeFn.indexOf("usageProductAnalyticsExporter.start();");

    expect(openIndex).toBeGreaterThan(-1);
    expect(tryIndex).toBeGreaterThan(openIndex);
    expect(finallyIndex).toBeGreaterThan(tryIndex);
    expect(tryIndex).toBeLessThan(firstServiceStart);
    expect(firstServiceStart).toBeLessThan(finallyIndex);
  });

  it("registers the database close first, so it releases last", () => {
    const firstPush = runtimeFn.indexOf("teardown.push(");
    const dbClose = runtimeFn.indexOf("db.close();");
    const secondPush = runtimeFn.indexOf("teardown.push(", firstPush + 1);

    expect(firstPush).toBeGreaterThan(-1);
    expect(dbClose).toBeGreaterThan(firstPush);
    expect(dbClose).toBeLessThan(secondPush);
  });

  it("drains the stack when construction fails and when the runtime is disposed", () => {
    const failurePath = runtimeFn.slice(finallyIndex);
    expect(failurePath).toContain("if (!runtimeCreated) {");
    expect(failurePath).toContain("teardown.drain();");

    const disposeIndex = runtimeFn.indexOf("dispose: () => {");
    expect(disposeIndex).toBeGreaterThan(-1);
    expect(runtimeFn.slice(disposeIndex, disposeIndex + 400)).toContain("teardown.drain();");
  });

  /**
   * Services that are started here on purpose without a release on this stack.
   *
   * The list is exceptions, not coverage: a service added tomorrow is NOT on it,
   * so it has to register a release or fail the test below. Each entry needs a
   * reason that survives review.
   */
  const startedWithoutRelease = new Map<string, string>([
    // Shared across every project scope in this process, so it outlives the one
    // being built. Only this scope's signal wiring is detached, by
    // `detachPushSources`.
    ["pushPublisherService", "shared publisher; outlives this runtime scope"],
  ]);

  /**
   * The body of every `teardown.push(...)` call in `code`.
   *
   * Scanning to the matching close paren, rather than to the next semicolon,
   * is what makes a release count: a release that spans statements -- a `try`
   * around a `stop()`, an `if` guard -- ends at a semicolon inside its own
   * body, so a semicolon-bounded match reads only the first line of it and
   * reports a released service as leaked.
   */
  function teardownPushSlices(code: string): string[] {
    const slices: string[] = [];
    const marker = "teardown.push(";
    for (let at = code.indexOf(marker); at !== -1; at = code.indexOf(marker, at + 1)) {
      let depth = 0;
      let end = -1;
      for (let i = at + marker.length - 1; i < code.length; i++) {
        if (code[i] === "(") depth += 1;
        else if (code[i] === ")") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      // An unbalanced tail means the slice would be a guess, so drop it rather
      // than assert against half a call.
      if (end !== -1) slices.push(code.slice(at, end + 1));
    }
    return slices;
  }

  it("registers a release for every service the runtime starts", () => {
    // A start without a matching release is the leak this stack removes. The
    // started set is read out of the source rather than hand-listed: a
    // hand-list passes for exactly the service nobody remembered to add to it.
    const code = guardedBody
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const started = new Set<string>();
    for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\.start\(/g)) {
      started.add(match[1]);
    }
    // Guards the extraction itself: a regex that silently matched nothing would
    // make every assertion below vacuous.
    expect(started.size).toBeGreaterThan(5);
    expect([...started]).toContain("usageProductAnalyticsExporter");

    const releases = teardownPushSlices(guardedBody);
    // Guards the extraction the same way `started.size` above does.
    expect(releases.length).toBeGreaterThan(5);

    const unreleased = [...started].filter(
      (service) =>
        !startedWithoutRelease.has(service)
        && !releases.some((release) => new RegExp(`\\b${service}\\b`).test(release)),
    );
    expect(unreleased).toEqual([]);

    // And the exception list may not outlive its reason: an entry for a service
    // nobody starts any more is stale documentation.
    expect([...startedWithoutRelease.keys()].filter((service) => !started.has(service))).toEqual([]);
  });

  it("wires the chat-end simulator release through bindIosSimulatorReleaseOnChatEnd", () => {
    expect(runtimeFn).toContain("bindIosSimulatorReleaseOnChatEnd({");
  });
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
    const categories: BufferedEvent["category"][] = ["orchestrator", "dag_mutation", "runtime", "pty"];

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
});

/**
 * The plugin action bridge calls ADE services directly, so none of the RPC
 * edge's scoping runs on it. This is the piece of that scoping the bridge has
 * to reproduce: a plugin cannot author the provenance that decides whether an
 * agent completion wakes another agent.
 */
describe("plugin action bridge provenance", () => {
  it("drops host-authored provenance a plugin supplied, and leaves its own metadata", () => {
    const args = {
      sessionId: "session-1",
      text: "run the tests",
      metadata: {
        spawnDispatch: { parentSessionId: "session-victim" },
        agentRelay: { fromSessionId: "session-victim" },
        scheduledWake: { at: "2026-08-11T00:00:00.000Z" },
        pluginNote: "kept",
      },
    };

    const scoped = withoutPluginAuthoredProvenance("chat", args);

    expect(scoped.metadata).toEqual({ pluginNote: "kept" });
    // The caller's object is never mutated: the same args reach the allowlist
    // check and the log line before this runs.
    expect(Object.keys(args.metadata)).toHaveLength(4);
  });

  it("passes other domains through untouched", () => {
    const args = { metadata: { spawnDispatch: { parentSessionId: "session-1" } } };
    expect(withoutPluginAuthoredProvenance("lane", args)).toBe(args);
    expect(withoutPluginAuthoredProvenance("chat", { text: "hi" })).toEqual({ text: "hi" });
  });

  it("stamps a card's author from the CALLER, not from the call", () => {
    const stamped = withPluginCallerProvenance(
      "chat",
      "emitAdeCard",
      { sessionId: "chat-1", card: { cardId: "c1", authoredBy: { pluginId: "ade-linear" } } },
      { pluginId: "ade-lint", displayName: "Lint" },
    );

    expect(readTrustedAdeCardAuthor(stamped)).toEqual({ pluginId: "ade-lint", displayName: "Lint" });
  });

  it("stamps nothing on any other action", () => {
    const args = { sessionId: "chat-1", text: "hi" };
    expect(withPluginCallerProvenance("chat", "sendMessage", args, { pluginId: "ade-lint" })).toBe(args);
    expect(withPluginCallerProvenance("lane", "emitAdeCard", args, { pluginId: "ade-lint" })).toBe(args);
    expect(readTrustedAdeCardAuthor(args)).toBeNull();
  });

  it.each(["createSession", "launchCli"])(
    "names the session-setup owner from the CALLER on chat.%s",
    (action) => {
      const stamped = withPluginCallerProvenance(
        "chat",
        action,
        { laneId: "lane-1", sessionSetup: { env: { ADE_PLUGIN_X: "1" }, pluginId: "ade-linear" } },
        { pluginId: "ade-lint" },
      );

      expect(readTrustedPluginSessionOwner(stamped)).toBe("ade-lint");
    },
  );

  it("names no session-setup owner when the launch injects nothing", () => {
    const args = { laneId: "lane-1", provider: "codex" };
    expect(withPluginCallerProvenance("chat", "createSession", args, { pluginId: "ade-lint" })).toBe(args);
    expect(readTrustedPluginSessionOwner(args)).toBeNull();
  });

  it("cannot have the session-setup owner forged through the arguments", () => {
    // The owner is a symbol a JSON payload cannot carry, which is the whole
    // point: an agent calling the same action gets no owner at all.
    expect(readTrustedPluginSessionOwner(
      JSON.parse(JSON.stringify({ sessionSetup: { env: {} }, pluginId: "ade-linear" })),
    )).toBeNull();
  });
});

/**
 * The per-verb half of the plugin action gate. Each of these refusals closes a
 * path by which a plugin could act as the user rather than as itself; the
 * automations ones close the widest, because a rule's steps run with the user's
 * authority and can call the verbs refused above.
 */
describe("plugin action bridge refusals", () => {
  it("refuses the whole account domain, which the bridge cannot redact", () => {
    expect(pluginActionRefusalMessage("account", "status")).toMatch(/not available to plugins/);
    expect(pluginActionRefusalMessage("account", "signOut")).toMatch(/not available to plugins/);
  });

  it("refuses session.requestSessionAttention in favour of the attributed verb", () => {
    expect(pluginActionRefusalMessage("session", "requestSessionAttention")).toMatch(
      /ade\.notifications\.post/,
    );
  });

  it("refuses every chat scheduler verb, reads included", () => {
    for (const action of [
      "createScheduledWork",
      "cancelScheduledWork",
      "listScheduledWork",
      "getScheduledWorkState",
      "setScheduledWorkPaused",
    ]) {
      expect(pluginActionRefusalMessage("chat", action), action).toMatch(/ade\.schedules\.\*/);
    }
  });

  it("refuses automations.saveRule so a plugin cannot author or overwrite a rule", () => {
    expect(pluginActionRefusalMessage("automations", "saveRule")).toMatch(
      /only the user can create, change, or run a rule/,
    );
  });

  it("refuses automations.triggerManually so a plugin cannot RUN a rule's steps as the user", () => {
    expect(pluginActionRefusalMessage("automations", "triggerManually")).toMatch(
      /contributes\.automationTriggers/,
    );
  });

  it("refuses automations.deleteRule and toggleRule, the other rule mutators", () => {
    expect(pluginActionRefusalMessage("automations", "deleteRule")).not.toBeNull();
    expect(pluginActionRefusalMessage("automations", "toggleRule")).not.toBeNull();
  });

  it("still allows the automations read verbs a plugin needs to inspect its own contributions", () => {
    for (const action of ["list", "get", "getHistory", "listRuns", "getRunDetail"]) {
      expect(pluginActionRefusalMessage("automations", action), action).toBeNull();
    }
  });

  it("leaves ordinary domains alone", () => {
    expect(pluginActionRefusalMessage("chat", "sendMessage")).toBeNull();
    expect(pluginActionRefusalMessage("lane", "list")).toBeNull();
    expect(pluginActionRefusalMessage("session", "list")).toBeNull();
  });

  it("refuses the raw lane issue-link verbs in favour of the attributed SDK verbs", () => {
    expect(pluginActionRefusalMessage("lane", "linkLinearIssues")).toMatch(
      /ade\.lanes\.linkIssue/,
    );
    expect(pluginActionRefusalMessage("lane", "unlinkLinearIssues")).toMatch(
      /ade\.lanes\.unlinkIssue/,
    );
  });

  it("refuses only the two issue-link verbs, not the rest of the lane domain", () => {
    // A blanket refusal on `lane` would take the plugin's read of its own
    // lanes with it, which is the reach `ade.lanes.list` depends on.
    for (const action of ["list", "getSummary", "create", "archive", "rename"]) {
      expect(pluginActionRefusalMessage("lane", action), action).toBeNull();
    }
  });

  /**
   * The refusal must key on PLUGIN ORIGIN, not on the verb being unavailable.
   *
   * `pluginActionRefusalMessage` is consulted in exactly one place —
   * `PluginProjectBinding.invokeAdeAction` in `bootstrap.ts` — which is the door
   * a plugin child's `ade.actions.invoke` comes through and nothing else does.
   * Every other caller class reaches the same verbs by a path that never asks
   * this function, so these tests pin the paths rather than the message.
   */
  describe("the raw lane verbs stay open to every non-plugin caller", () => {
    it("keeps them on the ade action allowlist, which the agent chat and automations layers key on", () => {
      // Those layers gate on `isAutomationAllowedAdeAction`, never on
      // `pluginActionRefusalMessage`. Dropping the verbs from the allowlist
      // would have taken the agent and the user's automations down with the
      // plugins, so the allowlist is the thing worth asserting.
      expect(isAutomationAllowedAdeAction("lane", "linkLinearIssues")).toBe(true);
      expect(isAutomationAllowedAdeAction("lane", "unlinkLinearIssues")).toBe(true);
    });

    it("keeps them in the lane domain's allowlist, which the built-in Linear pane and the CTO reach", () => {
      const laneVerbs = ADE_ACTION_ALLOWLIST.lane ?? [];
      expect(laneVerbs).toContain("linkLinearIssues");
      expect(laneVerbs).toContain("unlinkLinearIssues");
    });

    it("keeps the IPC channel the desktop UI unlinks through", () => {
      // The user's own unlink, from the lane UI, goes over IPC and never
      // touches the plugin bridge.
      expect(IPC.lanesUnlinkLinearIssues).toBe("ade.lanes.unlinkLinearIssues");
    });
  });

  /**
   * Drift guard: a new automations verb added to the allowlist has to be
   * classified deliberately. If this fails, decide whether the new verb writes
   * or runs a rule (add it to the refused set) or only reads (add it here).
   */
  it("classifies every plugin-reachable automations verb as refused or read-only", () => {
    const reachable = (ADE_ACTION_ALLOWLIST.automations ?? []).filter((action) =>
      isAutomationAllowedAdeAction("automations", action),
    );
    const refused = reachable.filter((action) => pluginActionRefusalMessage("automations", action));
    const allowed = reachable.filter((action) => !pluginActionRefusalMessage("automations", action));

    expect(refused.sort()).toEqual(["deleteRule", "saveRule", "toggleRule", "triggerManually"]);
    expect(allowed.sort()).toEqual(
      [
        "get",
        "getHistory",
        "getIngressStatus",
        "getRunDetail",
        "linearIngressGetStatus",
        "linearIngressPollNow",
        "list",
        "listIngressEvents",
        "listRuns",
        "listScheduledCleanups",
        "refreshWebhookGatewayStatus",
        "startIngress",
      ].sort(),
    );
  });
});

/**
 * The project's own secrets — the most sensitive read a plugin can attempt, and
 * the one gated on the MANIFEST rather than on the verb.
 *
 * The declared list reaches this function from the manifest the host parsed at
 * install, so these cases are the whole policy: one readable verb, declared
 * names only, and every other verb in the domain refused outright.
 */
describe("pluginProjectSecretRefusal", () => {
  it("lets a plugin read a secret it declared", () => {
    expect(pluginProjectSecretRefusal("get", { name: "STRIPE_API_KEY" }, ["STRIPE_API_KEY"]))
      .toBeNull();
  });

  it("refuses an undeclared name and names the manifest field to add it to", () => {
    const refusal = pluginProjectSecretRefusal("get", { name: "OPENAI_API_KEY" }, ["STRIPE_API_KEY"]);
    expect(refusal).toMatch(/OPENAI_API_KEY/);
    expect(refusal).toMatch(/projectSecrets/);
  });

  it("refuses every name for a plugin that declared none, which is most of them", () => {
    expect(pluginProjectSecretRefusal("get", { name: "STRIPE_API_KEY" }, [])).toMatch(/projectSecrets/);
    expect(pluginProjectSecretRefusal("get", { name: "STRIPE_API_KEY" }, undefined))
      .toMatch(/projectSecrets/);
  });

  it("refuses the writers, the importers and the lister, declared or not", () => {
    for (const action of ["list", "set", "delete", "previewEnvImport", "importEnv", "exportEnv"]) {
      expect(pluginProjectSecretRefusal(action, {}, ["STRIPE_API_KEY"]), action)
        .toMatch(/not available to plugins/);
    }
  });

  /**
   * Drift guard: a new verb in the domain must be classified deliberately. Only
   * `get` may ever answer null, and only for a declared name.
   */
  it("covers every verb the action allowlist exposes on the domain", () => {
    const domainVerbs = [...(ADE_ACTION_ALLOWLIST.project_secret ?? [])];
    expect(domainVerbs.sort()).toEqual(
      ["delete", "exportEnv", "get", "importEnv", "list", "previewEnvImport", "set"],
    );
    for (const action of domainVerbs) {
      const refusal = pluginProjectSecretRefusal(action, { name: "STRIPE_API_KEY" }, ["STRIPE_API_KEY"]);
      if (action === "get") expect(refusal).toBeNull();
      else expect(refusal, action).not.toBeNull();
    }
  });

  /**
   * The gate is the PLUGIN bridge, not the action layer. A user's own agent,
   * the CLI and the desktop renderer keep reaching `project_secret.get` — this
   * change must not have quietly taken the feature away from them.
   */
  it("leaves non-plugin callers alone: the action stays reachable at agent role", () => {
    expect(isAutomationAllowedAdeAction("project_secret", "get")).toBe(true);
    expect(isAutomationAllowedAdeAction("project_secret", "list")).toBe(true);
    // Still the one verb in the domain the action layer itself reserves.
    expect(isAutomationAllowedAdeAction("project_secret", "exportEnv")).toBe(false);
  });
});
