import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  laneSlugForWorktree,
  laneUserDataPath,
  listDevUserDataFolders,
  prepareLaneUserData,
  pruneStaleDevUserData,
  removeIfStillStale,
  userDataInUse,
} from "./dev-user-data.mjs";
import {
  canAutoStartRuntime,
  computeRuntimeBuildHash,
  detachedDevRuntimeEnv,
  devRuntimeEnv,
  resolveDevAppVersion,
  runtimeMismatchReason,
  resolveDefaultDevSocketPath,
  resolveDevRuntimeStartupTimeoutMs,
  resolveNpmInvocation,
  resolveDevSocketPath,
  resolveDevSpawnInvocation,
  resolveDetachedDevInvocation,
  printDevIsolationReport,
  shutdownRuntime,
} from "./dev-shared.mjs";

test("uses a per-user Windows named pipe for the default dev runtime", () => {
  const alice = resolveDefaultDevSocketPath("win32", {
    USERDOMAIN: "ACME",
    USERNAME: "alice",
  });
  const bob = resolveDefaultDevSocketPath("win32", {
    USERDOMAIN: "ACME",
    USERNAME: "bob",
  });

  assert.match(alice, /^\\\\\.\\pipe\\ade-runtime-dev-[a-f0-9]{12}$/);
  assert.notEqual(alice, bob);
  assert.equal(resolveDevSocketPath(alice), alice);
});

test("keeps the Unix dev runtime socket unchanged", () => {
  assert.equal(resolveDefaultDevSocketPath("linux", {}), "/tmp/ade-runtime-dev.sock");
});

test("allows additional startup time for a freshly rebuilt Windows runtime", () => {
  assert.equal(resolveDevRuntimeStartupTimeoutMs("win32"), 30_000);
  assert.equal(resolveDevRuntimeStartupTimeoutMs("linux"), 10_000);
});

test("runs Windows command shims through cmd.exe without using a shell string", () => {
  assert.deepEqual(
    resolveDevSpawnInvocation(
      "npm.cmd",
      ["--prefix", "apps/desktop", "run", "dev"],
      { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      "win32",
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        "\"\"npm.cmd\" \"--prefix\" \"apps/desktop\" \"run\" \"dev\"\"",
      ],
      windowsVerbatimArguments: true,
    },
  );
});

test("runs native executables directly", () => {
  assert.deepEqual(
    resolveDevSpawnInvocation("node.exe", ["script.mjs"], {}, "win32"),
    {
      command: "node.exe",
      args: ["script.mjs"],
      windowsVerbatimArguments: false,
    },
  );
});

test("runs npm through its JavaScript entry point on Windows", () => {
  const npmCliPath = "C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\npm.js";
  assert.deepEqual(
    resolveNpmInvocation(
      ["--prefix", "apps/desktop", "run", "dev"],
      {
        platform: "win32",
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        env: {},
        pathExists: (candidate) => candidate === npmCliPath,
      },
    ),
    {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        npmCliPath,
        "--prefix",
        "apps/desktop",
        "run",
        "dev",
      ],
    },
  );
});

test("detached dev runtime does not inherit another runtime's shutdown controls", () => {
  const env = detachedDevRuntimeEnv(
    "\\\\.\\pipe\\ade-runtime-dev-test",
    "C:\\dev\\ADE",
    {
      ADE_RUNTIME_PARENT_PID: "1234",
      ADE_RUNTIME_IDLE_EXIT_MS: "5000",
      ADE_CHAT_SESSION_ID: "agent-chat",
      ADE_RUN_ID: "agent-run",
      ADE_STEP_ID: "agent-step",
      ADE_ATTEMPT_ID: "agent-attempt",
      ADE_OWNER_ID: "agent-owner",
      KEEP_ME: "yes",
    },
  );

  assert.equal(env.ADE_RUNTIME_PARENT_PID, undefined);
  // The inherited budget is dropped, not carried over. The detached dev brain
  // sets its own 20-minute default (DEV_RUNTIME_IDLE_EXIT_MS), so a caller's
  // arbitrary value can neither shorten nor lengthen its life.
  assert.equal(env.ADE_RUNTIME_IDLE_EXIT_MS, String(20 * 60 * 1000));
  assert.equal(env.ADE_CHAT_SESSION_ID, undefined);
  assert.equal(env.ADE_RUN_ID, undefined);
  assert.equal(env.ADE_STEP_ID, undefined);
  assert.equal(env.ADE_ATTEMPT_ID, undefined);
  assert.equal(env.ADE_OWNER_ID, undefined);
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.ADE_RUNTIME_SOCKET_PATH, "\\\\.\\pipe\\ade-runtime-dev-test");
});

