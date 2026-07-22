import fs from "node:fs";
import path from "node:path";
import {
  asEpochMs,
  asRecord,
  asString,
  cleanSessionTitle,
  countJsonlUserMessagesCheap,
  cwdIsInScope,
  firstUserTextFromRecords,
  normalizeExternalSessionLimit,
  readFilePrefix,
  readFileSuffix,
  readJsonlRecords,
  recordWithFile,
  resolveHomeDir,
  safeParseJson,
  safeReadDir,
  sessionFileCandidate,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";
import type {
  AgentChatCodexApprovalPolicy,
  AgentChatCodexSandbox,
  AgentChatPermissionMode,
  TerminalResumeLaunchConfig,
} from "../../../shared/types";

const CODEX_LAUNCH_BACKWARD_SCAN_CHUNK_BYTES = 256 * 1024;
const CODEX_LAUNCH_BACKWARD_SCAN_MAX_BYTES = 64 * 1024 * 1024;
const CODEX_LAUNCH_BACKWARD_SCAN_MAX_LINE_BYTES = 1024 * 1024;

type CodexIndexEntry = {
  id: string;
  title: string | null;
  updatedAt: number | null;
};

type CodexSessionMeta = {
  id: string;
  cwd: string | null;
  createdAt: number | null;
  title: string | null;
  first: Record<string, unknown>;
  payload: Record<string, unknown>;
};

type CodexSessionCandidate = ExternalSessionFileCandidate<{ meta?: CodexSessionMeta | null }>;

const CODEX_PROJECT_SCOPE_SCAN_CEILING = 2000;
const CODEX_RECENT_SCAN_FLOOR = 1000;

function readCodexIndex(indexPath: string): Map<string, CodexIndexEntry> {
  const map = new Map<string, CodexIndexEntry>();
  const text = readFileSuffix(indexPath, 2 * 1024 * 1024);
  if (!text) return map;
  for (const line of text.split(/\r?\n/u)) {
    const record = asRecord(safeParseJson(line));
    if (!record) continue;
    const id = asString(record.id) ?? asString(record.session_id) ?? asString(record.sessionId);
    if (!id) continue;
    map.set(id, {
      id,
      title: cleanSessionTitle(asString(record.thread_name))
        ?? cleanSessionTitle(asString(record.threadName))
        ?? cleanSessionTitle(asString(record.name))
        ?? cleanSessionTitle(asString(record.title)),
      updatedAt: asEpochMs(record.updated_at) ?? asEpochMs(record.updatedAt) ?? null,
    });
  }
  return map;
}

function titleFromCodexPayload(payload: Record<string, unknown>, indexed: CodexIndexEntry | undefined): string | null {
  return cleanSessionTitle(asString(payload.thread_name))
    ?? cleanSessionTitle(asString(payload.threadName))
    ?? cleanSessionTitle(asString(payload.name))
    ?? indexed?.title
    ?? null;
}

function readCodexSessionMeta(filePath: string): CodexSessionMeta | null {
  const text = readFilePrefix(filePath, 64 * 1024);
  const line = text?.split(/\r?\n/u).find((entry) => entry.trim().length > 0);
  if (!line) return null;
  const first = asRecord(safeParseJson(line));
  const payload = asRecord(first?.payload);
  const type = asString(first?.type);
  if (type !== "session_meta" || !payload || !first) return null;
  const id = asString(payload.id) ?? asString(payload.session_id) ?? asString(payload.sessionId);
  if (!id) return null;
  return {
    id,
    cwd: asString(payload.cwd),
    createdAt: asEpochMs(payload.timestamp) ?? asEpochMs(first.timestamp),
    title: titleFromCodexPayload(payload, undefined),
    first,
    payload,
  };
}

function sortedChildDirs(dir: string, pattern: RegExp): string[] {
  return safeReadDir(dir)
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
}

export function matchesCodexLookup(entryName: string, sessionId: string | null): boolean {
  if (!sessionId) return true;
  return entryName.endsWith(`-${sessionId}.jsonl`) || entryName.endsWith(`-${sessionId}.jsonl.zst`);
}

export function probeCodexRolloutFile(
  threadId: string,
  opts: { codexHome?: string; maxEntries?: number; maxDurationMs?: number } = {},
): boolean | null {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) return false;
  const configuredHome = opts.codexHome?.trim()
    || (typeof process.env.CODEX_HOME === "string" ? process.env.CODEX_HOME.trim() : "");
  const sessionsDir = path.join(configuredHome ? path.resolve(configuredHome) : path.join(resolveHomeDir({}), ".codex"), "sessions");
  const maxEntries = Math.max(1, Math.min(opts.maxEntries ?? 4_096, 20_000));
  const maxDurationMs = Math.max(1, Math.min(opts.maxDurationMs ?? 50, 500));
  const deadline = Date.now() + maxDurationMs;
  const pending = [sessionsDir];
  let scanned = 0;

  try {
    if (!fs.existsSync(sessionsDir)) return false;
    while (pending.length) {
      if (scanned >= maxEntries || Date.now() > deadline) return null;
      const dir = pending.pop()!;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (scanned >= maxEntries || Date.now() > deadline) return null;
        scanned += 1;
        if (entry.isFile() && matchesCodexLookup(entry.name, normalizedThreadId)) return true;
        if (entry.isDirectory()) pending.push(path.join(dir, entry.name));
      }
    }
    return false;
  } catch {
    return null;
  }
}

