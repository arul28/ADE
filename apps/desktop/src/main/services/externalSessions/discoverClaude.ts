import path from "node:path";
import {
  claudeProjectSlugForCwd,
  countJsonlLinesCheap,
  firstUserTextFromRecords,
  isUuidLike,
  normalizeExternalSessionLimit,
  previewFromRecords,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeReadDir,
  sortDiscoveryRecords,
  asEpochMs,
  asRecord,
  asString,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

export function claudeConfigDir(args: ExternalSessionDiscoveryArgs = {}): string {
  const configured = typeof args.env?.CLAUDE_CONFIG_DIR === "string"
    ? args.env.CLAUDE_CONFIG_DIR.trim()
    : "";
  return configured || path.join(resolveHomeDir(args), ".claude");
}

export function claudeSessionPath(args: {
  sessionId: string;
  cwd: string;
  configDir?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const configDir = args.configDir?.trim()
    || claudeConfigDir({ homeDir: args.homeDir, env: args.env });
  return path.join(configDir, "projects", claudeProjectSlugForCwd(args.cwd), `${args.sessionId}.jsonl`);
}

export async function discoverClaudeSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const projectsDir = path.join(claudeConfigDir(args), "projects");
  const records: ExternalSessionDiscoveryRecord[] = [];

  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    for (const entry of safeReadDir(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      if (!isUuidLike(id)) continue;
      const filePath = path.join(projectDir, entry.name);
      const jsonl = readJsonlRecords(filePath);
      let cwd: string | null = null;
      let createdAt: number | null = null;
      for (const item of jsonl) {
        const record = asRecord(item);
        if (!record) continue;
        cwd = cwd ?? asString(record.cwd);
        createdAt = createdAt ?? asEpochMs(record.timestamp);
        if (cwd && createdAt) break;
      }
      const title = firstUserTextFromRecords(jsonl);
      records.push(recordWithFile({
        provider: "claude",
        id,
        cwd,
        title,
        preview: previewFromRecords(jsonl),
        createdAt,
        messageCount: countJsonlLinesCheap(filePath),
        filePath,
      }));
    }
  }

  return sortDiscoveryRecords(records, limit);
}
