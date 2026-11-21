/**
 * Fork-continue (CONTRACTS §8): a person sent a message to a chat whose
 * ADE Cloud computer is gone. The server started a launch for the same lane
 * with `continueChat`, and this new computer restores the chat:
 *
 * 1. reads the FULL saved transcript (every part, oldest to newest);
 * 2. reads the fork capsule saved at rest, when there is one;
 * 3. makes the chat here with the SAME chat id
 *    (`agentChatService.restoreSavedCloudChat`): the capsule gives the
 *    provider its own history, else the next turn replays the transcript;
 * 4. moves the saved copy to this computer's machine key
 *    (`POST /cloud/chats/:old/:chat/move`), so the chat lists once;
 * 5. lets this computer's uploader go on from the saved copy's last part.
 *
 * The caller then sends the person's message to the chat.
 *
 * A CLI row has no saved chat, only a session copy and (Claude Code, Codex)
 * a CLI capsule. It restores as a CLI with the same id
 * (`agentChatService.restoreSavedCloudCli`), which types the message itself.
 */

import { gunzipSync } from "node:zlib";
import type { CloudCapsuleManifest, CloudChatRow } from "../../../../account-directory/src/cloud/contract";
import { CLOUD_CAPSULE_MAX_BYTES } from "../../../../account-directory/src/cloud/contract";
import type { CloudApiClient } from "../../../../desktop/src/shared/cloudApiClient";
import type { AgentChatCrossMachineHandoffCapsule, AgentChatEventEnvelope } from "../../../../desktop/src/shared/types";

type Logger = {
  info: (event: string, meta?: Record<string, unknown>) => void;
  warn: (event: string, meta?: Record<string, unknown>) => void;
};

/** The most saved transcript text read for one restore; a longer chat keeps its newest part. */
const MAX_TRANSCRIPT_CHARS = 64 * 1024 * 1024;
/** A capsule unpacks to at most this much JSON. */
const MAX_CAPSULE_JSON_BYTES = 96 * 1024 * 1024;
const PAGE_LIMIT = 50;

export type CloudChatRestoreDeps = {
  api: CloudApiClient;
  /** The ADE Cloud computer that restores; null on the person's own machine (a kept lane moved to it). */
  instanceId: string | null;
  /** This computer's machine key: the saved copy moves here. */
  machineKey: string;
  logger: Logger;
  restore: (args: {
    sessionId: string;
    laneId: string;
    modelId: string;
    title: string | null;
    envelopes: AgentChatEventEnvelope[];
    capsule: AgentChatCrossMachineHandoffCapsule | null;
    olderPartLeftOut?: boolean;
  }) => Promise<{ sessionId: string; restoredWith: "capsule" | "replay" | "earlier" }>;
  /** Lets this computer's uploader go on from `seq` (`adoptRestoredCloudChat`). */
  adopt: (sessionId: string, seq: number, laneId: string | null) => Promise<boolean>;
  /** Holds back the chat's uploads until `adopt` (`holdRestoringCloudChat`). */
  hold: (sessionId: string) => void;
  /** Ends the hold after a failed restore (`releaseRestoringCloudChat`). */
  release: (sessionId: string) => void;
  /** Restores a CLI row and types the message into it; left out, a CLI row can't continue. */
  restoreCli?: (args: {
    sessionId: string;
    laneId: string;
    toolType: string;
    title: string | null;
    capsule: AgentChatCrossMachineHandoffCapsule | null;
    prompt: string;
    clientMessageId: string;
  }) => Promise<{ sessionId: string; restoredWith: "capsule" | "fresh" | "earlier" }>;
};

