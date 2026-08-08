import path from "node:path";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  countJsonlUserMessagesCheap,
  cwdIsInScope,
  externalSessionMessageFromRecord,
  firstUserTextFromRecords,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  readJsonlRecords,
  recordWithFile,
  safeReadDir,
  sessionFileCandidate,
  sortDiscoveryRecords,
  EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";
import { commandArrayToLine } from "../../../shared/shell";
import type { TerminalResumeLaunchConfig } from "../../../shared/types/sessions";
import { piSessionDirectoryForEnvironment } from "../chat/piSessionLease";

function piSessionsDir(args: ExternalSessionDiscoveryArgs): string {
  return piSessionDirectoryForEnvironment(args.env ?? process.env);
}

function sessionTitle(records: Record<string, unknown>[]): string | null {
  const info = records
    .filter((record) => record.type === "session_info")
    .at(-1);
  return cleanSessionTitle(asString(info?.name));
}

function launchFor(records: Record<string, unknown>[]): TerminalResumeLaunchConfig {
  const model = records
    .map((record) => record.type === "model_change" ? `${asString(record.provider) ?? ""}/${asString(record.modelId) ?? ""}` : "")
    .filter((value) => value !== "/")
    .at(-1);
  const thinking = records
    .map((record) => record.type === "thinking_level_change" ? asString(record.thinkingLevel) : null)
    .filter((value): value is string => Boolean(value))
    .at(-1);
  return {
    ...(model ? { model } : {}),
    ...(thinking ? { reasoningEffort: thinking } : {}),
  };
}

function collectSessionFiles(root: string): string[] {
  const files: string[] = [];
  const pendingDirectories = [path.resolve(root)];
  while (pendingDirectories.length > 0) {
    const dir = pendingDirectories.pop();
    if (!dir) continue;
    for (const entry of safeReadDir(dir)) {
      // Do not follow user-created symlinks while walking the native session
      // tree. The header cwd is checked below, but avoiding traversal here
      // also prevents a link from expanding discovery outside the configured
      // Pi session root (or creating a directory cycle).
      if (entry.isSymbolicLink()) continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(filePath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        // Pi includes the session id in the JSONL header; current releases
        // prefix the filename with a timestamp, so basename === id is not a
        // reliable lookup rule.
        files.push(filePath);
      }
    }
  }
  return files;
}

/** Discover Pi's native JSONL sessions without importing the user's Pi package. */
export async function discoverPiSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const lookupId = args.sessionId?.trim() || null;
  const candidates = collectSessionFiles(piSessionsDir(args))
    .map((filePath) => sessionFileCandidate(filePath, {}))
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  // An exact lookup must search the whole tree: the requested native session
  // may be older than the recent-session discovery budget.
  const candidatesToRead = lookupId
    ? candidates
    : candidates.slice(0, Math.max(limit * EXTERNAL_SESSION_READ_BUDGET_MULTIPLIER, limit));
  const records: ExternalSessionDiscoveryRecord[] = [];
  const seen = new Set<string>();
  for (const candidate of candidatesToRead) {
    const jsonl = readJsonlRecords(candidate.filePath, 512);
    const header = asRecord(jsonl[0]);
    if (!header || header.type !== "session") continue;
    const id = asString(header.id) ?? path.basename(candidate.filePath, ".jsonl");
    if (!id || (lookupId && id !== lookupId) || seen.has(id)) continue;
    const cwd = normalizeProviderCwd(asString(header.cwd));
    if (!cwdIsInScope(cwd, args.scopeRoots)) continue;
    const normalizedRecords = jsonl.map(asRecord).filter((record): record is Record<string, unknown> => record !== null);
    const messages = normalizedRecords
      .map(externalSessionMessageFromRecord)
      .filter((message): message is NonNullable<typeof message> => message !== null)
      .slice(-8);
    const timestamp = asEpochMs(header.timestamp);
    records.push(recordWithFile({
      provider: "pi",
      id,
      cwd,
      title: sessionTitle(normalizedRecords),
      preview: firstUserTextFromRecords(normalizedRecords),
      messages,
      createdAt: timestamp,
      updatedAt: candidate.mtimeMs,
      messageCount: countJsonlUserMessagesCheap(candidate.filePath, "pi"),
      launch: launchFor(normalizedRecords),
      filePath: candidate.filePath,
      sourceMtimeMs: candidate.mtimeMs,
    }));
    seen.add(id);
  }
  return sortDiscoveryRecords(records, limit);
}

/** Build a direct Pi CLI resume line for callers that need a native session file. */
export function piResumeCommandForSession(sessionFileOrId: string): string {
  const value = sessionFileOrId.trim();
  return commandArrayToLine(["pi", "--session", value], { platform: "linux" });
}
