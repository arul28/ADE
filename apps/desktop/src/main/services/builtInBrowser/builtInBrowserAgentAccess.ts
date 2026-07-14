import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import type { Logger } from "../logging/logger";

type AgentIdentity = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

type AccessPromptResult = {
  granted: boolean;
};

export function createBuiltInBrowserAgentAccessController(args: {
  hasAllowedPermissionForOrigin?: (origin: string) => boolean;
  resolveParentWindow: () => BrowserWindow | null;
  getLogger?: () => Logger | null;
  prompt?: (input: {
    parent: BrowserWindow | null;
    origin: string;
    laneId: string | null;
    chatSessionId: string | null;
    reason: string;
  }) => Promise<AccessPromptResult>;
}) {
  const grants = new Set<string>();
  const pendingPrompts = new Map<string, Promise<boolean>>();

  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };

  const authorizeUrl = async (
    url: string | null | undefined,
    identity: AgentIdentity,
    reason: string,
  ): Promise<{ origin: string | null; required: boolean; granted: boolean }> => {
    const agentKey = agentIdentityKey(identity);
    const origin = browserOrigin(url);
    if (
      !agentKey
      || !origin
      || (isLocalBrowserOrigin(origin) && !args.hasAllowedPermissionForOrigin?.(origin))
    ) {
      return { origin, required: false, granted: true };
    }
    const grantKey = accessGrantKey(agentKey, origin);
    if (grants.has(grantKey)) return { origin, required: true, granted: true };

    const existing = pendingPrompts.get(grantKey);
    if (existing) {
      const granted = await existing;
      return { origin, required: true, granted };
    }
    const prompt = (async () => {
      const result = await (args.prompt ?? showAgentAccessPrompt)({
        parent: args.resolveParentWindow(),
        origin,
        laneId: normalizedString(identity.laneId),
        chatSessionId: normalizedString(identity.chatSessionId),
        reason,
      });
      if (result.granted) grants.add(grantKey);
      logger()?.info("built_in_browser.agent_origin_access_decided", {
        origin,
        laneId: normalizedString(identity.laneId),
        chatSessionId: normalizedString(identity.chatSessionId),
        decision: result.granted ? "allow" : "block",
      });
      return result.granted;
    })().finally(() => pendingPrompts.delete(grantKey));
    pendingPrompts.set(grantKey, prompt);
    return { origin, required: true, granted: await prompt };
  };

  const assertUrlAccessSync = (url: string | null | undefined, identity: AgentIdentity): void => {
    const agentKey = agentIdentityKey(identity);
    const origin = browserOrigin(url);
    if (
      !agentKey
      || !origin
      || (isLocalBrowserOrigin(origin) && !args.hasAllowedPermissionForOrigin?.(origin))
    ) return;
    const grantKey = accessGrantKey(agentKey, origin);
    if (grants.has(grantKey)) return;
    throw new Error(
      `ADE agent access to ${origin} requires a browser human-approval check. Run ade --socket browser authorize${normalizedString(identity.chatSessionId) ? " from this chat" : ""} and try again.`,
    );
  };

  return {
    async requireUrlAccess(
      url: string | null | undefined,
      identity: AgentIdentity,
      reason: string,
    ): Promise<void> {
      const result = await authorizeUrl(url, identity, reason);
      if (result.granted) return;
      throw new Error(`Human approval was denied for ADE agent access to ${result.origin ?? "this browser origin"}.`);
    },
    authorizeUrl,
    assertUrlAccessSync,
    isUrlAccessRequiredSync(url: string | null | undefined, identity: AgentIdentity): boolean {
      try {
        assertUrlAccessSync(url, identity);
        return false;
      } catch {
        return true;
      }
    },
    recordHumanAuthentication(url: string, identity: AgentIdentity | null): void {
      const origin = browserOrigin(url);
      if (!origin || isLocalBrowserOrigin(origin)) return;
      const agentKey = identity ? agentIdentityKey(identity) : null;
      if (agentKey) grants.add(accessGrantKey(agentKey, origin));
      logger()?.info("built_in_browser.authenticated_origin_recorded", {
        origin,
        grantedToAgent: Boolean(agentKey),
      });
    },
  };
}

function agentIdentityKey(identity: AgentIdentity): string | null {
  const chatSessionId = normalizedString(identity.chatSessionId);
  if (chatSessionId) return `chat:${chatSessionId}`;
  const laneId = normalizedString(identity.laneId);
  return laneId ? `lane:${laneId}` : null;
}

function accessGrantKey(agentKey: string, origin: string): string {
  return JSON.stringify([agentKey, origin]);
}

function browserOrigin(value: string | null | undefined): string | null {
  const text = normalizedString(value);
  if (!text || text === "about:blank") return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isLocalBrowserOrigin(origin: string): boolean {
  const parsed = new URL(origin);
  const host = parsed.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

function normalizedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

async function showAgentAccessPrompt(input: {
  parent: BrowserWindow | null;
  origin: string;
  laneId: string | null;
  chatSessionId: string | null;
  reason: string;
}): Promise<AccessPromptResult> {
  const owner = input.chatSessionId
    ? `chat ${input.chatSessionId}${input.laneId ? ` in lane ${input.laneId}` : ""}`
    : input.laneId
      ? `lane ${input.laneId}`
      : "an ADE agent";
  const options = {
    type: "warning" as const,
    buttons: ["Allow for this chat", "Block"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: `Allow ${owner} to use your browser session at ${input.origin}?`,
    detail: `${input.reason} This site may contain a signed-in human session. Approval lasts only for this ADE run and this chat or lane.`,
  };
  const result = input.parent
    ? await dialog.showMessageBox(input.parent, options)
    : await dialog.showMessageBox(options);
  return { granted: result.response === 0 };
}
