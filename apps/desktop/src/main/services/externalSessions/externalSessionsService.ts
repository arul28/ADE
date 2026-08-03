import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  buildTrackedCliResumeCommand,
  withCodexNoAltScreen,
} from "../../../shared/cliLaunch";
import type {
  AgentChatImportExternalSessionResult,
  ExternalSessionCapabilities,
  ExternalSessionImportArgs,
  ExternalSessionImportResult,
  ExternalSessionListArgs,
  ExternalSessionProvider,
  ExternalSessionSummary,
  PtyCreateArgs,
  PtyCreateResult,
  TerminalResumeMetadata,
  TerminalSessionSummary,
  TerminalToolType,
} from "../../../shared/types";
import { transplantClaudeSession } from "./claudeSessionTransplant";
import { liveClaudeSessionIds } from "./claudeLiveSessions";
import { claudeConfigDir, discoverClaudeSessions } from "./discoverClaude";
import { discoverCodexSessions } from "./discoverCodex";
import { discoverCursorSessions } from "./discoverCursor";
import { discoverDroidSessions } from "./discoverDroid";
import { discoverOpenCodeSessions } from "./discoverOpenCode";
import { resolveCodexComputerUseMcpConfig } from "../../utils/codexComputerUse";
import { CLAUDE_SESSION_POINTER_MAX_LIMIT } from "../sessions/sessionService";
import { createImportedSessionStore, type ImportedSessionStore } from "./importedSessionStore";
import {
  commandArrayToLine,
  cwdIsInScope,
  directShellLaunchForCommandLine,
  isPathInside,
  normalizeExternalSessionLimit,
  realishPath,
  sortDiscoveryRecords,
  type ExternalSessionDiscoveryArgs,
  type ExternalSessionDiscoveryRecord,
} from "./discoveryUtils";

export interface ExternalChatImporter {
  importExternalChatSession(args: {
    provider: "claude" | "codex";
    externalSessionId: string;
    laneId: string;
    cwd: string | null;
    fork: boolean;
    title?: string;
  }): Promise<AgentChatImportExternalSessionResult>;
}

export type ImportedChatSessionRef = {
  provider: string;
  externalId: string;
  chatSessionId: string;
};

type ChatImportedRefsProvider = () =>
  | ImportedChatSessionRef[]
  | Promise<ImportedChatSessionRef[]>;

type LoggerLike = {
  warn: (message: string, fields?: Record<string, unknown>) => void;
  info?: (message: string, fields?: Record<string, unknown>) => void;
};

type LaneServiceLike = {
  getLaneWorktreePath?: (laneId: string) => string;
  getLaneBaseAndBranch?: (laneId: string) => { worktreePath?: string | null };
};

type SessionServiceLike = {
  list: (args: { limit: number | null }) => TerminalSessionSummary[];
  get?: (sessionId: string) => TerminalSessionSummary | null;
  listClaudeSessionPointers?: (args?: { laneId?: string; limit?: number }) => Array<{
    sessionId: string;
    chatSessionId?: string | null;
  }>;
};

type PtyServiceLike = {
  create: (args: PtyCreateArgs) => Promise<PtyCreateResult>;
};

type ExternalSessionsServiceArgs = {
  projectRoot: string;
  laneService: LaneServiceLike;
  sessionService: SessionServiceLike;
  ptyService: PtyServiceLike;
  logger: LoggerLike;
  chatImporter?: ExternalChatImporter | null;
  chatImportedRefsProvider?: ChatImportedRefsProvider | null;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides the installed-droid `--fork` probe (tests / callers that already know). */
  droidForkSupported?: boolean;
  /** Overrides the machine-local durable import log (tests). */
  importedSessionStore?: ImportedSessionStore;
};

type LaneScopedExternalSessionImportArgs = ExternalSessionImportArgs & {
  enforceLaneScopeCwd?: string | null;
};

const PROVIDERS: ExternalSessionProvider[] = ["claude", "codex", "cursor", "droid", "opencode"];
const UUID_EXTERNAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CLI_EXTERNAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const PROJECT_SCOPE_DISCOVERY_LIMIT = 200;

