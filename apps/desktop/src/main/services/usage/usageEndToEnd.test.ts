import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CostSnapshot } from "../../../shared/types";
import type { TokenEntry } from "./ledgers/localUsageLedgers";
import { sanitizeClaudeProjectPath } from "./ledgers/localUsageLedgers";
import { _testing } from "./usageTrackingService";

const requireForTest = createRequire(path.join(process.cwd(), "usage-e2e-test.cjs"));

const {
  buildCostSnapshots,
  scanClaudeLogs,
  scanCodexLogs,
  scanCursorLogs,
  scanDroidLogs,
  scanGeminiLogs,
} = _testing;

type TokenTotals = { input: number; output: number; cached: number; cacheWrite: number };
type TokenBreakdownValue = Omit<TokenTotals, "cacheWrite"> & { cacheWrite?: number };

function writeJsonl(filePath: string, records: unknown[], mtime: Date): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  fs.utimesSync(filePath, mtime, mtime);
}

function sumBreakdown(breakdown: Record<string, TokenBreakdownValue> | undefined): TokenTotals {
  return Object.values(breakdown ?? {}).reduce<TokenTotals>((total, model) => ({
    input: total.input + model.input,
    output: total.output + model.output,
    cached: total.cached + model.cached,
    cacheWrite: total.cacheWrite + (model.cacheWrite ?? 0),
  }), { input: 0, output: 0, cached: 0, cacheWrite: 0 });
}

function totalsFor(snapshot: CostSnapshot): TokenTotals {
  return sumBreakdown(snapshot.tokenBreakdownByPreset?.all);
}

function dailyTotalsFor(snapshot: CostSnapshot): Record<string, TokenTotals> {
  return Object.fromEntries(Object.entries(snapshot.dailyTokenBreakdownByPreset?.all ?? {})
    .map(([day, breakdown]) => [day, sumBreakdown(breakdown)]));
}

function totalTokens(totals: TokenTotals): number {
  return totals.input + totals.output + totals.cached + totals.cacheWrite;
}

