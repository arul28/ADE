// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CtoMemoryBrowser } from "./CtoMemoryBrowser";

function buildBridge() {
  return {
    app: {
      revealPath: vi.fn(async () => undefined),
    },
    memory: {
      search: vi.fn(async () => []),
      list: vi.fn(async () => [
        {
          id: "memory-1",
          scope: "project",
          scopeOwnerId: null,
          tier: 2,
          pinned: false,
          category: "convention",
          content: "Reviewer feedback: always add regression coverage.",
          importance: "medium",
          createdAt: "2026-03-12T09:00:00.000Z",
          updatedAt: "2026-03-12T09:00:00.000Z",
          lastAccessedAt: "2026-03-12T10:00:00.000Z",
          accessCount: 3,
          observationCount: 4,
          status: "candidate",
          confidence: 0.72,
          embedded: true,
          sourceRunId: "run-99",
          sourceType: "pr_feedback",
          sourceId: "pr_feedback:pr-1:comment-1",
          fileScopePattern: "src/validation/rules.ts",
        },
      ]),
      getHealthStats: vi.fn(async () => ({
        scopes: [
          {
            scope: "project",
            current: 10,
            max: 100,
            counts: { tier1: 1, tier2: 7, tier3: 2, archived: 0 },
          },
        ],
      })),
      runSweep: vi.fn(async () => ({
        sweepId: "sweep-1",
        projectId: "project-1",
        reason: "manual",
        startedAt: "2026-03-12T10:00:00.000Z",
        completedAt: "2026-03-12T10:00:01.000Z",
        halfLifeDays: 30,
        entriesDecayed: 0,
        entriesDemoted: 0,
        entriesPromoted: 0,
        entriesArchived: 0,
        entriesOrphaned: 0,
        durationMs: 1000,
      })),
      runConsolidation: vi.fn(async () => ({
        consolidationId: "consolidation-1",
        projectId: "project-1",
        reason: "manual",
        startedAt: "2026-03-12T10:00:00.000Z",
        completedAt: "2026-03-12T10:00:02.000Z",
        clustersFound: 1,
        entriesMerged: 1,
        entriesCreated: 1,
        tokensUsed: 0,
        durationMs: 2000,
      })),
      promote: vi.fn(async () => undefined),
      archive: vi.fn(async () => undefined),
      listProcedures: vi.fn(async () => [
        {
          memory: {
            id: "procedure-1",
            scope: "project",
            scopeOwnerId: null,
            tier: 2,
            pinned: false,
            category: "procedure",
            content: "{\"trigger\":\"When updating validation\",\"procedure\":\"1. Update regression coverage\"}",
            importance: "high",
            createdAt: "2026-03-12T09:00:00.000Z",
            updatedAt: "2026-03-12T09:30:00.000Z",
            lastAccessedAt: "2026-03-12T10:00:00.000Z",
            accessCount: 2,
            observationCount: 3,
            status: "candidate",
            confidence: 0.86,
            embedded: true,
            sourceRunId: "run-99",
            sourceType: "system",
            sourceId: "procedure:1",
            fileScopePattern: "src/validation/**",
          },
          procedural: {
            id: "procedure-1",
            trigger: "When updating validation rules",
            procedure: "1. Update regression coverage\n2. Re-run validation tests",
            confidence: 0.86,
            successCount: 3,
            failureCount: 1,
            sourceEpisodeIds: ["episode-1", "episode-2", "episode-3"],
            lastUsed: "2026-03-12T10:15:00.000Z",
            createdAt: "2026-03-12T09:00:00.000Z",
          },
          exportedSkillPath: null,
          exportedAt: null,
          supersededByMemoryId: null,
        },
      ]),
      getProcedureDetail: vi.fn(async () => ({
        memory: {
          id: "procedure-1",
          scope: "project",
          scopeOwnerId: null,
          tier: 2,
          pinned: false,
          category: "procedure",
          content: "{\"trigger\":\"When updating validation\",\"procedure\":\"1. Update regression coverage\"}",
          importance: "high",
          createdAt: "2026-03-12T09:00:00.000Z",
          updatedAt: "2026-03-12T09:30:00.000Z",
          lastAccessedAt: "2026-03-12T10:00:00.000Z",
          accessCount: 2,
          observationCount: 3,
          status: "candidate",
          confidence: 0.86,
          embedded: true,
          sourceRunId: "run-99",
          sourceType: "system",
          sourceId: "procedure:1",
          fileScopePattern: "src/validation/**",
        },
        procedural: {
          id: "procedure-1",
          trigger: "When updating validation rules",
          procedure: "1. Update regression coverage\n2. Re-run validation tests",
          confidence: 0.86,
          successCount: 3,
          failureCount: 1,
          sourceEpisodeIds: ["episode-1", "episode-2", "episode-3"],
          lastUsed: "2026-03-12T10:15:00.000Z",
          createdAt: "2026-03-12T09:00:00.000Z",
        },
        exportedSkillPath: null,
        exportedAt: null,
        supersededByMemoryId: null,
        sourceEpisodes: [
          {
            id: "episode-1",
            scope: "project",
            scopeOwnerId: null,
            tier: 2,
            pinned: false,
            category: "episode",
            content: "Resolved validation regression by adding test coverage.",
            importance: "medium",
            createdAt: "2026-03-10T09:00:00.000Z",
            updatedAt: "2026-03-10T09:00:00.000Z",
            lastAccessedAt: "2026-03-10T09:00:00.000Z",
            accessCount: 1,
            observationCount: 1,
            status: "promoted",
            confidence: 0.7,
            embedded: true,
            sourceRunId: "run-50",
            sourceType: "intervention",
            sourceId: "intervention:int-1",
            fileScopePattern: "src/validation/**",
          },
        ],
        confidenceHistory: [
          {
            id: "history-1",
            confidence: 0.86,
            outcome: "success",
            reason: "Validation change shipped cleanly.",
            recordedAt: "2026-03-12T10:20:00.000Z",
          },
        ],
      })),
      exportProcedureSkill: vi.fn(async () => ({
        path: "/tmp/.ade/skills/validation-coverage/SKILL.md",
        skill: null,
      })),
      listIndexedSkills: vi.fn(async () => [
        {
          id: "skill-1",
          path: "/tmp/.ade/skills/validation-coverage/SKILL.md",
          kind: "skill",
          source: "exported",
          memoryId: "procedure-1",
          contentHash: "abcdef1234567890",
          lastModifiedAt: "2026-03-12T10:30:00.000Z",
          archivedAt: null,
          createdAt: "2026-03-12T10:30:00.000Z",
          updatedAt: "2026-03-12T10:30:00.000Z",
        },
      ]),
      reindexSkills: vi.fn(async () => []),
      getKnowledgeSyncStatus: vi.fn(async () => ({
        syncing: false,
        lastSeenHeadSha: "12345678deadbeef",
        currentHeadSha: "abcdef1200000000",
        diverged: true,
        lastDigestAt: "2026-03-12T10:40:00.000Z",
        lastDigestMemoryId: "digest-1",
        lastError: null,
      })),
      syncKnowledge: vi.fn(async () => null),
    },
  };
}

