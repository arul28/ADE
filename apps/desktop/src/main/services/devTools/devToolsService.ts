import { spawn } from "node:child_process";
import type { DevToolStatus, DevToolsCheckResult } from "../../../shared/types/devTools";
import type { Logger } from "../logging/logger";

type ToolSpec = {
  id: "git" | "gh";
  label: string;
  command: string;
  versionArgs: string[];
  required: boolean;
};

const TOOL_SPECS: ToolSpec[] = [
  { id: "git", label: "Git", command: "git", versionArgs: ["--version"], required: true },
  { id: "gh", label: "GitHub CLI", command: "gh", versionArgs: ["--version"], required: false },
];

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}

function spawnAsync(
  command: string,
  args: string[],
  opts?: { timeout?: number },
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

async function detectOneTool(spec: ToolSpec): Promise<DevToolStatus> {
  const detectedPath = await which(spec.command);
  const installed = Boolean(detectedPath);
  const detectedVersion = installed ? await readVersion(spec) : null;
  return {
    id: spec.id,
    label: spec.label,
    command: spec.command,
    installed,
    detectedPath,
    detectedVersion,
    required: spec.required,
  };
}

export function createDevToolsService({ logger }: { logger: Logger }) {
  let cachedResult: DevToolsCheckResult | null = null;
  let cacheTimestamp = 0;
  const CACHE_TTL_MS = 30_000;

  return {
    async detect(force?: boolean): Promise<DevToolsCheckResult> {
      const now = Date.now();
      if (!force && cachedResult && now - cacheTimestamp < CACHE_TTL_MS) {
        return cachedResult;
      }

      const tools = await Promise.all(TOOL_SPECS.map(detectOneTool));

      logger.debug("devTools.detect", {
        found: tools.filter((t) => t.installed).map((t) => t.id),
      });

      const result: DevToolsCheckResult = { tools, platform: process.platform };
      cachedResult = result;
      cacheTimestamp = now;
      return result;
    },
  };
}