function snapshotsByProvider(snapshots: CostSnapshot[]): Record<string, CostSnapshot> {
  return Object.fromEntries(snapshots.map((snapshot) => [snapshot.provider, snapshot]));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("usage ledger end-to-end accuracy", () => {
  it("matches independently calculated provider, day, scope, origin, and estimation totals", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-usage-e2e-"));
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const originalClaudeConfigDirs = process.env.CLAUDE_CONFIG_DIRS;
    const originalCodexHome = process.env.CODEX_HOME;
    const originalFactoryDir = process.env.FACTORY_DIR;
    const originalTimezone = process.env.TZ;

    try {
      process.env.TZ = "America/New_York";
      const beforeMidnight = new Date(2026, 9, 31, 23, 59, 0, 0);
      const afterMidnight = new Date(2026, 10, 1, 0, 1, 0, 0);
      const beforeDstChange = new Date(2026, 10, 1, 0, 30, 0, 0);
      const afterDstChange = new Date(2026, 10, 1, 3, 30, 0, 0);
      const today = new Date(2026, 10, 2, 9, 0, 0, 0);
      const now = new Date(2026, 10, 2, 12, 0, 0, 0);
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const projectA = path.join(tmpDir, "project-a");
      const projectB = path.join(tmpDir, "project-b");
      const claudeConfigDir = path.join(tmpDir, "claude");
      const claudeProjectA = path.join(claudeConfigDir, "projects", sanitizeClaudeProjectPath(projectA));
      const claudeProjectB = path.join(claudeConfigDir, "projects", sanitizeClaudeProjectPath(projectB));
      const claudeEntry = ({
        id,
        timestamp,
        cwd,
        input,
        output,
        cacheRead = 0,
        cacheWrite = 0,
        cache5m,
        cache1h,
      }: {
        id: string;
        timestamp: Date;
        cwd: string;
        input: number;
        output: number;
        cacheRead?: number;
        cacheWrite?: number;
        cache5m?: number;
        cache1h?: number;
      }) => ({
        type: "assistant",
        timestamp: timestamp.toISOString(),
        cwd,
        message: {
          id,
          model: "claude-opus-4-6",
          usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheWrite,
            ...(cache5m != null || cache1h != null ? {
              cache_creation: {
                ephemeral_5m_input_tokens: cache5m ?? 0,
                ephemeral_1h_input_tokens: cache1h ?? 0,
              },
            } : {}),
            server_tool_use: { web_search_requests: 1 },
          },
        },
      });

      const resumedClaudeMessage = claudeEntry({
        id: "claude-resume",
        timestamp: beforeMidnight,
        cwd: projectA,
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
      });
      writeJsonl(path.join(claudeProjectA, "session-a.jsonl"), [
        resumedClaudeMessage,
        claudeEntry({ id: "claude-stream", timestamp: afterMidnight, cwd: projectA, input: 20, output: 4, cacheRead: 5, cacheWrite: 4 }),
        claudeEntry({ id: "claude-stream", timestamp: new Date(2026, 10, 1, 0, 2), cwd: projectA, input: 30, output: 7, cacheRead: 8, cacheWrite: 6 }),
        claudeEntry({
          id: "claude-stream",
          timestamp: new Date(2026, 10, 1, 0, 3),
          cwd: projectA,
          input: 40,
          output: 9,
          cacheRead: 10,
          cacheWrite: 7,
          cache5m: 3,
          cache1h: 5,
        }),
      ], now);
      writeJsonl(path.join(claudeProjectA, "session-b.jsonl"), [
        resumedClaudeMessage,
        claudeEntry({
          id: "claude-ade",
          timestamp: afterDstChange,
          cwd: path.join(projectA, ".ade", "worktrees", "lane-a"),
          input: 11,
          output: 4,
          cacheRead: 2,
          cacheWrite: 3,
        }),
      ], new Date(now.getTime() - 1_000));
      writeJsonl(path.join(claudeProjectA, "subagents", "workflows", "wf-1", "agent-explore.jsonl"), [
        claudeEntry({ id: "claude-subagent", timestamp: new Date(2026, 10, 1, 3, 45), cwd: projectA, input: 7, output: 3, cacheRead: 1, cacheWrite: 2 }),
      ], new Date(now.getTime() - 2_000));
      writeJsonl(path.join(claudeProjectB, "session-c.jsonl"), [
        claudeEntry({ id: "claude-project-b", timestamp: today, cwd: projectB, input: 13, output: 5, cacheRead: 4, cacheWrite: 6 }),
      ], new Date(now.getTime() - 3_000));

      process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
      delete process.env.CLAUDE_CONFIG_DIRS;

      const codexHome = path.join(tmpDir, "codex");
      const codexSessions = path.join(codexHome, "sessions", "2026", "11", "01");
      const codexUsage = ({ timestamp, input, cached, output, reasoning, total }: {
        timestamp: Date;
        input: number;
        cached: number;
        output: number;
        reasoning: number;
        total: number;
      }) => ({
        timestamp: timestamp.toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              reasoning_output_tokens: reasoning,
              total_tokens: total,
            },
            last_token_usage: {
              input_tokens: input,
              cached_input_tokens: cached,
              output_tokens: output,
              reasoning_output_tokens: reasoning,
              total_tokens: total,
            },
          },
        },
      });
      writeJsonl(path.join(codexSessions, "parent.jsonl"), [
        { type: "session_meta", payload: { id: "codex-parent", originator: "codex_cli_rs", cwd: projectA, model: "gpt-5.5" } },
        codexUsage({ timestamp: beforeDstChange, input: 50, cached: 10, output: 5, reasoning: 1, total: 56 }),
      ], now);
      writeJsonl(path.join(codexSessions, "fork.jsonl"), [
        { type: "session_meta", payload: { id: "codex-fork", forked_from_id: "codex-parent", originator: "ade_desktop", cwd: projectA, model: "gpt-5.5" } },
        codexUsage({ timestamp: new Date(2026, 10, 1, 3, 1), input: 50, cached: 10, output: 5, reasoning: 1, total: 56 }),
        {
          ...codexUsage({ timestamp: new Date(2026, 10, 1, 3, 15), input: 70, cached: 15, output: 8, reasoning: 2, total: 80 }),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 70, cached_input_tokens: 15, output_tokens: 8, reasoning_output_tokens: 2, total_tokens: 80 },
              last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 24 },
            },
          },
        },
      ], new Date(now.getTime() - 1_000));
      writeJsonl(path.join(codexHome, "sessions", "2026", "11", "02", "external-b.jsonl"), [
        { type: "session_meta", payload: { id: "codex-project-b", originator: "codex_cli_rs", cwd: projectB, model: "gpt-5.5" } },
        codexUsage({ timestamp: new Date(2026, 10, 2, 9, 15), input: 30, cached: 6, output: 4, reasoning: 0, total: 34 }),
      ], new Date(now.getTime() - 2_000));
      process.env.CODEX_HOME = codexHome;

      const cursorDbPath = path.join(tmpDir, "cursor", "state.vscdb");
      fs.mkdirSync(path.dirname(cursorDbPath), { recursive: true });
      const { DatabaseSync } = requireForTest("node:sqlite") as {
        DatabaseSync: new (dbPath: string) => {
          exec: (sql: string) => void;
          prepare: (sql: string) => { run: (...args: unknown[]) => void };
          close: () => void;
        };
      };
      const cursorDb = new DatabaseSync(cursorDbPath);
      cursorDb.exec("create table cursorDiskKV (key text, value text);");
      const insertCursor = cursorDb.prepare("insert into cursorDiskKV values (?, ?)");
      insertCursor.run("bubbleId:cursor-1", JSON.stringify({
        createdAt: new Date(2026, 10, 1, 0, 40).toISOString(),
        tokenCount: { inputTokens: 12, outputTokens: 3 },
        modelInfo: { modelName: "cursor-auto" },
        type: 1,
        text: "native",
      }));
      insertCursor.run("bubbleId:cursor-2", JSON.stringify({
        createdAt: new Date(2026, 10, 1, 3, 40).toISOString(),
        tokenCount: {},
        modelInfo: { modelName: "default" },
        type: 2,
        text: "abcdefghijklmnop",
      }));
      cursorDb.close();

      const geminiTmp = path.join(tmpDir, "gemini", "tmp");
      writeJsonl(path.join(geminiTmp, "project-a", "chats", "session-gemini.jsonl"), [
        { sessionId: "gemini-session", startTime: afterMidnight.toISOString(), projectHash: "project-a" },
        { id: "gemini-before-dst", type: "gemini", timestamp: new Date(2026, 10, 1, 0, 45).toISOString(), model: "gemini-3.1-pro-preview", tokens: { input: 30, output: 7, cached: 5, thoughts: 2 } },
        { id: "gemini-after-dst", type: "gemini", timestamp: new Date(2026, 10, 1, 3, 15).toISOString(), model: "gemini-3.1-pro-preview", tokens: { input: 20, output: 5, cached: 4, thoughts: 1 } },
      ], now);

      const factoryDir = path.join(tmpDir, "factory");
      const droidSession = path.join(factoryDir, "sessions", "project-a", "session-droid.jsonl");
      writeJsonl(droidSession, [
        { type: "session_start", id: "droid-session", cwd: projectA },
        { type: "message", id: "droid-before-dst", timestamp: new Date(2026, 10, 1, 0, 50).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "before" }] } },
        { type: "message", id: "droid-after-dst", timestamp: new Date(2026, 10, 1, 3, 20).toISOString(), message: { role: "assistant", content: [{ type: "tool_use", name: "Execute" }] } },
      ], now);
      fs.writeFileSync(droidSession.replace(/\.jsonl$/, ".settings.json"), JSON.stringify({
        model: "custom:[anthropic]-claude-sonnet-5-20260501",
        tokenUsage: { inputTokens: 21, outputTokens: 9, thinkingTokens: 3, cacheReadTokens: 5, cacheCreationTokens: 3 },
      }));
      process.env.FACTORY_DIR = factoryDir;

      const entriesByProvider = new Map<string, TokenEntry[]>([
        ["claude", await scanClaudeLogs([claudeProjectA, claudeProjectB])],
        ["codex", await scanCodexLogs()],
        ["cursor", await scanCursorLogs(cursorDbPath)],
        ["gemini", await scanGeminiLogs(geminiTmp)],
        ["droid", await scanDroidLogs()],
      ]);
      const machine = snapshotsByProvider(buildCostSnapshots(entriesByProvider, "machine", projectA));
      const project = snapshotsByProvider(buildCostSnapshots(entriesByProvider, "project", projectA));

      const expectedMachineTotals: Record<string, TokenTotals> = {
        claude: { input: 81, output: 23, cached: 20, cacheWrite: 23 },
        codex: { input: 79, output: 12, cached: 21, cacheWrite: 0 },
        cursor: { input: 12, output: 7, cached: 0, cacheWrite: 0 },
        gemini: { input: 41, output: 15, cached: 9, cacheWrite: 0 },
        droid: { input: 21, output: 12, cached: 5, cacheWrite: 3 },
      };
      const expectedProjectTotals: Record<string, TokenTotals> = {
        claude: { input: 68, output: 18, cached: 16, cacheWrite: 17 },
        codex: { input: 55, output: 8, cached: 15, cacheWrite: 0 },
        cursor: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
        gemini: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
        droid: { input: 0, output: 0, cached: 0, cacheWrite: 0 },
      };
      const expectedDailyTotals: Record<string, Record<string, TokenTotals>> = {
        claude: {
          "2026-10-31": { input: 10, output: 2, cached: 3, cacheWrite: 4 },
          "2026-11-01": { input: 58, output: 16, cached: 13, cacheWrite: 13 },
          "2026-11-02": { input: 13, output: 5, cached: 4, cacheWrite: 6 },
        },
        codex: {
          "2026-11-01": { input: 55, output: 8, cached: 15, cacheWrite: 0 },
          "2026-11-02": { input: 24, output: 4, cached: 6, cacheWrite: 0 },
        },
        cursor: { "2026-11-01": { input: 12, output: 7, cached: 0, cacheWrite: 0 } },
        gemini: { "2026-11-01": { input: 41, output: 15, cached: 9, cacheWrite: 0 } },
        droid: { "2026-11-01": { input: 21, output: 12, cached: 5, cacheWrite: 3 } },
      };

      for (const provider of Object.keys(expectedMachineTotals)) {
        expect(totalsFor(machine[provider]!), `${provider} machine totals`).toEqual(expectedMachineTotals[provider]);
        expect(totalsFor(project[provider]!), `${provider} project totals`).toEqual(expectedProjectTotals[provider]);
        expect(dailyTotalsFor(machine[provider]!), `${provider} daily totals`).toEqual(expectedDailyTotals[provider]);
      }

      expect(Object.fromEntries(Object.entries(machine).map(([provider, snapshot]) => {
        const total = totalTokens(totalsFor(snapshot));
        const ade = snapshot.adeOriginatedTokensByPreset?.all ?? 0;
        return [provider, { ade, external: total - ade }];
      }))).toEqual({
        claude: { ade: 20, external: 127 },
        codex: { ade: 23, external: 89 },
        cursor: { ade: 0, external: 19 },
        gemini: { ade: 0, external: 65 },
        droid: { ade: 0, external: 41 },
      });

      expect(Object.fromEntries(Object.entries(machine).map(([provider, snapshot]) => [provider, {
        estimation: snapshot.estimation ?? null,
        scopeSupported: snapshot.scopeSupported,
      }]))).toEqual({
        claude: { estimation: null, scopeSupported: true },
        codex: { estimation: null, scopeSupported: true },
        cursor: { estimation: "mixed", scopeSupported: false },
        gemini: { estimation: null, scopeSupported: false },
        droid: { estimation: "distribution", scopeSupported: false },
      });

      expect(afterDstChange.getTime() - beforeDstChange.getTime()).toBe(4 * 60 * 60 * 1_000);
    } finally {
      const restoreEnv = (key: "CLAUDE_CONFIG_DIR" | "CLAUDE_CONFIG_DIRS" | "CODEX_HOME" | "FACTORY_DIR" | "TZ", value: string | undefined) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      };
      restoreEnv("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
      restoreEnv("CLAUDE_CONFIG_DIRS", originalClaudeConfigDirs);
      restoreEnv("CODEX_HOME", originalCodexHome);
      restoreEnv("FACTORY_DIR", originalFactoryDir);
      restoreEnv("TZ", originalTimezone);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
