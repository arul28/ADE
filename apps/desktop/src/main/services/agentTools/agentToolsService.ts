import { spawnSync } from "node:child_process";
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

function which(command: string): string | null {
  try {
    if (process.platform === "win32") {
      const res = spawnSync("where", [command], { encoding: "utf8" });
      if (res.status !== 0) return null;
      const line = firstLine(res.stdout ?? "");
      return line.length ? line : null;
    }

    const res = spawnSync("sh", ["-lc", `command -v ${command} 2>/dev/null || true`], { encoding: "utf8" });
    const line = firstLine(res.stdout ?? "");
    return line.length ? line : null;
  } catch {
    return null;
  }
}

function readVersion(spec: ToolSpec): string | null {
  try {
    const res = spawnSync(spec.command, spec.versionArgs, { encoding: "utf8" });
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    const line = firstLine(out);
    return line.length ? line.slice(0, 160) : null;
  } catch {
    return null;
  }
}

export function createAgentToolsService({ logger }: { logger: Logger }) {
  return {
    detect(): AgentTool[] {
      const tools: AgentTool[] = [];

      for (const spec of TOOL_SPECS) {
        const detectedPath = which(spec.command);
        const installed = Boolean(detectedPath);
        const detectedVersion = installed ? readVersion(spec) : null;
        tools.push({
          id: spec.id,
          label: spec.label,
          command: spec.command,
          installed,
          detectedPath,
          detectedVersion
        });
      }

      logger.debug("agentTools.detect", {
        found: tools.filter((tool) => tool.installed).map((tool) => tool.id)
      });

      return tools;
    }
  };
}

