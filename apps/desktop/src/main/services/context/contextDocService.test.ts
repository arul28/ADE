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

async function createFixture() {
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
    projectConfigService: {} as any,
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

  it("reuses persisted doc generation preferences for matching auto-refresh cadences", async () => {
    const { db, service } = await createFixture();

    await service.generateDocs({
      provider: "codex",
      modelId: "gpt-5",
      reasoningEffort: "medium",
      trigger: "per_pr",
    });

    expect(runContextDocGeneration).toHaveBeenCalledTimes(1);

    db.setJson("context:docs:lastRun.v1", {
      generatedAt: "2026-03-05T11:30:00.000Z",
    });

    const refreshed = await service.maybeAutoRefreshDocs({
      trigger: "per_pr",
      reason: "pr_closed",
    });

    expect(refreshed?.provider).toBe("codex");
    expect(runContextDocGeneration).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex",
        modelId: "gpt-5",
        reasoningEffort: "medium",
        trigger: "per_pr",
      })
    );
  });

  it("skips auto-refresh when the previous run is still within the minimum interval", async () => {
    const { db, service } = await createFixture();

    await service.generateDocs({
      provider: "claude",
      trigger: "per_lane_refresh",
    });
    db.setJson("context:docs:lastRun.v1", {
      generatedAt: "2026-03-05T11:40:00.000Z",
    });

    const refreshed = await service.maybeAutoRefreshDocs({
      trigger: "per_lane_refresh",
      reason: "lane_refresh",
    });

    expect(refreshed).toBeNull();
    expect(runContextDocGeneration).toHaveBeenCalledTimes(1);
  });

  it("resolves canonical doc paths through the extracted service", async () => {
    const { projectRoot, service } = await createFixture();

    expect(service.getDocPath("prd_ade")).toBe(path.join(projectRoot, "prd_ade.md"));
    expect(resolveContextDocPath).toHaveBeenCalledWith(projectRoot, "prd_ade");
  });
});