describe("CtoMemoryBrowser", () => {
  beforeEach(() => {
    (window as any).ade = buildBridge();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows raw memory provenance in the CTO browser detail panel", async () => {
    render(<CtoMemoryBrowser />);

    await waitFor(() => {
      expect(screen.getByText("Reviewer feedback: always add regression coverage.")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Reviewer feedback: always add regression coverage."));

    const metadata = await screen.findByTestId("cto-memory-detail-metadata");
    expect(metadata.textContent).toContain("Source Type");
    expect(metadata.textContent).toContain("pr_feedback");
    expect(metadata.textContent).toContain("Source ID");
    expect(metadata.textContent).toContain("pr_feedback:pr-1:comment-1");
    expect(metadata.textContent).toContain("Source Run");
    expect(metadata.textContent).toContain("run-99");
    expect(metadata.textContent).toContain("Observations");
    expect(metadata.textContent).toContain("4");
    expect(metadata.textContent).toContain("File Scope");
    expect(metadata.textContent).toContain("src/validation/rules.ts");
  });

  it("renders procedures with detail, confidence history, and export actions", async () => {
    render(<CtoMemoryBrowser />);

    fireEvent.click(screen.getByRole("button", { name: /procedures/i }));

    await waitFor(() => {
      expect(screen.getByText("When updating validation rules")).toBeTruthy();
    });

    expect(screen.getByRole("button", { name: /promote/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /details/i }));

    await waitFor(() => {
      expect(screen.getByTestId("cto-procedure-source-episodes").textContent).toContain("Resolved validation regression by adding test coverage.");
      expect(screen.getByTestId("cto-procedure-confidence-history").textContent).toContain("Validation change shipped cleanly.");
    });

    fireEvent.click(screen.getByRole("button", { name: /export/i }));

    await waitFor(() => {
      expect((window as any).ade.memory.exportProcedureSkill).toHaveBeenCalledWith({ id: "procedure-1" });
    });
  });

  it("renders skills and supports reveal and reindex actions", async () => {
    render(<CtoMemoryBrowser />);

    fireEvent.click(screen.getByRole("button", { name: /skills/i }));

    await waitFor(() => {
      expect(screen.getByText("/tmp/.ade/skills/validation-coverage/SKILL.md")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /reveal/i }));
    fireEvent.click(screen.getByRole("button", { name: /^reindex$/i }));

    await waitFor(() => {
      expect((window as any).ade.app.revealPath).toHaveBeenCalledWith("/tmp/.ade/skills/validation-coverage/SKILL.md");
      expect((window as any).ade.memory.reindexSkills).toHaveBeenCalledWith({ paths: ["/tmp/.ade/skills/validation-coverage/SKILL.md"] });
    });
  });

  it("renders knowledge sync status and triggers a sync", async () => {
    render(<CtoMemoryBrowser />);

    fireEvent.click(screen.getByRole("button", { name: /knowledge sync/i }));

    const syncCard = await screen.findByTestId("cto-knowledge-sync");
    expect(syncCard.textContent).toContain("Behind HEAD");
    expect(syncCard.textContent).toContain("abcdef12");
    expect(syncCard.textContent).toContain("12345678");

    fireEvent.click(screen.getByRole("button", { name: /sync knowledge/i }));

    await waitFor(() => {
      expect((window as any).ade.memory.syncKnowledge).toHaveBeenCalledTimes(1);
    });
  });
});
