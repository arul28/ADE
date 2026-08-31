#!/usr/bin/env node
/**
 * Stand-in for the real `ade` binary in sidecar tests.
 *
 * Accepts `runtime run --socket <path> --profile embedded`, listens on the
 * socket, and answers just enough JSON-RPC for the handshake. It deliberately
 * never exits on its own: the point of the test is that `dispose()` and the
 * process exit hooks are what stop it.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const args = process.argv.slice(2);
const socketPath = args[args.indexOf("--socket") + 1];
const profile = args[args.indexOf("--profile") + 1];

if (args[0] !== "runtime" || args[1] !== "run" || !socketPath) {
  process.stderr.write(`fake-ade: unexpected argv ${JSON.stringify(args)}\n`);
  process.exit(2);
}

// The tests assert on this: the sidecar must pass the caller's isolated home
// through as ADE_HOME, and must ask for the embedded profile.
fs.writeFileSync(
  path.join(path.dirname(socketPath), "..", "spawn-record.json"),
  JSON.stringify({
    argv: args,
    profile,
    adeHome: process.env.ADE_HOME ?? null,
    embeddedParentPid: process.env.ADE_EMBEDDED_PARENT_PID ?? null,
    pid: process.pid,
  }),
);

if (process.env.FAKE_ADE_STARTUP_DELAY_MS) {
  await new Promise((resolve) =>
    setTimeout(resolve, Number(process.env.FAKE_ADE_STARTUP_DELAY_MS)),
  );
}

if (process.env.FAKE_ADE_EXIT_DURING_STARTUP === "1") {
  process.stderr.write("fake-ade: refusing to start\n");
  process.exit(3);
}

const server = net.createServer((socket) => {
  let pending = "";
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      index = pending.indexOf("\n");
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id == null) continue;
      const result =
        message.method === "ade/initialize"
          ? {
              runtimeInfo: { version: "fake-1.0.0", pid: process.pid },
              capabilities: { personalChats: { version: 1, actions: [], pushEvents: false } },
            }
          : null;
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
    }
  });
});

server.listen(socketPath, () => {
  process.stderr.write(`fake-ade: listening on ${socketPath}\n`);
});

// Keep the event loop alive forever; only a signal or a kill ends this process.
setInterval(() => {}, 1 << 30);