function collectRecentCodexSessionCandidates(
  root: string,
  limit: number,
  sessionId: string | null = null,
): CodexSessionCandidate[] {
  const candidates: CodexSessionCandidate[] = [];
  const years = sortedChildDirs(root, /^\d{4}$/u);
  for (const year of years) {
    const yearDir = path.join(root, year);
    for (const month of sortedChildDirs(yearDir, /^\d{2}$/u)) {
      const monthDir = path.join(yearDir, month);
      for (const day of sortedChildDirs(monthDir, /^\d{2}$/u)) {
        const dayDir = path.join(monthDir, day);
        for (const entry of safeReadDir(dayDir)) {
          if (!entry.isFile() || (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".jsonl.zst"))) {
            continue;
          }
          if (!matchesCodexLookup(entry.name, sessionId)) continue;
          const candidate = sessionFileCandidate(path.join(dayDir, entry.name), {});
          if (candidate) candidates.push(candidate);
        }
      }
    }
  }
  return sortFileCandidatesByMtime(candidates, limit);
}

function codexHomeDir(args: ExternalSessionDiscoveryArgs): string {
  const env = args.env ?? (args.homeDir ? undefined : process.env);
  const configured = typeof env?.CODEX_HOME === "string" ? env.CODEX_HOME.trim() : "";
  return configured ? path.resolve(configured) : path.join(resolveHomeDir(args), ".codex");
}

function isImportableCodexSession(meta: CodexSessionMeta): boolean {
  const source = asString(meta.payload.source)?.toLowerCase() ?? null;
  const originator = asString(meta.payload.originator)?.toLowerCase() ?? null;
  const agentRole = asString(meta.payload.agent_role) ?? asString(meta.payload.agentRole);
  if (agentRole) return false;
  if (source === "exec" || source === "vscode") return false;
  if (source && source !== "cli" && source !== "user_shell") return false;
  if (!originator) return true;
  return !(
    originator === "ade"
    || originator === "ade_desktop"
    || originator === "codex desktop"
    || originator === "codex_exec"
    || originator.startsWith("codex_sdk")
    || originator.startsWith("ade-title")
  );
}

function firstCodexUserText(records: unknown[]): string | null {
  const canonical = records.filter((item) => {
    const record = asRecord(item);
    const payload = asRecord(record?.payload);
    if (asString(record?.type)?.toLowerCase() !== "event_msg") return false;
    const type = asString(payload?.type)?.toLowerCase();
    const role = asString(payload?.role)?.toLowerCase();
    return type === "user_message" || (type === "message" && role === "user");
  });
  return canonical.length
    ? firstUserTextFromRecords(canonical)
    : firstUserTextFromRecords(records);
}

function codexApprovalPolicy(payload: Record<string, unknown>): AgentChatCodexApprovalPolicy | null {
  const value = (
    asString(payload.approval_policy)
    ?? asString(payload.approvalPolicy)
    ?? ""
  ).toLowerCase();
  if (value === "untrusted" || value === "on-request" || value === "on-failure" || value === "never") {
    return value;
  }
  return null;
}

