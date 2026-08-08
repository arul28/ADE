import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquirePiSessionLease,
  listPiSessionFilesForCwd,
  piSessionDirectoryForEnvironment,
  resolvePiSessionFile,
} from "./piSessionLease";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeSession(): { root: string; file: string; id: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-lease-"));
  tempRoots.push(root);
  const cwd = path.join(root, "worktree");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(path.join(sessionDir, "encoded"), { recursive: true });
  const id = "019fd86d-f40d-76c6-a194-d5ba030cbad3";
  const file = path.join(sessionDir, "encoded", `2026-04-01T00-00-00-000Z_${id}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: "session", id, cwd, timestamp: new Date().toISOString() })}\n`);
  return { root, file, id, cwd };
}

async function waitForChildOutput(child: ChildProcess, marker: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for child marker ${marker}. Output: ${output}`)), 10_000);
    const onData = (chunk: Buffer | string) => {
      output += String(chunk);
      if (!output.includes(marker)) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolve();
    };
    child.stdout?.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (output.includes(marker)) return;
      clearTimeout(timer);
      reject(new Error(`Lease child exited before ${marker}: ${code ?? signal ?? "unknown"}. Output: ${output}`));
    });
  });
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("Pi native session leases", () => {
  it("resolves and excludes concurrent SDK/CLI writers", () => {
    const session = makeSession();
    const canonicalFile = fs.realpathSync(session.file);
    expect(resolvePiSessionFile({ cwd: session.cwd, sessionId: session.id, sessionDir: path.join(session.root, "sessions") })).toBe(canonicalFile);
    expect(resolvePiSessionFile({ cwd: session.cwd, sessionId: "", sessionFile: session.file })).toBe(canonicalFile);

    const sdk = acquirePiSessionLease({ sessionFile: session.file, owner: "sdk", ownerId: "chat-1" });
    expect(() => acquirePiSessionLease({ sessionFile: session.file, owner: "cli", ownerId: "pty-1" })).toThrow(/already owned/iu);

    sdk.release();
    const cli = acquirePiSessionLease({ sessionFile: session.file, owner: "cli", ownerId: "pty-1" });
    expect(fs.existsSync(`${session.file}.ade-lease`)).toBe(true);
    cli.release();
    expect(fs.existsSync(`${session.file}.ade-lease`)).toBe(false);
  });

  it("honors the user-selected native Pi session directory", () => {
    const session = makeSession();
    const sessionDir = path.join(session.root, "sessions");
    expect(piSessionDirectoryForEnvironment({
      HOME: session.root,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
    })).toBe(path.resolve(sessionDir));
    expect(resolvePiSessionFile({
      cwd: session.cwd,
      sessionId: session.id,
      env: { HOME: session.root, PI_CODING_AGENT_SESSION_DIR: sessionDir },
    })).toBe(fs.realpathSync(session.file));
  });

  it("cleans a dead writer sidecar but never overwrites a live one", () => {
    const session = makeSession();
    const lockPath = `${session.file}.ade-lease`;
    fs.writeFileSync(lockPath, `${JSON.stringify({
      version: 1,
      token: "dead",
      owner: "sdk",
      ownerId: "old",
      pid: 999_999_999,
      acquiredAt: new Date().toISOString(),
      sessionFile: session.file,
    })}\n`);

    const lease = acquirePiSessionLease({ sessionFile: session.file, owner: "cli", ownerId: "pty-2" });
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).not.toBe("dead");
    lease.release();
  });

  it("uses the process start identity to distinguish a reused PID", () => {
    const session = makeSession();
    const lockPath = `${session.file}.ade-lease`;
    fs.writeFileSync(lockPath, `${JSON.stringify({
      version: 2,
      token: "reused-pid",
      owner: "sdk",
      ownerId: "old-runtime",
      pid: process.pid,
      processStartedAt: "2026-01-01T00:00:00.000Z",
      acquiredAt: new Date().toISOString(),
      sessionFile: session.file,
    })}\n`);

    const lease = acquirePiSessionLease({
      sessionFile: session.file,
      owner: "cli",
      ownerId: "new-runtime",
      isProcessIdentityLive: (_pid, startedAt) => startedAt === "2026-08-06T00:00:00.000Z",
    });
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).not.toBe("reused-pid");
    lease.release();

    fs.writeFileSync(lockPath, `${JSON.stringify({
      version: 2,
      token: "same-incarnation",
      owner: "sdk",
      ownerId: "live-runtime",
      pid: process.pid,
      processStartedAt: "2026-08-06T00:00:00.000Z",
      acquiredAt: new Date().toISOString(),
      sessionFile: session.file,
    })}\n`);
    expect(() => acquirePiSessionLease({
      sessionFile: session.file,
      owner: "cli",
      ownerId: "blocked-runtime",
      isProcessIdentityLive: (_pid, startedAt) => startedAt === "2026-08-06T00:00:00.000Z",
    })).toThrow(/already owned/iu);
    fs.unlinkSync(lockPath);
  });

  it("does not release a replacement sidecar owned by another writer", () => {
    const session = makeSession();
    const lockPath = `${session.file}.ade-lease`;
    const lease = acquirePiSessionLease({ sessionFile: session.file, owner: "sdk", ownerId: "chat-lease" });
    const replacement = {
      version: 1 as const,
      token: "replacement",
      owner: "cli" as const,
      ownerId: "external-cli",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      sessionFile: session.file,
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(replacement)}\n`);

    lease.release();
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ token: "replacement", owner: "cli" });
    fs.unlinkSync(lockPath);
  });

  it("rejects a session id whose header belongs to another cwd", () => {
    const session = makeSession();
    const otherCwd = path.join(session.root, "other");
    expect(resolvePiSessionFile({ cwd: otherCwd, sessionId: session.id, sessionDir: path.join(session.root, "sessions") })).toBeNull();
    expect(resolvePiSessionFile({ cwd: otherCwd, sessionId: "", sessionFile: session.file, sessionDir: path.join(session.root, "sessions") })).toBeNull();
  });

  it("rejects native headers with a missing cwd at both explicit and id lookup boundaries", () => {
    const session = makeSession();
    const missingCwdId = "019fd86d-f40d-76c6-a194-d5ba030cbad4";
    const missingCwdFile = path.join(session.root, "sessions", "encoded", `${missingCwdId}.jsonl`);
    fs.writeFileSync(missingCwdFile, `${JSON.stringify({ type: "session", id: missingCwdId })}\n`);

    expect(resolvePiSessionFile({
      cwd: session.cwd,
      sessionId: missingCwdId,
      sessionFile: missingCwdFile,
      sessionDir: path.join(session.root, "sessions"),
    })).toBeNull();
    expect(resolvePiSessionFile({
      cwd: session.cwd,
      sessionId: missingCwdId,
      sessionDir: path.join(session.root, "sessions"),
    })).toBeNull();
  });

  it("snapshots only exact-cwd native sessions for implicit PTY ownership", () => {
    const session = makeSession();
    const foreignCwd = path.join(session.root, "foreign");
    const foreignId = "019fd86d-f40d-76c6-a194-d5ba030cbad5";
    const foreignFile = path.join(session.root, "sessions", "encoded", `${foreignId}.jsonl`);
    fs.writeFileSync(foreignFile, `${JSON.stringify({ type: "session", id: foreignId, cwd: foreignCwd })}\n`);

    expect(listPiSessionFilesForCwd({
      cwd: session.cwd,
      sessionDir: path.join(session.root, "sessions"),
    })).toEqual([{ filePath: fs.realpathSync(session.file), id: session.id }]);
  });

  it("rejects a live lease held by another Node process and allows handoff after release", async () => {
    const session = makeSession();
    const childScript = `
      const { acquirePiSessionLease } = await import(process.env.ADE_PI_LEASE_MODULE);
      const lease = acquirePiSessionLease({ sessionFile: process.env.ADE_PI_LEASE_FILE, owner: "sdk", ownerId: "child" });
      process.stdout.write("ready\\n");
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        if (chunk.includes("release")) {
          lease.release();
          process.exit(0);
        }
      });
    `;
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      childScript,
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: session.root,
        USERPROFILE: session.root,
        ADE_PI_LEASE_MODULE: pathToFileURL(path.resolve(__dirname, "piSessionLease.ts")).href,
        ADE_PI_LEASE_FILE: session.file,
      },
    });

    try {
      await waitForChildOutput(child, "ready");
      const lockPath = `${session.file}.ade-lease`;
      const childRecord = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number; token: string };
      expect(childRecord.pid).toBe(child.pid);
      expect(() => acquirePiSessionLease({ sessionFile: session.file, owner: "cli", ownerId: "parent" })).toThrow(/already owned/iu);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toMatchObject({ pid: child.pid, token: childRecord.token });

      child.stdin?.write("release\\n");
      await waitForChildExit(child);
      const parentLease = acquirePiSessionLease({ sessionFile: session.file, owner: "cli", ownerId: "parent" });
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
      parentLease.release();
    } finally {
      if (child.exitCode == null && child.signalCode == null) {
        child.stdin?.write("release\\n");
        await waitForChildExit(child);
        if (child.exitCode == null && child.signalCode == null) child.kill();
      }
    }
  });
});
