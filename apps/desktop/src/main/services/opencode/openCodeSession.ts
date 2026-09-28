import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client";
import type { ModelDescriptor } from "../../../shared/modelRegistry";
import { resolveUserOpenCodeDataRoot } from "../../../shared/opencodeDataHome";
import type { Logger } from "../logging/logger";
import { openReadOnlyDatabase } from "../projects/readOnlySqlite";
import { resolveOpenCodeBinaryPath } from "./openCodeBinaryManager";
import {
  buildOpenCodeConfig,
  openCodeProfileFor,
  resolveOpenCodeModelRef,
  type BuildOpenCodeConfigArgs,
  type OpenCodeAgentProfile,
  type OpenCodePermissionRule,
} from "./openCodeConfig";
import { acquireOpenCodeServer, type OpenCodeServerLease, type OpenCodeServerOwnerKind } from "./openCodeServer";

/**
 * OpenCode 2.0 sessions as ADE uses them: create or resume a chat session on
 * the right server, attach ADE's per-session context, send prompts, and run
 * one-shot helper prompts.
 */

export type OpenCodePromptFile = {
  path: string;
  mime: string;
  filename?: string;
};

export type OpenCodeModelRef = { providerID: string; id: string; variant?: string };

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
  const dbPath = path.join(root, "opencode.db");
  if (!fs.existsSync(dbPath)) return false;
  let db: ReturnType<typeof openReadOnlyDatabase> | null = null;
  try {
    db = openReadOnlyDatabase(dbPath);
    db.exec("PRAGMA busy_timeout = 0");
    for (const table of ["session", "session_v2"]) {
      try {
        const row = db.prepare(`SELECT 1 AS hit FROM ${table} WHERE id = ? LIMIT 1`).get(sessionId) as { hit?: number } | undefined;
        if (row?.hit) return true;
      } catch {
        // The table does not exist in this store's schema.
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Closing a read-only handle cannot lose anything.
    }
  }
}

export function buildOpenCodePromptFiles(files: readonly OpenCodePromptFile[] | undefined): Array<{ uri: string; name?: string }> {
  return (files ?? []).map((file) => ({
    uri: pathToFileURL(file.path).toString(),
    ...(file.filename ? { name: file.filename } : {}),
  }));
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
  agent: OpenCodeAgentProfile;
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
        if (args.permissions) await client.session.update({ sessionID: existing.id, permissions: args.permissions });
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
      agent: args.agent,
      model: args.model,
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
  files?: OpenCodePromptFile[];
  agent?: OpenCodeAgentProfile;
  signal?: AbortSignal;
  logger?: Logger | null;
}): Promise<{ text: string; inputTokens: number | null; outputTokens: number | null }> {
  ensureOpenCodeAvailable();
  const lease = await acquireOpenCodeServer({
    config: buildOpenCodeConfig(args.config),
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
      ...(args.files?.length ? { files: buildOpenCodePromptFiles(args.files) } : {}),
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