export type CloudChatRestoreResult = {
  sessionId: string;
  restoredWith: "capsule" | "replay" | "earlier" | "fresh";
  /** A CLI restore typed the person's message already; the caller sends nothing. */
  promptSent: boolean;
  /** The saved copy is under this computer's machine key now. */
  moved: boolean;
  /** The saved transcript was longer than one restore reads: its oldest part is not in the chat here. */
  olderPartLeftOut: boolean;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A saved copy moves to this machine's key: a cloud computer names itself; the person's own machine names none. */
const moveRequest = (deps: Pick<CloudChatRestoreDeps, "machineKey" | "instanceId">) => ({
  toMachineKey: deps.machineKey,
  ...(deps.instanceId ? { instanceId: deps.instanceId } : {}),
});

/** The chat events in saved transcript text (JSON lines); a line that is not one is left out. */
export function parseSavedTranscript(texts: readonly string[]): AgentChatEventEnvelope[] {
  const out: AgentChatEventEnvelope[] = [];
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      const envelope = parsed as Partial<AgentChatEventEnvelope>;
      const event = envelope.event as { type?: unknown } | undefined;
      if (!event || typeof event !== "object" || typeof event.type !== "string") continue;
      out.push({
        ...(envelope as AgentChatEventEnvelope),
        timestamp: typeof envelope.timestamp === "string" ? envelope.timestamp : new Date(0).toISOString(),
      });
    }
  }
  return out;
}

/**
 * Where a chat stood when its capsule was made: its newest turn event (a
 * message sent, or a turn that ended) in ADE's own transcript. The rest save
 * writes it beside the capsule (`transcriptEnd`). Null fields: the chat had
 * no turn yet.
 */
export type CapsuleTranscriptEnd = { at: string | null; sequence: number | null };

const TURN_EVENTS: ReadonlySet<string> = new Set(["user_message", "done"]);

/** The newest turn event of `envelopes` (oldest first). */
export function transcriptEndOf(envelopes: readonly AgentChatEventEnvelope[]): CapsuleTranscriptEnd {
  for (let index = envelopes.length - 1; index >= 0; index -= 1) {
    const envelope = envelopes[index]!;
    if (!TURN_EVENTS.has(envelope.event.type)) continue;
    return { at: typeof envelope.timestamp === "string" ? envelope.timestamp : null, sequence: typeof envelope.sequence === "number" ? envelope.sequence : null };
  }
  return { at: null, sequence: null };
}

/**
 * True when the saved transcript has a turn the capsule does not: the
 * capsule was made before it (a later rest save could not replace it in
 * time, or its provider history could not be packed). Such a capsule would
 * resume the agent without the newer turns the chat shows, so the restore
 * replays the transcript instead. A capsule newer than the transcript (its
 * last parts did not upload) is kept: it has more, not less.
 */
export function capsuleOlderThanTranscript(end: CapsuleTranscriptEnd, envelopes: readonly AgentChatEventEnvelope[]): boolean {
  const saved = transcriptEndOf(envelopes);
  if (saved.at == null) return false;
  if (end.at == null) return true;
  const savedAt = Date.parse(saved.at);
  const endAt = Date.parse(end.at);
  if (!Number.isFinite(savedAt) || !Number.isFinite(endAt)) return saved.at !== end.at || (saved.sequence ?? 0) > (end.sequence ?? 0);
  if (savedAt !== endAt) return savedAt > endAt;
  return (saved.sequence ?? 0) > (end.sequence ?? 0);
}

/** Every part of the saved transcript, oldest first; null when the server has no such chat. */
async function readSavedTranscript(
  api: CloudApiClient,
  machineKey: string,
  chatId: string,
): Promise<{ chat: CloudChatRow; texts: string[]; olderPartLeftOut: boolean } | null> {
  const newestFirst: string[] = [];
  let chars = 0;
  let before: number | null = null;
  let chat: CloudChatRow | null = null;
  for (;;) {
    const page = await api.savedChat({ machineKey, chatId, before, limit: PAGE_LIMIT });
    if (!page) return chat ? { chat, texts: newestFirst.reverse(), olderPartLeftOut: false } : null;
    chat ??= page.chat;
    for (const part of page.parts) {
      if (chars + part.text.length > MAX_TRANSCRIPT_CHARS) {
        return { chat, texts: newestFirst.reverse(), olderPartLeftOut: true };
      }
      chars += part.text.length;
      newestFirst.push(part.text);
    }
    if (!page.hasMore || page.nextBefore == null) break;
    before = page.nextBefore;
  }
  return { chat: chat!, texts: newestFirst.reverse(), olderPartLeftOut: false };
}