const PROVIDER_CAPABILITIES: Record<ExternalSessionProvider, ExternalSessionCapabilities> = {
  claude: {
    resumeInPlace: true,
    resumeInDifferentCwd: false,
    fork: true,
    forkIntoDifferentCwd: true,
    importToChat: true,
  },
  codex: {
    resumeInPlace: true,
    resumeInDifferentCwd: true,
    fork: true,
    forkIntoDifferentCwd: true,
    importToChat: true,
  },
  cursor: {
    resumeInPlace: true,
    resumeInDifferentCwd: false,
    fork: false,
    forkIntoDifferentCwd: false,
    importToChat: false,
  },
  droid: {
    resumeInPlace: true,
    resumeInDifferentCwd: false,
    fork: true,
    forkIntoDifferentCwd: true,
    importToChat: false,
  },
  opencode: {
    resumeInPlace: true,
    resumeInDifferentCwd: false,
    fork: true,
    forkIntoDifferentCwd: false,
    importToChat: false,
  },
};

type ImportedSessionRef = NonNullable<ExternalSessionSummary["importedSessionRef"]>;

const CHAT_SESSION_TOOL_TYPES = new Set<TerminalToolType>([
  "codex-chat",
  "claude-chat",
  "opencode-chat",
  "cursor",
  "droid-chat",
]);

function isChatToolType(toolType: TerminalToolType | null | undefined): boolean {
  return toolType != null && CHAT_SESSION_TOOL_TYPES.has(toolType);
}

function providerSet(raw: ExternalSessionProvider[] | undefined): ExternalSessionProvider[] {
  if (!Array.isArray(raw) || raw.length === 0) return PROVIDERS;
  const allowed = new Set(PROVIDERS);
  return Array.from(new Set(raw.filter((provider): provider is ExternalSessionProvider => allowed.has(provider))));
}

function safeDirectoryExists(filePath: string, cache?: Map<string, boolean>): boolean {
  const cacheKey = path.resolve(filePath);
  const cached = cache?.get(cacheKey);
  if (cached !== undefined) return cached;
  let exists = false;
  try {
    exists = fs.statSync(filePath).isDirectory();
  } catch {
    exists = false;
  }
  cache?.set(cacheKey, exists);
  return exists;
}

function deriveProjectScopeRoots(projectRoot: string): string[] {
  const roots = new Set<string>();
  const raw = path.resolve(projectRoot);
  const resolved = realishPath(projectRoot);
  roots.add(raw);
  roots.add(resolved);
  const marker = `${path.sep}.ade${path.sep}worktrees${path.sep}`;
  for (const root of [raw, resolved]) {
    const markerIdx = root.indexOf(marker);
    if (markerIdx >= 0) {
      roots.add(root.slice(0, markerIdx));
    }
  }
  return Array.from(roots);
}

function resolveLaneCwd(laneService: LaneServiceLike, laneId: string): string {
  const clean = laneId.trim();
  if (!clean) throw new Error("laneId is required.");
  const direct = laneService.getLaneWorktreePath?.(clean);
  const worktreePath = direct ?? laneService.getLaneBaseAndBranch?.(clean)?.worktreePath ?? null;
  if (!worktreePath?.trim()) throw new Error(`Lane '${clean}' has no worktree configured.`);
  return realishPath(worktreePath);
}

function cwdMatches(cwd: string | null, requestedCwd: string | null): boolean | null {
  if (!requestedCwd) return null;
  if (!cwd) return null;
  return realishPath(cwd) === realishPath(requestedCwd);
}

function refRank(ref: ImportedSessionRef | null): number {
  if (ref?.kind === "chat") return 2;
  if (ref?.kind === "cli") return 1;
  return 0;
}

function putImportedRef(
  refs: Map<string, ImportedSessionRef | null>,
  key: string | null | undefined,
  ref: ImportedSessionRef | null,
): void {
  const cleanKey = key?.trim();
  if (!cleanKey) return;
  if (!refs.has(cleanKey) || refRank(ref) > refRank(refs.get(cleanKey) ?? null)) {
    refs.set(cleanKey, ref);
  }
}

type ImportedRefIndex = {
  refs: Map<string, ImportedSessionRef | null>;
  /** `provider:id` keys for provider sessions ADE itself created by copying. */
  adeCreated: Set<string>;
};

