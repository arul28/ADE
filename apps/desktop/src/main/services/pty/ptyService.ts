import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IPty, IWindowsPtyForkOptions } from "node-pty";
import type * as ptyNs from "node-pty";
import type { Logger } from "../logging/logger";
import type { createLaneService } from "../lanes/laneService";
import type { createSessionService } from "../sessions/sessionService";
import { runGit } from "../git/git";
import type { PtyDataEvent, PtyExitEvent, PtyCreateArgs, PtyCreateResult, TerminalSessionStatus } from "../../../shared/types";

type PtyEntry = {
  pty: IPty;
  laneId: string;
  sessionId: string;
  transcriptPath: string;
  transcriptStream: fs.WriteStream;
  lastPreviewWriteAt: number;
  disposed: boolean;
};

function resolveShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: [] };
  }
  const shell = process.env.SHELL && process.env.SHELL.trim().length ? process.env.SHELL : "/bin/zsh";
  return { file: shell, args: [] };
}

function clampDims(cols: number, rows: number): { cols: number; rows: number } {
  const safeCols = Number.isFinite(cols) ? Math.max(20, Math.min(400, Math.floor(cols))) : 80;
  const safeRows = Number.isFinite(rows) ? Math.max(6, Math.min(200, Math.floor(rows))) : 24;
  return { cols: safeCols, rows: safeRows };
}

function statusFromExit(exitCode: number | null): TerminalSessionStatus {
  if (exitCode == null) return "completed";
  if (exitCode === 0) return "completed";
  return "failed";
}

