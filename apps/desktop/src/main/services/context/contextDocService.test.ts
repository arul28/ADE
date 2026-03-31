import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";

vi.mock("./contextDocBuilder", () => ({
  readContextDocMeta: vi.fn(() => ({
    contextFingerprint: "fingerprint",
    contextVersion: 1,
    lastDocsRefreshAt: null,
    docsStaleReason: null,
  })),
  readContextStatus: vi.fn(() => ({
    docs: [],
    canonicalDocsPresent: 0,
    canonicalDocsScanned: 0,
    canonicalDocsFingerprint: "fingerprint",
    canonicalDocsUpdatedAt: null,
    projectExportFingerprint: null,
    projectExportUpdatedAt: null,
    contextManifestRefs: {
      project: null,
      packs: null,
      transcripts: null,
    },
    fallbackWrites: 0,
    insufficientContextCount: 0,
    warnings: [],
  })),
  resolveContextDocPath: vi.fn((projectRoot: string, docId: string) => path.join(projectRoot, `${docId}.md`)),
  runContextDocGeneration: vi.fn(async (_deps: unknown, args: Record<string, unknown>) => ({
    provider: args.provider ?? "unified",
    generatedAt: "2026-03-05T12:00:00.000Z",
    prdPath: "/tmp/PRD.ade.md",
    architecturePath: "/tmp/ARCHITECTURE.ade.md",
    usedFallbackPath: false,
    degraded: false,
    docResults: [
      { id: "prd_ade", health: "ready", source: "ai", sizeBytes: 512 },
      { id: "architecture_ade", health: "ready", source: "ai", sizeBytes: 640 },
    ],
    warnings: [],
    outputPreview: "generated",
  })),
}));

import { createContextDocService } from "./contextDocService";
import {
  resolveContextDocPath,
  runContextDocGeneration,
} from "./contextDocBuilder";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function createMockProjectConfigService(overrides?: { contextRefreshEvents?: Record<string, boolean> }) {
  return {
    get: () => ({
      shared: { contextRefreshEvents: overrides?.contextRefreshEvents ?? undefined },
      local: {},
      effective: {},
      validation: { ok: true, issues: [] },
      trust: { sharedHash: "", localHash: "", approvedSharedHash: null, requiresSharedTrust: false },
      paths: { sharedPath: "", localPath: "" },
    }),
  } as any;
}

async function createFixture(opts?: {
  contextRefreshEvents?: Record<string, boolean>;
  onStatusChanged?: (status: unknown) => void;
}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-context-doc-service-"));
  const packsDir = path.join(projectRoot, ".ade", "packs");
  fs.mkdirSync(packsDir, { recursive: true });
  const db = await openKvDb(path.join(projectRoot, "ade.db"), createLogger() as any);

  const service = createContextDocService({
    db,
    logger: createLogger() as any,
    projectRoot,
    projectId: "project-1",
    packsDir,
    laneService: {} as any,
    projectConfigService: createMockProjectConfigService(opts),
    onStatusChanged: opts?.onStatusChanged as ((status: any) => void) | undefined,
  });

  return { db, projectRoot, service };
}

