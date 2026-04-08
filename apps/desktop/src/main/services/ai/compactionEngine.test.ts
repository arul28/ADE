import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("../opencode/openCodeRuntime", () => ({
  runOpenCodeTextPrompt: vi.fn(),
}));

vi.mock("../../../shared/modelRegistry", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getModelById: vi.fn(),
  };
});

import { openKvDb } from "../state/kvDb";
import type { AdeDb } from "../state/kvDb";
import {
  appendTranscriptEntry,
  compactConversation,
  createCompactionMonitor,
  getTranscript,
  getTranscriptRecord,
  markTranscriptCompacted,
  preCompactionWriteback,
  type TranscriptEntry,
} from "./compactionEngine";
import { runOpenCodeTextPrompt } from "../opencode/openCodeRuntime";
import { getModelById } from "../../../shared/modelRegistry";
import type { ModelDescriptor } from "../../../shared/modelRegistry";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

let tmpDir: string;
let db: AdeDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-compaction-"));
  db = await openKvDb(path.join(tmpDir, "ade.db"), createLogger() as any);
  // Insert a project row so FK constraints (if any) pass
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) VALUES (?, ?, ?, ?, ?, ?)",
    ["project-1", tmpDir, "Test", "main", now, now],
  );
});

afterEach(() => {
  try {
    db.close();
  } catch { /* already closed */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    role: "user",
    content: "Hello",
    timestamp: new Date().toISOString(),
    tokenEstimate: 10,
    ...overrides,
  };
}

const fakeModelDescriptor: ModelDescriptor = {
  id: "test-model",
  shortId: "test",
  displayName: "Test Model",
  family: "anthropic",
  authTypes: ["api-key"],
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  capabilities: { tools: true, vision: true, reasoning: true, streaming: true },
  color: "#000",
  providerRoute: "anthropic",
  providerModelId: "test-model",
  isCliWrapped: false,
};

// ---------------------------------------------------------------------------
// Transcript CRUD — appendTranscriptEntry / getTranscript / getTranscriptRecord
// ---------------------------------------------------------------------------

describe("transcript CRUD", () => {
  it("appends a new transcript entry and retrieves it", () => {
    const entry = makeEntry({ content: "first message", tokenEstimate: 42 });

    appendTranscriptEntry(db, {
      projectId: "project-1",
      attemptId: "attempt-1",
      runId: "run-1",
      stepId: "step-1",
      entry,
    });

    const transcript = getTranscript(db, "attempt-1");
    expect(transcript).not.toBeNull();
    const messages = JSON.parse(transcript!.messagesJson) as TranscriptEntry[];
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("first message");
    expect(transcript!.compactionSummary).toBeNull();
  });

  it("appends to an existing transcript record", () => {
    appendTranscriptEntry(db, {
      projectId: "project-1",
      attemptId: "attempt-1",
      runId: "run-1",
      stepId: "step-1",
      entry: makeEntry({ content: "msg 1", tokenEstimate: 10 }),
    });
    appendTranscriptEntry(db, {
      projectId: "project-1",
      attemptId: "attempt-1",
      runId: "run-1",
      stepId: "step-1",
      entry: makeEntry({ content: "msg 2", tokenEstimate: 20 }),
    });

    const transcript = getTranscript(db, "attempt-1");
    const messages = JSON.parse(transcript!.messagesJson) as TranscriptEntry[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("msg 1");
    expect(messages[1]!.content).toBe("msg 2");
  });

  it("accumulates token counts across appends", () => {
    appendTranscriptEntry(db, {
      projectId: "project-1",
      attemptId: "attempt-1",
      runId: "run-1",
      stepId: "step-1",
      entry: makeEntry({ tokenEstimate: 100 }),
    });
    appendTranscriptEntry(db, {
      projectId: "project-1",
      attemptId: "attempt-1",
      runId: "run-1",
      stepId: "step-1",
      entry: makeEntry({ tokenEstimate: 200 }),
    });

    const record = getTranscriptRecord(db, "attempt-1");
    expect(record).not.toBeNull();
    expect(record!.tokenCount).toBe(300);
  });

  it("returns null for a non-existent attempt", () => {
    expect(getTranscript(db, "nonexistent")).toBeNull();
    expect(getTranscriptRecord(db, "nonexistent")).toBeNull();
  });

  it("getTranscriptRecord returns a full record with all fields", () => {
    appendTranscriptEntry(db, {
      projectId: "project-1",
      attemptId: "attempt-2",
      runId: "run-2",
      stepId: "step-2",
      entry: makeEntry({ content: "record test" }),
    });

    const record = getTranscriptRecord(db, "attempt-2");
    expect(record).not.toBeNull();
    expect(record!.projectId).toBe("project-1");
    expect(record!.attemptId).toBe("attempt-2");
    expect(record!.runId).toBe("run-2");
    expect(record!.stepId).toBe("step-2");
    expect(record!.id).toBeTruthy();
    expect(record!.createdAt).toBeTruthy();
    expect(record!.updatedAt).toBeTruthy();
    expect(record!.compactedAt).toBeNull();
    expect(record!.compactionSummary).toBeNull();
  });

  it("handles entries with no tokenEstimate gracefully (defaults to 0)", () => {
    appendTranscriptEntry(db, {
      projectId: "project-1",
      attemptId: "attempt-3",
      runId: "run-3",
      stepId: "step-3",
      entry: { role: "user", content: "no tokens", timestamp: new Date().toISOString() },
    });

    const record = getTranscriptRecord(db, "attempt-3");
    expect(record!.tokenCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// markTranscriptCompacted
// ---------------------------------------------------------------------------

describe("markTranscriptCompacted", () => {
  it("marks a transcript as compacted with summary and new message state", () => {
    appendTranscriptEntry(db, {
      projectId: "project-1",
      attemptId: "attempt-compact",
      runId: "run-1",
      stepId: "step-1",
      entry: makeEntry({ content: "original", tokenEstimate: 500 }),
    });

    const summaryMessages = JSON.stringify([{ role: "system", content: "Summary of conversation" }]);
    markTranscriptCompacted(db, "attempt-compact", "Conversation summary", summaryMessages, 50);

    const record = getTranscriptRecord(db, "attempt-compact");
    expect(record).not.toBeNull();
    expect(record!.compactedAt).toBeTruthy();
    expect(record!.compactionSummary).toBe("Conversation summary");
    expect(record!.tokenCount).toBe(50);
    const messages = JSON.parse(record!.messagesJson);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Summary of conversation");

    const transcript = getTranscript(db, "attempt-compact");
    expect(transcript!.compactionSummary).toBe("Conversation summary");
  });
});

// ---------------------------------------------------------------------------
// createCompactionMonitor
// ---------------------------------------------------------------------------

describe("createCompactionMonitor", () => {
  it("creates a monitor with correct threshold from model context window", () => {
    const monitor = createCompactionMonitor(fakeModelDescriptor);

    expect(monitor.contextWindow).toBe(200_000);
    expect(monitor.threshold).toBe(140_000); // 200k * 0.7
    expect(monitor.totalTokens).toBe(0);
    expect(monitor.shouldCompact()).toBe(false);
  });

  it("supports custom compaction ratio", () => {
    const monitor = createCompactionMonitor(fakeModelDescriptor, 0.5);

    expect(monitor.threshold).toBe(100_000); // 200k * 0.5
  });

  it("tracks tokens and triggers shouldCompact when threshold is exceeded", () => {
    const monitor = createCompactionMonitor(fakeModelDescriptor, 0.5);
    // threshold = 100_000

    monitor.recordTokens(50_000, 0);
    expect(monitor.totalTokens).toBe(50_000);
    expect(monitor.shouldCompact()).toBe(false);

    monitor.recordTokens(30_000, 25_000);
    expect(monitor.totalTokens).toBe(105_000);
    expect(monitor.shouldCompact()).toBe(true);
  });

  it("recordTokens handles zero and undefined-like values", () => {
    const monitor = createCompactionMonitor(fakeModelDescriptor);

    monitor.recordTokens(0, 0);
    expect(monitor.totalTokens).toBe(0);

    monitor.recordTokens(100, 0);
    expect(monitor.totalTokens).toBe(100);
  });

  it("fires shouldCompact at exact threshold boundary", () => {
    const smallModel: ModelDescriptor = { ...fakeModelDescriptor, contextWindow: 1000 };
    const monitor = createCompactionMonitor(smallModel, 0.5);
    // threshold = 500

    monitor.recordTokens(500, 0);
    expect(monitor.shouldCompact()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// compactConversation
// ---------------------------------------------------------------------------

describe("compactConversation", () => {
  const mockedRunPrompt = runOpenCodeTextPrompt as ReturnType<typeof vi.fn>;
  const mockedGetModel = getModelById as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedGetModel.mockReturnValue(fakeModelDescriptor);
  });

  it("calls runOpenCodeTextPrompt for summarization and fact extraction", async () => {
    mockedRunPrompt
      .mockResolvedValueOnce({ text: "## Summary\nDid stuff", inputTokens: 100, outputTokens: 50 })
      .mockResolvedValueOnce({ text: '["The auth API needs X-Request-ID"]', inputTokens: 80, outputTokens: 20 });

    const messages: TranscriptEntry[] = [
      { role: "user", content: "Fix the auth bug", timestamp: "2026-01-01T00:00:00Z", tokenEstimate: 10 },
      { role: "assistant", content: "I found the issue in middleware.ts", timestamp: "2026-01-01T00:01:00Z", tokenEstimate: 20 },
    ];

    const result = await compactConversation({
      messages,
      modelId: "test-model",
      projectConfig: { models: {} } as any,
    });

    expect(result.summary).toBe("## Summary\nDid stuff");
    expect(result.factsExtracted).toEqual(["The auth API needs X-Request-ID"]);
    expect(result.previousTokenCount).toBe(30); // 10 + 20
    expect(result.newTokenCount).toBeGreaterThan(0);
    expect(mockedRunPrompt).toHaveBeenCalledTimes(2);
  });

  it("throws when model ID is unknown", async () => {
    mockedGetModel.mockReturnValue(undefined);

    await expect(
      compactConversation({
        messages: [makeEntry()],
        modelId: "nonexistent-model",
        projectConfig: { models: {} } as any,
      }),
    ).rejects.toThrow("Unknown compaction model");
  });

  it("returns empty facts when fact extraction produces invalid JSON", async () => {
    mockedRunPrompt
      .mockResolvedValueOnce({ text: "Summary text", inputTokens: 10, outputTokens: 5 })
      .mockResolvedValueOnce({ text: "not valid json at all", inputTokens: 10, outputTokens: 5 });

    const result = await compactConversation({
      messages: [makeEntry()],
      modelId: "test-model",
      projectConfig: { models: {} } as any,
    });

    expect(result.factsExtracted).toEqual([]);
    expect(result.summary).toBe("Summary text");
  });

  it("filters non-string entries from fact extraction array", async () => {
    mockedRunPrompt
      .mockResolvedValueOnce({ text: "Summary", inputTokens: 10, outputTokens: 5 })
      .mockResolvedValueOnce({ text: '["valid fact", 42, null, "another fact"]', inputTokens: 10, outputTokens: 5 });

    const result = await compactConversation({
      messages: [makeEntry()],
      modelId: "test-model",
      projectConfig: { models: {} } as any,
    });

    expect(result.factsExtracted).toEqual(["valid fact", "another fact"]);
  });

  it("estimates tokens from content length when tokenEstimate is missing", async () => {
    mockedRunPrompt
      .mockResolvedValueOnce({ text: "Summary", inputTokens: 10, outputTokens: 5 })
      .mockResolvedValueOnce({ text: "[]", inputTokens: 10, outputTokens: 5 });

    // 40 chars -> ceil(40/4) = 10 tokens
    const result = await compactConversation({
      messages: [{ role: "user", content: "a".repeat(40), timestamp: "2026-01-01T00:00:00Z" }],
      modelId: "test-model",
      projectConfig: { models: {} } as any,
    });

    expect(result.previousTokenCount).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// preCompactionWriteback
// ---------------------------------------------------------------------------

describe("preCompactionWriteback", () => {
  it("calls writeMemory for each fact with correct classification", async () => {
    const writeMemory = vi.fn();

    await preCompactionWriteback({
      projectId: "project-1",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-1",
      facts: [
        "The auth API endpoint requires X-Request-ID header",
        "Schema migration adds a new column to users table",
        "Config env variable DATABASE_URL must be set",
        "Gotcha: edge case with null values in the array",
        "The service uses a singleton pattern for connections",
      ],
      writeMemory,
    });

    expect(writeMemory).toHaveBeenCalledTimes(5);

    // api_pattern -> category "fact"
    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "fact",
        content: "The auth API endpoint requires X-Request-ID header",
        importance: "medium",
        scopeOwnerId: "mission-1",
      }),
    );

    // schema_change -> category "fact"
    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "fact",
        content: "Schema migration adds a new column to users table",
      }),
    );

    // config -> category "preference"
    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "preference",
        content: "Config env variable DATABASE_URL must be set",
      }),
    );

    // gotcha -> category "gotcha", importance "high"
    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "gotcha",
        content: "Gotcha: edge case with null values in the array",
        importance: "high",
      }),
    );

    // architectural -> category "fact"
    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "fact",
        content: "The service uses a singleton pattern for connections",
        importance: "medium",
      }),
    );
  });

  it("falls back to runId as scopeOwnerId when missionId is null", async () => {
    const writeMemory = vi.fn();

    await preCompactionWriteback({
      projectId: "project-1",
      missionId: null,
      runId: "run-42",
      stepId: "step-1",
      facts: ["Some architectural decision"],
      writeMemory,
    });

    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeOwnerId: "run-42",
      }),
    );
  });

  it("falls back to runId when missionId is empty string", async () => {
    const writeMemory = vi.fn();

    await preCompactionWriteback({
      projectId: "project-1",
      missionId: "",
      runId: "run-43",
      stepId: "step-1",
      facts: ["A fact"],
      writeMemory,
    });

    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({ scopeOwnerId: "run-43" }),
    );
  });

  it("does nothing when facts array is empty", async () => {
    const writeMemory = vi.fn();

    await preCompactionWriteback({
      projectId: "project-1",
      runId: "run-1",
      stepId: "step-1",
      facts: [],
      writeMemory,
    });

    expect(writeMemory).not.toHaveBeenCalled();
  });

  it("sets correct source metadata on every memory write", async () => {
    const writeMemory = vi.fn();

    await preCompactionWriteback({
      projectId: "project-1",
      runId: "run-1",
      stepId: "step-7",
      facts: ["A fact about middleware headers"],
      writeMemory,
    });

    expect(writeMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "mission",
        confidence: 0.9,
        status: "promoted",
        sourceRunId: "run-1",
        sourceType: "system",
        sourceId: "compaction:step-7",
        writeGateMode: "strict",
      }),
    );
  });
});