export function createPtyService({
  projectRoot,
  transcriptsDir,
  laneService,
  sessionService,
  logger,
  broadcastData,
  broadcastExit,
  onSessionEnded,
  loadPty
}: {
  projectRoot: string;
  transcriptsDir: string;
  laneService: ReturnType<typeof createLaneService>;
  sessionService: ReturnType<typeof createSessionService>;
  logger: Logger;
  broadcastData: (ev: PtyDataEvent) => void;
  broadcastExit: (ev: PtyExitEvent) => void;
  onSessionEnded?: (args: { laneId: string; sessionId: string; exitCode: number | null }) => void;
  loadPty: () => typeof ptyNs;
}) {
  const ptys = new Map<string, PtyEntry>();

  const safeTranscriptPathFor = (sessionId: string) => path.join(transcriptsDir, `${sessionId}.log`);

  const computeHeadShaBestEffort = async (worktreePath: string): Promise<string | null> => {
    const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 6_000 });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length ? sha : null;
  };

  const closeEntry = (ptyId: string, exitCode: number | null) => {
    const entry = ptys.get(ptyId);
    if (!entry) return;
    if (entry.disposed) return;
    entry.disposed = true;

    try {
      entry.transcriptStream.end();
    } catch {
      // ignore
    }

    const endedAt = new Date().toISOString();
    const status = statusFromExit(exitCode);
    sessionService.end({ sessionId: entry.sessionId, endedAt, exitCode, status });

    // Best-effort head SHA at end; never block exit.
    Promise.resolve()
      .then(async () => {
        const { worktreePath } = laneService.getLaneBaseAndBranch(entry.laneId);
        const sha = await computeHeadShaBestEffort(worktreePath);
        if (sha) sessionService.setHeadShaEnd(entry.sessionId, sha);
      })
      .catch(() => {})
      .finally(() => {
        try {
          onSessionEnded?.({ laneId: entry.laneId, sessionId: entry.sessionId, exitCode });
        } catch {
          // ignore
        }
      });

    broadcastExit({ ptyId, sessionId: entry.sessionId, exitCode });
    ptys.delete(ptyId);
  };

  const writeTranscript = (entry: PtyEntry, data: string) => {
    try {
      entry.transcriptStream.write(data);
    } catch {
      // ignore
    }
  };

  const updatePreviewThrottled = (entry: PtyEntry, chunk: string) => {
    const now = Date.now();
    if (now - entry.lastPreviewWriteAt < 900) return;
    entry.lastPreviewWriteAt = now;
    const trimmed = chunk.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
    const last = trimmed[trimmed.length - 1];
    if (!last) return;
    sessionService.setLastOutputPreview(entry.sessionId, last.slice(0, 220));
  };

  return {
    async create(args: PtyCreateArgs): Promise<PtyCreateResult> {
      const { laneId, title } = args;
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const { cols, rows } = clampDims(args.cols, args.rows);

      const ptyId = randomUUID();
      const sessionId = randomUUID();
      const startedAt = new Date().toISOString();
      const transcriptPath = safeTranscriptPathFor(sessionId);

      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      const transcriptStream = fs.createWriteStream(transcriptPath, { flags: "a" });

      sessionService.create({ sessionId, laneId, ptyId, title, startedAt, transcriptPath });

      // Best-effort head SHA at start; do not block terminal creation.
      Promise.resolve()
        .then(async () => {
          const sha = await computeHeadShaBestEffort(worktreePath);
          if (sha) sessionService.setHeadShaStart(sessionId, sha);
        })
        .catch(() => {});

      const { file: shellFile, args: shellArgs } = resolveShell();
      let pty: IPty;
      try {
        const ptyLib = loadPty();
        const opts: IWindowsPtyForkOptions = {
          name: "xterm-256color",
          cols,
          rows,
          cwd: worktreePath,
          env: { ...process.env }
        };
        pty = ptyLib.spawn(shellFile, shellArgs, opts);
      } catch (err) {
        logger.error("pty.spawn_failed", { ptyId, sessionId, err: String(err) });
        try {
          transcriptStream.end();
        } catch {
          // ignore
        }
        sessionService.end({ sessionId, endedAt: new Date().toISOString(), exitCode: null, status: "failed" });
        broadcastExit({ ptyId, sessionId, exitCode: null });
        throw err;
      }

      const entry: PtyEntry = {
        pty,
        laneId,
        sessionId,
        transcriptPath,
        transcriptStream,
        lastPreviewWriteAt: 0,
        disposed: false
      };
      ptys.set(ptyId, entry);

      pty.onData((data) => {
        writeTranscript(entry, data);
        updatePreviewThrottled(entry, data);
        broadcastData({ ptyId, sessionId, data });
      });

      pty.onExit(({ exitCode }) => {
        logger.info("pty.exit", { ptyId, sessionId, exitCode });
        closeEntry(ptyId, exitCode ?? null);
      });

      logger.info("pty.create", { ptyId, sessionId, laneId, cwd: worktreePath });

      return { ptyId, sessionId };
    },

    write({ ptyId, data }: { ptyId: string; data: string }): void {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      try {
        entry.pty.write(data);
      } catch (err) {
        logger.warn("pty.write_failed", { ptyId, err: String(err) });
      }
    },

    resize({ ptyId, cols, rows }: { ptyId: string; cols: number; rows: number }): void {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      const safe = clampDims(cols, rows);
      try {
        entry.pty.resize(safe.cols, safe.rows);
      } catch (err) {
        logger.warn("pty.resize_failed", { ptyId, err: String(err) });
      }
    },

    dispose({ ptyId }: { ptyId: string }): void {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      if (entry.disposed) return;
      entry.disposed = true;
      try {
        entry.transcriptStream.end();
      } catch {
        // ignore
      }
      try {
        entry.pty.kill();
      } catch {
        // ignore
      }
      const endedAt = new Date().toISOString();
      sessionService.end({ sessionId: entry.sessionId, endedAt, exitCode: null, status: "disposed" });
      broadcastExit({ ptyId, sessionId: entry.sessionId, exitCode: null });
      ptys.delete(ptyId);

      try {
        onSessionEnded?.({ laneId: entry.laneId, sessionId: entry.sessionId, exitCode: null });
      } catch {
        // ignore
      }
    },

    disposeAll(): void {
      for (const ptyId of [...ptys.keys()]) {
        try {
          this.dispose({ ptyId });
        } catch {
          // ignore
        }
      }
    }
  };
}