/** A capsule as saved at rest, with where its chat stood then (left out by an older ADE). */
type SavedCapsule = { capsule: AgentChatCrossMachineHandoffCapsule; transcriptEnd: CapsuleTranscriptEnd | null };

/** The capsule saved at rest; null when there is none or it cannot be read (the restore replays). */
async function readCapsule(
  api: CloudApiClient,
  machineKey: string,
  chatId: string,
  logger: Logger,
  kind: "chat" | "cli" = "chat",
): Promise<SavedCapsule | null> {
  let manifest: CloudCapsuleManifest | null;
  try {
    manifest = await api.capsuleManifest(machineKey, chatId);
  } catch (error) {
    logger.warn("cloud.restore_capsule_read_failed", { chatId, error: errorText(error) });
    return null;
  }
  if (!manifest || manifest.sessionKind !== kind) return null;
  if (manifest.bytes <= 0 || manifest.bytes > CLOUD_CAPSULE_MAX_BYTES || manifest.parts <= 0) return null;
  try {
    const parts: Buffer[] = [];
    let total = 0;
    for (let part = 1; part <= manifest.parts; part += 1) {
      const bytes = Buffer.from(await api.readCapsulePart(machineKey, chatId, part));
      total += bytes.byteLength;
      if (total > manifest.bytes) throw new Error("The capsule is longer than its manifest says.");
      parts.push(bytes);
    }
    if (total !== manifest.bytes) throw new Error("The capsule is shorter than its manifest says.");
    const json = gunzipSync(Buffer.concat(parts), { maxOutputLength: MAX_CAPSULE_JSON_BYTES }).toString("utf8");
    const parsed = JSON.parse(json) as { v?: unknown; capsule?: AgentChatCrossMachineHandoffCapsule; transcriptEnd?: unknown };
    const capsule = parsed?.v === 1 ? parsed.capsule : null;
    if (!capsule || capsule.version !== 1 || typeof capsule.source?.provider !== "string") return null;
    if (kind === "chat" ? !capsule.forkTransport : !capsule.cli) return null;
    const end = parsed.transcriptEnd as Partial<CapsuleTranscriptEnd> | null | undefined;
    const transcriptEnd = end && typeof end === "object"
      ? { at: typeof end.at === "string" ? end.at : null, sequence: typeof end.sequence === "number" ? end.sequence : null }
      : null;
    return { capsule, transcriptEnd };
  } catch (error) {
    logger.warn("cloud.restore_capsule_unreadable", { chatId, error: errorText(error) });
    return null;
  }
}

export type CloudChatRestoreArgs = {
  fromMachineKey: string;
  chatId: string;
  laneId: string;
  modelId: string | null;
  /** The person's message: a CLI restore types it itself. */
  prompt: string;
  clientMessageId: string;
  /** `cli`: the saved row is a CLI session copy, so no saved chat is read. */
  kind?: "chat" | "cli";
};

/**
 * A CLI row: the session copy names its CLI; a CLI capsule (Claude Code,
 * Codex) carries its conversation. Null when neither is saved.
 */