test("dev runtime env pairs a dev-only desktop bridge socket with the runtime socket", () => {
  const posix = devRuntimeEnv("/tmp/ade-runtime-x.sock", "/dev/ADE", {});
  assert.equal(posix.ADE_RUNTIME_SOCKET_PATH, "/tmp/ade-runtime-x.sock");
  assert.equal(posix.ADE_DESKTOP_BRIDGE_SOCKET_PATH, "/tmp/ade-runtime-x-bridge.sock");

  const windows = devRuntimeEnv("\\\\.\\pipe\\ade-runtime-dev-test", "C:\\dev\\ADE", {});
  assert.equal(windows.ADE_DESKTOP_BRIDGE_SOCKET_PATH, "\\\\.\\pipe\\ade-runtime-dev-test-bridge");
});

test("detached dev runtime keeps the cto role when launched from an agent shell", () => {
  // Observed live: a dev daemon spawned from an ADE agent terminal reported
  // defaultRole "agent" because the shell's session binding survived.
  const env = detachedDevRuntimeEnv(
    "/tmp/ade-runtime-dev-test.sock",
    "/dev/ADE",
    {
      ADE_DEFAULT_ROLE: "agent",
      ADE_CHAT_SESSION_ID: "agent-chat",
      ADE_PARENT_CHAT_SESSION_ID: "parent-chat",
      ADE_SPAWN_KIND: "subagent",
      ADE_BROWSER_ACTOR_TOKEN: "token",
      ADE_LANE_ID: "lane-1",
      ADE_PROJECT_ROOT: "/dev/ADE/.ade/worktrees/lane-1",
      ADE_WORKSPACE_ROOT: "/dev/ADE/.ade/worktrees/lane-1",
      ADE_PERF_RUN_ID: "perf-run-1",
      PATH: "/usr/bin",
    },
  );

  assert.equal(env.ADE_DEFAULT_ROLE, "cto");
  assert.equal(env.ADE_CHAT_SESSION_ID, undefined);
  assert.equal(env.ADE_PARENT_CHAT_SESSION_ID, undefined);
  assert.equal(env.ADE_SPAWN_KIND, undefined);
  assert.equal(env.ADE_BROWSER_ACTOR_TOKEN, undefined);
  assert.equal(env.ADE_LANE_ID, undefined);
  assert.equal(env.ADE_WORKSPACE_ROOT, undefined);
  // The daemon's own project root wins over the agent shell's worktree.
  assert.equal(env.ADE_PROJECT_ROOT, "/dev/ADE");
  // Perf runs must still reach the daemon (chatTextProbe depends on it).
  assert.equal(env.ADE_PERF_RUN_ID, "perf-run-1");
  assert.equal(env.PATH, "/usr/bin");
});

test("graceful dev runtime cleanup sends shutdown instead of hard exit", async () => {
  const methods = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) return;
        const line = buffer.slice(0, lineEnd).trim();
        buffer = buffer.slice(lineEnd + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        methods.push(request.method);
        socket.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === "ade/initialize"
            ? { runtimeInfo: {} }
            : {},
        })}\n`);
        if (request.method === "shutdown") {
          socket.end();
          server.close();
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const closed = new Promise((resolve) => server.once("close", resolve));

  try {
    await shutdownRuntime(`tcp://127.0.0.1:${address.port}`);
    await closed;
  } finally {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }

  assert.deepEqual(methods, ["ade/initialize", "shutdown"]);
});

