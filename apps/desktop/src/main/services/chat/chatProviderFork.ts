import fs from "node:fs";
import type { AgentChatProvider, AgentChatSession } from "../../../shared/types";
import { resolveCodexExecutable } from "../ai/codexExecutable";
import { pinnedToolNotReadyError } from "../ai/pinnedProviderTools";
import type { Logger } from "../logging/logger";
import type { OpenCodeSessionHandle } from "../opencode/openCodeSession";
import type { AcpSession } from "./acpHost";
import { codexServerSupportsDeferGoalContinuation, type CodexAppServerVersion } from "./codexAppServerFeatures";
import { forkCodexThreadInEphemeralAppServer } from "./codexEphemeralFork";
import type { CopilotSdkPooled } from "./copilotSdkPool";
import type { DroidSdkPooled } from "./droidSdkPool";
import type { MuseHost } from "./museSdkHost";
import type { PiSdkPooled } from "./piSdkPool";

/**
 * One fork of a chat's provider history, per provider: the native fork the
 * handoff "Fork" and the side chat (`/side`) both make before the new chat
 * exists. Each fork answers how to point the new chat at it once it does.
 *
 * Claude and Cursor are not here: each caller handles Claude itself (a side
 * chat forks from a cut, and must never take the main chat's thread as its
 * own pointer), and Cursor has no fork to point at.
 */

/** A fork runs in its own app-server, so this also covers that process starting. */
const CODEX_EPHEMERAL_FORK_TIMEOUT_MS = 30_000;

type ForkableChat = { session: AgentChatSession; laneWorktreePath: string };

/** Point the new chat at its fork. It runs once the chat exists. */
export type ChatProviderForkPointer<TManaged> = (created: TManaged) => Promise<void>;

export type ForkedProviderPointerPatch = {
  providerSessionId?: string;
  droidSdkSessionId?: string;
  copilotSdkSessionId?: string;
  piSessionId?: string;
  piSessionFile?: string;
  acpSessionId?: string;
  museSessionId?: string;
};

export type CopilotForkOptions = NonNullable<Parameters<CopilotSdkPooled["forkSession"]>[2]>;

/** A fork the table refused; the caller turns it into its own error. */
export type ChatProviderForkFailure =
  | { kind: "no_history"; provider: "codex" }
  | { kind: "start_failed"; provider: "opencode" | "droid" | "muse"; error: unknown }
  /** OpenCode started without error, yet the chat's runtime is not OpenCode. */
  | { kind: "not_started"; provider: "opencode" }
  | { kind: "busy"; provider: "copilot" | "muse" }
  | { kind: "no_fork_id"; provider: "codex" | "opencode" | "droid" | "muse"; sourceId: string };

export type ChatProviderForkOptions = {
  /**
   * The Codex goal a fork must not carry. A handoff tidies the source thread
   * before it forks; a side chat clears the forked thread's goal after, so the
   * main chat's goal is left as it is.
   */
  codexGoal: "clear_source_first" | "clear_fork_after";
  /**
   * The turn a Codex fork stops before, or null for the whole thread. Called
   * once the source's app-server is up; it may throw to refuse the fork.
   */
  codexBeforeTurnId?: (serverVersion: CodexAppServerVersion | null) => string | null;
  /** Where a Copilot fork stops. Called after the busy check; none forks the whole session. */
  copilotForkOptions?: () => CopilotForkOptions;
  /**
   * Set for a side chat: ask for Muse's own side chat (`session/sideChat`),
   * which it can take while the main session works, and fall back to a plain
   * fork only when the source is idle. Unset, a busy Muse session is refused.
   */
  museSideChat?: { sourceBusy: boolean };
  /** The Pi entry to fork through; none forks to the last settled entry. */
  piEntryId?: string | null;
  /** What to throw for each refusal; each caller words its own. */
  failure: (failure: ChatProviderForkFailure) => unknown;
};

export type ChatProviderForkDeps<
  TManaged extends ForkableChat,
  TCodexRuntime extends { serverVersion: CodexAppServerVersion | null },
