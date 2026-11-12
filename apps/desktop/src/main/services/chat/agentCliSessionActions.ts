import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "../sessions/sessionService";
import { providerFromTool } from "../../utils/terminalSessionSignals";
import { DEFAULT_AGENT_CHAT_STOP_MODE, parseAgentChatStopMode, stopModeClearsQueue } from "../../../shared/chatStopModes";
import { isChatToolType } from "../../../shared/sessionSpawnNesting";
import {
  isTrackedAgentCliToolType,
  type AgentChatInterruptArgs,
  type AgentChatInterruptResult,
  type AgentChatMessageSessionArgs,
  type AgentChatMessageSessionKind,
  type AgentChatMessageSessionResult,
  type AgentChatRegenerateSessionMetadataArgs,
  type AgentChatRegenerateSessionMetadataResult,
  type AgentChatRespondToInputArgs,
  type AgentChatRestartSessionArgs,
  type AgentChatRestartSessionResult,
  type AgentChatSessionStatus,
  type AgentChatSteerArgs,
  type AgentChatSteerResult,
  type AgentChatSwitchAccountResult,
  type AgentChatUpdateSessionArgs,
  type PendingInputRequest,
  type PendingInputSource,
  type TerminalResumeProvider,
  type TerminalSessionSummary,
} from "../../../shared/types";

/**
 * The `ade chat` commands a tracked agent CLI answers.
 *
 * A tracked agent CLI (Claude Code, Codex, ... in a terminal) has no chat
 * runtime, so every chat action reaches it through its terminal instead:
 * text is typed at its prompt, Stop presses the provider's cancel key, and a
 * restart, a new model or effort, a new permission mode or a new account
 * relaunch it in the same row, resuming the provider's own conversation.
 * `agentChatService` routes a CLI row here before `ensureManagedSession`,
 * which refuses anything that is not a chat. A plain shell is refused here,
 * by name, instead of with "not an agent chat session".
 *
 * These run on the machine that owns the terminal: the action router sends
 * a chat action to that machine's brain (`--machine`, or a pinned call), and
 * the row and its process live there.
 */

type PtyService = ReturnType<typeof createPtyService>;

/** How long an interrupt-and-send waits for the CLI's prompt before it queues the text instead. */
const CLI_INTERRUPT_SEND_READY_WAIT_MS = 10_000;
const CLI_READY_POLL_MS = 200;
/** A restart asked for at the end of the running turn gives up after this long. */
const CLI_RESTART_AFTER_TURN_GIVE_UP_MS = 60 * 60_000;
const CLI_RESTART_AFTER_TURN_POLL_MS = 2_000;
/** The one pending input a CLI waiting at a prompt reports. */
const CLI_PROMPT_ITEM_ID = "cli-prompt";

/**
 * The keys that answer a provider's own approval prompt. Only providers whose
 * prompt ADE knows: Claude Code numbers its options ("1. Yes", "2. Yes, and
 * don't ask again", Esc = No); Codex binds y / a / Esc; Cursor binds y / n.
 */
const CLI_APPROVAL_KEYS: Partial<Record<TerminalResumeProvider, { accept: string; acceptForSession: string | null; decline: string }>> = {
  claude: { accept: "1", acceptForSession: "2", decline: "\x1b" },
  codex: { accept: "y", acceptForSession: "a", decline: "\x1b" },
  cursor: { accept: "y", acceptForSession: null, decline: "n" },
};

const PENDING_INPUT_SOURCES: ReadonlySet<string> = new Set(["claude", "codex", "cursor", "droid", "opencode", "pi", "muse"]);

