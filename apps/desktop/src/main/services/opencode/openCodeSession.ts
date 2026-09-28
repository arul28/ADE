import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import { resolveUserOpenCodeDataRoot } from "../../../shared/opencodeDataHome";
import type { Logger } from "../logging/logger";
import { ADE_OPENCODE_LAUNCH_ENV } from "../../../shared/cliLaunch";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";
import { readOpenCodeDb } from "./openCodeCredentials";
import {
  buildOpenCodeConfig,
  openCodeProfileFor,
  resolveOpenCodeModelRef,
  type BuildOpenCodeConfigArgs,
  type OpenCodeAgentProfile,
  type OpenCodePermissionRule,
  sharedOpenCodeProfileFor,
} from "./openCodeConfig";
import { acquireOpenCodeServer, type OpenCodeServerLease, type OpenCodeServerOwnerKind } from "./openCodeServer";

/**
 * OpenCode 2.0 sessions as ADE uses them: create or resume a chat session on
 * the right server, attach ADE's per-session context, send prompts, and run
 * one-shot helper prompts.
 */

/** A file part of an OpenCode prompt. */
export type OpenCodePromptFile = { uri: string; name?: string };

export type OpenCodeModelRef = { providerID: string; id: string; variant?: string };

export function sameOpenCodeModelRef(a: OpenCodeModelRef | null | undefined, b: OpenCodeModelRef): boolean {
  return Boolean(a && a.providerID === b.providerID && a.id === b.id && (a.variant ?? null) === (b.variant ?? null));
}

/**
 * Marks a session an ADE chat owns. A terminal's `--continue` picks the newest
 * session in its directory, and a chat's session there must never be taken:
 * the terminal would change its agent and rules under the chat.
 */
const ADE_CHAT_SESSION_METADATA = { adeSurface: "chat" } as const;

export function isAdeChatOpenCodeSession(info: { metadata?: Record<string, unknown> }): boolean {
  return info.metadata?.adeSurface === ADE_CHAT_SESSION_METADATA.adeSurface;
}

type OpenCodeRule = { action: string; resource: string; effect: string };

function sameRules(a: readonly OpenCodeRule[] | undefined, b: readonly OpenCodeRule[]): boolean {
  const flat = (rules: readonly OpenCodeRule[]) => JSON.stringify(rules.map((rule) => [rule.action, rule.resource, rule.effect]));
  return flat(a ?? []) === flat(b);
}

/**
 * Bring a session to the agent, model, and session rules ADE wants, judged
 * against what the server reports, not a cache: something else (another ADE
 * surface, the user in a TUI) may have changed them. `agent: null` keeps the
 * session's own agent (`config-toml`).
 */
export async function applyOpenCodeSessionMode(
  client: OpenCodeClient,
  current: { id: string; agent?: string; model?: OpenCodeModelRef; permissions?: readonly OpenCodeRule[] },
  mode: { agent: OpenCodeAgentProfile | null; model?: OpenCodeModelRef; rules?: readonly OpenCodePermissionRule[] | null },
): Promise<void> {
  if (mode.agent && current.agent !== mode.agent) {
    await client.session.switchAgent({ sessionID: current.id, agent: mode.agent });
  }
  if (mode.model && !sameOpenCodeModelRef(current.model, mode.model)) {
    await client.session.switchModel({ sessionID: current.id, model: mode.model });
  }
  if (mode.rules && !sameRules(current.permissions, mode.rules)) {
    await client.session.update({ sessionID: current.id, permissions: [...mode.rules] });
  }
}

export type OpenCodeSessionHandle = {
  lease: OpenCodeServerLease;
  client: OpenCodeClient;
  sessionId: string;
  directory: string;
  initialTitle: string | null;
  /** The session existed before this start (a reopened chat). */
  resumed: boolean;
  close(): void;
};

/** Instruction-entry key for ADE's per-session context. */
export const OPENCODE_ADE_INSTRUCTION_KEY = "ade";

/**
 * A chat whose OpenCode session lives in the user's personal store. OpenCode
 * 2.0 migrates any v1 store it opens in place, so ADE never opens that one: the
 * chat stays readable in ADE and cannot take new turns.
 */
export class OpenCodeSessionInPersonalStoreError extends Error {
  constructor(readonly sessionId: string) {
    super(
      "This chat's OpenCode history is in your personal OpenCode store, which ADE no longer opens. "
      + "Its transcript stays readable here; start a new chat to continue the work.",
    );
    this.name = "OpenCodeSessionInPersonalStoreError";
  }
}

export function isOpenCodeTaggedError(error: unknown, tag: string): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { _tag?: unknown; name?: unknown };
  return record._tag === tag || record.name === tag;
}

