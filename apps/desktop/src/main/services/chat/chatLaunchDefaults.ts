import fs from "node:fs";
import path from "node:path";
import type { AgentChatLaunchDefaults, AgentChatSession } from "../../../shared/types";
import { getModelById, resolveModelAlias, resolveProviderGroupForModel } from "../../../shared/modelRegistry";

/**
 * One file per ADE home: the model and settings this machine last launched or
 * switched a chat to. Clients read it to seed a new chat, so a phone, the web
 * client and every desktop window open on what was used last on this machine.
 */
const FILE_NAME = "chat-launch-defaults.json";

export function chatLaunchDefaultsPath(adeHome: string): string {
  return path.join(adeHome, FILE_NAME);
}

export function readChatLaunchDefaults(adeHome: string): AgentChatLaunchDefaults | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(chatLaunchDefaultsPath(adeHome), "utf8")) as Partial<AgentChatLaunchDefaults>;
    if (parsed?.version !== 1 || typeof parsed.modelId !== "string" || !parsed.modelId.trim()) return null;
    if (typeof parsed.provider !== "string" || typeof parsed.updatedAt !== "string") return null;
    return parsed as AgentChatLaunchDefaults;
  } catch {
    return null;
  }
}

/** Codes Windows raises while another process briefly holds the target open. */
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || attempt >= 4 || !WINDOWS_TRANSIENT_RENAME_CODES.has(code)) throw error;
      // A reader (another ADE process) holds the file for milliseconds; a
      // short synchronous back-off is cheaper than dropping the update.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

/** Atomic write: a reader never sees half a file. Best-effort; never throws. */
export function writeChatLaunchDefaults(adeHome: string, defaults: AgentChatLaunchDefaults): void {
  const target = chatLaunchDefaultsPath(adeHome);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
    renameWithRetry(temp, target);
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * This machine's launch defaults: the file under the machine ADE home, or —
 * with no home (tests, embedders) — memory only, so nothing ever lands in a
 * real home by accident.
 */
export function createChatLaunchDefaultsStore(machineAdeHome: string | null | undefined): {
  get: () => AgentChatLaunchDefaults | null;
  /** Record a person's top-level Work chat; any other chat is ignored. */
  remember: (session: AgentChatSession) => void;
} {
  let inMemory: AgentChatLaunchDefaults | null = null;
  return {
    get: () => (machineAdeHome ? readChatLaunchDefaults(machineAdeHome) : inMemory),
    remember: (session) => {
      // Subagents, CTO and identity chats, and automation runs launch on
      // settings someone else picked.
      if ((session.surface ?? "work") !== "work") return;
      if (session.orchestrationParentSessionId?.trim() || session.identityKey || session.automationId) return;
      const defaults = launchDefaultsFromSession(session);
      if (!defaults) return;
      if (machineAdeHome) writeChatLaunchDefaults(machineAdeHome, defaults);
      else inMemory = defaults;
    },
  };
}

/** The launch defaults a session's current model and settings describe. */
export function launchDefaultsFromSession(session: AgentChatSession, now = new Date()): AgentChatLaunchDefaults | null {
  // An older session can carry only `model`; resolve it to the registry id
  // rather than persist a CLI short name.
  const fallback = !session.modelId?.trim() && session.model
    ? getModelById(session.model) ?? resolveModelAlias(session.model)
    : undefined;
  // A short name can match another provider's model; only keep this one's.
  const modelId = session.modelId?.trim()
    || (fallback && resolveProviderGroupForModel(fallback) === session.provider ? fallback.id : undefined);
  if (!modelId) return null;
  return {
    version: 1,
    provider: session.provider,
    modelId,
    reasoningEffort: session.reasoningEffort ?? null,
    fastMode: session.fastMode === true,
    executionMode: session.executionMode ?? null,
    interactionMode: session.interactionMode ?? null,
    permissionMode: session.permissionMode ?? null,
    claudePermissionMode: session.claudePermissionMode ?? null,
    codexApprovalPolicy: session.codexApprovalPolicy ?? null,
    codexSandbox: session.codexSandbox ?? null,
    codexConfigSource: session.codexConfigSource ?? null,
    opencodePermissionMode: session.opencodePermissionMode ?? null,
    droidPermissionMode: session.droidPermissionMode ?? null,
    acpPermissionMode: session.acpPermissionMode ?? null,
    cursorModeId: session.cursorModeId ?? null,
    cursorConfigValues: session.cursorConfigValues ?? null,
    updatedAt: now.toISOString(),
  };
}
