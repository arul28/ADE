import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acquirePiSessionLease, piSessionCreationLeaseTarget, piSessionLeaseIsHeld } from "./piSessionLease";
import {
  piSessionCouldBelongToTerminal,
  piSessionIsAdoptableByTerminal,
  readPiSessionOwner,
  recordPiSessionOwner,
} from "./piSessionOwnership";
import {
  classifyPiSessionFile,
  listPiSessionFilesForCwd,
  piSessionRootForEnvironment,
  piSessionStoreForEnvironment,
  repositoryOverridesPiSessionDir,
  resolvePiSessionFile,
} from "./piSessionStore";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeSession(): { root: string; file: string; id: string; cwd: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-lease-"));
  tempRoots.push(root);
  const cwd = path.join(root, "worktree");
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(path.join(sessionRoot, "encoded"), { recursive: true });
  const id = "019fd86d-f40d-76c6-a194-d5ba030cbad3";
  const file = path.join(sessionRoot, "encoded", `2026-04-01T00-00-00-000Z_${id}.jsonl`);
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
    expect(resolvePiSessionFile({ cwd: session.cwd, sessionId: session.id, sessionRoot: path.join(session.root, "sessions") })).toBe(canonicalFile);
    expect(resolvePiSessionFile({ cwd: session.cwd, sessionId: "", sessionFile: session.file })).toBe(canonicalFile);

    const sdk = acquirePiSessionLease({ sessionFile: session.file, owner: "sdk", ownerId: "chat-1" });
    expect(() => acquirePiSessionLease({ sessionFile: session.file, owner: "cli", ownerId: "pty-1" })).toThrow(/already owned/iu);

    sdk.release();
    const cli = acquirePiSessionLease({ sessionFile: session.file, owner: "cli", ownerId: "pty-1" });
    expect(fs.existsSync(`${session.file}.ade-lease`)).toBe(true);
    cli.release();
    expect(fs.existsSync(`${session.file}.ade-lease`)).toBe(false);
  });

  // Pi buffers a new session in memory and only writes the JSONL file on the
  // first assistant message, so ADE has to take ownership of a path that does
  // not exist yet. Requiring the file up front made every new Pi chat fail
  // with "Pi SDK worker returned a session outside the authorized native
  // session directory".
  it("accepts a session Pi has named but not yet written", () => {
    const session = makeSession();
    const sessionRoot = path.join(session.root, "sessions");
    const planned = path.join(sessionRoot, "encoded", "2026-04-02T00-00-00-000Z_pending.jsonl");

    expect(resolvePiSessionFile({ cwd: session.cwd, sessionId: "", sessionFile: planned, sessionRoot })).toBeNull();
    // Canonicalized through the deepest directory that already exists, so the
    // eventual `.ade-lease` sidecar cannot be created twice for one JSONL file
    // under macOS aliases such as /var -> /private/var.
    expect(classifyPiSessionFile({ filePath: planned, cwd: session.cwd, sessionRoot })).toEqual({
      state: "pending",
      filePath: path.join(fs.realpathSync(path.dirname(planned)), path.basename(planned)),
    });
    expect(classifyPiSessionFile({ filePath: session.file, cwd: session.cwd, sessionId: session.id, sessionRoot })).toEqual({
      state: "authorized",
      filePath: fs.realpathSync(session.file),
    });
  });

  // ADE mis-assigned a days-old session to a terminal once, stored it as that
  // terminal's resume target, and then reopened it on every relaunch — the
  // user's typed message went into a stranger's transcript. A terminal creates
  // its own session, so one that predates the terminal cannot be its own.
  it("refuses a resume target older than the terminal that would open it", () => {
    const session = makeSession();
    const startedAt = "2026-08-10T17:44:00.000Z";

    // Four days older than the terminal — the exact shape ADE mis-assigned.
    const stale = path.join(path.dirname(session.file), "stale.jsonl");
    fs.writeFileSync(stale, `${JSON.stringify({
      type: "session",
      id: "019fd7c4-4d85-7b4d-8adc-86766db98403",
      cwd: session.cwd,
      timestamp: "2026-08-06T15:49:54.181Z",
    })}\n`);
    expect(piSessionCouldBelongToTerminal({ sessionFile: stale, terminalStartedAt: startedAt })).toBe(false);

    const own = path.join(path.dirname(session.file), "own.jsonl");
    fs.writeFileSync(own, `${JSON.stringify({
      type: "session",
      id: "own-session",
      cwd: session.cwd,
      timestamp: "2026-08-10T17:44:03.000Z",
    })}\n`);
    expect(piSessionCouldBelongToTerminal({ sessionFile: own, terminalStartedAt: startedAt })).toBe(true);

    // Pi can write its header a moment before ADE's row; the grace covers that.
    const early = path.join(path.dirname(session.file), "early.jsonl");
    fs.writeFileSync(early, `${JSON.stringify({
      type: "session",
      id: "early-session",
      cwd: session.cwd,
      timestamp: "2026-08-10T17:43:30.000Z",
    })}\n`);
    expect(piSessionCouldBelongToTerminal({ sessionFile: early, terminalStartedAt: startedAt })).toBe(true);

    // Nothing to compare against must never block a resume.
    expect(piSessionCouldBelongToTerminal({ sessionFile: own, terminalStartedAt: null })).toBe(true);
    expect(piSessionCouldBelongToTerminal({ sessionFile: "/nope.jsonl", terminalStartedAt: startedAt })).toBe(true);
  });

  // Chat and the tracked CLI share one native store, and two sessions created
  // minutes apart are indistinguishable by time — a terminal opened an ADE
  // chat's session and replayed its transcript. Ownership has to be recorded,
  // not inferred.
  it("keeps a terminal from adopting a session another ADE surface owns", () => {
    const session = makeSession();
    const chatOwned = path.join(path.dirname(session.file), "chat.jsonl");
    fs.writeFileSync(chatOwned, "{}\n");

    // Unowned: a `pi` run started outside ADE stays adoptable.
    expect(piSessionIsAdoptableByTerminal(chatOwned, "terminal-1")).toBe(true);

    recordPiSessionOwner({ sessionFile: chatOwned, owner: "sdk", ownerSessionId: "chat-61fa4009" });
    expect(readPiSessionOwner(chatOwned)).toEqual({ owner: "sdk", ownerSessionId: "chat-61fa4009" });
    expect(piSessionIsAdoptableByTerminal(chatOwned, "terminal-1")).toBe(false);

    const mine = path.join(path.dirname(session.file), "mine.jsonl");
    fs.writeFileSync(mine, "{}\n");
    recordPiSessionOwner({ sessionFile: mine, owner: "cli", ownerSessionId: "terminal-1" });
    expect(piSessionIsAdoptableByTerminal(mine, "terminal-1")).toBe(true);
    // Another terminal's session is not this terminal's to reopen either.
    expect(piSessionIsAdoptableByTerminal(mine, "terminal-2")).toBe(false);

    // Ownership survives the lease being released — that is the whole point.
    const lease = acquirePiSessionLease({ sessionFile: mine, owner: "cli", ownerId: "pty-1" });
    lease.release();
    expect(readPiSessionOwner(mine)).toEqual({ owner: "cli", ownerSessionId: "terminal-1" });
  });

  it("refuses planned session paths that leave the authorized store", () => {
    const session = makeSession();
    const sessionRoot = path.join(session.root, "sessions");
    const escape = path.join(session.root, "elsewhere");
    fs.mkdirSync(escape, { recursive: true });
    fs.symlinkSync(escape, path.join(sessionRoot, "linked"), "dir");

    expect(classifyPiSessionFile({
      filePath: path.join(session.root, "outside.jsonl"),
      cwd: session.cwd,
      sessionRoot,
    }).state).toBe("rejected");
    // Lexically inside the store, actually outside it.
    expect(classifyPiSessionFile({
      filePath: path.join(sessionRoot, "linked", "new.jsonl"),
      cwd: session.cwd,
      sessionRoot,
    }).state).toBe("rejected");
    expect(classifyPiSessionFile({ filePath: "relative.jsonl", cwd: session.cwd, sessionRoot }).state).toBe("rejected");
    // Written, but for a different working directory.
    expect(classifyPiSessionFile({
      filePath: session.file,
      cwd: path.join(session.root, "other-worktree"),
      sessionRoot,
    }).state).toBe("rejected");
  });

  // Pi fixes a session's file name when it creates the session, so two chats
  // in one working directory get distinct paths and can both be owned at once.
  // Making them share a directory-wide token until the first assistant message
  // would stop a second Pi chat in a lane from starting at all.
  it("owns two not-yet-written sessions for one working directory independently", () => {
    const session = makeSession();
    const sessionRoot = path.join(session.root, "sessions");
    const first = path.join(sessionRoot, "encoded", "2026-04-02T00-00-00-000Z_a.jsonl");
    const second = path.join(sessionRoot, "encoded", "2026-04-02T00-00-01-000Z_b.jsonl");

    const leaseA = acquirePiSessionLease({ sessionFile: first, owner: "sdk", ownerId: "chat-a" });
    const leaseB = acquirePiSessionLease({ sessionFile: second, owner: "sdk", ownerId: "chat-b" });
    expect(piSessionLeaseIsHeld(first)).toBe(true);
    expect(piSessionLeaseIsHeld(second)).toBe(true);
    expect(piSessionLeaseIsHeld(path.join(sessionRoot, "encoded", "unleased.jsonl"))).toBe(false);
    expect(() => acquirePiSessionLease({ sessionFile: first, owner: "cli", ownerId: "pty-1" })).toThrow(/already owned/iu);

    leaseA.release();
    leaseB.release();
    expect(piSessionLeaseIsHeld(first)).toBe(false);
  });

  // The store root is shared by every project on the machine, so a single
  // root-wide creation token would make one lane's first Pi session block
  // every other lane's.
  it("scopes the session-creation lease to a working directory", () => {
    const session = makeSession();
    const sessionRoot = path.join(session.root, "sessions");
    const first = piSessionCreationLeaseTarget(sessionRoot, session.cwd);
    const second = piSessionCreationLeaseTarget(sessionRoot, path.join(session.root, "other-worktree"));

    expect(first).not.toBe(second);
    expect(path.dirname(first)).toBe(path.resolve(sessionRoot));
    expect(piSessionCreationLeaseTarget(sessionRoot, `${session.cwd}${path.sep}`)).toBe(first);

    const lease = acquirePiSessionLease({ sessionFile: first, owner: "sdk", ownerId: "chat-1" });
    const other = acquirePiSessionLease({ sessionFile: second, owner: "cli", ownerId: "pty-1" });
    expect(() => acquirePiSessionLease({ sessionFile: first, owner: "cli", ownerId: "pty-2" })).toThrow(/already owned/iu);
    lease.release();
    other.release();
  });

  // Pi nests per cwd only when it is told nothing; an explicit directory is
  // used flat. Handing Pi the store root would write files where Pi's own
  // subdirectory-only discovery can never read them back.
  it("separates the authorized store root from the directory Pi writes into", () => {
    const session = makeSession();
    const sessionRoot = path.join(session.root, "sessions");

    expect(piSessionStoreForEnvironment({ HOME: session.root })).toEqual({
      root: path.join(session.root, ".pi", "agent", "sessions"),
      storageDir: null,
    });
    expect(piSessionStoreForEnvironment({ HOME: session.root, PI_CODING_AGENT_SESSION_DIR: sessionRoot })).toEqual({
      root: path.resolve(sessionRoot),
      storageDir: path.resolve(sessionRoot),
    });

    const agentDir = path.join(session.root, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    // `sessionDir` is Pi's own settings key, not ADE's field name.
    fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: sessionRoot }));
    expect(piSessionStoreForEnvironment({ HOME: session.root, PI_CODING_AGENT_DIR: agentDir })).toEqual({
      root: path.resolve(sessionRoot),
      storageDir: path.resolve(sessionRoot),
    });
    // The environment variable still wins, exactly as it does for Pi's CLI.
    expect(piSessionStoreForEnvironment({
      HOME: session.root,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: session.root,
    }).root).toBe(path.resolve(session.root));
  });

  it("honors the user-selected native Pi session directory", () => {
    const session = makeSession();
    const sessionRoot = path.join(session.root, "sessions");
    expect(piSessionRootForEnvironment({
      HOME: session.root,
      PI_CODING_AGENT_SESSION_DIR: sessionRoot,
    })).toBe(path.resolve(sessionRoot));
    expect(resolvePiSessionFile({
      cwd: session.cwd,
      sessionId: session.id,
      env: { HOME: session.root, PI_CODING_AGENT_SESSION_DIR: sessionRoot },
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
    expect(resolvePiSessionFile({ cwd: otherCwd, sessionId: session.id, sessionRoot: path.join(session.root, "sessions") })).toBeNull();
    expect(resolvePiSessionFile({ cwd: otherCwd, sessionId: "", sessionFile: session.file, sessionRoot: path.join(session.root, "sessions") })).toBeNull();
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
      sessionRoot: path.join(session.root, "sessions"),
    })).toBeNull();
    expect(resolvePiSessionFile({
      cwd: session.cwd,
      sessionId: missingCwdId,
      sessionRoot: path.join(session.root, "sessions"),
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
      sessionRoot: path.join(session.root, "sessions"),
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
        // Windows child processes need these: a Node spawned without SystemRoot
        // fails to initialize before it ever reaches the lease code.
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
        ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
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

describe("pi session store trust boundary", () => {
  function makeCheckout(settings: unknown): { home: string; cwd: string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-trust-"));
    tempRoots.push(home);
    const cwd = path.join(home, "checkout");
    fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
    return { home, cwd };
  }

  // Pi's own SettingsManager merges a checkout's `.pi/settings.json` over the
  // profile. ADE opens repositories the user has not vouched for, so honouring
  // that here would let any cloned repo point ADE's session store — the thing
  // that decides which files ADE authorizes and leases — at a directory the
  // repo controls.
  it("never lets a checkout redirect the session store", () => {
    const { home, cwd } = makeCheckout({ sessionDir: "./pi-sessions" });
    const store = piSessionStoreForEnvironment({ HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv);

    expect(store.root.startsWith(path.join(home, ".pi", "agent"))).toBe(true);
    expect(store.root).not.toContain("pi-sessions");
    expect(repositoryOverridesPiSessionDir(cwd)).toBe(true);
  });

  it("reports no override for a checkout that does not ask for one", () => {
    const { cwd } = makeCheckout({ theme: "dark" });
    expect(repositoryOverridesPiSessionDir(cwd)).toBe(false);
  });

  // The profile's own settings.json IS honoured — that file is the user's.
  it("honours the session directory the user set in their own profile", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pi-profile-"));
    tempRoots.push(home);
    const configured = path.join(home, "elsewhere", "sessions");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".pi", "agent", "settings.json"),
      JSON.stringify({ sessionDir: configured }),
    );

    const store = piSessionStoreForEnvironment({ HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv);
    expect(store.root).toBe(path.resolve(configured));
  });
});