async function restoreCloudCli(deps: CloudChatRestoreDeps, args: CloudChatRestoreArgs): Promise<CloudChatRestoreResult | null> {
  const { api, logger, machineKey } = deps;
  if (!deps.restoreCli) return null;
  const keys = args.fromMachineKey === machineKey ? [machineKey] : [args.fromMachineKey, machineKey];
  for (const key of keys) {
    const copy = await api.savedSession(key, args.chatId).catch(() => null);
    const capsule = (await readCapsule(api, key, args.chatId, logger, "cli"))?.capsule ?? null;
    const toolType = (copy?.session.kind === "cli" ? copy.session.toolType : null) ?? capsule?.cli?.toolType ?? null;
    if (!toolType) continue;
    const restored = await deps.restoreCli({
      sessionId: args.chatId,
      laneId: args.laneId,
      toolType,
      title: copy?.session.title ?? capsule?.source.title ?? null,
      capsule,
      prompt: args.prompt,
      clientMessageId: args.clientMessageId,
    });
    logger.info("cloud.chat_restored", { chatId: args.chatId, kind: "cli", restoredWith: restored.restoredWith });
    // The saved copy moves to this computer's key only now that the CLI runs here: until
    // then a send still finds the old address and joins this continue launch. Later sends
    // then reach this computer, not a new one. A capsule-only restore (its screen copy
    // was pruned) has no copy to move. The CLI already runs, so a failed move is logged
    // and the continue stands; a later send to the old address then starts another computer.
    let moved = false;
    if (copy && key !== machineKey) {
      moved = await api.moveSavedSession(key, args.chatId, moveRequest(deps)).then(() => true, (error: unknown) => {
        logger.warn("cloud.restore_move_failed", { chatId: args.chatId, kind: "cli", error: errorText(error) });
        return false;
      });
    }
    return { sessionId: restored.sessionId, restoredWith: restored.restoredWith, promptSent: true, moved, olderPartLeftOut: false };
  }
  return null;
}

export async function restoreCloudChat(
  deps: CloudChatRestoreDeps,
  args: CloudChatRestoreArgs,
): Promise<CloudChatRestoreResult> {
  const { api, logger, machineKey } = deps;
  if (args.kind === "cli") {
    const cli = await restoreCloudCli(deps, args);
    if (cli) return cli;
    throw new Error("ADE couldn't find this CLI's saved copy, so it can't continue it here.");
  }
  // A restore that ran before moved the copy here already: read it from here.
  let from = args.fromMachineKey;
  let saved = await readSavedTranscript(api, from, args.chatId);
  if (!saved && from !== machineKey) {
    saved = await readSavedTranscript(api, machineKey, args.chatId);
    if (saved) from = machineKey;
  }
  if (!saved) {
    const cli = await restoreCloudCli(deps, args);
    if (cli) return cli;
    throw new Error("ADE couldn't find this chat's saved copy, so it can't continue it here.");
  }
  // The capsule is under the key the copy is under, or (a restore that failed after the move) under the
  // key the copy moved from: the move kept it there (`keepCapsule`) until a restore succeeds.
  const forkedFrom = saved.chat.forkedFrom?.chatId === args.chatId ? saved.chat.forkedFrom.machineKey : null;
  let capsuleKey: string | null = from;
  let found = await readCapsule(api, from, args.chatId, logger);
  if (!found && forkedFrom && forkedFrom !== from) {
    found = await readCapsule(api, forkedFrom, args.chatId, logger);
    capsuleKey = forkedFrom;
  }
  if (!found) capsuleKey = null;
  const envelopes = parseSavedTranscript(saved.texts);
  // A capsule made before the chat's newest turns would resume the agent without them: replay instead.
  const stale = found?.transcriptEnd != null && capsuleOlderThanTranscript(found.transcriptEnd, envelopes);
  if (stale) logger.info("cloud.restore_capsule_stale", { chatId: args.chatId });
  const capsule = found && !stale ? found.capsule : null;
  const modelId = capsule?.target.targetModelId || args.modelId || saved.chat.model;
  if (!modelId) throw new Error("ADE can't tell which model this chat used, so it can't continue it here.");
  // The copy moves to this computer's key BEFORE any part of this chat uploads
  // here (CONTRACTS: moveSavedChat). A failed move stops the continue: a
  // restored chat would otherwise upload as a second copy of the same chat.
  // The capsule stays where it is through the move, so a restore that fails
  // after it still has the provider's history on the next try.
  let lastSeq = saved.chat.lastSeq;
  let moved = from === machineKey;
  if (!moved) {
    try {
      const answer = await api.moveSavedChat(from, args.chatId, { ...moveRequest(deps), keepCapsule: true });
      lastSeq = answer.chat.lastSeq;
      moved = answer.moved;
    } catch (error) {
      logger.warn("cloud.restore_move_failed", { chatId: args.chatId, error: errorText(error) });
      throw new Error("ADE couldn't move this chat's saved copy to this computer, so it can't continue it here. Try again.");
    }
  }
  // No upload of this chat until the uploader continues from the moved copy's sequence.
  deps.hold(args.chatId);
  let restored: Awaited<ReturnType<CloudChatRestoreDeps["restore"]>>;
  try {
    restored = await deps.restore({
      sessionId: args.chatId,
      laneId: args.laneId,
      modelId,
      title: saved.chat.title ?? null,
      envelopes,
      capsule,
      olderPartLeftOut: saved.olderPartLeftOut,
    });
  } catch (error) {
    deps.release(args.chatId);
    throw error;
  }
  if (!(await deps.adopt(restored.sessionId, lastSeq, args.laneId))) deps.release(args.chatId);
  // Used now (or older than the chat): a capsule left under another key goes. This machine's own stays,
  // as its rest save replaces it. Best effort: a capsule left behind goes with its lane or its chat.
  if (capsuleKey && capsuleKey !== machineKey) {
    await api.deleteCapsule(capsuleKey, args.chatId).catch((error: unknown) => {
      logger.warn("cloud.restore_capsule_delete_failed", { chatId: args.chatId, error: errorText(error) });
    });
  }
  logger.info("cloud.chat_restored", {
    chatId: args.chatId,
    restoredWith: restored.restoredWith,
    moved,
    events: envelopes.length,
    olderPartLeftOut: saved.olderPartLeftOut,
  });
  return { sessionId: restored.sessionId, restoredWith: restored.restoredWith, promptSent: false, moved, olderPartLeftOut: saved.olderPartLeftOut };
}

