import type { AgentTool } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { firstLine, spawnAsync, whichCommand } from "../shared/utils";

type ToolSpec = { id: string; label: string; command: string; versionArgs: string[] };

const TOOL_SPECS: ToolSpec[] = [
  { id: "claude", label: "Claude Code", command: "claude", versionArgs: ["--version"] },
  { id: "codex", label: "Codex", command: "codex", versionArgs: ["--version"] },
  { id: "cursor", label: "Cursor", command: "cursor", versionArgs: ["--version"] },
  { id: "aider", label: "Aider", command: "aider", versionArgs: ["--version"] },
  { id: "continue", label: "Continue", command: "continue", versionArgs: ["--version"] }
];

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
  const detectedPath = await whichCommand(spec.command);
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