function codexSandbox(payload: Record<string, unknown>): AgentChatCodexSandbox | null {
  const sandbox = asRecord(payload.sandbox_policy) ?? asRecord(payload.sandboxPolicy);
  const value = (
    asString(sandbox?.type)
    ?? asString(payload.sandbox_mode)
    ?? asString(payload.sandboxMode)
    ?? ""
  ).toLowerCase();
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  return null;
}

function codexPermissionMode(
  approvalPolicy: AgentChatCodexApprovalPolicy | null,
  sandbox: AgentChatCodexSandbox | null,
): AgentChatPermissionMode | null {
  if (approvalPolicy === "never" && sandbox === "danger-full-access") return "full-auto";
  if (approvalPolicy === "untrusted" && sandbox === "workspace-write") return "edit";
  if (approvalPolicy === "on-request" && sandbox === "workspace-write") return "default";
  if (approvalPolicy === "on-request" && sandbox === "read-only") return "plan";
  return null;
}

function codexLaunchFromRecords(records: unknown[]): TerminalResumeLaunchConfig | null {
  let launch: TerminalResumeLaunchConfig | null = null;
  for (const item of records) {
    const record = asRecord(item);
    if (asString(record?.type)?.toLowerCase() !== "turn_context") continue;
    const payload = asRecord(record?.payload);
    if (!payload) continue;
    const model = asString(payload.model) ?? asString(payload.model_id) ?? asString(payload.modelId);
    const reasoningEffort = asString(payload.effort)
      ?? asString(payload.reasoning_effort)
      ?? asString(payload.reasoningEffort);
    const approvalPolicy = codexApprovalPolicy(payload);
    const sandbox = codexSandbox(payload);
    const permissionMode = codexPermissionMode(approvalPolicy, sandbox);
    const serviceTier = (asString(payload.service_tier) ?? asString(payload.serviceTier) ?? "").toLowerCase();
    const next: TerminalResumeLaunchConfig = {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(approvalPolicy ? { codexApprovalPolicy: approvalPolicy } : {}),
      ...(sandbox ? { codexSandbox: sandbox } : {}),
      ...(approvalPolicy && sandbox ? { codexConfigSource: "flags" as const } : {}),
      ...(serviceTier === "fast" ? { fastMode: true } : {}),
      ...(serviceTier === "default" || serviceTier === "standard" ? { fastMode: false } : {}),
      ...(serviceTier && serviceTier !== "fast" && serviceTier !== "default" && serviceTier !== "standard"
        ? { fastMode: null }
        : {}),
    };
    if (Object.keys(next).length) launch = { ...(launch ?? {}), ...next };
  }
  return launch;
}