> = {
  logger: Logger;
  persistChatState: (managed: TManaged) => void;
  setResumeCommand: (sessionId: string, command: string) => void;
  seedForkedProviderPointer: (managed: TManaged, patch: ForkedProviderPointerPatch) => void;
  codex: {
    /** The thread id saved for a chat whose live session has none yet. */
    persistedThreadId: (sessionId: string) => string | undefined;
    ensureRuntime: (managed: TManaged) => Promise<TCodexRuntime>;
    runtimeEnv: (managed: TManaged) => NodeJS.ProcessEnv;
    /** The thread the chat's app-server controls, resumed when it is not yet. */
    controlThread: (managed: TManaged, runtime: TCodexRuntime, purpose: string) => Promise<string>;
    clearThreadGoal: (runtime: TCodexRuntime, threadId: string) => Promise<unknown>;
    clearKnownGoal: (managed: TManaged, runtime: TCodexRuntime) => void;
    /** The chat's thread changed under its runtime, which must resume it before the next turn. */
    markThreadUnresumed: (managed: TManaged) => void;
  };
  opencode: {
    start: (managed: TManaged) => Promise<unknown>;
    /** The live OpenCode session, or null when the chat's runtime is not OpenCode. */
    handleOf: (managed: TManaged) => OpenCodeSessionHandle | null;
  };
  droid: { ensureRuntime: (managed: TManaged) => Promise<{ sdk: DroidSdkPooled }> };
  copilot: {
    ensureRuntime: (managed: TManaged) => Promise<{ busy: boolean; sdk: CopilotSdkPooled; sdkSessionId: string }>;
  };
  muse: {
    ensureRuntime: (managed: TManaged) => Promise<{ busy: boolean; host: MuseHost; museSessionId: string }>;
  };
  /** The chat's live Pi runtime, started when there is none. */
  pi: { runtimeOf: (managed: TManaged) => Promise<{ sdk: PiSdkPooled }> };
  kimi: { ensureRuntime: (managed: TManaged) => Promise<{ session: AcpSession }> };
};

export function createChatProviderFork<
  TManaged extends ForkableChat,
  TCodexRuntime extends { serverVersion: CodexAppServerVersion | null },
