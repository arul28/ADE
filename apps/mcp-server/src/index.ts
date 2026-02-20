import path from "node:path";
import { createAdeMcpRuntime } from "./bootstrap";
import { startJsonRpcServer } from "./jsonrpc";
import { createMcpRequestHandler } from "./mcpServer";

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

async function main(): Promise<void> {
  const projectRoot = resolveProjectRoot();
  const runtime = await createAdeMcpRuntime(projectRoot);
  const version = "0.1.0";
  const handler = createMcpRequestHandler({ runtime, serverVersion: version });
  const stop = startJsonRpcServer(handler);

  const shutdown = () => {
    try {
      stop();
    } catch {
      // ignore
    }
    try {
      runtime.dispose();
    } catch {
      // ignore
    }
  };

  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.on("exit", () => {
    shutdown();
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
