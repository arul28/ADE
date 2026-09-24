import path from "node:path";
import { qwenConfigHome } from "../shared/providerConfigHomes";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  cwdIsInScope,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  readFilePrefix,
  resolveHomeDir,
  safeParseJson,
  safeReadDir,
  sessionFileCandidate,
  slugMatchesScopeRoots,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
  type ExternalSessionFileCandidate,
} from "./discoveryUtils";
import {
  acpDiscoveryRecord,
  collectNewestSessions,
  compact,
  expandHomePath,
  neutralRecord,
  readJsonlWindow,
  safeLookupId,
  startsWithAdeGuidance,
  summarizeNeutralRecords,
  type NeutralSessionRecord,
} from "./discoverAcpShared";

/**
 * Qwen Code (verified against 0.22.3) keeps one JSONL per session at
 * `<runtime>/projects/<sanitizeCwd(projectRoot)>/chats/<sessionId>.jsonl`, with
 * a `<sessionId>.runtime.json` sidecar (`work_dir`) while the CLI runs.
 *
 * `<runtime>` is Qwen's own `Storage.getRuntimeBaseDir()`: `QWEN_RUNTIME_DIR`,
 * else `QWEN_HOME`, else `~/.qwen`. Both env values accept a leading `~`.
 *
 * Records share one envelope — `{ uuid, parentUuid, sessionId, timestamp,
 * type: user|assistant|tool_result|system, cwd, provenance, message }`. Text
 * lives in `message.parts[].text` (Gemini-style parts; assistant role is
 * `"model"`, reasoning parts carry `thought: true`).
 */
export function qwenSessionRoot(args: Pick<ExternalSessionDiscoveryArgs, "homeDir" | "env">): string {
  const env = args.env ?? process.env;
  const homeDir = resolveHomeDir(args);
  const runtimeDir = env.QWEN_RUNTIME_DIR?.trim();
  if (runtimeDir) return expandHomePath(runtimeDir, homeDir);
  const qwenHome = env.QWEN_HOME?.trim();
  if (qwenHome) return expandHomePath(qwenHome, homeDir);
  return qwenConfigHome({ env: {}, homeDir });
}

/** Qwen's `sanitizeCwd`: lowercased on Windows, every non-alphanumeric to `-`. */
export function qwenProjectSlugForCwd(cwd: string): string {
  const normalized = process.platform === "win32" ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/gu, "-");
}

function qwenPartsText(message: Record<string, unknown> | null): string | null {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const text = parts
    .map(asRecord)
    .filter((part): part is Record<string, unknown> => part != null && part.thought !== true)
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((value) => value.trim().length > 0)
    .join("\n");
  return text || null;
}

/** A user record the person typed, as opposed to one Qwen injected. */
export function isQwenPromptRecord(record: Record<string, unknown>): boolean {
  if (record.type !== "user") return false;
  const provenance = asString(record.provenance);
  return provenance == null || provenance === "real_user";
}

function neutralQwenRecord(record: Record<string, unknown>): NeutralSessionRecord | null {
  const message = asRecord(record.message);
  if (isQwenPromptRecord(record)) return neutralRecord("user", qwenPartsText(message), asString(record.timestamp));
  if (record.type === "assistant") return neutralRecord("assistant", qwenPartsText(message), asString(record.timestamp));
  return null;
}

function systemSubtype(record: Record<string, unknown>): string | null {
  return record.type === "system" ? asString(record.subtype) : null;
}

type QwenCandidate = ExternalSessionFileCandidate<{ id: string }>;