export type AgentCliSessionActionDeps = {
  logger: Logger;
  sessionService: Pick<ReturnType<typeof createSessionService>, "get" | "updateMeta">;
  ptyService:
    | (Pick<PtyService, "canAcceptScheduledTurn" | "sendToSession">
      & Partial<Pick<PtyService, "hasLivePty" | "getRuntimeState" | "interruptAgentCli" | "restartAgentCli" | "regenerateAgentCliTitle" | "writeBySessionId">>)
    | null;
  isTrackedAgentCliSession: (sessionId: string) => boolean;
  agentCliOwnedByAnotherRuntime: (sessionId: string) => boolean;
  /** Types the text at the CLI's prompt, or answers "deferred" while it cannot take it (`agentCliWakes.ts`). */
  deliverWakeToSession: (args: AgentChatMessageSessionArgs) => Promise<"delivered" | "deferred">;
  /** A durable wait on the CLI itself that types the text once it is idle (`chatWaitRegistry`). Returns its id. */
  armQueuedSend: (args: { sessionId: string; text: string; metadata?: Record<string, unknown> | null }) => Promise<{ id: string }>;
  /** Whether durable sends are already queued for this CLI: a new one goes behind them. */
  hasQueuedSends: (sessionId: string) => Promise<boolean>;
  /** The durable sends queued for this CLI, so Stop can clear them. */
  cancelQueuedSends: (sessionId: string) => Promise<number>;
  notifyParentOfCliChildSpawn: (terminalSessionId: string, options: { resumed: true }) => void;
  /** The provider account an id or email names, or null when there is none. */
  resolveAccount: (provider: string, requested: string) => { id: string; signedIn: boolean; label: string } | null;
  isDisposed: () => boolean;
};

