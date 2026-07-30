import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  detachedDevRuntimeEnv,
  resolveDefaultDevSocketPath,
  resolveDevRuntimeStartupTimeoutMs,
  resolveNpmInvocation,
  resolveDevSocketPath,
  resolveDevSpawnInvocation,
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
      KEEP_ME: "yes",
    },
  );

  assert.equal(env.ADE_RUNTIME_PARENT_PID, undefined);
  assert.equal(env.ADE_RUNTIME_IDLE_EXIT_MS, undefined);
  assert.equal(env.KEEP_ME, "yes");
  assert.equal(env.ADE_RUNTIME_SOCKET_PATH, "\\\\.\\pipe\\ade-runtime-dev-test");
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