export function isOpenCodeNotFoundError(error: unknown): boolean {
  return isOpenCodeTaggedError(error, "SessionNotFoundError");
}

export function ensureOpenCodeAvailable(): void {
  if (!resolveOpenCodeBinaryPath()) {
    throw new Error("OpenCode is not available: no bundled or installed OpenCode 2 binary was found.");
  }
}

/** Whether the user's personal (v1) OpenCode store holds this session id. Read-only. */
function personalStoreHasSession(sessionId: string): boolean {
  const root = resolveUserOpenCodeDataRoot();
  if (!root) return false;
  return readOpenCodeDb(path.join(root, "opencode.db"), false, (db) => {
    for (const table of ["session", "session_v2"]) {
      try {
        const row = db.prepare(`SELECT 1 AS hit FROM ${table} WHERE id = ? LIMIT 1`).get(sessionId) as { hit?: number } | undefined;
        if (row?.hit) return true;
      } catch {
        // The table does not exist in this store's schema.
      }
    }
    return false;
  });
}

/**
 * Local files as OpenCode prompt file parts. A path that is gone from disk
 * cannot be sent as a file part, so it is left out; the caller names every
 * attachment in the prompt text.
 */
export function openCodePromptFiles(filePaths: readonly string[]): OpenCodePromptFile[] {
  return filePaths
    .filter((filePath) => Boolean(filePath) && fs.existsSync(filePath))
    .map((filePath) => ({ uri: pathToFileURL(filePath).toString(), name: path.basename(filePath) }));
}

/** Keys that must never reach an agent's shell commands. */
const SESSION_ENV_EXCLUDED = new Set(["OPENCODE_SERVER_PASSWORD", "OPENCODE_PASSWORD", ADE_OPENCODE_LAUNCH_ENV]);

/**
 * An environment as the variables OpenCode runs a session's shell commands
 * with: string values only, and never the server password or ADE's launch
 * intent.
 */
export function openCodeSessionEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || SESSION_ENV_EXCLUDED.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Attach ADE's context to a session: the instruction entry (part of the real
 * system prompt; a later change reaches the model at the next step) and the
 * shell environment its commands run with.
 */
export async function applyOpenCodeSessionContext(
  handle: Pick<OpenCodeSessionHandle, "client" | "sessionId">,
  context: { instructions?: string | null; environment?: Record<string, string> | null },
): Promise<void> {
  const instructions = context.instructions?.trim();
  if (instructions) {
    await handle.client.session.instructions.entry.put({
      sessionID: handle.sessionId,
      key: OPENCODE_ADE_INSTRUCTION_KEY,
      value: instructions,
    });
  }
  if (context.environment && Object.keys(context.environment).length) {
    await handle.client.session.environment({ sessionID: handle.sessionId, variables: context.environment });
  }
}

export async function startOpenCodeChatSession(args: {
  config: BuildOpenCodeConfigArgs;
  directory: string;
  /** ADE's agent for the mode; null (`config-toml`) keeps a reopened session's own agent. */
  agent: OpenCodeAgentProfile | null;
  model: OpenCodeModelRef;
  /**
   * Session-level rules. A child session inherits its parent's rules, while
   * agent rules stop at the agent, so these keep a subagent inside ADE's mode.
   */
  permissions?: readonly OpenCodePermissionRule[] | null;
  title?: string | null;
  /** The chat's persisted OpenCode session id, when it has one. */
  sessionId?: string | null;
  instructions?: string | null;
  environment?: Record<string, string> | null;
  ownerKind?: OpenCodeServerOwnerKind;
  ownerId?: string | null;
  logger?: Logger | null;
}): Promise<OpenCodeSessionHandle> {
  ensureOpenCodeAvailable();
  const lease = await acquireOpenCodeServer({
    profile: openCodeProfileFor({
      projectConfig: args.config.projectConfig,
      isolated: args.config.isolated,
      personal: args.config.personal,
      mcpServers: args.config.mcpServers,
      presetProviders: args.config.presetProviders,
    }),
    config: buildOpenCodeConfig(args.config),
    ownerKind: args.ownerKind ?? "chat",
    ownerId: args.ownerId ?? null,
    logger: args.logger,
  });
  const client = lease.client;
  const handleFor = (sessionId: string, title: string | null | undefined, resumed: boolean): OpenCodeSessionHandle => ({
    lease,
    client,
    sessionId,
    directory: args.directory,
    initialTitle: title?.trim() || null,
    resumed,
    close: () => lease.release(),
  });

  try {
    const persisted = args.sessionId?.trim();
    if (persisted) {
      try {
        const existing = await client.session.get({ sessionID: persisted });
        const handle = handleFor(existing.id, existing.title, true);
        // The saved session keeps the agent and model of its last turn; bring
        // it to what ADE shows now.
        await applyOpenCodeSessionMode(client, existing, { agent: args.agent, model: args.model, rules: args.permissions });
        await applyOpenCodeSessionContext(handle, args);
        return handle;
      } catch (error) {
        // Only a confirmed "session missing" may fall through; anything else
        // (transport, server restart) must surface, or the thread is stranded
        // on a fresh empty session.
        if (!isOpenCodeNotFoundError(error)) throw error;
        if (personalStoreHasSession(persisted)) throw new OpenCodeSessionInPersonalStoreError(persisted);
        args.logger?.warn("opencode.session_recreated_missing", { sessionId: persisted });
      }
    }
    const title = args.title?.trim();
    const created = await client.session.create({
      location: { directory: args.directory },
      // `config-toml` has no ADE agent: the session starts on the user's own
      // default agent, as a terminal does.
      ...(args.agent ? { agent: args.agent } : {}),
      model: args.model,
      metadata: ADE_CHAT_SESSION_METADATA,
      ...(args.permissions ? { permissions: args.permissions } : {}),
      ...(title ? { title } : {}),
    });
    const handle = handleFor(created.id, created.title, false);
    await applyOpenCodeSessionContext(handle, args);
    return handle;
  } catch (error) {
    lease.release();
    throw error;
  }
}