>(deps: ChatProviderForkDeps<TManaged, TCodexRuntime>): ChatProviderFork<TManaged> {
  const { logger } = deps;

  /** The common pointer: seed the provider's session id and the resume command. */
  const seedPointer = (
    provider: AgentChatProvider,
    patch: ForkedProviderPointerPatch,
  ): ChatProviderForkPointer<TManaged> => async (created) => {
    deps.seedForkedProviderPointer(created, patch);
    deps.setResumeCommand(created.session.id, `chat:${provider}:${created.session.id}`);
  };

  /**
   * Fork a Pi chat's session with Pi's own `createBranchedSession` (the
   * worker's `fork`): through `entryId`, or, with none, to the last settled
   * entry. The worker reads a snapshot of the file, so the source chat's
   * session is never written, even mid-turn.
   */
  const forkPiSession = async (
    source: TManaged,
    entryId: string | null,
  ): Promise<{ sessionFile: string; sessionId: string }> => {
    const piRuntime = await deps.pi.runtimeOf(source);
    const sourceFile = piRuntime.sdk.sessionFile?.trim() || "";
    const sourceId = piRuntime.sdk.sessionId?.trim() || "";
    // Pi writes a new session's file with its first answer.
    if (!sourceFile || !sourceId || !fs.existsSync(sourceFile)) {
      throw new Error("This Pi chat has no finished turn yet. Send it a message first.");
    }
    const forked = await piRuntime.sdk.fork({ sessionFile: sourceFile, sessionId: sourceId, ...(entryId ? { entryId } : {}) });
    if (!forked.sessionFile || !forked.sessionId) throw new Error("Pi did not return a session for the fork.");
    return { sessionFile: forked.sessionFile, sessionId: forked.sessionId };
  };

  const seedPiForkPointer = (created: TManaged, forked: { sessionFile: string; sessionId: string }): void => {
    created.session.piSessionFile = forked.sessionFile;
    created.session.piSessionId = forked.sessionId;
    deps.seedForkedProviderPointer(created, { piSessionId: forked.sessionId, piSessionFile: forked.sessionFile });
    deps.setResumeCommand(created.session.id, `chat:pi:${created.session.id}`);
  };

  /**
   * Fork a Kimi chat's whole session with ACP `session/fork` and answer the
   * new session's id. Kimi refuses while the source runs a turn.
   */
  const forkKimiSession = async (source: TManaged): Promise<string> => {
    const acpRuntime = await deps.kimi.ensureRuntime(source);
    const connection = acpRuntime.session.connection;
    const forked = await connection.request<{ sessionId?: string } | null>("session/fork", {
      sessionId: acpRuntime.session.sessionId,
      cwd: source.laneWorktreePath,
      mcpServers: [],
    });
    const forkedId = typeof forked?.sessionId === "string" ? forked.sessionId.trim() : "";
    if (!forkedId) throw new Error("Kimi did not return a session for the fork.");
    // The fork opens live in the source chat's process, which then holds
    // Kimi's session lock (2.3.0+); release it so the new chat's own process
    // can resume it.
    await connection.request("session/close", { sessionId: forkedId }, { timeoutMs: 10_000 }).catch((error: unknown) => {
      logger.warn("agent_chat.kimi_fork_close_failed", {
        sessionId: source.session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return forkedId;
  };

  const forkCodex = async (
    source: TManaged,
    options: ChatProviderForkOptions,
  ): Promise<ChatProviderForkPointer<TManaged>> => {
    const sourceThreadId = source.session.threadId?.trim()
      || deps.codex.persistedThreadId(source.session.id)?.trim()
      || "";
    if (!sourceThreadId) throw options.failure({ kind: "no_history", provider: "codex" });
    const runtime = await deps.codex.ensureRuntime(source);
    if (options.codexGoal === "clear_source_first") {
      try {
        // Tidying the source thread before a fork is ADE's own housekeeping.
        await deps.codex.clearThreadGoal(runtime, sourceThreadId);
      } catch (error) {
        logger.warn("agent_chat.codex_goal_clear_before_fork_failed", {
          sessionId: source.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const beforeTurnId = options.codexBeforeTurnId?.(runtime.serverVersion) ?? null;
    // Not on `runtime`: the process that forks keeps the new thread's writer
    // lock, and the forked chat resumes it from its own app-server.
    const forkEnv = deps.codex.runtimeEnv(source);
    const forkExecutable = resolveCodexExecutable({ env: forkEnv }).path;
    if (!forkExecutable) throw pinnedToolNotReadyError("codex", "Codex");
    const forkedThreadId = await forkCodexThreadInEphemeralAppServer({
      executable: forkExecutable,
      env: forkEnv,
      cwd: source.laneWorktreePath,
      forkParams: {
        threadId: sourceThreadId,
        excludeTurns: true,
        ...(beforeTurnId ? { beforeTurnId } : {}),
        ...(codexServerSupportsDeferGoalContinuation(runtime.serverVersion) ? { deferGoalContinuation: true } : {}),
      },
      timeoutMs: CODEX_EPHEMERAL_FORK_TIMEOUT_MS,
      logger,
      sessionId: source.session.id,
    });
    if (!forkedThreadId) throw options.failure({ kind: "no_fork_id", provider: "codex", sourceId: sourceThreadId });
    return async (created) => {
      created.session.threadId = forkedThreadId;
      deps.codex.markThreadUnresumed(created);
      deps.setResumeCommand(created.session.id, `chat:codex:${forkedThreadId}`);
      if (options.codexGoal !== "clear_fork_after") return;
      // Saved before the goal clear, which can be slow or fail.
      deps.persistChatState(created);
      // The fork carries the main chat's goal; a side chat has none.
      try {
        const createdRuntime = await deps.codex.ensureRuntime(created);
        const threadId = await deps.codex.controlThread(created, createdRuntime, "side chat goal cleanup");
        await deps.codex.clearThreadGoal(createdRuntime, threadId);
        deps.codex.clearKnownGoal(created, createdRuntime);
      } catch (error) {
        logger.warn("agent_chat.side_chat_goal_clear_failed", {
          sessionId: created.session.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
  };

  const forkOpenCode = async (
    source: TManaged,
    options: ChatProviderForkOptions,
  ): Promise<ChatProviderForkPointer<TManaged>> => {
    if (!deps.opencode.handleOf(source)) {
      try {
        await deps.opencode.start(source);
      } catch (error) {
        throw options.failure({ kind: "start_failed", provider: "opencode", error });
      }
    }
    const handle = deps.opencode.handleOf(source);
    if (!handle) throw options.failure({ kind: "not_started", provider: "opencode" });
    const forked = await handle.client.session.fork({ sessionID: handle.sessionId });
    const forkedId = forked.id?.trim() ?? "";
    if (!forkedId) throw options.failure({ kind: "no_fork_id", provider: "opencode", sourceId: handle.sessionId });
    return seedPointer("opencode", { providerSessionId: forkedId });
  };

  const forkDroid = async (
    source: TManaged,
    options: ChatProviderForkOptions,
  ): Promise<ChatProviderForkPointer<TManaged>> => {
    let droidRuntime: { sdk: DroidSdkPooled };
    try {
      droidRuntime = await deps.droid.ensureRuntime(source);
    } catch (error) {
      throw options.failure({ kind: "start_failed", provider: "droid", error });
    }
    const forkResult = await droidRuntime.sdk.request<{ newSessionId?: string }>("fork_session");
    const forkedId = typeof forkResult?.newSessionId === "string" ? forkResult.newSessionId.trim() : "";
    if (!forkedId) throw options.failure({ kind: "no_fork_id", provider: "droid", sourceId: source.session.id });
    return seedPointer("droid", { droidSdkSessionId: forkedId });
  };

  const forkCopilot = async (
    source: TManaged,
    options: ChatProviderForkOptions,
  ): Promise<ChatProviderForkPointer<TManaged>> => {
    const copilotRuntime = await deps.copilot.ensureRuntime(source);
    if (copilotRuntime.busy) throw options.failure({ kind: "busy", provider: "copilot" });
    const forkOptions = options.copilotForkOptions?.() ?? {};
    const forkedId = await copilotRuntime.sdk.forkSession(source.session.id, copilotRuntime.sdkSessionId, forkOptions);
    return seedPointer("copilot", { copilotSdkSessionId: forkedId });
  };

  const forkMuse = async (
    source: TManaged,
    options: ChatProviderForkOptions,
  ): Promise<ChatProviderForkPointer<TManaged>> => {
    let museRuntime: { busy: boolean; host: MuseHost; museSessionId: string };
    try {
      museRuntime = await deps.muse.ensureRuntime(source);
    } catch (error) {
      throw options.failure({ kind: "start_failed", provider: "muse", error });
    }
    const forkSession = async (): Promise<string> => {
      const forked = await museRuntime.host.command<{ session?: { sessionId?: string } }>("session/fork", {
        sessionId: museRuntime.museSessionId,
        excludeItems: true,
      });
      return forked.session?.sessionId?.trim() ?? "";
    };
    let forkedId = "";
    if (options.museSideChat) {
      try {
        // Muse's own side chat: a fork it can take while the main session works.
        const side = await museRuntime.host.command<{ session?: { sessionId?: string } }>("session/sideChat", {
          sessionId: museRuntime.museSessionId,
        });
        forkedId = side.session?.sessionId?.trim() ?? "";
      } catch (error) {
        if (options.museSideChat.sourceBusy) throw error;
        forkedId = await forkSession();
      }
    } else {
      if (museRuntime.busy) throw options.failure({ kind: "busy", provider: "muse" });
      forkedId = await forkSession();
    }
    if (!forkedId) throw options.failure({ kind: "no_fork_id", provider: "muse", sourceId: museRuntime.museSessionId });
    return seedPointer("muse", { museSessionId: forkedId });
  };

  /**
   * Fork `source`'s provider history and answer how to point the new chat at
   * the fork, or null for a provider this table has no fork for (Claude,
   * Cursor, and providers that cannot fork). The pointer applies only to a
   * new chat on the same provider.
   */
  const forkProviderHistory = async (
    source: TManaged,
    options: ChatProviderForkOptions,
  ): Promise<ChatProviderForkPointer<TManaged> | null> => {
    const provider = source.session.provider;
    let pointer: ChatProviderForkPointer<TManaged>;
    switch (provider) {
      case "codex":
        pointer = await forkCodex(source, options);
        break;
      case "opencode":
        pointer = await forkOpenCode(source, options);
        break;
      case "droid":
        pointer = await forkDroid(source, options);
        break;
      case "copilot":
        pointer = await forkCopilot(source, options);
        break;
      case "muse":
        pointer = await forkMuse(source, options);
        break;
      case "pi": {
        // The worker handles requests concurrently, so this can run beside a
        // turn, cutting at the last settled entry.
        const forked = await forkPiSession(source, options.piEntryId ?? null);
        pointer = async (created) => seedPiForkPointer(created, forked);
        break;
      }
      case "kimi": {
        // Kimi forks only an idle session; each caller sends a mid-turn
        // request away first.
        const forkedId = await forkKimiSession(source);
        pointer = async (created) => {
          deps.seedForkedProviderPointer(created, { acpSessionId: forkedId });
        };
        break;
      }
      default:
        return null;
    }
    return async (created) => {
      if (created.session.provider !== provider) return;
      await pointer(created);
    };
  };

  return { forkProviderHistory };
}

export type ChatProviderFork<TManaged> = {
  forkProviderHistory: (
    source: TManaged,
    options: ChatProviderForkOptions,
  ) => Promise<ChatProviderForkPointer<TManaged> | null>;
};
