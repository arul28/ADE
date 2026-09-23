import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseGrokTurnEntries,
  parsePiEntries,
  parseQwenSessionProjects,
  parseQwenUsageEntries,
  scanGrokLogs,
  scanQwenLogs,
} from "./acpProviderLedgers";
import {
  scanCopilotLogs,
  scanDroidLogs,
  usageLedgerTranscriptRoots,
} from "./localUsageLedgers";

const requireForTest = createRequire(path.join(process.cwd(), "history-scanners-test.cjs"));

type TestDatabase = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...params: unknown[]) => void };
  close: () => void;
};

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ade-history-scanners-"));
}

function makeCopilotStore(dbPath: string, rows: Array<Record<string, unknown>>, sessions: Array<{ id: string; cwd: string }>): void {
  const { DatabaseSync } = requireForTest("node:sqlite") as { DatabaseSync: new (dbPath: string) => TestDatabase };
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table sessions (id text primary key, cwd text);
    create table assistant_usage_events (
      id integer primary key autoincrement,
      session_id text not null,
      model text not null,
      input_tokens integer,
      output_tokens integer,
      cache_read_tokens integer,
      cache_write_tokens integer,
      reasoning_tokens integer,
      created_at text
    );
  `);
  for (const session of sessions) {
    db.prepare("insert into sessions (id, cwd) values (?, ?)").run(session.id, session.cwd);
  }
  for (const row of rows) {
    db.prepare(
      `insert into assistant_usage_events
        (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.session_id,
      row.model,
      row.input_tokens,
      row.output_tokens,
      row.cache_read_tokens,
      row.cache_write_tokens,
      row.reasoning_tokens,
      row.created_at,
    );
  }
  db.close();
}

describe("parsePiEntries", () => {
  it("reads one turn per assistant message and keeps list-price cost out", () => {
    const raw = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "sess-1",
        timestamp: "2026-08-06T17:58:47.581Z",
        cwd: "/Users/me/ADE/.ade/worktrees/lane-1",
      }),
      JSON.stringify({ type: "model_change", id: "m1", provider: "openai-codex", modelId: "gpt-5.4" }),
      JSON.stringify({
        type: "message",
        id: "a1",
        timestamp: "2026-08-06T17:58:55.171Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.4",
          usage: {
            input: 329,
            output: 336,
            cacheRead: 15872,
            cacheWrite: 0,
            reasoning: 220,
            totalTokens: 16537,
            cost: { total: 0.0098305 },
          },
          timestamp: 1786039127627,
        },
      }),
      "",
    ].join("\n");

    const entries = parsePiEntries(raw, "/tmp/sessions/2026-08-06T17-58-47-581Z_sess-1.jsonl");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      messageId: "pi:sess-1:a1",
      model: "gpt-5.4",
      inputTokens: 329,
      outputTokens: 336,
      cachedTokens: 15872,
      cacheWriteTokens: 0,
      requestContextTokens: 16201,
      timestamp: 1786039127627,
      projectPath: "/Users/me/ADE/.ade/worktrees/lane-1",
      adeOriginated: true,
    });
    // Reasoning is inside output for this provider, so nothing is added to it.
    expect(entries[0]).not.toHaveProperty("billableOutputTokens");
    expect(entries[0]?.costOverrideUsd).toBeUndefined();
  });

  it("prefers the served response model when present", () => {
    const raw = [
      JSON.stringify({ type: "session", id: "sess-2", cwd: "/Users/me/plain" }),
      JSON.stringify({
        type: "message",
        id: "a1",
        message: {
          role: "assistant",
          model: "gpt-5.4",
          responseModel: "gpt-5.4-luna",
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 3, reasoning: 2 },
        },
      }),
    ].join("\n");

    const entries = parsePiEntries(raw, "/tmp/s.jsonl");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      model: "gpt-5.4-luna",
      cacheWriteTokens: 3,
    });
    // Reasoning is inside output for this provider, so nothing is added to it.
    expect(entries[0]).not.toHaveProperty("billableOutputTokens");
    expect(entries[0]?.adeOriginated).toBeUndefined();
  });
});

