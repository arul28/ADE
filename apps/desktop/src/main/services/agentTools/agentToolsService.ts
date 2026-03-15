import { spawn } from "node:child_process";
import type { AgentTool } from "../../../shared/types";
import type { Logger } from "../logging/logger";

type ToolSpec = { id: string; label: string; command: string; versionArgs: string[] };

const TOOL_SPECS: ToolSpec[] = [
  { id: "claude", label: "Claude Code", command: "claude", versionArgs: ["--version"] },
  { id: "codex", label: "Codex", command: "codex", versionArgs: ["--version"] },
  { id: "cursor", label: "Cursor", command: "cursor", versionArgs: ["--version"] },
  { id: "aider", label: "Aider", command: "aider", versionArgs: ["--version"] },
  { id: "continue", label: "Continue", command: "continue", versionArgs: ["--version"] }
];

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}

function spawnAsync(
  command: string,
  args: string[],
  opts?: { timeout?: number }
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: opts?.timeout ?? 5_000,
      });

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8").slice(0, 10_000);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8").slice(0, 10_000);
      });

      child.on("error", () => {
        resolve({ status: 1, stdout, stderr });
      });
      child.on("close", (code) => {
        resolve({ status: code, stdout, stderr });
      });
    } catch {
      resolve({ status: 1, stdout: "", stderr: "" });
    }
  });
}

async function which(command: string): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const res = await spawnAsync("where", [command]);
      if (res.status !== 0) return null;
      const line = firstLine(res.stdout ?? "");
      return line.length ? line : null;
    }

    const res = await spawnAsync("sh", ["-lc", 'command -v "$1" 2>/dev/null || true', "--", command]);
    const line = firstLine(res.stdout ?? "");
    return line.length ? line : null;
  } catch {
    return null;
  }
}

async function readVersion(spec: ToolSpec): Promise<string | null> {
  try {
    const res = await spawnAsync(spec.command, spec.versionArgs);
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    const line = firstLine(out);
    return line.length ? line.slice(0, 160) : null;
  } catch {
    return null;
  }
}

async function detectOneTool(spec: ToolSpec): Promise<AgentTool> {
  const detectedPath = await which(spec.command);
  const installed = Boolean(detectedPath);
  const detectedVersion = installed ? await readVersion(spec) : null;
  return {
    id: spec.id,
    label: spec.label,
    command: spec.command,
    installed,
    detectedPath,
    detectedVersion
  };
}

export function createAgentToolsService({ logger }: { logger: Logger }) {
  let cachedResult: AgentTool[] | null = null;
  let cacheTimestamp = 0;
  const CACHE_TTL_MS = 30_000;

  return {
    async detect(): Promise<AgentTool[]> {
      const now = Date.now();
      if (cachedResult && now - cacheTimestamp < CACHE_TTL_MS) {
        return cachedResult;
      }

      const tools = await Promise.all(TOOL_SPECS.map(detectOneTool));

      logger.debug("agentTools.detect", {
        found: tools.filter((tool) => tool.installed).map((tool) => tool.id)
      });

      cachedResult = tools;
      cacheTimestamp = now;
      return tools;
    }
  };
}