async function importedSessionRefs(
  sessionService: SessionServiceLike,
  chatImportedRefsProvider: ChatImportedRefsProvider | null | undefined,
  importedStore: ImportedSessionStore,
  logger: LoggerLike,
): Promise<ImportedRefIndex> {
  const refs = new Map<string, ImportedSessionRef | null>();
  const adeCreated = new Set<string>();
  const liveAdeSessionIds = new Set<string>();
  for (const session of sessionService.list({ limit: null })) {
    liveAdeSessionIds.add(session.id);
    const metadata = session.resumeMetadata as (TerminalResumeMetadata & {
      importedFrom?: { provider?: ExternalSessionProvider; targetId?: string | null };
    }) | null | undefined;
    const ref: ImportedSessionRef = {
      kind: isChatToolType(session.toolType) ? "chat" : "cli",
      sessionId: session.id,
    };
    if (metadata?.provider && metadata.targetId) {
      putImportedRef(refs, `${metadata.provider}:${metadata.targetId}`, ref);
    }
    if (metadata?.importedFrom?.provider && metadata.importedFrom.targetId) {
      putImportedRef(refs, `${metadata.importedFrom.provider}:${metadata.importedFrom.targetId}`, ref);
    }
  }
  // The durable log is the only source that survives deleting the ADE session,
  // and the only one that knows the provider id a fork import created.
  for (const record of importedStore.list()) {
    const ref: ImportedSessionRef | null = liveAdeSessionIds.has(record.adeSessionId)
      ? { kind: record.kind, sessionId: record.adeSessionId }
      : null;
    putImportedRef(refs, `${record.provider}:${record.externalId}`, ref);
    if (record.targetId) {
      putImportedRef(refs, `${record.provider}:${record.targetId}`, ref);
      if (record.targetId !== record.externalId) {
        adeCreated.add(`${record.provider}:${record.targetId}`);
      }
    }
  }
  // Claude pointers are one of the imported-marking sources; ask for all of them
  // rather than a page, at exactly the ceiling `sessionService` enforces.
  for (const pointer of sessionService.listClaudeSessionPointers?.({ limit: CLAUDE_SESSION_POINTER_MAX_LIMIT }) ?? []) {
    const sessionId = pointer.sessionId?.trim();
    if (!sessionId) continue;
    const chatSessionId = pointer.chatSessionId?.trim();
    putImportedRef(
      refs,
      `claude:${sessionId}`,
      chatSessionId ? { kind: "chat", sessionId: chatSessionId } : null,
    );
  }
  if (chatImportedRefsProvider) {
    try {
      for (const chatRef of await chatImportedRefsProvider()) {
        const provider = chatRef.provider.trim();
        const externalId = chatRef.externalId.trim();
        const chatSessionId = chatRef.chatSessionId.trim();
        if (!provider || !externalId || !chatSessionId) continue;
        putImportedRef(refs, `${provider}:${externalId}`, { kind: "chat", sessionId: chatSessionId });
      }
    } catch (error) {
      logger.warn("external_sessions.chat_import_refs_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { refs, adeCreated };
}

/**
 * The strongest ref among the ids this row stands for. Discovery collapses
 * continuation chains and fork parents, so the id a session was imported under
 * is often no longer the id it is listed under.
 */
function resolveImportedRef(
  index: ImportedRefIndex,
  record: Pick<ExternalSessionDiscoveryRecord, "id" | "provider" | "lineageIds">,
): { imported: boolean; ref: ImportedSessionRef | null } {
  let imported = false;
  let ref: ImportedSessionRef | null = null;
  for (const id of [record.id, ...(record.lineageIds ?? [])]) {
    const key = `${record.provider}:${id}`;
    if (!index.refs.has(key)) continue;
    imported = true;
    const candidate = index.refs.get(key) ?? null;
    if (refRank(candidate) > refRank(ref)) ref = candidate;
  }
  return { imported, ref };
}

/**
 * ADE's own copies re-list as fresh provider sessions: a cross-cwd Claude fork
 * writes a transplanted transcript under a new uuid into `~/.claude`, and a
 * Codex chat fork mints a new thread. Both are already open in ADE under their
 * original row, so listing them again offers to import ADE's work into ADE.
 *
 * Every id has to be ADE-created. When discovery collapses the user's original
 * into the copy, that one row is also the only place the original appears;
 * hiding it would drop the conversation instead of marking it imported.
 */
function isAdeCreatedArtifact(
  index: ImportedRefIndex,
  record: Pick<ExternalSessionDiscoveryRecord, "id" | "provider" | "lineageIds">,
): boolean {
  return [record.id, ...(record.lineageIds ?? [])]
    .every((id) => index.adeCreated.has(`${record.provider}:${id}`));
}

function toolTypeForProvider(provider: ExternalSessionProvider): TerminalToolType {
  if (provider === "cursor") return "cursor-cli";
  return provider;
}

export function validateExternalSessionId(provider: ExternalSessionProvider, id: string): string {
  const trimmed = id.trim();
  if (provider === "cursor" && trimmed.startsWith("agent-")) {
    throw new Error(
      "cursor external session id is not resumable by cursor-agent; refusing to import SDK-origin transcript.",
    );
  }
  const pattern = provider === "claude" || provider === "codex"
    ? UUID_EXTERNAL_SESSION_ID
    : CLI_EXTERNAL_SESSION_ID;
  if (!pattern.test(trimmed)) {
    throw new Error(
      `${provider} external session id is invalid; refusing to import '${trimmed || "(empty)"}'.`,
    );
  }
  return trimmed;
}

function targetKindForProvider(provider: ExternalSessionProvider): TerminalResumeMetadata["targetKind"] {
  return provider === "codex" ? "thread" : "session";
}

/**
 * The launch settings an import runs with, resolved once from the user's request
 * and whatever discovery recovered from the session. Passed around whole: every
 * consumer — the resume command, each fork command, the stored metadata — needs
 * the same set, and the codex-only `codexComputerUse` is added at the one call
 * site that can await it.
 */
type LaunchOverrides = {
  model: string | null;
  reasoningEffort: string | null;
  fastMode: boolean | null;
  permissionMode: TerminalResumeMetadata["launch"]["permissionMode"];
  codexApprovalPolicy: TerminalResumeMetadata["launch"]["codexApprovalPolicy"];
  codexSandbox: TerminalResumeMetadata["launch"]["codexSandbox"];
  codexConfigSource: TerminalResumeMetadata["launch"]["codexConfigSource"];
};

function metadataForImport(args: {
  provider: ExternalSessionProvider;
  targetId: string | null;
  originalTargetId: string;
  mode: "resume" | "fork";
  overrides: LaunchOverrides;
}): TerminalResumeMetadata {
  const overrides = args.overrides;
  const launch = {
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.reasoningEffort ? { reasoningEffort: overrides.reasoningEffort } : {}),
    ...(typeof overrides.fastMode === "boolean" ? { fastMode: overrides.fastMode } : {}),
    ...(overrides.permissionMode ? { permissionMode: overrides.permissionMode } : {}),
    ...(overrides.codexApprovalPolicy ? { codexApprovalPolicy: overrides.codexApprovalPolicy } : {}),
    ...(overrides.codexSandbox ? { codexSandbox: overrides.codexSandbox } : {}),
    ...(overrides.codexConfigSource ? { codexConfigSource: overrides.codexConfigSource } : {}),
  };
  return {
    provider: args.provider,
    targetKind: targetKindForProvider(args.provider),
    targetId: args.targetId,
    launch,
    importedFrom: {
      provider: args.provider,
      targetId: args.originalTargetId,
      mode: args.mode,
      importedAt: new Date().toISOString(),
    },
  } as TerminalResumeMetadata;
}

async function forkCommandFor(args: {
  provider: ExternalSessionProvider;
  metadata: TerminalResumeMetadata;
  targetId: string;
  overrides: LaunchOverrides;
  transplantedClaude: boolean;
}): Promise<string> {
  const forkMetadata = { ...args.metadata, targetId: args.targetId };

  if (args.provider === "claude") {
    const command = buildTrackedCliResumeCommand(forkMetadata, args.overrides);
    return args.transplantedClaude ? command : `${command} --fork-session`;
  }

  if (args.provider === "codex") {
    const resume = buildTrackedCliResumeCommand(forkMetadata, {
      ...args.overrides,
      codexComputerUse: await resolveCodexComputerUseMcpConfig(),
    });
    return withCodexNoAltScreen(resume.replace(/\bresume\b/u, "fork"));
  }

  if (args.provider === "droid") {
    return commandArrayToLine(["droid", "--fork", validateExternalSessionId("droid", args.targetId)]);
  }

  if (args.provider === "opencode") {
    return `${buildTrackedCliResumeCommand(forkMetadata, args.overrides)} --fork`;
  }

  throw new Error("Cursor sessions cannot be forked.");
}

export function createExternalSessionsService(args: ExternalSessionsServiceArgs) {
  const importedStore = args.importedSessionStore ?? createImportedSessionStore({
    ...(args.homeDir ? { homeDir: args.homeDir } : {}),
    ...(args.env ? { env: args.env } : {}),
    logger: args.logger,
  });
  // Factory's docs describe `droid --fork`, but installed CLIs predating it only
  // expose `--resume`; offering fork against such a binary launches a failing command.
  let droidForkProbe: boolean | null = typeof args.droidForkSupported === "boolean" ? args.droidForkSupported : null;
  let droidForkProbePromise: Promise<boolean> | null = null;
  const startDroidForkProbe = (): Promise<boolean> => {
    if (droidForkProbe !== null) return Promise.resolve(droidForkProbe);
    if (droidForkProbePromise) return droidForkProbePromise;
    droidForkProbePromise = new Promise((resolve) => {
      execFile("droid", ["--help"], {
        timeout: 1500,
        encoding: "utf8",
        env: args.env ?? process.env,
      }, (_error, stdout, stderr) => {
        droidForkProbe = /(^|\s)--fork\b/u.test(`${stdout ?? ""}\n${stderr ?? ""}`);
        resolve(droidForkProbe);
      });
    });
    return droidForkProbePromise;
  };
  const droidForkAvailable = (): boolean => {
    if (droidForkProbe !== null) return droidForkProbe;
    void startDroidForkProbe();
    return false;
  };
  const resolveDroidForkAvailable = async (): Promise<boolean> => {
    if (droidForkProbe !== null) return droidForkProbe;
    return startDroidForkProbe();
  };
  void startDroidForkProbe();
  const capabilitiesFor = (
    provider: ExternalSessionProvider,
    session?: Pick<ExternalSessionDiscoveryRecord, "cwd"> | null,
    cwdExistenceCache?: Map<string, boolean>,
  ): ExternalSessionCapabilities => {
    const base = provider !== "droid"
      ? PROVIDER_CAPABILITIES[provider]
      : (() => {
          const fork = droidForkAvailable();
          return { ...PROVIDER_CAPABILITIES.droid, fork, forkIntoDifferentCwd: fork };
        })();
    if (session === undefined || provider === "codex") return base;
    const cwd = session?.cwd?.trim() ?? "";
    const cwdAvailable = cwd.length > 0 && safeDirectoryExists(cwd, cwdExistenceCache);
    if (cwdAvailable) return base;
    if (provider === "claude" && cwd.length > 0) {
      return {
        ...base,
        resumeInPlace: false,
      };
    }
    if (provider === "droid") {
      // Droid forks are created in the destination lane and do not depend on
      // the source cwd remaining available. Only in-place resume is lost.
      return {
        ...base,
        resumeInPlace: false,
        resumeInDifferentCwd: false,
      };
    }
    return {
      resumeInPlace: false,
      resumeInDifferentCwd: false,
      fork: false,
      forkIntoDifferentCwd: false,
      importToChat: false,
    };
  };

  const discoverByProvider: Record<ExternalSessionProvider, (discoveryArgs: ExternalSessionDiscoveryArgs) => Promise<ExternalSessionDiscoveryRecord[]>> = {
    claude: discoverClaudeSessions,
    codex: discoverCodexSessions,
    cursor: discoverCursorSessions,
    droid: discoverDroidSessions,
    opencode: discoverOpenCodeSessions,
  };

  const list = async (rawArgs: ExternalSessionListArgs = {}): Promise<ExternalSessionSummary[]> => {
    const hasRequestedSessionId = rawArgs.sessionId != null;
    const requestedSessionId = rawArgs.sessionId?.trim() || null;
    if (hasRequestedSessionId && !requestedSessionId) return [];
    const limit = requestedSessionId ? 1 : normalizeExternalSessionLimit(rawArgs.limit);
    const projectScoped = rawArgs.scope !== "all";
    const discoveryLimit = requestedSessionId
      ? 1
      : projectScoped
        ? Math.max(limit, PROJECT_SCOPE_DISCOVERY_LIMIT)
        : limit;
    const requestedProviders = providerSet(rawArgs.providers);
    const providers = requestedSessionId
      ? requestedProviders.filter((provider) => {
          try {
            validateExternalSessionId(provider, requestedSessionId);
            return true;
          } catch {
            return false;
          }
        })
      : requestedProviders;
    if (providers.length === 0) return [];
    const requestedLaneCwd = rawArgs.laneId ? resolveLaneCwd(args.laneService, rawArgs.laneId) : null;
    const requestedCwd = rawArgs.cwd?.trim() ? realishPath(rawArgs.cwd) : requestedLaneCwd;
    const scopeRoots = projectScoped ? deriveProjectScopeRoots(args.projectRoot) : [];
    const discoveryArgs: ExternalSessionDiscoveryArgs = {
      homeDir: args.homeDir,
      env: args.env,
      cwd: requestedCwd,
      projectRoot: args.projectRoot,
      limit: discoveryLimit,
      sessionId: requestedSessionId,
      scopeRoots: projectScoped ? scopeRoots : null,
      logger: args.logger,
    };

    const settled = await Promise.all(providers.map(async (provider) => {
      try {
        return await discoverByProvider[provider](discoveryArgs);
      } catch (error) {
        args.logger.warn("external_sessions.discovery_failed", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
        if (providers.length === 1) throw error;
        return [] as ExternalSessionDiscoveryRecord[];
      }
    }));

    const imported = await importedSessionRefs(
      args.sessionService,
      args.chatImportedRefsProvider,
      importedStore,
      args.logger,
    );
    const activeCutoffMs = Date.now() - 2 * 60_000;
    const liveClaudeIds = providers.includes("claude")
      ? liveClaudeSessionIds({ homeDir: args.homeDir, env: args.env })
      : null;
    const cwdExistenceCache = new Map<string, boolean>();
    const discovered = sortDiscoveryRecords(settled.flat(), discoveryLimit * providers.length);
    // `scopeRoots` is non-empty whenever `projectScoped`, so the util's
    // empty-roots-means-everything behaviour is never reached here.
    const inScope = projectScoped
      ? discovered.filter((session) => cwdIsInScope(session.cwd, scopeRoots))
      : discovered;
    // An exact lookup names the session the caller wants and must resolve even
    // when that session is an ADE-created copy.
    const scoped = requestedSessionId
      ? inScope
      : inScope.filter((session) => !isAdeCreatedArtifact(imported, session));

    const summaries = scoped
      .map((session): ExternalSessionSummary => {
        const { imported: alreadyImported, ref: importedRef } = resolveImportedRef(imported, session);
        return {
          provider: session.provider,
          id: session.id,
          cwd: session.cwd,
          title: session.title,
          preview: session.preview,
          messages: session.messages,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount,
          launch: session.launch ?? null,
          alreadyImported,
          importedSessionRef: importedRef,
          // Claude publishes its own live-session registry, which answers "open
          // right now" instead of "written in the last two minutes".
          possiblyActive: session.provider === "claude" && liveClaudeIds
            ? liveClaudeIds.has(session.id)
            : typeof session.sourceMtimeMs === "number" && session.sourceMtimeMs >= activeCutoffMs,
          cwdMatchesRequestedLane: cwdMatches(session.cwd, requestedCwd),
          capabilities: capabilitiesFor(session.provider, session, cwdExistenceCache),
        };
      })
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
    return projectScoped ? summaries.slice(0, limit) : summaries;
  };

  const findExternalSummary = async (
    provider: ExternalSessionProvider,
    sessionId: string,
    destinationCwd: string,
  ): Promise<ExternalSessionSummary | null> => {
    // OpenCode can omit `directory` from list rows. Its CLI scopes the list by
    // the cwd it runs in, so an exact lookup for a lane-scoped import may use
    // that resolved destination as the missing row's cwd. Keep other providers
    // and unscoped browse discovery conservative: their cwd must come from the
    // provider's own session metadata.
    const openCodeScopeRoots = provider === "opencode"
      ? deriveProjectScopeRoots(args.projectRoot)
      : null;
    const [session] = await discoverByProvider[provider]({
      homeDir: args.homeDir,
      env: args.env,
      ...(provider === "opencode" ? { cwd: destinationCwd } : {}),
      projectRoot: args.projectRoot,
      sessionId,
      limit: 1,
      scopeRoots: openCodeScopeRoots,
      logger: args.logger,
    });
    if (!session || session.id !== sessionId) return null;
    return {
      provider: session.provider,
      id: session.id,
      cwd: session.cwd,
      title: session.title,
      preview: session.preview,
      messages: session.messages,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      launch: session.launch ?? null,
      alreadyImported: false,
      importedSessionRef: null,
      possiblyActive: typeof session.sourceMtimeMs === "number"
        && session.sourceMtimeMs >= Date.now() - 2 * 60_000,
      cwdMatchesRequestedLane: cwdMatches(session.cwd, destinationCwd),
      capabilities: capabilitiesFor(provider, session),
    };
  };

  const importExternalSession = async (
    importArgs: LaneScopedExternalSessionImportArgs,
  ): Promise<ExternalSessionImportResult> => {
    const provider = importArgs.provider;
    if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported external session provider '${provider}'.`);
    const sessionId = validateExternalSessionId(provider, importArgs.sessionId);
    const laneId = importArgs.laneId.trim();
    const laneCwd = resolveLaneCwd(args.laneService, laneId);
    // Resolved before any discovery work, so an import that cannot run fails
    // before it reads the provider's session store. Binding the importer here is
    // also what lets the branch below use it without asserting it exists.
    const chatImport = importArgs.target === "chat"
      ? (() => {
          if (provider !== "claude" && provider !== "codex") {
            throw new Error(`Chat import is only available for Claude and Codex sessions, not ${provider}.`);
          }
          if (!args.chatImporter) {
            throw new Error("Chat import unavailable: external chat importer is not configured.");
          }
          return { provider, importer: args.chatImporter };
        })()
      : null;
    const summary = await findExternalSummary(provider, sessionId, laneCwd);
    if (!summary) {
      throw new Error(`${provider} external session '${sessionId}' was not found or is not resumable.`);
    }
    const sourceCwd = summary?.cwd ?? null;
    const enforceLaneScopeCwd = importArgs.enforceLaneScopeCwd?.trim();
    if (enforceLaneScopeCwd) {
      const scopeRoot = realishPath(enforceLaneScopeCwd);
      if (!sourceCwd || !isPathInside(scopeRoot, realishPath(sourceCwd))) {
        throw new Error("External session import is not permitted for this lane.");
      }
    }

    if (chatImport) {
      const { importer } = chatImport;
      if (!summary.capabilities.importToChat) {
        throw new Error(`${provider} session '${sessionId}' cannot be imported as an ADE chat.`);
      }
      if (
        provider === "claude"
        && importArgs.mode === "resume"
        && cwdMatches(sourceCwd, laneCwd) !== true
      ) {
        throw new Error("Claude sessions from another folder must be copied into the target lane; continuing the original across folders is not supported.");
      }
      const result = await importer.importExternalChatSession({
        provider: chatImport.provider,
        externalSessionId: sessionId,
        laneId,
        cwd: sourceCwd,
        fork: importArgs.mode === "fork",
        ...(summary?.title ? { title: summary.title } : {}),
      });
      // A fork import binds the chat to a provider id that did not exist when
      // the user picked the row; both ids have to be marked, or the fork lists
      // back as a fresh session and the original loses its badge.
      const providerTargetId = result.providerTargetId?.trim() || null;
      importedStore.record({
        provider,
        externalId: sessionId,
        targetId: providerTargetId && providerTargetId !== sessionId ? providerTargetId : null,
        kind: "chat",
        adeSessionId: result.chatSessionId,
        mode: importArgs.mode === "fork" ? "fork" : "continue",
      });
      return {
        kind: "chat",
        chatSessionId: result.chatSessionId,
        laneId,
        chatSummary: result.chatSummary,
      };
    }

    if (provider === "cursor" && importArgs.mode === "fork") {
      throw new Error("Cursor external sessions do not support fork import.");
    }

    let runCwd = laneCwd;
    let launchTargetId = sessionId;
    let metadataTargetId: string | null = sessionId;
    let transplantedClaude = false;

    if (importArgs.mode === "resume") {
      if (provider !== "codex" && !summary.capabilities.resumeInPlace) {
        throw new Error(`${provider} session '${sessionId}' cannot be resumed because its original folder is unavailable.`);
      }
      if (provider === "codex") {
        runCwd = laneCwd;
      } else {
        if (!sourceCwd) throw new Error(`${provider} session '${sessionId}' has no recoverable cwd and cannot be resumed in place.`);
        runCwd = sourceCwd;
      }
    } else {
      const canFork = provider === "droid" ? await resolveDroidForkAvailable() : summary.capabilities.fork;
      if (!canFork) {
        throw new Error(provider === "droid"
          ? "The installed droid CLI does not support forking (--fork unavailable) — resume the session in its original folder or update droid."
          : `${provider} sessions do not support fork import.`);
      }
      if (provider === "claude") {
        if (!sourceCwd) throw new Error("Claude fork import requires the source session cwd.");
        if (realishPath(sourceCwd) !== realishPath(laneCwd)) {
          const transplant = await transplantClaudeSession({
            sessionId,
            sourceCwd,
            targetCwd: laneCwd,
            fork: true,
            configDir: claudeConfigDir({ env: args.env, homeDir: args.homeDir }),
          });
          launchTargetId = transplant.newSessionId;
          metadataTargetId = transplant.newSessionId;
          transplantedClaude = true;
          runCwd = laneCwd;
        } else {
          metadataTargetId = null;
          runCwd = sourceCwd;
        }
      } else if (provider === "droid" || provider === "codex") {
        metadataTargetId = null;
        runCwd = laneCwd;
      } else if (provider === "opencode") {
        if (!sourceCwd) throw new Error("OpenCode fork import requires the source session cwd.");
        if (realishPath(sourceCwd) !== realishPath(laneCwd)) {
          throw new Error("OpenCode sessions cannot be copied into a different lane folder.");
        }
        metadataTargetId = null;
        runCwd = sourceCwd;
      }
    }

    // An explicit permission mode replaces the discovered codex permission
    // triple wholesale; keeping half of each would launch a mix the user never
    // chose.
    const preserveDiscoveredCodexPermissions = provider === "codex" && importArgs.permissionMode == null;
    const overrides: LaunchOverrides = {
      model: importArgs.model?.trim() || summary.launch?.model?.trim() || null,
      reasoningEffort: importArgs.reasoningEffort?.trim()
        || summary.launch?.reasoningEffort?.trim()
        || null,
      fastMode: typeof importArgs.fastMode === "boolean"
        ? importArgs.fastMode
        : summary.launch?.fastMode ?? summary.launch?.codexFastMode ?? null,
      permissionMode: (importArgs.permissionMode?.trim()
        || summary.launch?.permissionMode?.trim()
        || null) as TerminalResumeMetadata["launch"]["permissionMode"],
      codexApprovalPolicy: preserveDiscoveredCodexPermissions
        ? summary.launch?.codexApprovalPolicy ?? null
        : null,
      codexSandbox: preserveDiscoveredCodexPermissions
        ? summary.launch?.codexSandbox ?? null
        : null,
      codexConfigSource: preserveDiscoveredCodexPermissions
        ? summary.launch?.codexConfigSource ?? null
        : null,
    };
    const metadata = metadataForImport({
      provider,
      targetId: metadataTargetId,
      originalTargetId: sessionId,
      mode: importArgs.mode,
      overrides,
    });
    const startupCommand = importArgs.mode === "resume"
      ? buildTrackedCliResumeCommand(metadata, {
          ...overrides,
          ...(provider === "codex" ? { codexComputerUse: await resolveCodexComputerUseMcpConfig() } : {}),
        })
      : await forkCommandFor({
          provider,
          metadata,
          targetId: launchTargetId,
          overrides,
          transplantedClaude,
        });

    const ptyArgs: PtyCreateArgs = {
      laneId,
      cwd: runCwd,
      allowExternalCwd: realishPath(runCwd) !== realishPath(laneCwd),
      cols: 120,
      rows: 36,
      title: summary?.title ?? `${provider} ${importArgs.mode} ${sessionId.slice(0, 8)}`,
      tracked: true,
      toolType: toolTypeForProvider(provider),
      startupCommand,
      resumeMetadata: metadata,
      ...directShellLaunchForCommandLine(startupCommand),
    };

    const created = await args.ptyService.create(ptyArgs);
    importedStore.record({
      provider,
      externalId: sessionId,
      // Only a Claude transplant produces a new provider id ADE knows here; a
      // Codex/Droid CLI fork mints its id inside the launched process.
      targetId: launchTargetId !== sessionId ? launchTargetId : null,
      kind: "cli",
      adeSessionId: created.sessionId,
      mode: importArgs.mode === "fork" ? "fork" : "continue",
    });
    args.logger.info?.("external_sessions.imported_cli", {
      provider,
      sessionId,
      laneId,
      mode: importArgs.mode,
      ptyId: created.ptyId,
      adeSessionId: created.sessionId,
    });
    const session = args.sessionService.get?.(created.sessionId) ?? undefined;
    return {
      kind: "cli",
      sessionId: created.sessionId,
      ptyId: created.ptyId,
      laneId,
      ...(session ? { session } : {}),
    };
  };

  return {
    list,
    importExternalSession,
    import: importExternalSession,
  };
}

export type ExternalSessionsService = ReturnType<typeof createExternalSessionsService>;