describe("Pi history root", () => {
  const keys = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"] as const;
  const saved = new Map<string, string | undefined>();
  let tmpDir = "";

  afterEach(() => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = "";
  });

  function useAgentDir(settings?: Record<string, unknown>): string {
    for (const key of keys) saved.set(key, process.env[key]);
    for (const key of keys) delete process.env[key];
    tmpDir = makeTmpDir();
    const agentDir = path.join(tmpDir, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    if (settings) fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    return agentDir;
  }

  it("reads sessions/ under PI_CODING_AGENT_DIR by default", () => {
    const agentDir = useAgentDir();
    expect(usageLedgerTranscriptRoots().pi).toEqual([path.join(agentDir, "sessions")]);
  });

  it("follows the sessionDir in Pi's own settings.json, the way ADE's Pi chat does", () => {
    const custom = path.join(os.tmpdir(), "pi-sessions-from-settings");
    useAgentDir({ sessionDir: custom });
    expect(usageLedgerTranscriptRoots().pi).toEqual([path.resolve(custom)]);
  });

  it("lets PI_CODING_AGENT_SESSION_DIR override settings and the default outright", () => {
    useAgentDir({ sessionDir: path.join(os.tmpdir(), "pi-sessions-from-settings") });
    process.env.PI_CODING_AGENT_SESSION_DIR = "/mirror/pi/sessions";
    expect(usageLedgerTranscriptRoots().pi).toEqual([path.resolve("/mirror/pi/sessions")]);
  });
});

describe("parseQwenUsageEntries", () => {
  it("keeps thoughts inside output (no double billing) and normalizes cached input", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      id: "q1",
      timestamp: "2026-08-31T19:54:26.847Z",
      sessionId: "s",
      model: "gpt-5.5",
      inputTokens: 13033,
      outputTokens: 110,
      cachedTokens: 1000,
      thoughtsTokens: 89,
      totalTokens: 13143,
    });

    const entries = parseQwenUsageEntries(raw, "token-usage-2026-08.jsonl");

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      messageId: "qwen:q1",
      model: "gpt-5.5",
      inputTokens: 12033,
      outputTokens: 110,
      cachedTokens: 1000,
      cacheWriteTokens: 0,
      requestContextTokens: 13033,
    });
    // Reasoning is inside output for this provider, so nothing is added to it.
    expect(entries[0]).not.toHaveProperty("billableOutputTokens");
  });
});

describe("parseQwenSessionProjects", () => {
  it("attributes request rows to the project recorded in the session summary", () => {
    const summaries = [
      JSON.stringify({ version: 1, sessionId: "s-lane", project: "/repo/.ade/worktrees/lane-a" }),
      JSON.stringify({ version: 1, sessionId: "s-home", project: "/Users/me" }),
      "not json",
    ].join("\n");
    const projects = parseQwenSessionProjects(summaries);
    const row = (id: string, sessionId: string) => JSON.stringify({ id, sessionId, model: "qwen3.7-plus", inputTokens: 10, outputTokens: 1 });

    const entries = parseQwenUsageEntries([row("a", "s-lane"), row("b", "s-home"), row("c", "s-unknown")].join("\n"), "token-usage-2026-09.jsonl", projects);

    expect(entries[0]).toMatchObject({ projectPath: "/repo/.ade/worktrees/lane-a", adeOriginated: true });
    expect(entries[1]).toMatchObject({ projectPath: "/Users/me", adeOriginated: false });
    expect(entries[2]?.projectPath).toBeUndefined();
  });
});

