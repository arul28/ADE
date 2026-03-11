import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";

vi.mock("../packs/projectPackBuilder", () => ({
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
    warnings: [],
    outputPreview: "generated",
  })),
}));

import { createContextDocService } from "./contextDocService";
import {
  resolveContextDocPath,
  runContextDocGeneration,
} from "../packs/projectPackBuilder";

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

async function createFixture(opts?: { contextRefreshEvents?: Record<string, boolean> }) {
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
});
