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

async function chooseRemoteDebugPort(start = 9222, attempts = 64) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = start + offset;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free remote debugging port found in range ${start}-${start + attempts - 1}`);
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

async function waitForStableFile(filePath, timeoutMs, stableWindowMs = 300) {
  const startedAt = Date.now();
  let lastSignature = "";
  let stableSince = 0;

  while (true) {
    try {
      const stat = fs.statSync(filePath);
      const signature = `${stat.size}:${stat.mtimeMs}`;
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableWindowMs) {
        return stat;
      }
    } catch {
      lastSignature = "";
      stableSince = 0;
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for stable file: ${filePath}`);
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
  const envDebugPort = Number.parseInt(process.env.ADE_ELECTRON_REMOTE_DEBUGGING_PORT || "", 10);
  const remoteDebugPort =
    Number.isFinite(envDebugPort) && envDebugPort > 0
      ? envDebugPort
      : await chooseRemoteDebugPort(9222, 64);
  process.stdout.write(`[ade] dev launcher using ${devServerUrl}\n`);
  process.stdout.write(`[ade] electron CDP endpoint: http://127.0.0.1:${remoteDebugPort}/json/version\n`);

  const children = new Set();
  let shuttingDown = false;
  let electron = null;
  let electronRestartPending = false;

  const teardown = (signal = "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    fs.unwatchFile(distMainFile);
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

  // Start the main-process bundler first and wait for an initial `main.cjs` before Vite.
  // If Vite + tsup start together, a stale `dist/main/main.cjs` from a prior `npm run build`
  // can satisfy `waitForStableFile` briefly; then tsup's clean step deletes it and the first
  // Electron load races a missing module. Sequential startup removes that class of flake.
  const main = spawnProcess("main", "npx", ["tsup", "--watch"]);
  children.add(main);

  const onUnexpectedExit = (child) => (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(
      `[ade] ${child.__adeName ?? "process"} exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})\n`
    );
    teardown("SIGTERM");
    process.exit(code ?? 1);
  };

  main.on("exit", onUnexpectedExit(main));

  const initialMainBundleStat = await waitForStableFile(distMainFile, 120_000);

  const vite = spawnProcess("renderer", "npx", ["vite", "--port", String(devPort), "--strictPort", "--force"]);
  children.add(vite);
  vite.on("exit", onUnexpectedExit(vite));

  await waitForPort(devPort, 30_000);

  const electronEnv = { VITE_DEV_SERVER_URL: devServerUrl };
  const launchElectron = () => {
    const electronArgs = ["electron"];
    if (process.platform === "linux" && process.env.ADE_ELECTRON_NO_SANDBOX !== "0") {
      electronArgs.push("--no-sandbox");
    }
    electronArgs.push(".", `--remote-debugging-port=${remoteDebugPort}`);
    const child = spawnProcess("electron", "npx", electronArgs, electronEnv);
    electron = child;
    children.add(child);
    child.on("exit", (code, signal) => {
      children.delete(child);
      if (shuttingDown) return;
      if (electron !== child) return;
      electron = null;
      if (electronRestartPending) {
        electronRestartPending = false;
        waitForStableFile(distMainFile, 30_000)
          .then((stat) => {
            lastMainBundleMtimeMs = stat.mtimeMs;
            process.stdout.write("[ade] electron restarted with updated main bundle\n");
            launchElectron();
          })
          .catch((error) => {
            process.stderr.write(
              `[ade] failed to restart electron after main bundle update: ${error instanceof Error ? error.message : String(error)}\n`
            );
            teardown("SIGTERM");
            process.exit(1);
          });
        return;
      }
      process.stdout.write(
        `[ade] electron exited (code=${code ?? "null"}, signal=${signal ?? "null"}); stopping dev launcher.\n`
      );
      teardown("SIGTERM");
      process.exit(code ?? 0);
    });
  };

  const requestElectronRestart = (reason) => {
    if (shuttingDown || !electron) return;
    if (electronRestartPending) return;
    electronRestartPending = true;
    process.stdout.write(`[ade] restarting electron (${reason})\n`);
    try {
      electron.kill("SIGTERM");
    } catch {
      electronRestartPending = false;
    }
  };

  launchElectron();

  let lastMainBundleMtimeMs = initialMainBundleStat.mtimeMs;
  fs.watchFile(distMainFile, { interval: 250 }, (curr) => {
    if (shuttingDown) return;
    if (!curr || curr.nlink === 0) return;
    if (!curr || curr.mtimeMs <= lastMainBundleMtimeMs) return;
    lastMainBundleMtimeMs = curr.mtimeMs;
    requestElectronRestart("main bundle updated");
  });
}

main().catch((error) => {
  process.stderr.write(`[ade] dev launcher failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