test("an agent shell does not see a healthy cto daemon as stale", () => {
  // Regression: `runtimeMismatchReason` read the LAUNCHER's ADE_DEFAULT_ROLE
  // ("agent" in every ADE-hosted terminal) while the daemon's env is built from
  // the SANITIZED parent env (role stripped → "cto"). Every ensureRuntime()
  // therefore reported `default role cto != agent` and restarted a healthy
  // daemon — a shutdown/respawn loop on each dev command from an agent shell.
  const agentShellEnv = {
    ADE_DEFAULT_ROLE: "agent",
    ADE_CHAT_SESSION_ID: "agent-chat",
    PATH: "/usr/bin",
  };
  const healthyDaemon = {
    version: resolveDevAppVersion(),
    buildHash: computeRuntimeBuildHash(),
    defaultRole: "cto",
    projectRoot: null,
  };

  assert.equal(
    runtimeMismatchReason(healthyDaemon, { parentEnv: agentShellEnv }),
    null,
  );
  // The daemon env and the expectation are derived from the same sanitization.
  assert.equal(
    detachedDevRuntimeEnv("/tmp/ade-runtime-dev-test.sock", null, agentShellEnv)
      .ADE_DEFAULT_ROLE,
    "cto",
  );
  // A genuinely wrong role is still reported.
  assert.match(
    runtimeMismatchReason(
      { ...healthyDaemon, defaultRole: "agent" },
      { parentEnv: agentShellEnv },
    ) ?? "",
    /default role agent != cto/,
  );
});

test("isolation report names live sync only when this launch started the brain", () => {
  const previous = process.env.ADE_DEV_RUNTIME_SYNC;
  delete process.env.ADE_DEV_RUNTIME_SYNC;
  const chunks = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    printDevIsolationReport("/tmp/ade-runtime-dev.sock", "/work", { ownsRuntime: true });
    printDevIsolationReport("/tmp/ade-runtime-dev.sock", "/work", { ownsRuntime: false });
  } finally {
    process.stdout.write = write;
    if (previous === undefined) delete process.env.ADE_DEV_RUNTIME_SYNC;
    else process.env.ADE_DEV_RUNTIME_SYNC = previous;
  }
  const [owned, reused] = chunks.join("").split("[ade] dev isolation report").slice(1);
  assert.match(owned, /sync\s+: off \(--no-sync\)/);
  assert.doesNotMatch(owned, /left the process already on the socket/);
  assert.match(reused, /off \(--no-sync\) requested; this launch left the process already on the socket alone/);
});

test("only local runtimes may be auto-started or stopped", () => {
  assert.equal(canAutoStartRuntime("/tmp/ade-runtime-dev.sock"), true);
  assert.equal(canAutoStartRuntime("tcp://127.0.0.1:9999"), true);
  assert.equal(canAutoStartRuntime("tcp://localhost:9999"), true);
  assert.equal(canAutoStartRuntime("tcp://10.0.0.4:9999"), false);
  assert.equal(canAutoStartRuntime("tcp://runtime.internal:9999"), false);
});