/** Text of the last assistant message in a session, answer text only. */
async function readLastAssistantText(client: OpenCodeClient, sessionId: string): Promise<{
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
}> {
  const page = await client.message.list({ sessionID: sessionId, limit: 20, order: "desc", type: "assistant" });
  for (const message of page.data) {
    if (message.type !== "assistant") continue;
    const text = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("")
      .trim();
    if (!text) continue;
    return {
      text,
      inputTokens: message.tokens?.input ?? null,
      outputTokens: message.tokens?.output ?? null,
    };
  }
  return { text: "", inputTokens: null, outputTokens: null };
}

/**
 * One-shot helper prompt (titles, lane names, summaries): an ephemeral session
 * on the shared server under the `ade-helper` agent, deleted afterwards so it
 * leaves no history. The helper denies every side-effecting action, and any ask
 * that still arrives is rejected at once — there is no UI to answer it.
 */
export async function runOpenCodeTextPrompt(args: {
  config: BuildOpenCodeConfigArgs;
  directory: string;
  modelDescriptor: ModelDescriptor;
  prompt: string;
  system?: string;
  agent?: OpenCodeAgentProfile;
  signal?: AbortSignal;
  logger?: Logger | null;
}): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
  ensureOpenCodeAvailable();
  const lease = await acquireOpenCodeServer({
    profile: sharedOpenCodeProfileFor(args.config.projectConfig),
    config: buildOpenCodeConfig(args.config),
    // A running shared server keeps the chats' fuller config (skills, local
    // models); a helper prompt only seeds a server that is starting.
    configMode: "if-starting",
    ownerKind: "oneshot",
    logger: args.logger,
  });
  const client = lease.client;
  let sessionId: string | null = null;
  const stopListening = lease.listen({
    onEvent(event: OpenCodeEvent) {
      if (event.type !== "permission.asked" || !sessionId || event.data.sessionID !== sessionId) return;
      void client.permission.reply({ sessionID: sessionId, requestID: event.data.id, decision: "reject" }).catch(() => {});
    },
  });
  const onAbort = (): void => {
    if (sessionId) void client.session.interrupt({ sessionID: sessionId }).catch(() => {});
  };
  args.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const created = await client.session.create({
      location: { directory: args.directory },
      agent: args.agent ?? "ade-helper",
      model: resolveOpenCodeModelRef(args.modelDescriptor),
    });
    sessionId = created.id;
    await applyOpenCodeSessionContext({ client, sessionId }, { instructions: args.system });
    await client.session.prompt({
      sessionID: sessionId,
      text: args.prompt,
    });
    await client.session.wait({ sessionID: sessionId }, args.signal ? { signal: args.signal } : undefined);
    if (args.signal?.aborted) throw new Error("OpenCode prompt aborted.");
    const info = await client.session.get({ sessionID: sessionId });
    if (info.outcome === "failed") throw new Error("OpenCode prompt failed.");
    return await readLastAssistantText(client, sessionId);
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
    stopListening();
    if (sessionId) await client.session.remove({ sessionID: sessionId }).catch(() => {});
    lease.release();
  }
}
