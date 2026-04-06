import type { DevToolStatus, DevToolsCheckResult } from "../../../shared/types/devTools";
import type { Logger } from "../logging/logger";
import { firstLine, spawnAsync, whichCommand } from "../shared/utils";
import { resolveExecutableFromKnownLocations } from "../ai/cliExecutableResolver";

type ToolSpec = {
  id: "git";
  label: string;
  command: string;
  versionArgs: string[];
  required: boolean;
};

const TOOL_SPECS: ToolSpec[] = [
  { id: "git", label: "Git", command: "git", versionArgs: ["--version"], required: true },
];

async function readVersion(commandPath: string, versionArgs: string[]): Promise<string | null> {
  try {
    const res = await spawnAsync(commandPath, versionArgs);
    const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim();
    const line = firstLine(out);
    return line.length ? line.slice(0, 160) : null;
  } catch {
    return null;
  }
}

async function detectOneTool(spec: ToolSpec): Promise<DevToolStatus> {
  const detectedPath = resolveExecutableFromKnownLocations(spec.command)?.path
    ?? await whichCommand(spec.command);
  const installed = Boolean(detectedPath);
  const detectedVersion = detectedPath ? await readVersion(detectedPath, spec.versionArgs) : null;
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