export function createAgentCliSessionActions(deps: AgentCliSessionActionDeps) {
  const { logger, sessionService } = deps;

  const requirePty = () => {
    if (!deps.ptyService) throw new Error("Terminals are not available in this ADE runtime.");
    return deps.ptyService;
  };

  const providerOf = (row: TerminalSessionSummary): TerminalResumeProvider | null =>
    row.resumeMetadata?.provider ?? providerFromTool(row.toolType);

  const providerName = (row: TerminalSessionSummary): string => {
    const provider = providerOf(row);
    return provider ? `${provider.charAt(0).toUpperCase()}${provider.slice(1)}` : "The CLI";
  };

  /**
   * The tracked agent CLI row behind `sessionId`, or null when the id is a
   * chat (or unknown) and the chat path should answer. A plain shell, or an
   * agent CLI ADE does not track, is refused here with what it is.
   */
  const target = (sessionId: unknown, verb: string): TerminalSessionSummary | null => {
    if (typeof sessionId !== "string" || !sessionId.trim()) return null;
    const id = sessionId.trim();
    const row = sessionService.get(id);
    if (!row) return null;
    if (deps.isTrackedAgentCliSession(id)) return row;
    if (isChatToolType(row.toolType)) return null;
    const what = isTrackedAgentCliToolType(row.toolType)
      ? "an agent CLI that ADE does not track"
      : "a plain terminal";
    throw new Error(
      `Session '${id}' is ${what}, not an agent chat or a tracked agent CLI session, so \`ade chat\` cannot ${verb} it. `
        + `Type into it with \`ade terminal write ${id} --data "…"\`.`,
    );
  };

  const assertRunsHere = (sessionId: string, verb: string): void => {
    if (deps.agentCliOwnedByAnotherRuntime(sessionId)) {
      throw new Error(`Terminal session '${sessionId}' runs under another live ADE runtime; ${verb} it from there.`);
    }
  };

  const isLive = (row: TerminalSessionSummary): boolean =>
    deps.ptyService?.hasLivePty?.(row.id) ?? row.status === "running";

  /** Busy: a live CLI that cannot take text at its prompt right now (mid-turn, or still starting). */
  const isBusy = (row: TerminalSessionSummary): boolean =>
    isLive(row) && deps.ptyService?.canAcceptScheduledTurn(row.id) !== true;

  const statusOf = (row: TerminalSessionSummary): AgentChatSessionStatus =>
    !isLive(row) ? "ended" : isBusy(row) ? "active" : "idle";

  /** Waiting on its own prompt (a permission question): ADE saw the prompt, or the CLI said so. */
  const awaitingPrompt = (row: TerminalSessionSummary): boolean => {
    if (!isLive(row)) return false;
    const runtimeState = deps.ptyService?.getRuntimeState?.(row.id, row.status) ?? row.runtimeState;
    if (runtimeState === "waiting-input") return true;
    return Boolean(row.attentionRequestedAt)
      && (row.attentionSource === "cli_prompt" || row.attentionSource === "provider_structured");
  };

  const refuseAttachments = (args: { attachments?: unknown[]; contextAttachments?: unknown[] }): void => {
    if ((args.attachments?.length ?? 0) > 0 || (args.contextAttachments?.length ?? 0) > 0) {
      throw new Error(
        "A CLI session takes text only: images and attachments cannot be typed into a terminal. "
          + "Put the file's path in the message instead, or send it to a chat.",
      );
    }
  };

  const pendingPromptError = (sessionId: string): Error =>
    new Error(
      `The CLI is waiting on a prompt in its terminal, so a message now would be typed into that prompt. `
        + `See it with \`ade chat pending ${sessionId} --text\` and answer it with \`ade chat respond ${sessionId} --approve | --deny\`, `
        + "or send with --queue to deliver it once the CLI is free.",
    );

  const notifyResumed = (sessionId: string, resumed: boolean): void => {
    if (!resumed) return;
    try {
      deps.notifyParentOfCliChildSpawn(sessionId, { resumed: true });
    } catch (error) {
      logger.warn("agent_chat.cli_action_resume_parent_notify_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const waitUntilReady = async (sessionId: string, timeoutMs: number, pollMs = CLI_READY_POLL_MS): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (requirePty().canAcceptScheduledTurn(sessionId) === true) return true;
      if (Date.now() >= deadline || deps.isDisposed() || !deps.isTrackedAgentCliSession(sessionId)) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, pollMs);
        timer.unref?.();
      });
    }
  };

  /**
   * `chat.messageSession` on a CLI. Free (idle, or ended and resumable): typed
   * now. Busy: queued as a durable wait on the CLI that types it at its next
   * free prompt (it survives a brain restart; cancel with `ade chat wait
   * --cancel <steerId>`). `interrupt-replace`: the provider's cancel key, then
   * the text once the prompt is back.
   */
  const messageSession = async (
    row: TerminalSessionSummary,
    args: AgentChatMessageSessionArgs,
  ): Promise<AgentChatMessageSessionResult> => {
    const sessionId = row.id;
    refuseAttachments(args);
    assertRunsHere(sessionId, "message");
    const kind: AgentChatMessageSessionKind = args.kind ?? "auto";
    const statusBefore = statusOf(row);
    const awaitingInputBefore = awaitingPrompt(row);
    if (awaitingInputBefore && kind !== "queue" && kind !== "wake") throw pendingPromptError(sessionId);
    const base = { sessionId, kind, statusBefore, awaitingInputBefore };
    const queue = async (): Promise<AgentChatMessageSessionResult> => {
      const queued = await deps.armQueuedSend({ sessionId, text: args.text, metadata: args.metadata as Record<string, unknown> | null | undefined });
      logger.info("agent_chat.cli_message_queued", { sessionId, waiterId: queued.id });
      return { ...base, routedAction: "steer", delivery: "queued", queued: true, steerId: queued.id };
    };
    if (kind === "interrupt-replace" && isBusy(row)) {
      const stopped = await requirePty().interruptAgentCli?.(sessionId);
      if (!stopped) throw new Error("This ADE runtime cannot interrupt a CLI session.");
      if (!(await waitUntilReady(sessionId, CLI_INTERRUPT_SEND_READY_WAIT_MS))) return await queue();
      const delivered = await deps.deliverWakeToSession({ sessionId, text: args.text, kind: "auto" });
      if (delivered === "deferred") return await queue();
      return { ...base, routedAction: "interrupt-replace", delivery: "sent" };
    }
    // Texts already queued for this CLI go first: a new send waits behind them.
    if (isBusy(row) || awaitingInputBefore || await deps.hasQueuedSends(sessionId)) return await queue();
    const delivered = await deps.deliverWakeToSession({ sessionId, text: args.text, kind: "auto" });
    if (delivered === "deferred") return await queue();
    return { ...base, routedAction: "sendMessage", delivery: "sent" };
  };

  /**
   * `chat.steer` on a CLI: typed now, even mid-turn. What the CLI does with
   * text that arrives mid-turn is its own: Claude Code and Codex hold it for
   * the running turn, others queue it for the next one.
   */
  const steer = async (row: TerminalSessionSummary, args: AgentChatSteerArgs): Promise<AgentChatSteerResult> => {
    const sessionId = row.id;
    refuseAttachments(args);
    assertRunsHere(sessionId, "steer");
    if (awaitingPrompt(row)) throw pendingPromptError(sessionId);
    if (args.dispatchMode === "interrupt" && isBusy(row)) {
      await requirePty().interruptAgentCli?.(sessionId);
      await waitUntilReady(sessionId, CLI_INTERRUPT_SEND_READY_WAIT_MS);
    }
    const sent = await requirePty().sendToSession({ sessionId, text: args.text });
    notifyResumed(sent.sessionId, sent.resumed);
    return { steerId: randomUUID(), queued: false };
  };

  /** `chat.interrupt` on a CLI: the provider's cancel key; the process keeps running. */
  const interrupt = async (row: TerminalSessionSummary, args: AgentChatInterruptArgs): Promise<AgentChatInterruptResult> => {
    const sessionId = row.id;
    assertRunsHere(sessionId, "stop");
    const mode = parseAgentChatStopMode(args.mode ?? DEFAULT_AGENT_CHAT_STOP_MODE);
    const pty = requirePty();
    if (!pty.interruptAgentCli) throw new Error("This ADE runtime cannot interrupt a CLI session.");
    // Stop means stop: messages ADE queued for the CLI go too, unless the mode keeps them.
    const cancelledQueuedCount = stopModeClearsQueue(mode) ? await deps.cancelQueuedSends(sessionId) : 0;
    const result = await pty.interruptAgentCli(sessionId);
    logger.info("agent_chat.cli_interrupt", { sessionId, mode, pressed: result.key, cancelledQueuedCount });
    return { mode, cancelledQueuedCount };
  };

  const restartNow = async (
    row: TerminalSessionSummary,
    launch: Omit<Parameters<NonNullable<PtyService["restartAgentCli"]>>[0], "sessionId"> = {},
  ) => {
    const pty = requirePty();
    if (!pty.restartAgentCli) throw new Error("This ADE runtime cannot restart a CLI session.");
    const restarted = await pty.restartAgentCli({ sessionId: row.id, ...launch });
    notifyResumed(restarted.sessionId, true);
    return restarted;
  };

  const restartsAfterTurn = new Set<string>();

  /** `chat.restartSession` on a CLI: relaunched in its row, resuming its conversation. */
  const restartSession = async (
    row: TerminalSessionSummary,
    { stopFirst = false, afterTurn = false }: AgentChatRestartSessionArgs,
  ): Promise<AgentChatRestartSessionResult> => {
    const sessionId = row.id;
    assertRunsHere(sessionId, "restart");
    const busy = isBusy(row);
    if (busy && afterTurn && !stopFirst) {
      // Usually the CLI asking for its own restart: its turn ends first. Held
      // in memory only, like a chat's restart-after-turn.
      if (!restartsAfterTurn.has(sessionId)) {
        restartsAfterTurn.add(sessionId);
        void (async () => {
          try {
            const ready = await waitUntilReady(sessionId, CLI_RESTART_AFTER_TURN_GIVE_UP_MS, CLI_RESTART_AFTER_TURN_POLL_MS);
            const current = sessionService.get(sessionId);
            if (!ready || !current || deps.isDisposed()) return;
            await restartNow(current);
          } catch (error) {
            logger.warn("agent_chat.cli_restart_after_turn_failed", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            restartsAfterTurn.delete(sessionId);
          }
        })();
      }
      return { sessionId, restarted: false, stoppedTurn: false, backgroundJobsStopped: 0, scheduled: true };
    }
    if (busy && !stopFirst) {
      throw new Error(
        `A turn is running in this CLI. Stop it first (\`ade chat interrupt ${sessionId}\`), or restart with --stop to end it now.`,
      );
    }
    await restartNow(row);
    return { sessionId, restarted: true, stoppedTurn: busy, backgroundJobsStopped: 0 };
  };

  /**
   * `chat.updateSession` on a CLI. Title and pin are row settings. Model,
   * effort, Fast and permission mode relaunch the CLI with them, resuming its
   * conversation (refused mid-turn, and refused when the provider's resume
   * command cannot carry the setting). Chat-only settings are refused by name.
   */
  const updateSession = async (
    row: TerminalSessionSummary,
    args: AgentChatUpdateSessionArgs & { model?: string | null; pinned?: boolean },
  ): Promise<TerminalSessionSummary> => {
    const sessionId = row.id;
    const supported = new Set([
      "sessionId", "runtimeActor", "title", "manuallyNamed", "pinned", "model", "modelId",
      "reasoningEffort", "fastMode", "codexFastMode", "permissionMode", "codexApprovalPolicy", "codexSandbox",
      "codexConfigSource",
    ]);
    const unsupported = Object.entries(args)
      .filter(([key, value]) => value !== undefined && !supported.has(key))
      .map(([key]) => key);
    if (unsupported.length) {
      throw new Error(
        `A CLI session cannot change ${unsupported.join(", ")}: those are chat settings. `
          + "A CLI session takes --title, --pin, --model, --effort, --fast and --permission-mode.",
      );
    }
    const model = (typeof args.model === "string" && args.model.trim()) || (typeof args.modelId === "string" && args.modelId.trim()) || undefined;
    const fastMode = args.fastMode ?? args.codexFastMode;
    const launch = {
      ...(model ? { model } : {}),
      ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
      ...(typeof fastMode === "boolean" ? { fastMode } : {}),
      ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
      ...(args.codexApprovalPolicy ? { codexApprovalPolicy: args.codexApprovalPolicy } : {}),
      ...(args.codexSandbox ? { codexSandbox: args.codexSandbox } : {}),
      ...(args.codexConfigSource ? { codexConfigSource: args.codexConfigSource } : {}),
    };
    const changesPermissions = Boolean(launch.permissionMode || launch.codexApprovalPolicy || launch.codexSandbox || launch.codexConfigSource);
    if (changesPermissions && args.runtimeActor) {
      throw new Error("An agent cannot change a CLI session's permissions. The user can, from ADE or their own `ade` shell.");
    }
    if (Object.keys(launch).length > 0) assertRunsHere(sessionId, "change");
    // The relaunch goes first: a refused setting leaves the title and pin as they were.
    // Mid-turn is refused inside, after the settings are checked, so a setting
    // the CLI cannot take is named even while it works.
    if (Object.keys(launch).length > 0) await restartNow(row, { ...launch, requireIdle: true });
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (title || typeof args.pinned === "boolean" || typeof args.manuallyNamed === "boolean") {
      sessionService.updateMeta({
        sessionId,
        ...(title ? { title, manuallyNamed: args.manuallyNamed ?? true } : typeof args.manuallyNamed === "boolean" ? { manuallyNamed: args.manuallyNamed } : {}),
        ...(typeof args.pinned === "boolean" ? { pinned: args.pinned } : {}),
      });
    }
    return sessionService.get(sessionId) ?? row;
  };

  /** `chat.switchAccount` on a CLI: relaunched under the other account, resuming its conversation. */
  const switchAccount = async (
    row: TerminalSessionSummary,
    instanceId: string,
  ): Promise<AgentChatSwitchAccountResult> => {
    const sessionId = row.id;
    assertRunsHere(sessionId, "switch the account of");
    const provider = providerOf(row);
    if (provider !== "claude" && provider !== "codex") {
      return { ok: false, reason: "failed", message: `${providerName(row)} CLI sessions do not run on a provider account ADE can switch.` };
    }
    const launch = row.resumeMetadata?.launch;
    if (launch?.presetId?.trim() || launch?.credentialId?.trim() || row.resumeMetadata?.presetId?.trim()) {
      return { ok: false, reason: "failed", message: "This CLI session runs on a saved key or custom provider, not an account." };
    }
    if (isBusy(row)) return { ok: false, reason: "busy", message: "Wait for this turn to finish." };
    const account = deps.resolveAccount(provider, instanceId.trim());
    if (!account) return { ok: false, reason: "failed", message: `No ${providerName(row)} account '${instanceId.trim()}' on this machine.` };
    if (!account.signedIn) return { ok: false, reason: "signed_out", message: "That account is signed out." };
    const current = launch?.instanceId?.trim() || row.resumeMetadata?.instanceId?.trim() || null;
    if (current === account.id) return { ok: true, instanceId: account.id };
    try {
      await restartNow(row, { instanceId: account.id, requireIdle: true });
    } catch (error) {
      return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
    }
    logger.info("agent_chat.cli_account_switched", { sessionId, provider, fromInstanceId: current, toInstanceId: account.id });
    return { ok: true, instanceId: account.id };
  };

  /** `chat.regenerateSessionMetadata` on a CLI: the title. A CLI row has no status line or lane name of its own to write. */
  const regenerateSessionMetadata = async (
    row: TerminalSessionSummary,
    args: AgentChatRegenerateSessionMetadataArgs,
  ): Promise<AgentChatRegenerateSessionMetadataResult> => {
    const requested = args.fields ?? ["title", "laneName", "statusLine"];
    const skipped = requested.filter((field) => field !== "title");
    if (!requested.includes("title")) {
      throw new Error("A CLI session can only have its title generated. Pass --title, or leave the fields out.");
    }
    const pty = requirePty();
    if (!pty.regenerateAgentCliTitle) throw new Error("This ADE runtime cannot name a CLI session.");
    const named = await pty.regenerateAgentCliTitle(row.id);
    return {
      sessionId: row.id,
      applied: named.title ? ["title"] : [],
      skipped: named.title ? skipped : requested,
      modelId: named.modelId,
      generationError: named.error,
    };
  };

  /**
   * `chat.listPendingInputs` on a CLI: one item while the CLI waits at its own
   * prompt (a permission question). ADE reads the screen, not the provider's
   * protocol, so the item carries the prompt line it saw, not its options.
   */
  const listPendingInputs = (row: TerminalSessionSummary): { requests: PendingInputRequest[] } => {
    if (!awaitingPrompt(row)) return { requests: [] };
    const provider = providerOf(row);
    const keys = provider ? CLI_APPROVAL_KEYS[provider] : undefined;
    return {
      requests: [{
        requestId: CLI_PROMPT_ITEM_ID,
        itemId: CLI_PROMPT_ITEM_ID,
        source: (provider && PENDING_INPUT_SOURCES.has(provider) ? provider : "ade") as PendingInputSource,
        kind: "approval",
        title: row.attentionMessage?.trim() || "The CLI is waiting at a prompt in its terminal.",
        description: keys
          ? `Answer with --approve${keys.acceptForSession ? ", --approve-session" : ""} or --deny; ADE presses ${providerName(row)}'s own key.`
          : `ADE does not know ${providerName(row)}'s approval keys; answer it in the terminal (\`ade terminal write ${row.id} --data …\`).`,
        questions: [],
        allowsFreeform: false,
        blocking: true,
        canProceedWithoutAnswer: false,
      }],
    };
  };

  /**
   * `chat.respondToInput` on a CLI: presses the provider's own key for the
   * decision at its prompt. Refused when the CLI is not waiting on one, and for
   * a provider whose keys ADE does not know, rather than typing a guess.
   */
  const respondToInput = async (row: TerminalSessionSummary, args: AgentChatRespondToInputArgs): Promise<void> => {
    const sessionId = row.id;
    assertRunsHere(sessionId, "answer");
    if (!awaitingPrompt(row)) {
      throw new Error(`The CLI in '${sessionId}' is not waiting on a prompt ADE can see. Look at its terminal, or read it with \`ade terminal read ${sessionId}\`.`);
    }
    const provider = providerOf(row);
    const keys = provider ? CLI_APPROVAL_KEYS[provider] : undefined;
    if (!keys) {
      throw new Error(`ADE does not know ${providerName(row)}'s approval keys. Answer the prompt in the terminal (\`ade terminal write ${sessionId} --data …\`).`);
    }
    const decision = args.decision ?? (args.responseText?.trim() ? "decline" : "accept");
    const key = decision === "accept"
      ? keys.accept
      : decision === "accept_for_session"
        ? keys.acceptForSession
        : keys.decline;
    if (key == null) {
      throw new Error(`${providerName(row)} has no "allow for this session" answer ADE can press. Use --approve or --deny.`);
    }
    const pty = requirePty();
    if (!pty.writeBySessionId?.(sessionId, key)) {
      throw new Error(`Terminal session '${sessionId}' is not running, so its prompt cannot be answered.`);
    }
    logger.info("agent_chat.cli_prompt_answered", { sessionId, provider, decision });
    // A denial with a reason: the reason goes to the CLI as the next message.
    const reason = args.responseText?.trim();
    if (reason && decision !== "accept" && decision !== "accept_for_session") {
      await deps.armQueuedSend({ sessionId, text: reason });
    }
  };

  return {
    target,
    messageSession,
    steer,
    interrupt,
    restartSession,
    updateSession,
    switchAccount,
    regenerateSessionMetadata,
    listPendingInputs,
    respondToInput,
  };
}