test("a detached dev launch finds npm on Windows and hides the console", () => {
  const npmCliPath = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const windows = resolveDetachedDevInvocation("npm", ["run", "dev:desktop"], {
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    env: {},
    pathExists: (candidate) => candidate === npmCliPath,
  });
  // Not a bare `npm`, which `spawn` cannot find without a shell on Windows.
  assert.equal(windows.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(windows.args.slice(-2), ["run", "dev:desktop"]);
  assert.equal(windows.windowsHide, true);

  const batch = resolveDetachedDevInvocation("tool.cmd", ["--flag"], { platform: "win32", env: { ComSpec: "cmd.exe" } });
  assert.equal(batch.command, "cmd.exe");
  assert.equal(batch.windowsVerbatimArguments, true);

  const mac = resolveDetachedDevInvocation("npm", ["run", "dev:desktop"], { platform: "darwin" });
  assert.deepEqual(mac, { command: "npm", args: ["run", "dev:desktop"], windowsVerbatimArguments: false, windowsHide: true });
});

/* ── Per-lane dev user-data folders (scripts/dev-user-data.mjs) ──────────── */

const DAY_MS = 24 * 60 * 60 * 1000;
/** A pid that cannot be alive: above every platform's pid ceiling. */
const DEAD_PID = 999_999_999;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function laneWorktree(projectRoot, name) {
  return path.join(projectRoot, ".ade", "worktrees", name);
}

function writeMarker(folder, marker) {
  fs.writeFileSync(path.join(folder, ".ade-dev-lane.json"), `${JSON.stringify(marker, null, 2)}\n`);
}

test("per-lane dev user data: the primary checkout keeps the shared folder, a lane gets its own", () => {
  const projectRoot = "/Users/dev/Projects/ADE";
  const laneRoot = laneWorktree(projectRoot, "my-lane-1234abcd");
  const appDataPath = tempDir("ade-dev-user-data-appdata-");

  assert.equal(laneSlugForWorktree(projectRoot), null);
  assert.equal(laneUserDataPath(projectRoot, appDataPath), null);
  assert.equal(prepareLaneUserData(projectRoot, { appDataPath }), null);

  assert.equal(laneSlugForWorktree(laneRoot), "my-lane-1234abcd");
  assert.equal(
    laneUserDataPath(laneRoot, appDataPath),
    path.join(appDataPath, "ade-desktop-dev-my-lane-1234abcd"),
  );
  assert.equal(
    prepareLaneUserData(laneRoot, { appDataPath }),
    path.join(appDataPath, "ade-desktop-dev-my-lane-1234abcd"),
  );
});

test("per-lane dev user data: a long lane slug keeps its lane-id tail so two lanes never share a folder", () => {
  const projectRoot = "/Users/dev/Projects/ADE";
  const longName = `${"a".repeat(100)}-1111aaaa`;
  const otherName = `${"a".repeat(100)}-2222bbbb`;
  const slug = laneSlugForWorktree(laneWorktree(projectRoot, longName));
  const otherSlug = laneSlugForWorktree(laneWorktree(projectRoot, otherName));

  assert.ok(slug.length <= 80, `slug too long: ${slug.length}`);
  assert.ok(slug.endsWith("-1111aaaa"), `slug lost its lane-id tail: ${slug}`);
  assert.notEqual(slug, otherSlug);
});

test("per-lane dev user data: a new lane folder seeds ade-state.json from the shared folder once", () => {
  const projectRoot = "/Users/dev/Projects/ADE";
  const laneRoot = laneWorktree(projectRoot, "seed-lane-1111aaaa");
  const appDataPath = tempDir("ade-dev-user-data-seed-");
  fs.mkdirSync(path.join(appDataPath, "ade-desktop-dev"), { recursive: true });
  fs.writeFileSync(path.join(appDataPath, "ade-desktop-dev", "ade-state.json"), '{"seeded":true}');
  fs.writeFileSync(path.join(appDataPath, "ade-desktop-dev", "window-layout.json"), '{"ignored":true}');

  const folder = prepareLaneUserData(laneRoot, { appDataPath });
  assert.equal(fs.readFileSync(path.join(folder, "ade-state.json"), "utf8"), '{"seeded":true}');
  // Only the seeded files copy; other machine-local state starts fresh.
  assert.equal(fs.existsSync(path.join(folder, "window-layout.json")), false);
  // A second prepare does not overwrite the lane's own state.
  fs.writeFileSync(path.join(folder, "ade-state.json"), '{"seeded":false}');
  prepareLaneUserData(laneRoot, { appDataPath });
  assert.equal(fs.readFileSync(path.join(folder, "ade-state.json"), "utf8"), '{"seeded":false}');
});

test("per-lane dev user data: a held single-instance lock means the folder is in use", () => {
  const folder = tempDir("ade-dev-user-data-lock-");
  fs.symlinkSync(`devhost-${process.pid}`, path.join(folder, "SingletonLock"));
  assert.equal(userDataInUse(folder, "darwin"), true);

  // A symlink to `<host>-<pid>`: `existsSync` follows the dangling target.
  assert.equal(fs.lstatSync(path.join(folder, "SingletonLock")).isSymbolicLink(), true);
  fs.rmSync(path.join(folder, "SingletonLock"));
  fs.symlinkSync(`devhost-${DEAD_PID}`, path.join(folder, "SingletonLock"));
  assert.equal(userDataInUse(folder, "darwin"), false);
});

test("per-lane dev user data: prune removes a folder whose worktree is gone", () => {
  const appDataPath = tempDir("ade-dev-user-data-prune-");
  const folder = path.join(appDataPath, "ade-desktop-dev-gone-1111aaaa");
  fs.mkdirSync(folder, { recursive: true });
  writeMarker(folder, { worktreePath: laneWorktree("/p/ADE", "gone-1111aaaa"), lastUsedAt: new Date().toISOString() });

  const removed = pruneStaleDevUserData({ appDataPath });
  assert.equal(removed.length, 1);
  assert.equal(fs.existsSync(folder), false);
});

test("per-lane dev user data: prune leaves a folder whose launcher is still alive", () => {
  const appDataPath = tempDir("ade-dev-user-data-launcher-");
  const folder = path.join(appDataPath, "ade-desktop-dev-live-1111aaaa");
  fs.mkdirSync(folder, { recursive: true });
  // The worktree is gone, but the launcher that marked it is this process.
  writeMarker(folder, {
    worktreePath: laneWorktree("/p/ADE", "live-1111aaaa"),
    lastUsedAt: new Date().toISOString(),
    launcherPid: process.pid,
  });

  const entries = listDevUserDataFolders({ appDataPath });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].inUse, true);
  assert.equal(entries[0].stale, false);
  assert.deepEqual(pruneStaleDevUserData({ appDataPath }), []);
  assert.equal(fs.existsSync(folder), true);
});

