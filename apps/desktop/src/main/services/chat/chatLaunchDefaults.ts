import fs from "node:fs";
import path from "node:path";
import type { AgentChatLaunchDefaults, AgentChatSession } from "../../../shared/types";

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

/** Atomic write: a reader never sees half a file. Best-effort; never throws. */
export function writeChatLaunchDefaults(adeHome: string, defaults: AgentChatLaunchDefaults): void {
  const target = chatLaunchDefaultsPath(adeHome);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
  } catch {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
  }
}

/** The launch defaults a session's current model and settings describe. */
export function launchDefaultsFromSession(session: AgentChatSession, now = new Date()): AgentChatLaunchDefaults | null {
  const modelId = session.modelId?.trim();
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
