import path from "node:path";
import {
  claudeProjectSlugForCwd,
  cleanSessionTitle,
  countJsonlLinesCheap,
  firstUserTextFromRecords,
  isUuidLike,
  normalizeExternalSessionLimit,
  previewFromRecords,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeReadDir,
  sessionFileCandidate,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  asEpochMs,
  asRecord,
  asString,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

export function claudeConfigDir(args: ExternalSessionDiscoveryArgs = {}): string {
  const env = args.env ?? (args.homeDir ? undefined : process.env);
  const configured = typeof env?.CLAUDE_CONFIG_DIR === "string"
    ? env.CLAUDE_CONFIG_DIR.trim()
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

function explicitClaudeTitleFromRecords(records: unknown[]): string | null {
  for (const item of records) {
    const record = asRecord(item);
    if (!record) continue;
    const title = cleanSessionTitle(asString(record.summary)) ?? cleanSessionTitle(asString(record.title));
    if (title) return title;
  }
  return null;
}

export async function discoverClaudeSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const projectsDir = path.join(claudeConfigDir(args), "projects");
  const candidates: Array<ExternalSessionFileCandidate<{ id: string }>> = [];

  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    for (const entry of safeReadDir(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      if (!isUuidLike(id)) continue;
      const filePath = path.join(projectDir, entry.name);
      const candidate = sessionFileCandidate(filePath, { id });
      if (candidate) candidates.push(candidate);
    }
  }

  const records: ExternalSessionDiscoveryRecord[] = [];
  for (const candidate of sortFileCandidatesByMtime(candidates, limit)) {
    const jsonl = readJsonlRecords(candidate.filePath);
    let cwd: string | null = null;
    let createdAt: number | null = null;
    for (const item of jsonl) {
      const record = asRecord(item);
      if (!record) continue;
      cwd = cwd ?? asString(record.cwd);
      createdAt = createdAt ?? asEpochMs(record.timestamp);
      if (cwd && createdAt) break;
    }
    const firstUserText = firstUserTextFromRecords(jsonl);
    records.push(recordWithFile({
      provider: "claude",
      id: candidate.id,
      cwd,
      title: explicitClaudeTitleFromRecords(jsonl),
      preview: firstUserText ?? previewFromRecords(jsonl),
      createdAt,
      messageCount: countJsonlLinesCheap(candidate.filePath),
      filePath: candidate.filePath,
      sourceMtimeMs: candidate.mtimeMs,
    }));
  }

  return sortDiscoveryRecords(records, limit);
}