test("per-lane dev user data: prune leaves a folder whose Electron lock is held", () => {
  const appDataPath = tempDir("ade-dev-user-data-held-");
  const folder = path.join(appDataPath, "ade-desktop-dev-held-1111aaaa");
  fs.mkdirSync(folder, { recursive: true });
  writeMarker(folder, { worktreePath: laneWorktree("/p/ADE", "held-1111aaaa"), lastUsedAt: new Date().toISOString() });
  fs.symlinkSync(`devhost-${process.pid}`, path.join(folder, "SingletonLock"));

  assert.deepEqual(pruneStaleDevUserData({ appDataPath }), []);
  assert.equal(fs.existsSync(folder), true);
});

test("per-lane dev user data: a folder re-stamped between list and delete is kept", () => {
  const appDataPath = tempDir("ade-dev-user-data-restamp-");
  const folder = path.join(appDataPath, "ade-desktop-dev-restamp-1111aaaa");
  const worktreePath = laneWorktree(appDataPath, "restamp-1111aaaa");
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(worktreePath, { recursive: true });
  writeMarker(folder, { worktreePath, lastUsedAt: new Date(Date.now() - 31 * DAY_MS).toISOString() });
  // Stale on this read: the worktree exists but the folder is past the idle window.
  assert.equal(listDevUserDataFolders({ appDataPath })[0].stale, true);

  // A lane starts on it after the list: its launcher re-stamps the marker.
  writeMarker(folder, {
    worktreePath,
    lastUsedAt: new Date().toISOString(),
    launcherPid: DEAD_PID,
  });
  assert.equal(removeIfStillStale(folder), false);
  assert.equal(fs.existsSync(folder), true);
});

test("per-lane dev user data: a half-deleted folder is never listed or pruned", () => {
  const appDataPath = tempDir("ade-dev-user-data-deleting-");
  const folder = path.join(appDataPath, "ade-desktop-dev-x-1111aaaa.deleting-123-456");
  fs.mkdirSync(folder, { recursive: true });

  assert.deepEqual(listDevUserDataFolders({ appDataPath }), []);
  assert.equal(fs.existsSync(folder), true);
});
