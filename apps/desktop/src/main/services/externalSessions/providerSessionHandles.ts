import { execFile } from "node:child_process";
import path from "node:path";
import { resolveHomeDir } from "./discoveryUtils";
import { piSessionRootForEnvironment } from "../chat/piSessionStore";
import { isPathInside, pathKey } from "../shared/pathCompare";
import type { ExternalSessionProvider } from "../../../shared/types/externalSessions";
import { claudeConfigHome, codexConfigHome, factoryConfigHome } from "../shared/providerConfigHomes";

export type ProviderSessionHandle = {
  provider: ExternalSessionProvider;
  sessionId: string;
  filePath: string;
  pid: number;
};

export type HandleInspectionAvailability =
  | { available: true; method: "lsof" | "handle.exe" }
  | {
      available: false;
      reason: "windows_handle_enumeration_unavailable" | "lsof_unavailable";
    };

export type LiveProviderSessionIndex = {
  availability: HandleInspectionAvailability;
  /** Sessions currently held open by any inspected process. */
  byKey: Map<string, ProviderSessionHandle[]>;
};

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

/**
 * Handle enumeration shells out to `lsof`/`handle.exe`/`powershell.exe`, which
 * can take seconds on a busy machine. Every runner here is awaited so the
 * Electron main thread never blocks on one — callers may still inject a
 * synchronous implementation in tests.
 */
export type RunCommand = (
  command: string,
  args: string[],
  options?: { timeoutMs?: number },
) => CommandResult | Promise<CommandResult>;

const UUID_IN_PATH = /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/iu;
const CLI_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const HANDLE_CAPTURE_DELAYS_MS = [400, 1_200, 3_000, 8_000] as const;

export const PROVIDER_SESSION_HANDLE_CAPTURE_DELAYS_MS: readonly number[] = HANDLE_CAPTURE_DELAYS_MS;

function defaultRunCommand(command: string, args: string[], options?: { timeoutMs?: number }): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    try {
      execFile(
        command,
        args,
        {
          encoding: "utf8",
          timeout: options?.timeoutMs ?? 4_000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const status = error == null
            ? 0
            : (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null);
          resolve({
            status,
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            ...(error ? { error: error.message } : {}),
          });
        },
      );
    } catch (error) {
      resolve({
        status: null,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function providerSessionRoots(args: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): Array<{ provider: ExternalSessionProvider; root: string }> {
  const homeDir = resolveHomeDir(args);
  const env = args.env ?? process.env;
  const xdgData = typeof env.XDG_DATA_HOME === "string" && env.XDG_DATA_HOME.trim()
    ? env.XDG_DATA_HOME.trim()
    : path.join(homeDir, ".local", "share");
  // Each provider's config-dir override has its own shape; providerConfigHomes
  // keeps them straight so ADE reads the same directory the CLI writes.
  const providerEnv = { ...env, HOME: homeDir };
  return [
    { provider: "claude", root: path.join(claudeConfigHome(providerEnv), "projects") },
    { provider: "codex", root: path.join(codexConfigHome(providerEnv), "sessions") },
    { provider: "droid", root: path.join(factoryConfigHome(providerEnv), "sessions") },
    { provider: "cursor", root: path.join(homeDir, ".cursor", "chats") },
    { provider: "cursor", root: path.join(homeDir, ".cursor", "projects") },
    { provider: "opencode", root: path.join(xdgData, "opencode") },
    { provider: "opencode", root: path.join(homeDir, ".local", "share", "opencode") },
    { provider: "pi", root: piSessionRootForEnvironment(env) },
  ];
}

function isSessionTranscriptPath(filePath: string): boolean {
  return /\.(jsonl|json|db)$/iu.test(filePath);
}

function sessionIdFromBasename(filePath: string): string | null {
  const base = path.basename(filePath);
  const stem = base.replace(/\.(jsonl|json|db)$/iu, "");
  const uuid = stem.match(UUID_IN_PATH)?.[0];
  if (uuid) return uuid.toLowerCase();
  const rollout = stem.match(/^rollout-.*-([0-9a-f-]{36})$/iu);
  if (rollout?.[1] && UUID_IN_PATH.test(rollout[1])) return rollout[1].toLowerCase();
  if (CLI_SESSION_ID.test(stem) && !stem.startsWith("agent-")) return stem;
  return null;
}

export function parseProviderSessionFromPath(
  filePath: string,
  roots: Array<{ provider: ExternalSessionProvider; root: string }>,
): { provider: ExternalSessionProvider; sessionId: string } | null {
  const trimmed = filePath.trim();
  if (!trimmed || trimmed.startsWith("->") || trimmed.includes("(deleted)")) return null;
  for (const { provider, root } of roots) {
    if (!isPathInside(trimmed, root) && pathKey(trimmed) !== pathKey(root)) continue;
    if (provider === "cursor") {
      const relative = path.relative(root, trimmed);
      const parts = relative.split(/[\\/]/u).filter(Boolean);
      // `~/.cursor/chats/<workspace-hash>/<conversation-id>/store.db` and
      // `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl` are the two
      // layouts `discoverCursor` reads; anything else under those roots is not a
      // session.
      const id = path.basename(root).toLowerCase() === "chats"
        ? parts[1]
        : (parts[1]?.toLowerCase() === "agent-transcripts" ? parts[2] : undefined);
      if (id && CLI_SESSION_ID.test(id) && !id.startsWith("agent-") && isSessionTranscriptPath(trimmed)) {
        return { provider, sessionId: id };
      }
      // A cursor id only ever comes from that directory layout. Falling through
      // to the basename derivation below would mint ids from unrelated files
      // such as `~/.cursor/projects/<slug>/data.json`, and a wrong key here
      // decides which session the importer hides as ADE-owned.
      continue;
    }
    if (!isSessionTranscriptPath(trimmed)) continue;
    const sessionId = sessionIdFromBasename(trimmed)
      ?? sessionIdFromBasename(path.dirname(trimmed));
    if (!sessionId) continue;
    return { provider, sessionId };
  }
  return null;
}

export function parseLsofNameLines(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith("n")) continue;
    const name = line.slice(1).trim();
    if (name) names.push(name);
  }
  return names;
}

export function parseHandleExePaths(stdout: string): string[] {
  const names: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const match = line.match(/\btype:\s*File\s+((?:[A-Z]:\\|\\\\).+)$/iu)
      ?? line.match(/\s+([A-Z]:\\[^\s].+)$/u)
      ?? line.match(/\s+(\\\\[^\s].+)$/u);
    if (!match?.[1]) continue;
    const candidate = match[1].trim();
    if (candidate.includes(":\\") || candidate.startsWith("\\\\")) names.push(candidate);
  }
  return names;
}

