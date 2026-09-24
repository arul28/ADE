import path from "node:path";
import { copilotConfigHome } from "../shared/providerConfigHomes";
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
  safeReadDir,
  safeStat,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";
import {
  acpDiscoveryRecord,
  collectNewestSessions,
  compact,
  neutralRecord,
  readJsonlWindow,
  safeLookupId,
  summarizeNeutralRecords,
  type NeutralSessionRecord,
} from "./discoverAcpShared";

/**
 * GitHub Copilot CLI (verified against 1.0.88) keeps each session in
 * `$COPILOT_HOME/session-state/<uuid>/` (`COPILOT_HOME` defaults to
 * `~/.copilot`):
 *
 * - `workspace.yaml` — flat `key: value` lines: `id, cwd, git_root, branch,
 *   client_name, name, summary, created_at, updated_at`. `name` is sometimes a
 *   `|-` block scalar.
 * - `events.jsonl` — `{ type, data, id, timestamp }`: `session.start`
 *   (`data.context.cwd`), `user.message` (`data.content`, `data.source`),
 *   `assistant.message` (`data.content`, `data.toolRequests`),
 *   `tool.execution_start|complete`, `session.model_change` (`data.newModel`).
 *
 * Sessions created by ADE itself (`client_name` `ade`, `ade-probe`,
 * `ade-telemetry-probe`, …) and folders without a single prompt are left out.
 */
function copilotSessionStateDir(args: ExternalSessionDiscoveryArgs): string {
  return path.join(
    copilotConfigHome({ env: args.env ?? process.env, homeDir: resolveHomeDir(args) }),
    "session-state",
  );
}

function unquoteYamlScalar(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/gu, "'");
  }
  return value;
}

/**
 * Top-level scalars of a flat YAML document. Handles plain, quoted, and block
 * (`|`, `|-`, `>`, `>-`) values; nested maps and lists are skipped. Enough for
 * Copilot's `workspace.yaml` without taking a YAML dependency.
 */
export function parseFlatYaml(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s+(.*))?$/u.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const rawValue = (match[2] ?? "").replace(/\s+#.*$/u, "").trim();
    const block = /^([|>])([+-]?)$/u.exec(rawValue);
    if (block) {
      const body: string[] = [];
      while (index + 1 < lines.length) {
        const next = lines[index + 1] ?? "";
        if (next.trim() && !/^\s/u.test(next)) break;
        body.push(next);
        index += 1;
      }
      const indent = Math.min(...body.filter((entry) => entry.trim()).map((entry) => /^\s*/u.exec(entry)![0].length));
      const stripped = body.map((entry) => entry.slice(Number.isFinite(indent) ? indent : 0));
      const joined = block[1] === ">"
        ? stripped.join(" ").replace(/\s+/gu, " ")
        : stripped.join("\n");
      result[key] = block[2] === "+" ? joined : joined.replace(/\s+$/u, "");
      continue;
    }
    if (!rawValue) continue;
    result[key] = unquoteYamlScalar(rawValue);
  }
  return result;
}

function copilotEventText(record: Record<string, unknown>): string | null {
  const content = asRecord(record.data)?.content;
  return typeof content === "string" ? content : null;
}

/**
 * A prompt the person typed. Autopilot writes its own "keep going" turns as
 * `user.message` with `source: "autopilot"`; those are not prompts.
 */
export function isCopilotPrompt(record: Record<string, unknown>): boolean {
  if (record.type !== "user.message") return false;
  const source = asString(asRecord(record.data)?.source);
  return source == null || source === "user";
}

function neutralCopilotRecord(record: Record<string, unknown>): NeutralSessionRecord | null {
  if (isCopilotPrompt(record)) return neutralRecord("user", copilotEventText(record), asString(record.timestamp));
  if (record.type === "assistant.message") {
    return neutralRecord("assistant", copilotEventText(record), asString(record.timestamp));
  }
  return null;
}

type CopilotCandidate = {
  id: string;
  workspace: Record<string, string>;
  eventsPath: string;
  mtimeMs: number;
  size: number;
};