async function latestCodexLaunchFromFile(
  filePath: string,
  logger: ExternalSessionDiscoveryArgs["logger"],
): Promise<TerminalResumeLaunchConfig | null> {
  let handle: fs.promises.FileHandle | null = null;
  let launch: TerminalResumeLaunchConfig | null = null;
  try {
    handle = await fs.promises.open(filePath, "r");
    const stat = await handle.stat();
    let position = stat.size;
    let bytesScanned = 0;
    let partialLeadingLine = Buffer.alloc(0);
    while (position > 0 && bytesScanned < CODEX_LAUNCH_BACKWARD_SCAN_MAX_BYTES) {
      const bytesToRead = Math.min(
        CODEX_LAUNCH_BACKWARD_SCAN_CHUNK_BYTES,
        position,
        CODEX_LAUNCH_BACKWARD_SCAN_MAX_BYTES - bytesScanned,
      );
      const start = position - bytesToRead;
      const chunk = Buffer.allocUnsafe(bytesToRead);
      const { bytesRead } = await handle.read(chunk, 0, bytesToRead, start);
      if (bytesRead <= 0) break;
      const combined = Buffer.concat([chunk.subarray(0, bytesRead), partialLeadingLine]);
      let completeStart = 0;
      if (start > 0) {
        const firstNewline = combined.indexOf(0x0a);
        if (firstNewline < 0) {
          // turn_context rows are tiny. Do not repeatedly concatenate an
          // unbounded tool-output row while walking backwards through a large
          // rollout; once its fragment exceeds this cap, discard that row and
          // keep searching for the preceding newline/context.
          partialLeadingLine = combined.length <= CODEX_LAUNCH_BACKWARD_SCAN_MAX_LINE_BYTES
            ? combined
            : Buffer.alloc(0);
          position = start;
          bytesScanned += bytesRead;
          continue;
        }
        partialLeadingLine = Buffer.from(combined.subarray(0, firstNewline));
        completeStart = firstNewline + 1;
      } else {
        partialLeadingLine = Buffer.alloc(0);
      }
      const lines = combined.subarray(completeStart).toString("utf8").split(/\r?\n/u);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line?.includes("turn_context")) continue;
        const record = safeParseJson(line);
        const olderLaunch = record ? codexLaunchFromRecords([record]) : null;
        if (!olderLaunch) continue;
        // Records are visited newest-first. Fill fields omitted by a partial
        // newest context from the prior context without overwriting newer data.
        launch = { ...olderLaunch, ...(launch ?? {}) };
        if (
          launch.model?.trim()
          && launch.reasoningEffort?.trim()
          && launch.codexApprovalPolicy
          && launch.codexSandbox
        ) return launch;
      }
      position = start;
      bytesScanned += bytesRead;
    }
    if (position > 0) {
      logger?.warn?.("external_sessions.codex_launch_scan_truncated", {
        filePath,
        bytesScanned,
        fileSize: stat.size,
      });
    }
    return launch;
  } catch {
    return launch;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function codexLaunchForFile(
  filePath: string,
  prefixRecords: unknown[],
  exactLookup: boolean,
  logger: ExternalSessionDiscoveryArgs["logger"],
): Promise<TerminalResumeLaunchConfig | null> {
  const prefixLaunch = codexLaunchFromRecords(prefixRecords);
  if (!exactLookup) return prefixLaunch;
  const latestLaunch = await latestCodexLaunchFromFile(filePath, logger);
  if (latestLaunch) return latestLaunch;
  if (!prefixLaunch) return null;
  const fallback: TerminalResumeLaunchConfig = {
    ...(prefixLaunch.model !== undefined ? { model: prefixLaunch.model } : {}),
    ...(prefixLaunch.reasoningEffort !== undefined ? { reasoningEffort: prefixLaunch.reasoningEffort } : {}),
    ...(prefixLaunch.fastMode !== undefined ? { fastMode: prefixLaunch.fastMode } : {}),
    ...(prefixLaunch.codexFastMode !== undefined ? { codexFastMode: prefixLaunch.codexFastMode } : {}),
  };
  return Object.keys(fallback).length ? fallback : null;
}

function collectProjectScopedCodexSessionCandidates(
  root: string,
  limit: number,
  scopeRoots: string[],
  logger: ExternalSessionDiscoveryArgs["logger"],
  sessionId: string | null = null,
): CodexSessionCandidate[] {
  const candidates: CodexSessionCandidate[] = [];
  let scanned = 0;
  let ceilingHit = false;
  const finish = (): CodexSessionCandidate[] => {
    if (ceilingHit && candidates.length < limit) {
      logger?.warn?.("external_sessions.codex_project_scope_scan_truncated", {
        ceiling: CODEX_PROJECT_SCOPE_SCAN_CEILING,
        scanned,
        matched: candidates.length,
        limit,
      });
    }
    return sortFileCandidatesByMtime(candidates, limit);
  };

  const years = sortedChildDirs(root, /^\d{4}$/u);
  for (const year of years) {
    const yearDir = path.join(root, year);
    for (const month of sortedChildDirs(yearDir, /^\d{2}$/u)) {
      const monthDir = path.join(yearDir, month);
      for (const day of sortedChildDirs(monthDir, /^\d{2}$/u)) {
        const dayDir = path.join(monthDir, day);
        for (const entry of safeReadDir(dayDir)) {
          if (!entry.isFile() || (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".jsonl.zst"))) {
            continue;
          }
          if (!matchesCodexLookup(entry.name, sessionId)) continue;
          const candidate = sessionFileCandidate(path.join(dayDir, entry.name), {});
          if (!candidate) continue;
          if (scanned >= CODEX_PROJECT_SCOPE_SCAN_CEILING) {
            ceilingHit = true;
            return finish();
          }
          scanned += 1;
          if (candidate.filePath.endsWith(".jsonl.zst")) continue;
          const meta = readCodexSessionMeta(candidate.filePath);
          if (!cwdIsInScope(meta?.cwd, scopeRoots)) continue;
          candidates.push({ ...candidate, meta });
          if (candidates.length >= limit) return finish();
        }
      }
    }
  }
  return finish();
}

