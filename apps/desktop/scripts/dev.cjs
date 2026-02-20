#!/usr/bin/env node

const cp = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const distMainFile = path.join(projectRoot, "dist", "main", "main.cjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canListenOnHost(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (code === "EADDRNOTAVAIL") {
        resolve(true);
        return;
      }
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function isPortFree(port) {
  const ipv4Free = await canListenOnHost(port, "127.0.0.1");
  if (!ipv4Free) return false;
  const ipv6Free = await canListenOnHost(port, "::1");
  return ipv6Free;
}

async function choosePort(start = 5173, attempts = 32) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = start + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free dev port found in range ${start}-${start + attempts - 1}`);
}

function waitForPort(port, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host: "localhost", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for Vite port ${port}`));
          return;
        }
        setTimeout(tryConnect, 150);
      });
    };
    tryConnect();
  });
}

async function waitForFile(filePath, timeoutMs) {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for file: ${filePath}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(150);
  }
}

function spawnProcess(name, cmd, args, extraEnv = {}) {
  const child = cp.spawn(cmd, args, {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
    stdio: "inherit"
  });
  child.__adeName = name;
  return child;
}

async function main() {
  const devPort = await choosePort(5173, 32);
  const devServerUrl = `http://localhost:${devPort}`;
  process.stdout.write(`[ade] dev launcher using ${devServerUrl}\n`);

  const children = new Set();
  let shuttingDown = false;

  const teardown = (signal = "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) {
        try {
          child.kill(signal);
        } catch {
          // ignore
        }
      }
    }
  };

  process.on("SIGINT", () => teardown("SIGINT"));
  process.on("SIGTERM", () => teardown("SIGTERM"));
  process.on("exit", () => teardown("SIGTERM"));

  const vite = spawnProcess("renderer", "npx", ["vite", "--port", String(devPort), "--strictPort", "--force"]);
  const main = spawnProcess("main", "npx", ["tsup", "--watch"]);
  children.add(vite);
  children.add(main);

  const onUnexpectedExit = (child) => (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(
      `[ade] ${child.__adeName ?? "process"} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})\n`
    );
    teardown("SIGTERM");
    process.exit(code ?? 1);
  };

  vite.on("exit", onUnexpectedExit(vite));
  main.on("exit", onUnexpectedExit(main));

  await Promise.all([waitForPort(devPort, 30_000), waitForFile(distMainFile, 30_000)]);

  const electron = spawnProcess("electron", "npx", ["electron", "."], {
    VITE_DEV_SERVER_URL: devServerUrl
  });
  children.add(electron);

  electron.on("exit", (code, signal) => {
    if (shuttingDown) return;
    process.stdout.write(
      `[ade] electron exited (code=${code ?? "null"}, signal=${signal ?? "null"}); stopping dev launcher.\n`
    );
    teardown("SIGTERM");
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  process.stderr.write(`[ade] dev launcher failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