describe("scanQwenLogs", () => {
  it("reads monthly token files and ignores usage_record.jsonl summaries", async () => {
    const tmpDir = makeTmpDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, "token-usage-2026-08.jsonl"),
        `${JSON.stringify({ id: "q1", timestamp: "2026-08-31T19:54:26.847Z", model: "gpt-5.5", inputTokens: 100, outputTokens: 10, cachedTokens: 0, thoughtsTokens: 0 })}\n`,
      );
      fs.writeFileSync(
        path.join(tmpDir, "usage_record.jsonl"),
        `${JSON.stringify({ id: "summary", timestamp: "2026-08-31T19:00:00.000Z", model: "gpt-5.5", inputTokens: 999, outputTokens: 999 })}\n`,
      );

      const entries = await scanQwenLogs(tmpDir);

      expect(entries.map((entry) => entry.messageId)).toEqual(["qwen:q1"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("parseGrokTurnEntries", () => {
  it("reads one entry per model per turn, converts ticks, and ignores response_completed", () => {
    const raw = [
      JSON.stringify({
        timestamp: 1788158671,
        method: "_x.ai/session/update",
        params: {
          sessionId: "sess",
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: "p1",
            usage: {
              inputTokens: 29805,
              outputTokens: 32,
              totalTokens: 29837,
              cachedReadTokens: 5888,
              cacheCreationTokens: 0,
              reasoningTokens: 27,
              costUsdTicks: 86649000,
              modelUsage: {
                "grok-4.6-build": {
                  inputTokens: 29805,
                  outputTokens: 32,
                  cachedReadTokens: 5888,
                  cacheCreationTokens: 0,
                  reasoningTokens: 27,
                  modelCalls: 1,
                  costUsdTicks: 86649000,
                },
              },
            },
          },
        },
        _meta: { agentTimestampMs: 1788158671191 },
      }),
      JSON.stringify({
        timestamp: 1788158672,
        params: {
          sessionId: "sess",
          update: {
            sessionUpdate: "response_completed",
            usage: { input_tokens: 99999, output_tokens: 99999 },
          },
        },
      }),
      "",
    ].join("\n");

    const entries = parseGrokTurnEntries(
      raw,
      path.join("/root", ".grok", "sessions", "%2FUsers%2Fme%2Fproj", "uuid-1", "updates.jsonl"),
      "/Users/me/proj",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      messageId: "grok:uuid-1:p1:grok-4.6-build",
      model: "grok-4.6-build",
      inputTokens: 23917,
      outputTokens: 32,
      cachedTokens: 5888,
      requestContextTokens: 29805,
      costOverrideUsd: 0.086649,
      timestamp: 1788158671191,
      projectPath: "/Users/me/proj",
    });
    // Reasoning is inside output for this provider, so nothing is added to it.
    expect(entries[0]).not.toHaveProperty("billableOutputTokens");
  });

  function grokTurn(promptId: string, usage: Record<string, unknown>): string {
    return JSON.stringify({
      timestamp: 1788158671,
      params: { sessionId: "sess", update: { sessionUpdate: "turn_completed", prompt_id: promptId, usage } },
    });
  }

  it("prices only a row that says it is exactly one request at a long-context tier", () => {
    const row = { inputTokens: 300_000, outputTokens: 10, cachedReadTokens: 1_000, cacheCreationTokens: 500 };
    const raw = [
      grokTurn("unsaid", { modelUsage: { "grok-4.6-build": row } }),
      grokTurn("many", { modelUsage: { "grok-4.6-build": { ...row, modelCalls: 3 } } }),
      grokTurn("one", { modelUsage: { "grok-4.6-build": { ...row, modelCalls: 1 } } }),
      "",
    ].join("\n");

    const entries = parseGrokTurnEntries(raw, path.join("/root", "sessions", "enc", "uuid-1", "updates.jsonl"));

    expect(entries.map((entry) => [entry.messageId, entry.requestContextTokens])).toEqual([
      ["grok:uuid-1:unsaid:grok-4.6-build", undefined],
      ["grok:uuid-1:many:grok-4.6-build", undefined],
      ["grok:uuid-1:one:grok-4.6-build", 300_000],
    ]);
    // xAI counts the cache inside `inputTokens`; the uncached share is split out
    // the same way the live chat path does it.
    expect(entries[2]).toMatchObject({ inputTokens: 298_500, cachedTokens: 1_000, cacheWriteTokens: 500 });
  });
});

describe("scanGrokLogs", () => {
  it("attributes a session to a Windows working directory as well as a POSIX one", async () => {
    const tmpDir = makeTmpDir();
    try {
      const turn = JSON.stringify({
        timestamp: 1788158671,
        params: {
          sessionId: "sess",
          update: { sessionUpdate: "turn_completed", prompt_id: "p1", usage: { inputTokens: 10, outputTokens: 2 } },
        },
      });
      const cwds = ["C:\\Users\\me\\proj", "/Users/me/proj", "not-a-path"];
      for (const [index, cwd] of cwds.entries()) {
        const sessionDir = path.join(tmpDir, encodeURIComponent(cwd), `uuid-${index}`);
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, "updates.jsonl"), `${turn}\n`);
      }

      const entries = await scanGrokLogs(tmpDir);
      const projectBySession = new Map(entries.map((entry) => [entry.messageId.split(":")[1], entry.projectPath]));

      expect(projectBySession.get("uuid-0")).toBe("C:\\Users\\me\\proj");
      expect(projectBySession.get("uuid-1")).toBe("/Users/me/proj");
      expect(projectBySession.get("uuid-2")).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanCopilotLogs measured store", () => {
  it("reads measured usage rows and attributes them to the session cwd", async () => {
    const tmpDir = makeTmpDir();
    try {
      const dbPath = path.join(tmpDir, "session-store.db");
      makeCopilotStore(
        dbPath,
        [
          {
            session_id: "session-1",
            model: "gpt-5.6-luna",
            input_tokens: 23112,
            output_tokens: 18,
            cache_read_tokens: 0,
            cache_write_tokens: 23109,
            reasoning_tokens: 0,
            created_at: "2026-09-13T23:01:38.653Z",
          },
        ],
        [{ id: "session-1", cwd: "/Users/me/ADE/.ade/worktrees/lane-2" }],
      );

      const entries = await scanCopilotLogs(path.join(tmpDir, "missing-session-state"), [], dbPath);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        messageId: "copilot-cli:session-1:1",
        model: "gpt-5.6-luna",
        inputTokens: 3,
        outputTokens: 18,
        cachedTokens: 0,
        cacheWriteTokens: 23109,
        requestContextTokens: 23112,
        projectPath: "/Users/me/ADE/.ade/worktrees/lane-2",
        adeOriginated: true,
      });
      expect(entries[0]?.costOverrideUsd).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanCopilotLogs dedupe", () => {
  it("prefers the measured SQLite row and drops the matching event-log turn", async () => {
    const tmpDir = makeTmpDir();
    try {
      const sessionStateDir = path.join(tmpDir, "home", "session-state");
      const sessionDir = path.join(sessionStateDir, "session-1");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "events.jsonl"),
        [
          JSON.stringify({
            type: "session.start",
            timestamp: "2026-09-13T23:01:33.998Z",
            data: { sessionId: "session-1", producer: "copilot-agent", context: { cwd: "/Users/me/ADE" } },
          }),
          JSON.stringify({
            type: "user.message",
            timestamp: "2026-09-13T23:01:34.000Z",
            data: { content: "hello" },
          }),
          JSON.stringify({
            type: "assistant.message",
            timestamp: "2026-09-13T23:01:38.912Z",
            data: { messageId: "assistant-1", model: "gpt-5.6-luna", content: "first answer" },
          }),
          JSON.stringify({
            type: "assistant.message",
            timestamp: "2026-09-13T23:04:32.406Z",
            data: { messageId: "assistant-2", model: "gpt-5.6-luna", content: "second answer" },
          }),
          "",
        ].join("\n"),
      );

      const dbPath = path.join(tmpDir, "home", "session-store.db");
      makeCopilotStore(
        dbPath,
        [
          {
            session_id: "session-1",
            model: "gpt-5.6-luna",
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            created_at: "2026-09-13T23:01:38.653Z",
          },
          {
            session_id: "session-1",
            model: "gpt-5.6-luna",
            input_tokens: 200,
            output_tokens: 40,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            reasoning_tokens: 0,
            created_at: "2026-09-13T23:04:30.493Z",
          },
        ],
        [{ id: "session-1", cwd: "/Users/me/ADE" }],
      );

      const entries = await scanCopilotLogs(sessionStateDir, [], dbPath);

      expect(entries).toHaveLength(2);
      expect(entries.map((entry) => entry.messageId).sort()).toEqual([
        "copilot-cli:session-1:1",
        "copilot-cli:session-1:2",
      ]);
      expect(entries.reduce((sum, entry) => sum + entry.outputTokens, 0)).toBe(60);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // The bug: the store's row count per session skipped that many event-log
  // turns from the START. A session that began before Copilot wrote
  // session-store.db has rows only for its newest turns, so the old turns were
  // dropped and the newest ones counted twice.
  it("regression: a session that predates the store keeps its oldest turns and counts its newest once", async () => {
    const tmpDir = makeTmpDir();
    try {
      const sessionStateDir = path.join(tmpDir, "home", "session-state");
      const sessionDir = path.join(sessionStateDir, "session-1");
      fs.mkdirSync(sessionDir, { recursive: true });
      const assistant = (messageId: string, timestamp: string, content: string) => JSON.stringify({
        type: "assistant.message",
        timestamp,
        data: { messageId, model: "gpt-5.6-luna", content },
      });
      fs.writeFileSync(
        path.join(sessionDir, "events.jsonl"),
        [
          JSON.stringify({
            type: "session.start",
            timestamp: "2026-09-10T10:00:00.000Z",
            data: { sessionId: "session-1", producer: "copilot-agent", context: { cwd: "/Users/me/ADE" } },
          }),
          assistant("before-upgrade-1", "2026-09-10T10:00:05.000Z", "first answer"),
          assistant("before-upgrade-2", "2026-09-10T10:01:05.000Z", "second answer"),
          assistant("after-upgrade", "2026-09-13T23:01:38.912Z", "third answer"),
          "",
        ].join("\n"),
      );

      const dbPath = path.join(tmpDir, "home", "session-store.db");
      makeCopilotStore(
        dbPath,
        [{
          session_id: "session-1",
          model: "gpt-5.6-luna",
          input_tokens: 100,
          output_tokens: 20,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          created_at: "2026-09-13T23:01:38.653Z",
        }],
        [{ id: "session-1", cwd: "/Users/me/ADE" }],
      );

      const entries = await scanCopilotLogs(sessionStateDir, [], dbPath);

      expect(entries.map((entry) => entry.messageId).sort()).toEqual([
        "copilot-cli:session-1:1",
        "copilot:session-1:before-upgrade-1",
        "copilot:session-1:before-upgrade-2",
      ]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scanDroidLogs", () => {
  // Droid's `thinkingTokens` are inside `outputTokens` (no local session has
  // more thinking than output), so adding them billed every reasoning token twice.
  it("regression: bills output alone and never adds thinking on top of it", async () => {
    const tmpDir = makeTmpDir();
    try {
      const sessionPath = path.join(tmpDir, "sessions", "project-a", "session-1.jsonl");
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
      fs.writeFileSync(sessionPath, [
        JSON.stringify({ type: "session_start", id: "session-1", cwd: "/repo" }),
        JSON.stringify({
          type: "message",
          id: "assistant-1",
          timestamp: "2026-09-20T12:00:00.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        }),
        JSON.stringify({
          type: "message",
          id: "assistant-2",
          timestamp: "2026-09-20T12:01:00.000Z",
          message: { role: "assistant", content: [{ type: "tool_use", name: "Execute" }] },
        }),
        "",
      ].join("\n"));
      fs.writeFileSync(sessionPath.replace(/\.jsonl$/, ".settings.json"), JSON.stringify({
        model: "custom:[anthropic]-claude-sonnet-5-20260501",
        tokenUsage: { inputTokens: 101, outputTokens: 41, thinkingTokens: 30, cacheCreationTokens: 5, cacheReadTokens: 9 },
      }));

      const entries = await scanDroidLogs(path.join(tmpDir, "sessions"));

      expect(entries.map((entry) => [entry.outputTokens, entry.billableOutputTokens])).toEqual([[20, 20], [21, 21]]);
      expect(entries.reduce((sum, entry) => sum + (entry.billableOutputTokens ?? 0), 0)).toBe(41);
      expect(entries[0]).toMatchObject({ model: "claude-sonnet-5", projectPath: "/repo", estimation: "distribution" });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