/** The most chats one lane brings back to a new computer, and the list pages read to find them. */
const LANE_CHATS_MAX = 50;
const LANE_CHATS_MAX_PAGES = 10;

/**
 * Contract C3 for a lane that comes back on a new computer (a new computer
 * for a kept lane, or a send that continues one of its chats): its other
 * chats come back too. Their old computer is gone, so every surface lists
 * them under this computer; restored here with their own ids, they open and
 * take sends like any chat on it. Chats only: a CLI comes back when a send
 * continues it. One chat that can't be restored is logged and skipped.
 * Returns how many came back.
 */
export async function restoreLaneChats(
  deps: CloudChatRestoreDeps,
  args: { laneId: string; projectKey: string },
): Promise<number> {
  const { api, logger, machineKey } = deps;
  const newest = new Map<string, CloudChatRow>();
  let cursor: string | null = null;
  for (let page = 0; page < LANE_CHATS_MAX_PAGES; page += 1) {
    const listed = await api.savedChats({ projectKey: args.projectKey, limit: 500, cursor });
    for (const row of listed.chats) {
      if (row.laneId !== args.laneId) continue;
      const current = newest.get(row.chatId);
      if (!current || row.updatedAt > current.updatedAt) newest.set(row.chatId, row);
    }
    cursor = listed.nextCursor;
    if (!cursor) break;
  }
  // Only a chat whose newest copy is on a computer that is gone: one on a live computer stays there.
  const lost = [...newest.values()]
    .filter((row) => row.machineKey.toLowerCase() !== machineKey.toLowerCase() && row.computer?.state === "deleted")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, LANE_CHATS_MAX);
  const { restoreCli: _cliRestore, ...chatOnly } = deps;
  let restored = 0;
  for (const row of lost) {
    try {
      await restoreCloudChat(chatOnly, {
        fromMachineKey: row.machineKey,
        chatId: row.chatId,
        laneId: args.laneId,
        modelId: null,
        prompt: "",
        clientMessageId: `restore-${row.chatId}`,
        kind: "chat",
      });
      restored += 1;
    } catch (error) {
      logger.warn("cloud.lane_chat_restore_failed", { chatId: row.chatId, error: errorText(error) });
    }
  }
  return restored;
}