function listQwenCandidates(
  projectsDir: string,
  scopeRoots: readonly string[] | null | undefined,
  lookupId: string | null,
): QwenCandidate[] {
  const candidates: QwenCandidate[] = [];
  for (const projectEntry of safeReadDir(projectsDir)) {
    if (!projectEntry.isDirectory()) continue;
    // The folder is Qwen's lossy slug of the project root. It cannot be turned
    // back into a path, but a slug that does not start with a scope root's slug
    // cannot hold a session inside it, so those folders are skipped unopened.
    if (!slugMatchesScopeRoots(projectEntry.name, scopeRoots, qwenProjectSlugForCwd)) continue;
    const chatsDir = path.join(projectsDir, projectEntry.name, "chats");
    const fileNames = lookupId
      ? [`${lookupId}.jsonl`]
      : safeReadDir(chatsDir)
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => entry.name);
    for (const fileName of fileNames) {
      const id = path.basename(fileName, ".jsonl");
      if (!id) continue;
      const candidate = sessionFileCandidate(path.join(chatsDir, fileName), { id });
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

function runtimeWorkDir(sessionFile: string): string | null {
  const sidecar = sessionFile.replace(/\.jsonl$/u, ".runtime.json");
  const text = readFilePrefix(sidecar, 64 * 1024);
  return text ? asString(asRecord(safeParseJson(text))?.work_dir) : null;
}

function qwenRecordFromCandidate(
  candidate: QwenCandidate,
  scopeRoots: readonly string[] | null | undefined,
): ExternalSessionDiscoveryRecord | null {
  const window = readJsonlWindow(candidate.filePath, candidate.size);
  const head = window.head;
  const tail = window.tail;
  const everything = window.all ?? [...head, ...tail];

  // The folder slug is not reversible, so the records' own `cwd` is the truth.
  const recordCwd = [...tail].reverse().map((record) => asString(record.cwd)).find(Boolean)
    ?? head.map((record) => asString(record.cwd)).find(Boolean)
    ?? runtimeWorkDir(candidate.filePath);
  const cwd = normalizeProviderCwd(recordCwd);
  if (!cwdIsInScope(cwd, scopeRoots)) return null;

  // ADE's own ACP chats never write `attribution_snapshot` (the interactive TUI
  // always does) and open with the ADE guidance block. Those belong to ADE's
  // chat list, not to the importer.
  const hasAttribution = head.some((record) => systemSubtype(record) === "attribution_snapshot");
  const firstPrompt = head.find(isQwenPromptRecord);
  if (!hasAttribution && startsWithAdeGuidance(qwenPartsText(asRecord(firstPrompt?.message)))) return null;

  const summary = summarizeNeutralRecords("qwen", {
    head: compact(head.map(neutralQwenRecord)),
    tail: compact(tail.map(neutralQwenRecord)),
    all: window.all ? compact(window.all.map(neutralQwenRecord)) : null,
  });
  if (!summary.hasPrompt) return null;

  const customTitle = everything
    .filter((record) => systemSubtype(record) === "custom_title")
    .map((record) => asString(asRecord(record.systemPayload)?.customTitle))
    .filter(Boolean)
    .at(-1);
  const model = everything
    .map((record) => (
      systemSubtype(record) === "session_model"
        ? asString(asRecord(record.systemPayload)?.modelId)
        : record.type === "assistant" ? asString(record.model) : null
    ))
    .filter((value): value is string => Boolean(value))
    .at(-1);
  const lastAt = [...tail].reverse().map((record) => asEpochMs(record.timestamp)).find((value) => value != null);

  return acpDiscoveryRecord({
    provider: "qwen",
    id: asString(head[0]?.sessionId) ?? candidate.id,
    cwd,
    title: cleanSessionTitle(customTitle),
    preview: summary.preview,
    messages: summary.messages,
    createdAt: head.map((record) => asEpochMs(record.timestamp)).find((value) => value != null) ?? null,
    updatedAt: Math.max(lastAt ?? 0, candidate.mtimeMs) || null,
    messageCount: summary.messageCount,
    launch: model ? { model } : null,
    filePath: candidate.filePath,
    sourceMtimeMs: candidate.mtimeMs,
    sizeBytes: candidate.size,
  });
}

/** Lists Qwen sessions from the provider's own on-disk store. */
export async function discoverQwenSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const lookupId = safeLookupId(args.sessionId);
  if (lookupId === false) return [];
  const projectsDir = path.join(qwenSessionRoot(args), "projects");
  return collectNewestSessions({
    candidates: listQwenCandidates(projectsDir, args.scopeRoots, lookupId),
    limit: normalizeExternalSessionLimit(args.limit),
    lookupId,
    read: (candidate) => qwenRecordFromCandidate(candidate, args.scopeRoots),
  });
}