describe("contextDocService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-05T12:00:00.000Z"));
    vi.mocked(runContextDocGeneration).mockClear();
    vi.mocked(resolveContextDocPath).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses persisted doc generation preferences for matching auto-refresh events", async () => {
    const { db, service } = await createFixture();

    await service.generateDocs({
      provider: "codex",
      modelId: "gpt-5",
      reasoningEffort: "medium",
      events: { onPrCreate: true },
    });

    expect(runContextDocGeneration).toHaveBeenCalledTimes(1);

    db.setJson("context:docs:lastRun.v1", {
      generatedAt: "2026-03-05T11:30:00.000Z",
    });

    const refreshed = await service.maybeAutoRefreshDocs({
      event: "pr_create",
      reason: "pr_closed",
    });

    expect(refreshed?.provider).toBe("codex");
    expect(runContextDocGeneration).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        modelId: "gpt-5",
        reasoningEffort: "medium",
        events: expect.objectContaining({ onPrCreate: true }),
      })
    );
  });

  it("skips auto-refresh when the previous run is still within the minimum interval", async () => {
    const { db, service } = await createFixture();

    await service.generateDocs({
      provider: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
      events: { onSessionEnd: true },
    });
    db.setJson("context:docs:lastRun.v1", {
      generatedAt: "2026-03-05T11:40:00.000Z",
    });

    const refreshed = await service.maybeAutoRefreshDocs({
      event: "session_end",
      reason: "lane_refresh",
    });

    expect(refreshed).toBeNull();
    expect(runContextDocGeneration).toHaveBeenCalledTimes(1);
  });

  it("skips auto-refresh when event is not enabled", async () => {
    const { service } = await createFixture();

    await service.generateDocs({
      provider: "unified",
      modelId: "openai/gpt-5.4-codex",
      events: { onPrCreate: true },
    });

    const refreshed = await service.maybeAutoRefreshDocs({
      event: "commit",
      reason: "test_commit",
    });

    expect(refreshed).toBeNull();
    // Only the initial generateDocs call
    expect(runContextDocGeneration).toHaveBeenCalledTimes(1);
  });

  it("backward compat: old trigger cadence maps to event flags", async () => {
    const { db, service } = await createFixture();

    // Simulate old-style prefs with cadence but no events
    await service.generateDocs({
      provider: "codex",
      modelId: "gpt-5",
      trigger: "per_mission",
    });

    db.setJson("context:docs:lastRun.v1", {
      generatedAt: "2026-03-05T11:30:00.000Z",
    });

    const refreshed = await service.maybeAutoRefreshDocs({
      event: "mission_start",
      reason: "mission_launch",
    });

    expect(refreshed?.provider).toBe("codex");
  });

  it("uses project config contextRefreshEvents when available", async () => {
    const { db, service } = await createFixture({
      contextRefreshEvents: { onCommit: true },
    });

    await service.generateDocs({
      provider: "unified",
      modelId: "openai/gpt-5.4-codex",
      events: { onPrCreate: true },
    });

    db.setJson("context:docs:lastRun.v1", {
      generatedAt: "2026-03-05T11:30:00.000Z",
    });

    // commit event is enabled via project config, not stored prefs
    const refreshed = await service.maybeAutoRefreshDocs({
      event: "commit",
      reason: "config_override",
    });

    expect(refreshed?.provider).toBe("unified");
  });

  it("resolves canonical doc paths through the extracted service", async () => {
    const { projectRoot, service } = await createFixture();

    expect(service.getDocPath("prd_ade")).toBe(path.join(projectRoot, "prd_ade.md"));
    expect(resolveContextDocPath).toHaveBeenCalledWith(projectRoot, "prd_ade");
  });

  it("persists active auto-refresh status as pending/running with trigger metadata", async () => {
    const { service } = await createFixture();
    const deferred = createDeferred<Awaited<ReturnType<typeof runContextDocGeneration>>>();
    vi.mocked(runContextDocGeneration).mockReturnValueOnce(deferred.promise as ReturnType<typeof runContextDocGeneration>);

    await service.savePrefs({
      provider: "unified",
      modelId: "gpt-5",
      reasoningEffort: "medium",
      events: { onPrLand: true },
    });

    const refreshPromise = service.maybeAutoRefreshDocs({
      event: "pr_land",
      reason: "prs_land:123",
    });

    const duringRun = service.getStatus().generation;
    expect(["pending", "running"]).toContain(duringRun.state);
    expect(duringRun.source).toBe("auto");
    expect(duringRun.event).toBe("pr_land");
    expect(duringRun.reason).toBe("prs_land:123");
    expect(duringRun.provider).toBe("unified");
    expect(duringRun.modelId).toBe("gpt-5");
    expect(duringRun.reasoningEffort).toBe("medium");

    deferred.resolve({
      provider: "unified",
      generatedAt: "2026-03-05T12:01:00.000Z",
      prdPath: "/tmp/PRD.ade.md",
      architecturePath: "/tmp/ARCHITECTURE.ade.md",
      usedFallbackPath: false,
      degraded: false,
      docResults: [
        { id: "prd_ade", health: "ready", source: "ai", sizeBytes: 512 },
        { id: "architecture_ade", health: "ready", source: "ai", sizeBytes: 640 },
      ],
      warnings: [],
      outputPreview: "generated",
    });

    await expect(refreshPromise).resolves.toMatchObject({
      provider: "unified",
      generatedAt: "2026-03-05T12:01:00.000Z",
    });

    expect(service.getStatus().generation).toMatchObject({
      state: "succeeded",
      source: "auto",
      event: "pr_land",
      reason: "prs_land:123",
      provider: "unified",
      modelId: "gpt-5",
      reasoningEffort: "medium",
      finishedAt: "2026-03-05T12:01:00.000Z",
    });
  });

  it("records manual generation metadata on completion", async () => {
    const { service } = await createFixture();

    await service.generateDocs({
      provider: "codex",
      modelId: "gpt-5-codex",
      reasoningEffort: "high",
      events: { onPrCreate: true },
    });

    expect(service.getStatus().generation).toMatchObject({
      state: "succeeded",
      source: "manual",
      event: null,
      reason: "manual_generate",
      provider: "codex",
      modelId: "gpt-5-codex",
      reasoningEffort: "high",
      finishedAt: "2026-03-05T12:00:00.000Z",
    });
  });

  it("rejects manual generation when no model is selected", async () => {
    const { service } = await createFixture();

    await expect(service.generateDocs({
      provider: "unified",
      events: { onPrCreate: true },
    })).rejects.toThrow("Select a model before generating context docs.");

    expect(runContextDocGeneration).not.toHaveBeenCalled();
  });

  it("skips auto-refresh when no model is configured", async () => {
    const { service } = await createFixture();

    await service.savePrefs({
      provider: "unified",
      modelId: null,
      reasoningEffort: null,
      events: { onPrCreate: true },
    });

    const refreshed = await service.maybeAutoRefreshDocs({
      event: "pr_create",
      reason: "pr_opened",
    });

    expect(refreshed).toBeNull();
    expect(runContextDocGeneration).not.toHaveBeenCalled();
    expect(service.getStatus().generation.state).toBe("idle");
  });

  it("clears stale finished timestamps when a new generation starts", async () => {
    const { db, service } = await createFixture();
    const deferred = createDeferred<Awaited<ReturnType<typeof runContextDocGeneration>>>();

    await service.generateDocs({
      provider: "unified",
      modelId: "openai/gpt-5.4-codex",
      events: { onPrLand: true },
    });

    vi.mocked(runContextDocGeneration).mockReturnValueOnce(deferred.promise as ReturnType<typeof runContextDocGeneration>);
    db.setJson("context:docs:lastRun.v1", {
      generatedAt: "2026-03-05T11:30:00.000Z",
    });

    const refreshPromise = service.maybeAutoRefreshDocs({
      event: "pr_land",
      reason: "prs_land:456",
    });

    const duringRun = service.getStatus().generation;
    expect(["pending", "running"]).toContain(duringRun.state);
    expect(duringRun.finishedAt).toBeNull();

    deferred.resolve({
      provider: "unified",
      generatedAt: "2026-03-05T12:01:00.000Z",
      prdPath: "/tmp/PRD.ade.md",
      architecturePath: "/tmp/ARCHITECTURE.ade.md",
      usedFallbackPath: false,
      degraded: false,
      docResults: [
        { id: "prd_ade", health: "ready", source: "ai", sizeBytes: 512 },
        { id: "architecture_ade", health: "ready", source: "ai", sizeBytes: 640 },
      ],
      warnings: [],
      outputPreview: "generated",
    });

    await refreshPromise;
  });

  it("does not mark an active long-running generation as stale", async () => {
    const { service } = await createFixture();
    const deferred = createDeferred<Awaited<ReturnType<typeof runContextDocGeneration>>>();
    vi.mocked(runContextDocGeneration).mockReturnValueOnce(deferred.promise as ReturnType<typeof runContextDocGeneration>);

    const generatePromise = service.generateDocs({
      provider: "unified",
      modelId: "openai/gpt-5.4-codex",
    });

    vi.advanceTimersByTime(6 * 60_000);

    expect(service.getStatus().generation).toMatchObject({
      state: "running",
      provider: "unified",
      modelId: "openai/gpt-5.4-codex",
    });

    deferred.resolve({
      provider: "unified",
      generatedAt: "2026-03-05T12:06:00.000Z",
      prdPath: "/tmp/PRD.ade.md",
      architecturePath: "/tmp/ARCHITECTURE.ade.md",
      usedFallbackPath: false,
      degraded: false,
      docResults: [
        { id: "prd_ade", health: "ready", source: "ai", sizeBytes: 512 },
        { id: "architecture_ade", health: "ready", source: "ai", sizeBytes: 640 },
      ],
      warnings: [],
      outputPreview: "generated",
    });

    await expect(generatePromise).resolves.toMatchObject({
      generatedAt: "2026-03-05T12:06:00.000Z",
    });
    expect(service.getStatus().generation).toMatchObject({
      state: "succeeded",
      finishedAt: "2026-03-05T12:06:00.000Z",
    });
  });

  it("emits status updates when generation state changes", async () => {
    const onStatusChanged = vi.fn();
    const { service } = await createFixture({ onStatusChanged });
    const deferred = createDeferred<Awaited<ReturnType<typeof runContextDocGeneration>>>();
    vi.mocked(runContextDocGeneration).mockReturnValueOnce(deferred.promise as ReturnType<typeof runContextDocGeneration>);

    const generatePromise = service.generateDocs({
      provider: "unified",
      modelId: "gpt-5",
    });

    expect(onStatusChanged).toHaveBeenCalled();
    expect(onStatusChanged.mock.calls.at(-1)?.[0]?.generation?.state).toBe("running");

    deferred.resolve({
      provider: "unified",
      generatedAt: "2026-03-05T12:02:00.000Z",
      prdPath: "/tmp/PRD.ade.md",
      architecturePath: "/tmp/ARCHITECTURE.ade.md",
      usedFallbackPath: false,
      degraded: false,
      docResults: [
        { id: "prd_ade", health: "ready", source: "ai", sizeBytes: 512 },
        { id: "architecture_ade", health: "ready", source: "ai", sizeBytes: 640 },
      ],
      warnings: [],
      outputPreview: "generated",
    });

    await generatePromise;

    expect(onStatusChanged.mock.calls.at(-1)?.[0]?.generation?.state).toBe("succeeded");
  });

  it("maps legacy idle generation records with a finish time to succeeded", async () => {
    const { db, service } = await createFixture();

    db.setJson("context:docs:generationStatus.v1", {
      state: "idle",
      finishedAt: "2026-03-05T09:30:00.000Z",
      source: "auto",
      event: "pr_create",
      reason: "legacy_run",
    });

    expect(service.getStatus().generation).toMatchObject({
      state: "succeeded",
      source: "auto",
      event: "pr_create",
      reason: "legacy_run",
      finishedAt: "2026-03-05T09:30:00.000Z",
    });
  });

  it("repairs stale in-progress generation records", async () => {
    const { db, service } = await createFixture();

    db.setJson("context:docs:generationStatus.v1", {
      state: "running",
      requestedAt: "2026-03-05T11:40:00.000Z",
      startedAt: "2026-03-05T11:40:00.000Z",
      finishedAt: "2026-03-05T11:30:00.000Z",
      error: null,
      source: "auto",
      event: "pr_create",
      reason: "stale_run",
      provider: "unified",
      modelId: null,
      reasoningEffort: null,
    });

    expect(service.getStatus().generation).toMatchObject({
      state: "failed",
      source: "auto",
      event: "pr_create",
      reason: "stale_run",
      provider: "unified",
    });
    expect(service.getStatus().generation.error).toContain("did not finish");
  });
});