function uniquePositivePids(pids: Iterable<number>): number[] {
  const seen = new Set<number>();
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    seen.add(pid);
  }
  return [...seen];
}

export async function collectDescendantPids(
  rootPids: readonly number[],
  runCommand: RunCommand = defaultRunCommand,
  platform: NodeJS.Platform = process.platform,
): Promise<number[]> {
  const roots = uniquePositivePids(rootPids);
  const found = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const parent = queue.pop();
    if (parent == null) continue;
    const children = platform === "win32"
      ? await listWindowsChildPids(parent, runCommand)
      : await listPosixChildPids(parent, runCommand);
    for (const child of children) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}

async function listPosixChildPids(parent: number, runCommand: RunCommand): Promise<number[]> {
  const result = await runCommand("pgrep", ["-P", String(parent)], { timeoutMs: 2_000 });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\s+/u)
    .map((token) => Number.parseInt(token, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function listWindowsChildPids(parent: number, runCommand: RunCommand): Promise<number[]> {
  const result = await runCommand(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent}" | Select-Object -ExpandProperty ProcessId`,
    ],
    { timeoutMs: 4_000 },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/u)
    .map((token) => Number.parseInt(token.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function listProviderCliPids(
  runCommand: RunCommand,
  platform: NodeJS.Platform,
): Promise<number[]> {
  if (platform === "win32") {
    const result = await runCommand(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Csv -NoTypeInformation",
      ],
      { timeoutMs: 6_000 },
    );
    if (result.status !== 0) return [];
    const pids: number[] = [];
    for (const line of result.stdout.split(/\r?\n/u).slice(1)) {
      if (!line.trim()) continue;
      const lower = line.toLowerCase();
      if (!isProviderCliCommandLine(lower)) continue;
      const pid = Number.parseInt(line.replace(/^"+|"+$/g, "").split(",")[0] ?? "", 10);
      if (Number.isInteger(pid) && pid > 0) pids.push(pid);
    }
    return uniquePositivePids(pids);
  }
  const result = await runCommand("ps", ["-axo", "pid=,args="], { timeoutMs: 3_000 });
  if (result.status !== 0) return [];
  const pids: number[] = [];
  for (const line of result.stdout.split(/\n/u)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    if (!match) continue;
    if (!isProviderCliCommandLine(match[2]!.toLowerCase())) continue;
    pids.push(Number.parseInt(match[1]!, 10));
  }
  return uniquePositivePids(pids);
}

function isProviderCliCommandLine(lowerArgs: string): boolean {
  if (/(?:^|[\\/\s])(?:claude|claude\.exe|codex|codex\.exe|droid|droid\.exe|opencode|opencode\.exe|cursor-agent|cursor-agent\.exe)(?:\s|$|\.exe)/u.test(lowerArgs)) {
    return true;
  }
  return /(?:^|[\\/\s])pi(?:\.exe)?(?:\s|$)/u.test(lowerArgs)
    && (lowerArgs.includes(".pi") || lowerArgs.includes("coding-agent") || lowerArgs.includes("--session"));
}

async function listOpenFilesForPids(
  pids: readonly number[],
  availability: Extract<HandleInspectionAvailability, { available: true }>,
  runCommand: RunCommand,
): Promise<Array<{ pid: number; filePath: string }>> {
  if (pids.length === 0) return [];
  if (availability.method === "lsof") {
    const result = await runCommand("lsof", ["-nP", "-Fn", "-a", "-p", pids.join(",")], { timeoutMs: 6_000 });
    const files: Array<{ pid: number; filePath: string }> = [];
    let currentPid: number | null = null;
    for (const line of result.stdout.split(/\n/u)) {
      if (line.startsWith("p")) {
        const pid = Number.parseInt(line.slice(1), 10);
        currentPid = Number.isInteger(pid) && pid > 0 ? pid : null;
        continue;
      }
      if (!line.startsWith("n") || currentPid == null) continue;
      const filePath = line.slice(1).trim();
      if (filePath) files.push({ pid: currentPid, filePath });
    }
    return files;
  }
  const files: Array<{ pid: number; filePath: string }> = [];
  for (const pid of pids) {
    const result = await runCommand("handle.exe", ["-accepteula", "-nobanner", "-p", String(pid)], { timeoutMs: 4_000 });
    for (const filePath of parseHandleExePaths(result.stdout)) {
      files.push({ pid, filePath });
    }
  }
  return files;
}

async function resolveAvailability(
  runCommand: RunCommand,
  platform: NodeJS.Platform,
): Promise<HandleInspectionAvailability> {
  if (platform === "win32") {
    const probe = await runCommand("handle.exe", ["-accepteula", "-nobanner", "-?"], { timeoutMs: 2_000 });
    if (probe.error && /enoent|not found|is not recognized/i.test(probe.error)) {
      return { available: false, reason: "windows_handle_enumeration_unavailable" };
    }
    if (probe.status == null && probe.error) {
      return { available: false, reason: "windows_handle_enumeration_unavailable" };
    }
    return { available: true, method: "handle.exe" };
  }
  const probe = await runCommand("lsof", ["-v"], { timeoutMs: 2_000 });
  if (probe.error && /enoent|not found/i.test(probe.error)) {
    return { available: false, reason: "lsof_unavailable" };
  }
  if (probe.status == null && probe.error) {
    return { available: false, reason: "lsof_unavailable" };
  }
  return { available: true, method: "lsof" };
}

export async function inspectLiveProviderSessions(args: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  extraPids?: readonly number[];
  runCommand?: RunCommand;
  platform?: NodeJS.Platform;
}): Promise<LiveProviderSessionIndex> {
  const runCommand = args.runCommand ?? defaultRunCommand;
  const platform = args.platform ?? process.platform;
  const availability = await resolveAvailability(runCommand, platform);
  const byKey = new Map<string, ProviderSessionHandle[]>();
  if (!availability.available) {
    return { availability, byKey };
  }
  const roots = providerSessionRoots({ homeDir: args.homeDir, env: args.env });
  const providerPids = await listProviderCliPids(runCommand, platform);
  const treePids = await collectDescendantPids(
    [...providerPids, ...(args.extraPids ?? [])],
    runCommand,
    platform,
  );
  for (const { pid, filePath } of await listOpenFilesForPids(treePids, availability, runCommand)) {
    const parsed = parseProviderSessionFromPath(filePath, roots);
    if (!parsed) continue;
    const key = `${parsed.provider}:${parsed.sessionId}`;
    const handle: ProviderSessionHandle = {
      provider: parsed.provider,
      sessionId: parsed.sessionId,
      filePath,
      pid,
    };
    const existing = byKey.get(key);
    if (existing) existing.push(handle);
    else byKey.set(key, [handle]);
  }
  return { availability, byKey };
}

export function handlesForSession(
  index: LiveProviderSessionIndex,
  provider: ExternalSessionProvider,
  sessionId: string,
): ProviderSessionHandle[] {
  return index.byKey.get(`${provider}:${sessionId}`) ?? [];
}

export async function captureProviderSessionFromPidTree(args: {
  rootPid: number;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: RunCommand;
  platform?: NodeJS.Platform;
}): Promise<ProviderSessionHandle | null> {
  const runCommand = args.runCommand ?? defaultRunCommand;
  const platform = args.platform ?? process.platform;
  const availability = await resolveAvailability(runCommand, platform);
  if (!availability.available) return null;
  const pids = await collectDescendantPids([args.rootPid], runCommand, platform);
  const roots = providerSessionRoots({ homeDir: args.homeDir, env: args.env });
  for (const { pid, filePath } of await listOpenFilesForPids(pids, availability, runCommand)) {
    const parsed = parseProviderSessionFromPath(filePath, roots);
    if (!parsed) continue;
    return {
      provider: parsed.provider,
      sessionId: parsed.sessionId,
      filePath,
      pid,
    };
  }
  return null;
}

export function handleInspectionUnavailableMessage(reason: Extract<HandleInspectionAvailability, { available: false }>["reason"]): string {
  switch (reason) {
    case "windows_handle_enumeration_unavailable":
      return "Windows cannot list another process's open files unless Sysinternals handle.exe is on PATH; ADE falls back to mtime only for live-session detection.";
    case "lsof_unavailable":
      return "lsof is unavailable; ADE falls back to mtime only for live-session detection.";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
