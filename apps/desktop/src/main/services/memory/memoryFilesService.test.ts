import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import { createProjectMemoryFilesService } from "./memoryFilesService";
import type { Memory } from "./memoryService";

function makeMemory(overrides: Partial<Memory>): Memory {
  const now = "2026-03-25T10:00:00.000Z";
  return {
    id: overrides.id ?? "memory-1",
    projectId: overrides.projectId ?? "project-1",
    scope: overrides.scope ?? "project",
    scopeOwnerId: overrides.scopeOwnerId ?? null,
    tier: overrides.tier ?? 2,
    category: overrides.category ?? "fact",
    content: overrides.content ?? "Fact: default memory.",
    importance: overrides.importance ?? "medium",
    sourceSessionId: overrides.sourceSessionId ?? null,
    sourcePackKey: overrides.sourcePackKey ?? null,
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    lastAccessedAt: overrides.lastAccessedAt ?? now,
    accessCount: overrides.accessCount ?? 0,
    observationCount: overrides.observationCount ?? 0,
    status: overrides.status ?? "promoted",
    agentId: overrides.agentId ?? null,
    confidence: overrides.confidence ?? 1,
    promotedAt: overrides.promotedAt ?? now,
    sourceRunId: overrides.sourceRunId ?? null,
    sourceType: overrides.sourceType ?? "user",
    sourceId: overrides.sourceId ?? null,
    fileScopePattern: overrides.fileScopePattern ?? null,
    pinned: overrides.pinned ?? false,
    accessScore: overrides.accessScore ?? 0,
    compositeScore: overrides.compositeScore ?? 0.8,
    writeGateReason: overrides.writeGateReason ?? null,
    embedded: overrides.embedded ?? true,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors in tests.
    }
  }
});

describe("createProjectMemoryFilesService", () => {
  it("writes a bootstrap index plus topic files from promoted project memory", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-memory-files-"));
    tempDirs.push(projectRoot);
    const service = createProjectMemoryFilesService({
      projectRoot,
      projectId: "project-1",
      memoryService: {
        listMemories: () => [
          makeMemory({
            id: "decision-1",
            category: "decision",
            pinned: true,
            tier: 1,
            importance: "high",
            content: "Decision: use generated auto-memory files as a bootstrap layer, not a new source of truth.",
          }),
          makeMemory({
            id: "gotcha-1",
            category: "gotcha",
            importance: "high",
            content: "Gotcha: renderer-only fixes drift from the shared contract and come back later as regressions.",
          }),
          makeMemory({
            id: "procedure-1",
            category: "procedure",
            content: "Procedure: run targeted desktop checks before full Electron builds when iterating on memory behavior.",
          }),
        ],
      } as any,
    });

    service.sync();

    const memoryDir = resolveAdeLayout(projectRoot).memoryDir;
    const indexPath = path.join(memoryDir, "MEMORY.md");
    const topicPaths = {
      decisions: path.join(memoryDir, "decisions.md"),
      gotchas: path.join(memoryDir, "gotchas.md"),
    };
    expect(fs.existsSync(indexPath)).toBe(true);
    expect(fs.existsSync(topicPaths.decisions)).toBe(true);
    expect(fs.existsSync(topicPaths.gotchas)).toBe(true);

    const indexText = fs.readFileSync(indexPath, "utf8");
    expect(indexText).toContain("# ADE Auto Memory");
    expect(indexText).toContain("decisions.md");
    expect(indexText).toContain("Decision: use generated auto-memory files as a bootstrap layer");

    const gotchasText = fs.readFileSync(topicPaths.gotchas, "utf8");
    expect(gotchasText).toContain("# Gotchas");
    expect(gotchasText).toContain("renderer-only fixes drift from the shared contract");
  });

  it("builds bounded prompt context from the bootstrap index and matching topic files", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-memory-files-"));
    tempDirs.push(projectRoot);
    const service = createProjectMemoryFilesService({
      projectRoot,
      projectId: "project-1",
      memoryService: {
        listMemories: () => [
          makeMemory({
            id: "convention-1",
            category: "convention",
            pinned: true,
            tier: 1,
            content: "Convention: keep ADE memory storage in SQLite and treat generated markdown as a mirror.",
          }),
          makeMemory({
            id: "procedure-1",
            category: "procedure",
            content: "Procedure: run the desktop memory tests before broader builds when iterating on auto-memory behavior.",
          }),
        ],
      } as any,
    });

    service.sync();
    const promptContext = service.buildPromptContext({
      promptText: "Please fix the failing memory tests and preserve the SQLite-backed workflow.",
      maxBootstrapLines: 40,
      maxTopicFiles: 2,
      maxTopicLines: 12,
      maxChars: 2_000,
    });

    expect(promptContext.bootstrapLoaded).toBe(true);
    expect(promptContext.topicFilesLoaded).toContain("procedures.md");
    expect(promptContext.text).toContain("ADE auto memory bootstrap");
    expect(promptContext.text).toContain("Relevant ADE auto memory topic");
    expect(promptContext.text).toContain("run the desktop memory tests");
  });
});
