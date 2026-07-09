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
import { claudeConfigDir, discoverClaudeSessions } from "./discoverClaude";
import { discoverCodexSessions } from "./discoverCodex";
import { discoverCursorSessions } from "./discoverCursor";
import { discoverDroidSessions } from "./discoverDroid";
import { discoverOpenCodeSessions } from "./discoverOpenCode";
import {
  commandArrayToLine,
  directShellLaunchForCommandLine,
  isPathInside,
  normalizeExternalSessionLimit,
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

function realish(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function safeDirectoryExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function deriveProjectScopeRoots(projectRoot: string): string[] {
  const roots = new Set<string>();
  const raw = path.resolve(projectRoot);
  const resolved = realish(projectRoot);
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
  return realish(worktreePath);
}

function cwdMatches(cwd: string | null, requestedCwd: string | null): boolean | null {
  if (!requestedCwd) return null;
  if (!cwd) return null;
  return realish(cwd) === realish(requestedCwd);
}

function isInProjectScope(cwd: string | null, scopeRoots: string[]): boolean {
  if (!cwd) return false;
  const resolved = realish(cwd);
  return scopeRoots.some((root) => isPathInside(root, resolved));
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

async function importedSessionRefs(
  sessionService: SessionServiceLike,
  chatImportedRefsProvider: ChatImportedRefsProvider | null | undefined,
  logger: LoggerLike,
): Promise<Map<string, ImportedSessionRef | null>> {
  const refs = new Map<string, ImportedSessionRef | null>();
  for (const session of sessionService.list({ limit: null })) {
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
  for (const pointer of sessionService.listClaudeSessionPointers?.({ limit: 5000 }) ?? []) {
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
  return refs;
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

function metadataForImport(args: {
  provider: ExternalSessionProvider;
  targetId: string | null;
  originalTargetId: string;
  mode: "resume" | "fork";
  model?: string | null;
  permissionMode?: string | null;
}): TerminalResumeMetadata {
  const launch = {
    ...(args.model ? { model: args.model } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode as TerminalResumeMetadata["launch"]["permissionMode"] } : {}),
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

function forkCommandFor(args: {
  provider: ExternalSessionProvider;
  metadata: TerminalResumeMetadata;
  targetId: string;
  model?: string | null;
  permissionMode?: string | null;
  transplantedClaude: boolean;
}): string {
  if (args.provider === "claude") {
    const command = buildTrackedCliResumeCommand(
      { ...args.metadata, targetId: args.targetId },
      {
        model: args.model,
        permissionMode: args.permissionMode as TerminalResumeMetadata["launch"]["permissionMode"],
      },
    );
    return args.transplantedClaude ? command : `${command} --fork-session`;
  }

  if (args.provider === "codex") {
    const resume = buildTrackedCliResumeCommand(
      { ...args.metadata, targetId: args.targetId },
      {
        model: args.model,
        permissionMode: args.permissionMode as TerminalResumeMetadata["launch"]["permissionMode"],
      },
    );
    return withCodexNoAltScreen(resume.replace(/\bresume\b/u, "fork"));
  }

  if (args.provider === "droid") {
    return commandArrayToLine(["droid", "--fork", validateExternalSessionId("droid", args.targetId)]);
  }

  if (args.provider === "opencode") {
    const resume = buildTrackedCliResumeCommand(
      { ...args.metadata, targetId: args.targetId },
      {
        model: args.model,
        permissionMode: args.permissionMode as TerminalResumeMetadata["launch"]["permissionMode"],
      },
    );
    return `${resume} --fork`;
  }

  throw new Error("Cursor sessions cannot be forked.");
}

export function createExternalSessionsService(args: ExternalSessionsServiceArgs) {
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
  ): ExternalSessionCapabilities => {
    const base = provider !== "droid"
      ? PROVIDER_CAPABILITIES[provider]
      : (() => {
          const fork = droidForkAvailable();
          return { ...PROVIDER_CAPABILITIES.droid, fork, forkIntoDifferentCwd: fork };
        })();
    if (session === undefined || provider === "codex") return base;
    const cwd = session?.cwd?.trim() ?? "";
    const cwdAvailable = cwd.length > 0 && safeDirectoryExists(cwd);
    if (cwdAvailable) return base;
    if (provider === "claude" && cwd.length > 0) {
      return {
        ...base,
        resumeInPlace: false,
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
    const limit = normalizeExternalSessionLimit(rawArgs.limit);
    const projectScoped = rawArgs.scope !== "all";
    const discoveryLimit = projectScoped
      ? Math.max(limit, PROJECT_SCOPE_DISCOVERY_LIMIT)
      : limit;
    const providers = providerSet(rawArgs.providers);
    const requestedLaneCwd = rawArgs.laneId ? resolveLaneCwd(args.laneService, rawArgs.laneId) : null;
    const requestedCwd = rawArgs.cwd?.trim() ? realish(rawArgs.cwd) : requestedLaneCwd;
    const scopeRoots = projectScoped ? deriveProjectScopeRoots(args.projectRoot) : [];
    const discoveryArgs: ExternalSessionDiscoveryArgs = {
      homeDir: args.homeDir,
      env: args.env,
      cwd: requestedCwd,
      projectRoot: args.projectRoot,
      limit: discoveryLimit,
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

    const imported = await importedSessionRefs(args.sessionService, args.chatImportedRefsProvider, args.logger);
    const activeCutoffMs = Date.now() - 2 * 60_000;
    const discovered = sortDiscoveryRecords(settled.flat(), discoveryLimit * providers.length);
    const scoped = projectScoped
      ? discovered.filter((session) => isInProjectScope(session.cwd, scopeRoots))
      : discovered;

    return scoped
      .map((session): ExternalSessionSummary => {
        const importKey = `${session.provider}:${session.id}`;
        const importedRef = imported.get(importKey) ?? null;
        return {
          provider: session.provider,
          id: session.id,
          cwd: session.cwd,
          title: session.title,
          preview: session.preview,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount,
          alreadyImported: importedRef != null,
          importedSessionRef: importedRef,
          possiblyActive: typeof session.sourceMtimeMs === "number" && session.sourceMtimeMs >= activeCutoffMs,
          cwdMatchesRequestedLane: cwdMatches(session.cwd, requestedCwd),
          capabilities: capabilitiesFor(session.provider, session),
        };
      })
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, projectScoped ? limit : scoped.length);
  };

  const findExternalSummary = async (provider: ExternalSessionProvider, sessionId: string): Promise<ExternalSessionSummary | null> => {
    const sessions = await list({ providers: [provider], scope: "all", limit: MAX_FIND_LIMIT });
    return sessions.find((session) => session.id === sessionId) ?? null;
  };

  const importExternalSession = async (
    importArgs: LaneScopedExternalSessionImportArgs,
  ): Promise<ExternalSessionImportResult> => {
    const provider = importArgs.provider;
    if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported external session provider '${provider}'.`);
    const sessionId = validateExternalSessionId(provider, importArgs.sessionId);
    const laneId = importArgs.laneId.trim();
    const laneCwd = resolveLaneCwd(args.laneService, laneId);
    if (importArgs.target === "chat") {
      if (provider !== "claude" && provider !== "codex") {
        throw new Error(`Chat import is only available for Claude and Codex sessions, not ${provider}.`);
      }
      if (!args.chatImporter) {
        throw new Error("Chat import unavailable: external chat importer is not configured.");
      }
    }
    const summary = await findExternalSummary(provider, sessionId);
    if (!summary) {
      throw new Error(`${provider} external session '${sessionId}' was not found or is not resumable.`);
    }
    const sourceCwd = summary?.cwd ?? null;
    const enforceLaneScopeCwd = importArgs.enforceLaneScopeCwd?.trim();
    if (enforceLaneScopeCwd) {
      const scopeRoot = realish(enforceLaneScopeCwd);
      if (!sourceCwd || !isPathInside(scopeRoot, realish(sourceCwd))) {
        throw new Error("External session import is not permitted for this lane.");
      }
    }

    if (importArgs.target === "chat") {
      if (provider !== "claude" && provider !== "codex") {
        throw new Error(`Chat import is only available for Claude and Codex sessions, not ${provider}.`);
      }
      const importer = args.chatImporter!;
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
        provider,
        externalSessionId: sessionId,
        laneId,
        cwd: sourceCwd,
        fork: importArgs.mode === "fork",
        ...(summary?.title ? { title: summary.title } : {}),
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
        if (realish(sourceCwd) !== realish(laneCwd)) {
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
        if (realish(sourceCwd) !== realish(laneCwd)) {
          throw new Error("OpenCode sessions cannot be copied into a different lane folder.");
        }
        metadataTargetId = null;
        runCwd = sourceCwd;
      }
    }

    const metadata = metadataForImport({
      provider,
      targetId: metadataTargetId,
      originalTargetId: sessionId,
      mode: importArgs.mode,
      model: importArgs.model,
      permissionMode: importArgs.permissionMode,
    });
    const startupCommand = importArgs.mode === "resume"
      ? buildTrackedCliResumeCommand(metadata, {
          model: importArgs.model,
          permissionMode: importArgs.permissionMode as TerminalResumeMetadata["launch"]["permissionMode"],
        })
      : forkCommandFor({
          provider,
          metadata,
          targetId: launchTargetId,
          model: importArgs.model,
          permissionMode: importArgs.permissionMode,
          transplantedClaude,
        });

    const ptyArgs: PtyCreateArgs = {
      laneId,
      cwd: runCwd,
      allowExternalCwd: realish(runCwd) !== realish(laneCwd),
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

const MAX_FIND_LIMIT = 5000;

export type ExternalSessionsService = ReturnType<typeof createExternalSessionsService>;
