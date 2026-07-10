import path from "node:path";
import {
  claudeProjectSlugForCwd,
  cleanSessionTitle,
  countJsonlUserMessagesCheap,
  firstUserTextFromRecords,
  cwdIsInScope,
  isUuidLike,
  normalizeExternalSessionLimit,
  readFileSuffix,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeReadDir,
  safeParseJson,
  sessionFileCandidate,
  slugMatchesScopeRoots,
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
  for (const item of records.slice().reverse()) {
    const record = asRecord(item);
    if (!record) continue;
    const title = cleanSessionTitle(asString(record.aiTitle))
      ?? cleanSessionTitle(asString(record.customTitle))
      ?? cleanSessionTitle(asString(record.sessionTitle))
      ?? cleanSessionTitle(asString(record.summary))
      ?? cleanSessionTitle(asString(record.title));
    if (title) return title;
  }
  return null;
}

function claudeScanRecords(filePath: string): unknown[] {
  const prefix = readJsonlRecords(filePath);
  const suffixText = readFileSuffix(filePath);
  if (!suffixText) return prefix;
  const suffixLines = suffixText.split(/\r?\n/u);
  if (suffixText.length > 0 && !suffixText.startsWith("{")) suffixLines.shift();
  const suffix = suffixLines
    .map((line) => safeParseJson(line))
    .filter((record): record is Record<string, unknown> => record != null);
  return [...prefix, ...suffix];
}

function latestClaudeCwd(records: unknown[]): string | null {
  for (const item of records.slice().reverse()) {
    const cwd = asString(asRecord(item)?.cwd);
    if (cwd) return cwd;
  }
  return null;
}

function isClaudeCliTranscript(records: unknown[]): boolean {
  const entrypoints = records
    .map((item) => asString(asRecord(item)?.entrypoint)?.toLowerCase())
    .filter((entrypoint): entrypoint is string => Boolean(entrypoint));
  return !entrypoints.some((entrypoint) => entrypoint.startsWith("sdk"));
}

export async function discoverClaudeSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const projectsDir = path.join(claudeConfigDir(args), "projects");
  const lookupId = args.sessionId?.trim() || null;
  if (lookupId && !isUuidLike(lookupId)) return [];
  const candidates: Array<ExternalSessionFileCandidate<{ id: string }>> = [];

  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    if (!slugMatchesScopeRoots(projectEntry.name, args.scopeRoots, claudeProjectSlugForCwd)) continue;
    const projectDir = path.join(projectsDir, projectEntry.name);
    if (lookupId) {
      const candidate = sessionFileCandidate(path.join(projectDir, `${lookupId}.jsonl`), { id: lookupId });
      if (candidate) candidates.push(candidate);
      continue;
    }
    for (const entry of safeReadDir(projectDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      if (!isUuidLike(id)) continue;
      const filePath = path.join(projectDir, entry.name);
      const candidate = sessionFileCandidate(filePath, { id });
      if (candidate) candidates.push(candidate);
    }
  }

  const newestById = new Map<string, ExternalSessionFileCandidate<{ id: string }>>();
  for (const candidate of sortFileCandidatesByMtime(candidates, candidates.length)) {
    if (!newestById.has(candidate.id)) newestById.set(candidate.id, candidate);
  }

  const records: ExternalSessionDiscoveryRecord[] = [];
  for (const candidate of newestById.values()) {
    const jsonl = claudeScanRecords(candidate.filePath);
    if (!isClaudeCliTranscript(jsonl)) continue;
    const cwd = latestClaudeCwd(jsonl);
    let createdAt: number | null = null;
    for (const item of jsonl) {
      const record = asRecord(item);
      if (!record) continue;
      createdAt = createdAt ?? asEpochMs(record.timestamp);
      if (createdAt) break;
    }
    if (!cwdIsInScope(cwd, args.scopeRoots)) continue;
    const firstUserText = firstUserTextFromRecords(jsonl);
    records.push(recordWithFile({
      provider: "claude",
      id: candidate.id,
      cwd,
      title: explicitClaudeTitleFromRecords(jsonl),
      preview: firstUserText,
      createdAt,
      messageCount: countJsonlUserMessagesCheap(candidate.filePath, "claude"),
      filePath: candidate.filePath,
      sourceMtimeMs: candidate.mtimeMs,
    }));
    if (records.length >= limit) break;
  }

  return sortDiscoveryRecords(records, limit);
}
