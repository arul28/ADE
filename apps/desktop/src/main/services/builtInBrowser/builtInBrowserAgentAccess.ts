import { dialog } from "electron";
import type { BrowserWindow, Session } from "electron";
import type { Logger } from "../logging/logger";

const HIGH_RISK_HOSTS = new Set([
  "accounts.google.com",
  "console.aws.amazon.com",
  "dev.azure.com",
  "github.com",
  "gitlab.com",
  "portal.azure.com",
  "signin.aws.amazon.com",
]);

const HIGH_RISK_HOST_SUFFIXES = [
  ".aws.amazon.com",
  ".github.com",
  ".gitlab.com",
  ".microsoftonline.com",
];

type AgentIdentity = {
  laneId?: string | null;
  chatSessionId?: string | null;
};

type AccessPromptResult = {
  granted: boolean;
};

export function createBuiltInBrowserAgentAccessController(args: {
  getSession: () => Session;
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
  const authenticatedCookieDomains = new Set<string>();
  const evaluatedSafeOrigins = new Set<string>();
  const grants = new Set<string>();
  const pendingPrompts = new Map<string, Promise<boolean>>();

  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };

  const refreshAuthenticatedDomains = async (): Promise<void> => {
    try {
      const cookies = await args.getSession().cookies.get({});
      authenticatedCookieDomains.clear();
      for (const cookie of cookies) {
        const domain = normalizeCookieDomain(cookie.domain);
        if (domain) authenticatedCookieDomains.add(domain);
      }
    } catch (error) {
      logger()?.warn("built_in_browser.agent_access_cookie_scan_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  const inspectOrigin = async (origin: string): Promise<boolean> => {
    const host = new URL(origin).hostname.toLowerCase();
    if (isHighRiskHost(host) || cookieDomainsContainHost(authenticatedCookieDomains, host)) return true;
    try {
      const cookies = await args.getSession().cookies.get({ url: `${origin}/` });
      if (cookies.length > 0) {
        for (const cookie of cookies) {
          const domain = normalizeCookieDomain(cookie.domain);
          if (domain) authenticatedCookieDomains.add(domain);
        }
        return true;
      }
      evaluatedSafeOrigins.add(origin);
      return false;
    } catch (error) {
      logger()?.warn("built_in_browser.agent_access_cookie_check_failed", {
        origin,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  };

  const authorizeUrl = async (
    url: string | null | undefined,
    identity: AgentIdentity,
    reason: string,
  ): Promise<{ origin: string | null; required: boolean; granted: boolean }> => {
    const agentKey = agentIdentityKey(identity);
    const origin = browserOrigin(url);
    if (!agentKey || !origin || isLocalBrowserOrigin(origin)) {
      return { origin, required: false, granted: true };
    }
    const grantKey = accessGrantKey(agentKey, origin);
    if (grants.has(grantKey)) return { origin, required: true, granted: true };
    const required = await inspectOrigin(origin);
    if (!required) return { origin, required: false, granted: true };

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
    if (!agentKey || !origin || isLocalBrowserOrigin(origin)) return;
    const grantKey = accessGrantKey(agentKey, origin);
    if (grants.has(grantKey)) return;
    const host = new URL(origin).hostname.toLowerCase();
    const knownSafe = evaluatedSafeOrigins.has(origin)
      && !isHighRiskHost(host)
      && !cookieDomainsContainHost(authenticatedCookieDomains, host);
    if (knownSafe) return;
    throw new Error(
      `ADE agent access to ${origin} requires a browser human-approval check. Run ade --socket browser authorize${normalizedString(identity.chatSessionId) ? " from this chat" : ""} and try again.`,
    );
  };

  return {
    refreshAuthenticatedDomains,
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
    isKnownSensitiveUrlSync(url: string | null | undefined, identity: AgentIdentity): boolean {
      const agentKey = agentIdentityKey(identity);
      const origin = browserOrigin(url);
      if (!agentKey || !origin || isLocalBrowserOrigin(origin)) return false;
      if (grants.has(accessGrantKey(agentKey, origin))) return false;
      const host = new URL(origin).hostname.toLowerCase();
      return isHighRiskHost(host) || cookieDomainsContainHost(authenticatedCookieDomains, host);
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

function isHighRiskHost(host: string): boolean {
  return HIGH_RISK_HOSTS.has(host) || HIGH_RISK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function normalizeCookieDomain(value: unknown): string | null {
  const domain = normalizedString(value)?.replace(/^\./, "").toLowerCase() ?? null;
  return domain && !domain.includes("/") ? domain : null;
}

function cookieDomainsContainHost(domains: Set<string>, host: string): boolean {
  for (const domain of domains) {
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
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