function listCopilotCandidates(args: ExternalSessionDiscoveryArgs, lookupId: string | null): CopilotCandidate[] {
  const stateDir = copilotSessionStateDir(args);
  const ids = lookupId
    ? [lookupId]
    : safeReadDir(stateDir).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const candidates: CopilotCandidate[] = [];
  for (const id of ids) {
    const sessionDir = path.join(stateDir, id);
    const eventsPath = path.join(sessionDir, "events.jsonl");
    const stat = safeStat(eventsPath);
    if (!stat?.isFile() || stat.size === 0) continue;
    const workspace = parseFlatYaml(readFilePrefix(path.join(sessionDir, "workspace.yaml"), 64 * 1024) ?? "");
    if (workspace.client_name?.toLowerCase().startsWith("ade")) continue;
    // `workspace.yaml` names the cwd, so an out-of-scope session is dropped
    // before its (often multi-megabyte) event log is opened.
    const yamlCwd = normalizeProviderCwd(workspace.cwd);
    if (yamlCwd && !cwdIsInScope(yamlCwd, args.scopeRoots)) continue;
    candidates.push({ id, workspace, eventsPath, mtimeMs: Math.floor(stat.mtimeMs), size: stat.size });
  }
  return candidates;
}

function copilotRecordFromCandidate(
  candidate: CopilotCandidate,
  scopeRoots: readonly string[] | null | undefined,
): ExternalSessionDiscoveryRecord | null {
  const window = readJsonlWindow(candidate.eventsPath, candidate.size);
  const start = window.head.find((record) => record.type === "session.start");
  const startData = asRecord(start?.data);
  const cwd = normalizeProviderCwd(
    candidate.workspace.cwd ?? asString(asRecord(startData?.context)?.cwd),
  );
  if (!cwdIsInScope(cwd, scopeRoots)) return null;

  const summary = summarizeNeutralRecords("copilot", {
    head: compact(window.head.map(neutralCopilotRecord)),
    tail: compact(window.tail.map(neutralCopilotRecord)),
    all: window.all ? compact(window.all.map(neutralCopilotRecord)) : null,
  });
  if (!summary.hasPrompt) return null;

  const everything = window.all ?? [...window.head, ...window.tail];
  // The user's own pick (start, resume or /model) wins. `shutdown.currentModel`
  // is only a fallback: under "auto" it names the router's choice, which
  // `copilot --model` rejects (1.0.88 prints "not available" and uses auto).
  const selectedModel = everything
    .map((record) => {
      const data = asRecord(record.data);
      if (record.type === "session.start" || record.type === "session.resume") return asString(data?.selectedModel);
      if (record.type === "session.model_change") return asString(data?.newModel);
      return null;
    })
    .filter((value): value is string => Boolean(value))
    .at(-1);
  const shutdownModel = everything
    .map((record) => (record.type === "session.shutdown" ? asString(asRecord(record.data)?.currentModel) : null))
    .filter((value): value is string => Boolean(value))
    .at(-1);
  // "auto" is Copilot's router, not a model; leaving it out lets the resumed
  // CLI apply its own default rather than pinning a `--model auto` flag.
  const recorded = selectedModel ?? shutdownModel ?? null;
  const model = recorded === "auto" ? null : recorded;
  const updatedAt = asEpochMs(candidate.workspace.updated_at);

  return acpDiscoveryRecord({
    provider: "copilot",
    id: candidate.workspace.id?.trim() || asString(startData?.sessionId) || candidate.id,
    cwd,
    title: cleanSessionTitle(candidate.workspace.name) ?? cleanSessionTitle(candidate.workspace.summary),
    preview: summary.preview,
    messages: summary.messages,
    createdAt: asEpochMs(candidate.workspace.created_at) ?? asEpochMs(startData?.startTime),
    updatedAt: Math.max(updatedAt ?? 0, candidate.mtimeMs) || null,
    messageCount: summary.messageCount,
    launch: model ? { model } : null,
    filePath: candidate.eventsPath,
    sourceMtimeMs: candidate.mtimeMs,
    sizeBytes: candidate.size,
  });
}

/** Lists Copilot sessions from the provider's own on-disk store. */
export async function discoverCopilotSessions(
  args: ExternalSessionDiscoveryArgs = {},
): Promise<ExternalSessionDiscoveryRecord[]> {
  const lookupId = safeLookupId(args.sessionId);
  if (lookupId === false) return [];
  return collectNewestSessions({
    candidates: listCopilotCandidates(args, lookupId),
    limit: normalizeExternalSessionLimit(args.limit),
    lookupId,
    read: (candidate) => copilotRecordFromCandidate(candidate, args.scopeRoots),
  });
}
