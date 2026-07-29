import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentChatService,
  resolveRehydratedEventSequence,
} from "../agentChatService";
import type { AgentChatEventEnvelope } from "../../../../shared/types";

/**
 * `sessionId + sequence` is treated as an event identity by clients (iOS most
 * visibly). Every one of these tests exists to hold one invariant: across any
 * number of desktop restarts, a chat session must never mint a sequence number
 * it has already used. Reusing one makes consumers discard the new event as a
 * replay, which is how AskUserQuestion cards silently vanished on iOS.
 */

let tmpRoot: string;

const laneRoot = () => path.join(tmpRoot, "lane-1");

function createLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

function createMockLaneService() {
  const lane = {
    id: "lane-1",
    name: "Primary",
    laneType: "primary",
    branchRef: "feature/primary",
    worktreePath: laneRoot(),
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
  };
  return {
    getLaneBaseAndBranch: vi.fn(() => ({
      baseRef: "main",
      branchRef: lane.branchRef,
      worktreePath: lane.worktreePath,
      laneType: lane.laneType,
    })),
    list: vi.fn(async () => [lane]),
    getSummary: vi.fn(async () => lane),
    getLane: vi.fn(() => lane),
    ensurePrimaryLane: vi.fn(async () => {}),
    linkLinearIssues: vi.fn(() => {}),
    attachLinearIssueToSession: vi.fn(() => []),
    listLinearIssuesForSession: vi.fn(() => []),
  } as any;
}

/** Stands in for the sqlite-backed session table. Shared across "restarts" so a
 * second service instance sees the same rows a real relaunch would. */
function createMockSessionService(rows: Map<string, any>) {
  return {
    create: vi.fn((args: any) => {
      rows.set(args.sessionId, {
        id: args.sessionId,
        laneId: args.laneId,
        ptyId: args.ptyId ?? null,
        tracked: args.tracked ?? true,
        title: args.title ?? "Chat",
        toolType: args.toolType ?? "codex-chat",
        status: "running",
        startedAt: args.startedAt ?? new Date().toISOString(),
        endedAt: null,
        archivedAt: null,
        transcriptPath: args.transcriptPath ?? "",
        resumeCommand: args.resumeCommand ?? null,
        lastOutputPreview: null,
        summary: null,
        goal: args.goal ?? null,
        manuallyNamed: false,
        headShaStart: null,
        headShaEnd: null,
      });
    }),
    get: vi.fn((sessionId: string) => rows.get(sessionId) ?? null),
    list: vi.fn(() => Array.from(rows.values())),
    reopen: vi.fn((sessionId: string) => {
      const row = rows.get(sessionId);
      if (row) { row.status = "running"; row.endedAt = null; }
    }),
    end: vi.fn((args: any) => {
      const sessionId = typeof args === "string" ? args : args?.sessionId;
      const row = rows.get(sessionId);
      if (row) {
        row.status = args?.status ?? "disposed";
        row.endedAt = args?.endedAt ?? new Date().toISOString();
      }
    }),
    deleteSession: vi.fn((sessionId: string) => rows.delete(sessionId)),
    archiveSession: vi.fn(() => true),
    unarchiveSession: vi.fn(() => true),
    updateMeta: vi.fn(),
    setHeadShaStart: vi.fn(),
    setHeadShaEnd: vi.fn(),
    setLastOutputPreview: vi.fn(),
    clearTurnStartMarkers: vi.fn(),
    markLastTurnFailed: vi.fn(),
    clearLastTurnFailed: vi.fn(),
    setSummary: vi.fn(),
    setResumeCommand: vi.fn(),
    upsertClaudeSessionPointer: vi.fn((pointer: any) => pointer),
    getClaudeSessionPointer: vi.fn(() => null),
    getClaudeSessionPointerByChatSessionId: vi.fn(() => null),
    listClaudeSessionPointers: vi.fn(() => []),
  } as any;
}

function createMockProjectConfigService() {
  return {
    get: vi.fn(() => ({
      effective: {
        ai: {
          permissions: { cli: { mode: "edit" }, inProcess: { mode: "edit" } },
          chat: {},
          sessionIntelligence: {},
        },
      },
    })),
    getAll: vi.fn(() => ({})),
    set: vi.fn(),
  } as any;
}

type Harness = {
  service: ReturnType<typeof createAgentChatService>;
  events: AgentChatEventEnvelope[];
};

/** One desktop process. Call twice with the same `sessionRows` to simulate a
 * relaunch: on-disk metadata + transcripts persist, in-memory state does not. */
function startHost(sessionRows: Map<string, any>): Harness {
  const events: AgentChatEventEnvelope[] = [];
  const transcriptsDir = path.join(tmpRoot, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });
  const service = createAgentChatService({
    projectRoot: tmpRoot,
    transcriptsDir,
    laneService: createMockLaneService(),
    sessionService: createMockSessionService(sessionRows),
    projectConfigService: createMockProjectConfigService(),
    aiIntegrationService: { getMode: vi.fn(() => "subscription") } as any,
    logger: createLogger(),
    appVersion: "0.0.1-test",
    getDirtyFileTextForPath: () => undefined,
    onEvent: (event: AgentChatEventEnvelope) => events.push(event),
  } as any);
  return { service, events };
}

const card = (cardId: string) => ({
  cardId,
  variant: "proof_artifact",
  state: "live" as const,
  title: cardId,
  fallbackText: cardId,
});

const cardSequences = (events: AgentChatEventEnvelope[]): number[] =>
  events
    .filter((entry) => entry.event.type === "ade_card")
    .map((entry) => entry.sequence as number);

