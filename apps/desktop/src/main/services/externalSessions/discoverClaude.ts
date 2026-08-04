import type fs from "node:fs";
import path from "node:path";
import {
  claudeProjectSlugForCwd,
  cleanSessionTitle,
  countJsonlUserMessagesCheap,
  firstUserTextFromRecords,
  cwdIsInScope,
  isUuidLike,
  normalizeExternalSessionLimit,
  normalizeProviderCwd,
  readFileWindow,
  readJsonlRecords,
  readJsonlRecordsFromSuffix,
  recentExternalSessionMessagesFromRecords,
  recordWithFile,
  resolveHomeDir,
  safeReadDir,
  sessionFileCandidate,
  slugMatchesScopeRoots,
  sortFileCandidatesByMtime,
  sortDiscoveryRecords,
  asEpochMs,
  asRecord,
  asString,
  JSONL_SCAN_BYTE_LIMIT,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionFileCandidate,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

/** Window read when looking for the first or last record uuid, and when probing. */
const CLAUDE_CHAIN_WINDOW_BYTES = JSONL_SCAN_BYTE_LIMIT;
/**
 * How far into a transcript the walk for the first record uuid may go. One
 * pasted opening prompt can be hundreds of KB on its own, and roughly one
 * transcript in seven pushes its first uuid past a 64 KiB window.
 */
const CLAUDE_CHAIN_HEAD_MAX_BYTES = 4 * JSONL_SCAN_BYTE_LIMIT;
/** Overlap between successive windows so a uuid split across the seam is still seen. */
const CLAUDE_CHAIN_WINDOW_OVERLAP_BYTES = 256;
/** Window read from each side when sampling shared record uuids mid-file. */
const CLAUDE_CHAIN_SAMPLE_BYTES = 64 * 1024;
const CLAUDE_CHAIN_SAMPLE_FRACTIONS = [0.25, 0.5, 0.75] as const;
/** Entrypoint rows inspected at the head of a transcript to classify its origin. */
const CLAUDE_ENTRYPOINT_SAMPLE_SIZE = 20;

type ClaudeSessionCandidate = ExternalSessionFileCandidate<{ id: string }>;

type ClaudeChainSignature = {
  /** uuid of the first record that carries one; identifies the continuation chain. */
  chainKey: string | null;
  /** Snake-case `session_id` pointers to the session this transcript continues. */
  ancestorIds: string[];
  /** uuid of the last record that carries one. */
  lastUuid: string | null;
};

type ClaudeChainMember = {
  candidate: ClaudeSessionCandidate;
  signature: ClaudeChainSignature;
  /** Index of this member's row in the result array, so a leaf can replace it. */
  recordIndex: number;
};

type ClaudeChain = { members: ClaudeChainMember[] };

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

function claudeScanRecords(filePath: string): {
  prefix: unknown[];
  suffix: unknown[];
  combined: unknown[];
} {
  const prefix = readJsonlRecords(filePath);
  const suffix = readJsonlRecordsFromSuffix(filePath);
  return { prefix, suffix, combined: [...prefix, ...suffix] };
}

function latestClaudeCwd(records: unknown[]): string | null {
  for (const item of records.slice().reverse()) {
    // Normalized here rather than at the call site: this is where a transcript's
    // own recorded cwd first becomes an ADE value, and a CLI that opened the
    // workspace through a long-path handle writes the `\\?\` spelling.
    const cwd = normalizeProviderCwd(asString(asRecord(item)?.cwd));
    if (cwd) return cwd;
  }
  return null;
}

/**
 * A transcript is SDK-origin when the entrypoints it *starts* with are SDK ones,
 * which is how ADE's own Claude chats look. Classifying on any single `sdk` row
 * instead would hide a real CLI session the moment one SDK-driven turn landed in
 * it; those sessions resume fine and must stay listed.
 */
function isClaudeSdkOriginTranscript(records: unknown[]): boolean {
  const entrypoints: string[] = [];
  for (const item of records) {
    const entrypoint = asString(asRecord(item)?.entrypoint)?.toLowerCase();
    if (entrypoint) entrypoints.push(entrypoint);
    if (entrypoints.length >= CLAUDE_ENTRYPOINT_SAMPLE_SIZE) break;
  }
  if (!entrypoints.length) return false;
  const sdkCount = entrypoints.filter((entrypoint) => entrypoint.startsWith("sdk")).length;
  return sdkCount * 2 > entrypoints.length;
}

/**
 * Only `<projectSlug>/<uuid>.jsonl` is a resumable CLI session. Sidecar
 * transcripts live under `<sessionId>/subagents/**` (workflow runs included) and
 * outnumber real sessions roughly nine to one, so discovery never descends into
 * a project subdirectory, and non-uuid names such as `agent-*.jsonl` are ignored.
 */
function claudeTopLevelSessionId(entry: fs.Dirent): string | null {
  if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return null;
  const id = entry.name.slice(0, -".jsonl".length);
  return isUuidLike(id) ? id : null;
}

/**
 * Field-level scan rather than a per-line `JSON.parse`. A single tool result can
 * be larger than these windows, which leaves a window with no complete line and
 * would otherwise report a transcript as having no records at all.
 * `"parentUuid"` cannot match: the pattern anchors on the opening quote.
 */
function scanUuidField(text: string | null, field: "uuid" | "session_id"): string[] {
  if (!text) return [];
  const pattern = new RegExp(`"${field}"\\s*:\\s*"([0-9a-fA-F-]{36})"`, "gu");
  return [...text.matchAll(pattern)].map((match) => match[1]!);
}

/**
 * Chain identity for one transcript. The per-record camelCase `sessionId` is
 * always rewritten to match the filename, so it says nothing about ancestry; the
 * uuid of the first record survives every copy and separates chains exactly,
 * including chats whose opening text is identical because ADE injected the same
 * preamble. First-message text must never be used as the key.
 */
function claudeChainSignature(candidate: ClaudeSessionCandidate): ClaudeChainSignature {
  const ancestorIds = new Set<string>();
  let chainKey: string | null = null;
  const headCeiling = Math.min(candidate.size, CLAUDE_CHAIN_HEAD_MAX_BYTES);
  for (let offset = 0; offset < headCeiling; offset += CLAUDE_CHAIN_WINDOW_BYTES - CLAUDE_CHAIN_WINDOW_OVERLAP_BYTES) {
    const window = readFileWindow(candidate.filePath, offset, CLAUDE_CHAIN_WINDOW_BYTES);
    if (!window) break;
    for (const ancestorId of scanUuidField(window, "session_id")) {
      if (ancestorId !== candidate.id && isUuidLike(ancestorId)) ancestorIds.add(ancestorId);
    }
    chainKey = scanUuidField(window, "uuid")[0] ?? null;
    if (chainKey) break;
  }
  const tailOffset = Math.max(0, candidate.size - CLAUDE_CHAIN_WINDOW_BYTES);
  const tailUuids = scanUuidField(readFileWindow(candidate.filePath, tailOffset, CLAUDE_CHAIN_WINDOW_BYTES), "uuid");
  return { chainKey, ancestorIds: [...ancestorIds], lastUuid: tailUuids.at(-1) ?? null };
}

/**
 * True when `shorter`'s records are a prefix of (or identical to) `longer`'s.
 *
 * Both checks are needed. A resumed session appends in place, so a continuation
 * copy holds the shorter file's final record; a real `--fork-session` or rewind
 * branch does not. But a longer file can still contain the shorter file's last
 * record while having dropped records in between, so uuids sampled across the
 * shorter file must also appear in the longer one at the same rough offsets.
 * Copies rewrite `sessionId` in place with a same-length uuid, which keeps byte
 * offsets aligned to within a few KB of the sampling windows.
 */
function isClaudeContinuationPrefix(
  shorter: ClaudeSessionCandidate,
  shorterSignature: ClaudeChainSignature,
  longer: ClaudeSessionCandidate,
): boolean {
  if (!shorterSignature.lastUuid || shorter.size > longer.size) return false;
  const probeStart = Math.max(0, shorter.size - Math.floor(CLAUDE_CHAIN_WINDOW_BYTES / 2));
  const probe = readFileWindow(longer.filePath, probeStart, CLAUDE_CHAIN_WINDOW_BYTES);
  if (!probe?.includes(shorterSignature.lastUuid)) return false;
  for (const fraction of CLAUDE_CHAIN_SAMPLE_FRACTIONS) {
    const offset = Math.floor(shorter.size * fraction);
    const sampled = scanUuidField(readFileWindow(shorter.filePath, offset, CLAUDE_CHAIN_SAMPLE_BYTES), "uuid");
    const against = scanUuidField(readFileWindow(
      longer.filePath,
      Math.max(0, offset - CLAUDE_CHAIN_SAMPLE_BYTES),
      CLAUDE_CHAIN_SAMPLE_BYTES * 3,
    ), "uuid");
    // One record can span the whole window; a sample with no uuid on either side says nothing.
    if (!sampled.length || !against.length) continue;
    if (!sampled.some((uuid) => against.includes(uuid))) return false;
  }
  return true;
}

function claudeChainKeys(candidate: ClaudeSessionCandidate, signature: ClaudeChainSignature): string[] {
  const keys = [`id:${candidate.id}`];
  if (signature.chainKey) keys.push(`chain:${signature.chainKey}`);
  for (const ancestorId of signature.ancestorIds) keys.push(`id:${ancestorId}`);
  return keys;
}

/**
 * Returns the chain these keys belong to, merging any chains they join. A
 * transcript can arrive keyed by its first record while an already-listed one
 * pointed at it by `session_id`, so the two groups have to become one.
 */
function claimClaudeChain(index: Map<string, ClaudeChain>, keys: string[]): ClaudeChain {
  const joined = new Set<ClaudeChain>();
  for (const key of keys) {
    const existing = index.get(key);
    if (existing) joined.add(existing);
  }
  if (joined.size === 1) {
    const [only] = joined;
    for (const key of keys) index.set(key, only);
    return only;
  }
  const merged: ClaudeChain = { members: [] };
  for (const chain of joined) merged.members.push(...chain.members);
  if (joined.size) {
    for (const [key, chain] of index) {
      if (joined.has(chain)) index.set(key, merged);
    }
  }
  for (const key of keys) index.set(key, merged);
  return merged;
}

/**
 * Ids a listed row now stands for. Only the leaf of a continuation chain is
 * listed, so an import recorded against an earlier id in the same chain has to
 * be recognizable from the leaf.
 */
function addClaudeLineage(record: ExternalSessionDiscoveryRecord, ids: Array<string | null | undefined>): void {
  const lineage = new Set(record.lineageIds ?? []);
  for (const id of ids) {
    const clean = id?.trim();
    if (clean && clean !== record.id) lineage.add(clean);
  }
  if (lineage.size) record.lineageIds = [...lineage];
}

export async function discoverClaudeSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const limit = normalizeExternalSessionLimit(args.limit);
  const projectsDir = path.join(claudeConfigDir(args), "projects");
  const lookupId = args.sessionId?.trim() || null;
  if (lookupId && !isUuidLike(lookupId)) return [];
  const candidates: ClaudeSessionCandidate[] = [];

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
      const id = claudeTopLevelSessionId(entry);
      if (!id) continue;
      const candidate = sessionFileCandidate(path.join(projectDir, entry.name), { id });
      if (candidate) candidates.push(candidate);
    }
  }

  const newestById = new Map<string, ClaudeSessionCandidate>();
  for (const candidate of sortFileCandidatesByMtime(candidates, candidates.length)) {
    if (!newestById.has(candidate.id)) newestById.set(candidate.id, candidate);
  }

  const records: ExternalSessionDiscoveryRecord[] = [];
  // Continuation chains cross project directories — a session moved with `/cd`
  // lands in another slug — so chains are tracked globally, not per project dir.
  const chainIndex = new Map<string, ClaudeChain>();
  for (const candidate of newestById.values()) {
    const scan = claudeScanRecords(candidate.filePath);
    const jsonl = scan.combined;
    if (isClaudeSdkOriginTranscript(scan.prefix)) continue;
    const cwd = latestClaudeCwd(jsonl);
    let createdAt: number | null = null;
    for (const item of jsonl) {
      const record = asRecord(item);
      if (!record) continue;
      createdAt = createdAt ?? asEpochMs(record.timestamp);
      if (createdAt) break;
    }
    if (!cwdIsInScope(cwd, args.scopeRoots)) continue;
    const firstUserText = firstUserTextFromRecords(scan.prefix);
    const record = recordWithFile({
      provider: "claude",
      id: candidate.id,
      cwd,
      title: explicitClaudeTitleFromRecords(jsonl),
      preview: firstUserText,
      messages: recentExternalSessionMessagesFromRecords(scan.suffix),
      createdAt,
      messageCount: countJsonlUserMessagesCheap(candidate.filePath, "claude"),
      filePath: candidate.filePath,
      sourceMtimeMs: candidate.mtimeMs,
    });

    // An exact lookup already names the session the caller wants; it must resolve
    // even when that session is an ancestor of a newer continuation.
    const signature = lookupId ? null : claudeChainSignature(candidate);
    const chain = signature
      ? claimClaudeChain(chainIndex, claudeChainKeys(candidate, signature))
      : null;
    if (chain && signature) {
      const listedLeaf = chain.members.find(
        (member) => isClaudeContinuationPrefix(candidate, signature, member.candidate),
      );
      if (listedLeaf) {
        addClaudeLineage(records[listedLeaf.recordIndex]!, [candidate.id, ...signature.ancestorIds]);
        continue;
      }
      const listedAncestor = chain.members.find(
        (member) => isClaudeContinuationPrefix(member.candidate, member.signature, candidate),
      );
      if (listedAncestor) {
        const superseded = records[listedAncestor.recordIndex]!;
        addClaudeLineage(record, [
          ...(superseded.lineageIds ?? []),
          superseded.id,
          ...signature.ancestorIds,
        ]);
        records[listedAncestor.recordIndex] = record;
        listedAncestor.candidate = candidate;
        listedAncestor.signature = signature;
        continue;
      }
      // Diverging members are real forks. Both stay listed.
    }

    if (signature) addClaudeLineage(record, signature.ancestorIds);
    records.push(record);
    if (chain && signature) chain.members.push({ candidate, signature, recordIndex: records.length - 1 });
    if (records.length >= limit) break;
  }

  return sortDiscoveryRecords(records, limit);
}
