import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createAdeMcpRuntime } from "./bootstrap";
import { startJsonRpcServer } from "./jsonrpc";
import { createMcpRequestHandler } from "./mcpServer";
import { createStdioTransport } from "./transport";

function resolveProjectRoot(): string {
  const fromEnv = process.env.ADE_PROJECT_ROOT?.trim();
  if (fromEnv) return path.resolve(fromEnv);

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--project-root") {
      const next = args[i + 1];
      if (next?.trim()) return path.resolve(next.trim());
    }
  }

  return process.cwd();
}

async function startHeadless(projectRoot: string): Promise<void> {
  process.stderr.write("[ade-mcp] Starting in headless mode\n");
  const runtime = await createAdeMcpRuntime(projectRoot);
  const version = "0.1.0";
  const handler = createMcpRequestHandler({ runtime, serverVersion: version });
  const transport = createStdioTransport();
  const stop = startJsonRpcServer(handler, transport);

  const shutdown = () => {
    try { stop(); } catch {}
    try { runtime.dispose(); } catch {}
  };

  process.on("SIGINT", () => { shutdown(); process.exit(0); });
  process.on("SIGTERM", () => { shutdown(); process.exit(0); });
  process.on("exit", () => { shutdown(); });
}

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const socketPath = path.join(projectRoot, ".ade", "mcp.sock");

  if (fs.existsSync(socketPath)) {
    // Desktop is running — proxy mode: relay stdio <-> socket
    const socket = net.createConnection(socketPath);

    socket.on("error", (err) => {
      // Socket file exists but desktop isn't listening — fall back to headless
      process.stderr.write(`[ade-mcp] Socket connect failed, falling back to headless: ${err.message}\n`);
      void startHeadless(projectRoot);
    });

    socket.on("connect", () => {
      process.stderr.write("[ade-mcp] Connected to desktop app (proxy mode)\n");
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);

      socket.on("close", () => process.exit(0));
      process.stdin.on("end", () => {
        socket.end();
        process.exit(0);
      });
    });
  } else {
    // No desktop running — headless mode
    await startHeadless(projectRoot);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