function idFromCodexFilename(filePath: string): string | null {
  const base = path.basename(filePath).replace(/\.jsonl(?:\.zst)?$/u, "");
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu);
  return match?.[1] ?? null;
}

/**
 * Resolve a Codex rollout file path by session/thread id with NO originator
 * filtering. `discoverCodexSessions` is the external-import surface and
 * deliberately excludes ADE-originated rollouts (`isImportableCodexSession`),
 * which makes it wrong for flows that need ADE's own sessions — e.g. packaging
 * a cross-machine fork of an ADE-created Codex chat. Mirrors codex's own
 * filename-suffix lookup; returns the newest match or null.
 */
export function findCodexRolloutPathBySessionId(
  sessionId: string,
  args: ExternalSessionDiscoveryArgs = {},
): string | null {
  const lookupId = sessionId.trim();
  if (!lookupId) return null;
  const sessionsDir = path.join(codexHomeDir(args), "sessions");
  if (!fs.existsSync(sessionsDir)) return null;
  const candidates = collectRecentCodexSessionCandidates(sessionsDir, 1, lookupId);
  return candidates[0]?.filePath ?? null;
}

export async function discoverCodexSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const lookupId = args.sessionId?.trim() || null;
  const codexDir = codexHomeDir(args);
  const sessionsDir = path.join(codexDir, "sessions");
  const index = readCodexIndex(path.join(codexDir, "session_index.jsonl"));
  const recordsById = new Map<string, ExternalSessionDiscoveryRecord>();
  if (!fs.existsSync(sessionsDir)) return [];

  const scanLimit = Math.max(CODEX_RECENT_SCAN_FLOOR, limit * 20);
  const candidates = args.scopeRoots?.length
    ? collectProjectScopedCodexSessionCandidates(sessionsDir, scanLimit, args.scopeRoots, args.logger, lookupId)
    : collectRecentCodexSessionCandidates(sessionsDir, scanLimit, lookupId);

  for (const candidate of candidates) {
    const filePath = candidate.filePath;
    const compressed = filePath.endsWith(".jsonl.zst");
    if (compressed) {
      const id = idFromCodexFilename(filePath);
      if (!id || (lookupId && id !== lookupId) || recordsById.has(id)) continue;
      const indexed = index.get(id);
      recordsById.set(id, recordWithFile({
        provider: "codex",
        id,
        cwd: null,
        title: indexed?.title ?? null,
        preview: null,
        updatedAt: indexed?.updatedAt ?? candidate.mtimeMs,
        filePath,
        sourceMtimeMs: candidate.mtimeMs,
      }));
      continue;
    }

    const jsonl = readJsonlRecords(filePath);
    const first = candidate.meta?.first ?? asRecord(jsonl[0]);
    const payload = candidate.meta?.payload ?? asRecord(first?.payload);
    const type = asString(first?.type);
    if (type !== "session_meta" || !payload) continue;
    const meta = candidate.meta ?? readCodexSessionMeta(filePath);
    if (!meta || !isImportableCodexSession(meta)) continue;
    const id = candidate.meta?.id ?? asString(payload.id) ?? asString(payload.session_id) ?? asString(payload.sessionId);
    if (!id || (lookupId && id !== lookupId) || recordsById.has(id)) continue;
    const indexed = index.get(id);
    const firstUserText = firstCodexUserText(jsonl);
    const title = candidate.meta?.title ?? titleFromCodexPayload(payload, indexed);
    const launch = await codexLaunchForFile(filePath, jsonl, lookupId != null, args.logger);
    recordsById.set(id, recordWithFile({
      provider: "codex",
      id,
      cwd: candidate.meta?.cwd ?? asString(payload.cwd),
      title,
      preview: firstUserText,
      createdAt: candidate.meta?.createdAt ?? asEpochMs(payload.timestamp) ?? asEpochMs(first?.timestamp),
      updatedAt: Math.max(indexed?.updatedAt ?? 0, candidate.mtimeMs),
      messageCount: countJsonlUserMessagesCheap(filePath, "codex"),
      launch,
      filePath,
      sourceMtimeMs: candidate.mtimeMs,
    }));
  }

  return sortDiscoveryRecords(Array.from(recordsById.values()), limit);
}