const chatTranscriptPath = (sessionId: string) =>
  path.join(tmpRoot, ".ade", "transcripts", "chat", `${sessionId}.jsonl`);

const metadataPath = (sessionId: string) =>
  path.join(tmpRoot, ".ade", "cache", "chat-sessions", `${sessionId}.json`);

/** Freeze every transcript on disk at its first line, leaving later events
 * emitted-but-unwritten. That is exactly the on-disk state of a session that
 * has tripped MAX_CHAT_TRANSCRIPT_BYTES: the counter kept climbing, the file
 * did not. */
function freezeTranscriptsAtFirstLine(sessionId: string): void {
  for (const file of [
    chatTranscriptPath(sessionId),
    path.join(tmpRoot, "transcripts", `${sessionId}.chat.jsonl`),
  ]) {
    if (!fs.existsSync(file)) continue;
    const firstLine = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)[0];
    fs.writeFileSync(file, firstLine ? `${firstLine}\n` : "");
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-chat-seq-"));
  fs.mkdirSync(laneRoot(), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("rehydrated chat event sequences", () => {
  it("starts a brand-new session's numbering at 1", async () => {
    const host = startHost(new Map());
    const session = await host.service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });

    await host.service.emitAdeCard({ sessionId: session.id, card: card("a") });
    await host.service.emitAdeCard({ sessionId: session.id, card: card("b") });

    expect(cardSequences(host.events)).toEqual([1, 2]);
    host.service.forceDisposeAll();
  });

  it("continues from the transcript's highest sequence after a restart", async () => {
    const rows = new Map<string, any>();
    const first = startHost(rows);
    const session = await first.service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    for (const id of ["a", "b", "c"]) {
      await first.service.emitAdeCard({ sessionId: session.id, card: card(id) });
    }
    const beforeRestart = cardSequences(first.events);
    expect(beforeRestart).toEqual([1, 2, 3]);
    first.service.forceDisposeAll();

    const second = startHost(rows);
    await second.service.emitAdeCard({ sessionId: session.id, card: card("d") });

    expect(cardSequences(second.events)).toEqual([4]);
    second.service.forceDisposeAll();
  });

  it("continues past a capped transcript using the persisted counter", async () => {
    const rows = new Map<string, any>();
    const first = startHost(rows);
    const session = await first.service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    for (const id of ["a", "b", "c", "d", "e"]) {
      await first.service.emitAdeCard({ sessionId: session.id, card: card(id) });
    }
    const usedBeforeRestart = cardSequences(first.events);
    expect(usedBeforeRestart).toEqual([1, 2, 3, 4, 5]);
    first.service.forceDisposeAll();

    // The transcript can only account for sequence 1 from here on.
    freezeTranscriptsAtFirstLine(session.id);
    const persistedState = JSON.parse(fs.readFileSync(metadataPath(session.id), "utf8"));
    expect(persistedState.eventSequence).toBe(5);

    const second = startHost(rows);
    await second.service.emitAdeCard({ sessionId: session.id, card: card("f") });
    await second.service.emitAdeCard({ sessionId: session.id, card: card("g") });

    const usedAfterRestart = cardSequences(second.events);
    expect(usedAfterRestart).toEqual([6, 7]);
    // The invariant, stated directly: no (sessionId, sequence) pair is reused.
    expect(new Set([...usedBeforeRestart, ...usedAfterRestart]).size)
      .toBe(usedBeforeRestart.length + usedAfterRestart.length);
    second.service.forceDisposeAll();
  });

  it("still recovers from the transcript when persisted state predates the counter", async () => {
    const rows = new Map<string, any>();
    const first = startHost(rows);
    const session = await first.service.createSession({
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
    });
    for (const id of ["a", "b", "c"]) {
      await first.service.emitAdeCard({ sessionId: session.id, card: card(id) });
    }
    first.service.forceDisposeAll();

    // An install that wrote its metadata before `eventSequence` existed.
    const legacy = JSON.parse(fs.readFileSync(metadataPath(session.id), "utf8"));
    delete legacy.eventSequence;
    fs.writeFileSync(metadataPath(session.id), JSON.stringify(legacy));

    const second = startHost(rows);
    await second.service.emitAdeCard({ sessionId: session.id, card: card("d") });

    expect(cardSequences(second.events)).toEqual([4]);
    second.service.forceDisposeAll();
  });
});

describe("resolveRehydratedEventSequence", () => {
  it("takes whichever source saw more events", () => {
    // Normal case: the transcript is the fresher record.
    expect(resolveRehydratedEventSequence(12, 9)).toBe(12);
    // Post-cap case: the transcript stopped growing, the counter did not.
    expect(resolveRehydratedEventSequence(4, 41)).toBe(41);
  });

  it("treats a missing persisted counter as no information, not as zero events", () => {
    expect(resolveRehydratedEventSequence(7, undefined)).toBe(7);
    expect(resolveRehydratedEventSequence(7, null)).toBe(7);
    expect(resolveRehydratedEventSequence(0, undefined)).toBe(0);
  });

  it("refuses corrupt values rather than seeding a session with them", () => {
    expect(resolveRehydratedEventSequence(5, Number.NaN)).toBe(5);
    expect(resolveRehydratedEventSequence(5, Number.POSITIVE_INFINITY)).toBe(5);
    expect(resolveRehydratedEventSequence(5, -20)).toBe(5);
    expect(resolveRehydratedEventSequence(Number.NaN, Number.NaN)).toBe(0);
    // A fractional value would let the next `++` land back on an integer that
    // was already used.
    expect(resolveRehydratedEventSequence(0, 6.9)).toBe(6);
  });
});
