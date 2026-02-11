import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  EffectiveProjectConfig,
  GetTestLogTailArgs,
  ListTestRunsArgs,
  RunTestSuiteArgs,
  StopTestRunArgs,
  TestEvent,
  TestRunStatus,
  TestRunSummary,
  TestSuiteDefinition
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";
import type { createProjectConfigService } from "../config/projectConfigService";

type ActiveRunEntry = {
  runId: string;
  suiteId: string;
  suiteName: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  startedAt: string;
  logPath: string;
  logStream: fs.WriteStream;
  timeoutTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  stopIntent: "canceled" | "timed_out" | null;
};

function clampMaxBytes(maxBytes: number | undefined, fallback: number): number {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) return fallback;
  return Math.max(1024, Math.min(2_000_000, Math.floor(maxBytes)));
}

function readTail(filePath: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function createTestService({
  db,
  projectRoot,
  projectId,
  testLogsDir,
  logger,
  projectConfigService,
  broadcastEvent
}: {
  db: AdeDb;
  projectRoot: string;
  projectId: string;
  testLogsDir: string;
  logger: Logger;
  projectConfigService: ReturnType<typeof createProjectConfigService>;
  broadcastEvent: (ev: TestEvent) => void;
}) {
  const activeRuns = new Map<string, ActiveRunEntry>();

  const nowIso = () => new Date().toISOString();

  const persistRunStart = (runId: string, suiteId: string, startedAt: string, logPath: string) => {
    db.run(
      `
        insert into test_runs(id, project_id, lane_id, suite_key, started_at, ended_at, status, exit_code, duration_ms, summary_json, log_path)
        values (?, ?, null, ?, ?, null, 'running', null, null, null, ?)
      `,
      [runId, projectId, suiteId, startedAt, logPath]
    );
  };

  const persistRunEnd = ({
    runId,
    status,
    exitCode,
    endedAt,
    durationMs
  }: {
    runId: string;
    status: TestRunStatus;
    exitCode: number | null;
    endedAt: string;
    durationMs: number;
  }) => {
    db.run("update test_runs set ended_at = ?, status = ?, exit_code = ?, duration_ms = ? where id = ?", [
      endedAt,
      status,
      exitCode,
      durationMs,
      runId
    ]);
  };

  const getSuiteMap = (config: EffectiveProjectConfig) => {
    return new Map(config.testSuites.map((s) => [s.id, s] as const));
  };

  const emitRun = (run: TestRunSummary) => {
    broadcastEvent({ type: "run", run });
  };

  const emitLog = (runId: string, suiteId: string, stream: "stdout" | "stderr", chunk: string) => {
    broadcastEvent({ type: "log", runId, suiteId, stream, chunk, ts: nowIso() });
  };

  const buildRunSummary = (row: {
    id: string;
    suiteId: string;
    laneId: string | null;
    status: TestRunStatus;
    exitCode: number | null;
    durationMs: number | null;
    startedAt: string;
    endedAt: string | null;
    logPath: string;
  }, suiteNameMap: Map<string, string>): TestRunSummary => ({
    id: row.id,
    suiteId: row.suiteId,
    suiteName: suiteNameMap.get(row.suiteId) ?? row.suiteId,
    laneId: row.laneId,
    status: row.status,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    logPath: row.logPath
  });

  const getRunById = (runId: string, suiteNameMap: Map<string, string>): TestRunSummary | null => {
    const row = db.get<{
      id: string;
      suiteId: string;
      laneId: string | null;
      status: TestRunStatus;
      exitCode: number | null;
      durationMs: number | null;
      startedAt: string;
      endedAt: string | null;
      logPath: string;
    }>(
      `
        select
          id as id,
          suite_key as suiteId,
          lane_id as laneId,
          status as status,
          exit_code as exitCode,
          duration_ms as durationMs,
          started_at as startedAt,
          ended_at as endedAt,
          log_path as logPath
        from test_runs
        where id = ?
        limit 1
      `,
      [runId]
    );

    if (!row) return null;
    return buildRunSummary(row, suiteNameMap);
  };

  const finishRun = (entry: ActiveRunEntry, exitCode: number | null) => {
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }

    const endedAt = nowIso();
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(entry.startedAt));

    let status: TestRunStatus;
    if (entry.stopIntent === "timed_out") {
      status = "timed_out";
    } else if (entry.stopIntent === "canceled") {
      status = "canceled";
    } else {
      status = exitCode === 0 ? "passed" : "failed";
    }

    try {
      entry.logStream.write(`\n# test run ended at ${endedAt} status=${status} exit=${exitCode ?? "null"}\n`);
    } catch {
      // ignore
    }

    try {
      entry.logStream.end();
    } catch {
      // ignore
    }

    persistRunEnd({ runId: entry.runId, status, exitCode, endedAt, durationMs });

    const suiteMap = new Map<string, string>([[entry.suiteId, entry.suiteName]]);
    const summary = getRunById(entry.runId, suiteMap);
    if (summary) emitRun(summary);

    activeRuns.delete(entry.runId);

    logger.info("tests.run.finished", {
      runId: entry.runId,
      suiteId: entry.suiteId,
      status,
      exitCode,
      durationMs
    });
  };

  const spawnSuite = (suite: TestSuiteDefinition): TestRunSummary => {
    const runId = randomUUID();
    const startedAt = nowIso();
    const cwd = path.isAbsolute(suite.cwd) ? suite.cwd : path.join(projectRoot, suite.cwd);

    if (!suite.command.length) {
      throw new Error(`Suite '${suite.id}' has an empty command`);
    }

    const suiteDir = path.join(testLogsDir, suite.id);
    fs.mkdirSync(suiteDir, { recursive: true });
    const logPath = path.join(suiteDir, `${runId}.log`);
    const logStream = fs.createWriteStream(logPath, { flags: "a" });

    logStream.write(`\n# test run start ${startedAt} cmd=${JSON.stringify(suite.command)} cwd=${cwd}\n`);

    const child: ChildProcessByStdio<null, Readable, Readable> = spawn(suite.command[0]!, suite.command.slice(1), {
      cwd,
      env: { ...process.env, ...suite.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const entry: ActiveRunEntry = {
      runId,
      suiteId: suite.id,
      suiteName: suite.name,
      child,
      startedAt,
      logPath,
      logStream,
      timeoutTimer: null,
      killTimer: null,
      stopIntent: null
    };

    activeRuns.set(runId, entry);
    persistRunStart(runId, suite.id, startedAt, logPath);

    const summary: TestRunSummary = {
      id: runId,
      suiteId: suite.id,
      suiteName: suite.name,
      laneId: null,
      status: "running",
      exitCode: null,
      durationMs: null,
      startedAt,
      endedAt: null,
      logPath
    };
    emitRun(summary);

    const onChunk = (stream: "stdout" | "stderr", chunk: string) => {
      try {
        logStream.write(chunk);
      } catch {
        // ignore
      }
      emitLog(runId, suite.id, stream, chunk);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => onChunk("stdout", chunk));
    child.stderr.on("data", (chunk: string) => onChunk("stderr", chunk));

    child.on("error", (err) => {
      try {
        logStream.write(`\n[test run error] ${String(err)}\n`);
      } catch {
        // ignore
      }
    });

    child.on("close", (code) => {
      finishRun(entry, code ?? null);
    });

    if (suite.timeoutMs && suite.timeoutMs > 0) {
      entry.timeoutTimer = setTimeout(() => {
        entry.stopIntent = "timed_out";
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }

        entry.killTimer = setTimeout(() => {
          if (activeRuns.has(runId)) {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, 2000);
      }, suite.timeoutMs);
    }

    logger.info("tests.run.started", {
      runId,
      suiteId: suite.id,
      cwd,
      command: suite.command
    });

    return summary;
  };

  return {
    listSuites(): TestSuiteDefinition[] {
      return projectConfigService.get().effective.testSuites;
    },

    run(arg: RunTestSuiteArgs): TestRunSummary {
      const config = projectConfigService.getExecutableConfig();
      const suite = config.testSuites.find((s) => s.id === arg.suiteId);
      if (!suite) {
        throw new Error(`Suite not found: ${arg.suiteId}`);
      }

      const existing = Array.from(activeRuns.values()).find((entry) => entry.suiteId === suite.id);
      if (existing) {
        const summary = getRunById(existing.runId, new Map([[suite.id, suite.name]]));
        if (summary) return summary;
      }

      return spawnSuite(suite);
    },

    stop(arg: StopTestRunArgs): void {
      const entry = activeRuns.get(arg.runId);
      if (!entry) return;

      entry.stopIntent = "canceled";
      try {
        entry.child.kill("SIGTERM");
      } catch {
        // ignore
      }

      if (entry.killTimer) clearTimeout(entry.killTimer);
      entry.killTimer = setTimeout(() => {
        if (!activeRuns.has(arg.runId)) return;
        try {
          entry.child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 2000);
    },

    listRuns(arg: ListTestRunsArgs = {}): TestRunSummary[] {
      const suites = projectConfigService.get().effective.testSuites;
      const suiteNameMap = new Map(suites.map((s) => [s.id, s.name] as const));

      const where: string[] = ["project_id = ?"];
      const params: Array<string | number> = [projectId];

      if (arg.suiteId) {
        where.push("suite_key = ?");
        params.push(arg.suiteId);
      }

      const limit = typeof arg.limit === "number" ? Math.max(1, Math.min(500, Math.floor(arg.limit))) : 100;
      params.push(limit);

      const rows = db.all<{
        id: string;
        suiteId: string;
        laneId: string | null;
        status: TestRunStatus;
        exitCode: number | null;
        durationMs: number | null;
        startedAt: string;
        endedAt: string | null;
        logPath: string;
      }>(
        `
          select
            id as id,
            suite_key as suiteId,
            lane_id as laneId,
            status as status,
            exit_code as exitCode,
            duration_ms as durationMs,
            started_at as startedAt,
            ended_at as endedAt,
            log_path as logPath
          from test_runs
          where ${where.join(" and ")}
          order by started_at desc
          limit ?
        `,
        params
      );

      return rows.map((row) => buildRunSummary(row, suiteNameMap));
    },

    getLogTail(arg: GetTestLogTailArgs): string {
      const run = db.get<{ logPath: string }>("select log_path as logPath from test_runs where id = ? limit 1", [arg.runId]);
      if (!run?.logPath) return "";
      return readTail(run.logPath, clampMaxBytes(arg.maxBytes, 180_000));
    },

    disposeAll() {
      for (const entry of activeRuns.values()) {
        if (entry.timeoutTimer) {
          clearTimeout(entry.timeoutTimer);
          entry.timeoutTimer = null;
        }
        if (entry.killTimer) {
          clearTimeout(entry.killTimer);
          entry.killTimer = null;
        }
        entry.stopIntent = "canceled";
        try {
          entry.child.kill("SIGKILL");
        } catch {
          // ignore
        }
        try {
          entry.logStream.end();
        } catch {
          // ignore
        }
      }
      activeRuns.clear();
    }
  };
}
