import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import { pathKey } from "../shared/pathCompare";
import {
  BUILT_IN_BROWSER_AGENT_ACCESS_DEFAULT_MODE,
  BUILT_IN_BROWSER_APPROVAL_BLOCKED_CODE,
  BUILT_IN_BROWSER_APPROVAL_PENDING_CODE,
  normalizeBuiltInBrowserAgentAccessMode,
  type BuiltInBrowserAgentAccessAnswer,
  type BuiltInBrowserAgentAccessMode,
  type BuiltInBrowserAgentAccessPrompt,
  type BuiltInBrowserAgentAccessRevokeArgs,
  type BuiltInBrowserAgentAccessSnapshot,
  type BuiltInBrowserAgentChatGrant,
  type BuiltInBrowserAgentLaneGrant,
} from "../../../shared/types/builtInBrowser";

/**
 * Who may drive the ADE browser.
 *
 * One machine-wide setting decides it (see {@link BuiltInBrowserAgentAccessMode}),
 * plus the lanes and chats the user allowed. A grant covers the whole browser —
 * every site — because the question a person can actually answer is "may this
 * agent use my browser?", not "may it visit this origin?".
 *
 * Callers with no lane and no chat are the human (the Browser pane, a plain
 * terminal): they are never asked.
 */

type AgentIdentity = {
  laneId?: string | null;
  chatSessionId?: string | null;
  projectRoot?: string | null;
};

/** Names a person recognises for the agent asking: its chat title and lane name. */
export type BuiltInBrowserAgentDescription = {
  chatTitle?: string | null;
  laneName?: string | null;
  projectRoot?: string | null;
};

/** What is saved: the setting and the grants. Prompts are never saved. */
export type BuiltInBrowserAgentAccessPersisted = {
  mode: BuiltInBrowserAgentAccessMode;
  laneGrants: BuiltInBrowserAgentLaneGrant[];
  chatGrants: BuiltInBrowserAgentChatGrant[];
};

export type BuiltInBrowserAgentAccessStore = {
  read: () => Partial<BuiltInBrowserAgentAccessPersisted> | null | undefined;
  write: (state: BuiltInBrowserAgentAccessPersisted) => void;
};

/**
 * The human has not answered the prompt inside one call's budget. The prompt
 * stays open; the same call made again joins it instead of asking twice.
 */
export class BuiltInBrowserApprovalPendingError extends Error {
  readonly code = BUILT_IN_BROWSER_APPROVAL_PENDING_CODE;

  constructor(subject: "chat" | "lane") {
    super(
      `${BUILT_IN_BROWSER_APPROVAL_PENDING_CODE}: waiting for the user to allow this ${subject} to use the ADE browser. `
      + "The prompt is still open in ADE; run the same command again to keep waiting.",
    );
    this.name = "BuiltInBrowserApprovalPendingError";
  }
}

/** The human pressed Block. */
export class BuiltInBrowserApprovalBlockedError extends Error {
  readonly code = BUILT_IN_BROWSER_APPROVAL_BLOCKED_CODE;

  constructor(subject: "chat" | "lane") {
    super(
      `${BUILT_IN_BROWSER_APPROVAL_BLOCKED_CODE}: the user blocked this ${subject} from using the ADE browser. `
      + "Do not retry; ask the user if the browser is needed.",
    );
    this.name = "BuiltInBrowserApprovalBlockedError";
  }
}

/**
 * How long a Block stays the answer for a caller that was told "pending" and
 * is coming back for the result. Only long enough to cover the gap between one
 * call returning pending and the CLI's re-run arriving; after it, a new call
 * asks again.
 */
const BLOCK_ANSWER_REJOIN_MS = 10_000;
/**
 * An unanswered prompt closes itself after this long. The CLI stops waiting at
 * two minutes; a question left on screen for much longer than that is about an
 * agent that has moved on.
 */
const PROMPT_EXPIRY_MS = 10 * 60_000;
/** Saved grants are bounded; the oldest go first. */
const MAX_SAVED_GRANTS = 500;

type PromptEntry = {
  key: string;
  prompt: BuiltInBrowserAgentAccessPrompt;
  identity: AgentIdentity;
  /** Hidden from the snapshot until the chat and lane names are known. */
  ready: boolean;
  promise: Promise<boolean>;
  resolve: (granted: boolean) => void;
  toldPending: boolean;
  expiryTimer: ReturnType<typeof setTimeout> | null;
};

export function createBuiltInBrowserAgentAccessController(args: {
  /** Where the setting and grants live. Omitted: in memory, default mode. */
  store?: BuiltInBrowserAgentAccessStore | null;
  getLogger?: () => Logger | null;
  /** Chat title and lane name for the prompt; ids are the fallback. */
  describeAgent?: (identity: {
    laneId: string | null;
    chatSessionId: string | null;
  }) => BuiltInBrowserAgentDescription | null | Promise<BuiltInBrowserAgentDescription | null>;
  /** Called whenever the setting, the grants or the open prompts change. */
  onChange?: (snapshot: BuiltInBrowserAgentAccessSnapshot) => void;
  /** Test seam. */
  initialMode?: BuiltInBrowserAgentAccessMode;
}) {
  const logger = (): Logger | null => {
    try {
      return args.getLogger?.() ?? null;
    } catch {
      return null;
    }
  };

  const loaded = (() => {
    try {
      return args.store?.read() ?? null;
    } catch {
      return null;
    }
  })();
  let mode: BuiltInBrowserAgentAccessMode = loaded?.mode != null
    ? normalizeBuiltInBrowserAgentAccessMode(loaded.mode)
    : args.initialMode ?? BUILT_IN_BROWSER_AGENT_ACCESS_DEFAULT_MODE;
  let laneGrants: BuiltInBrowserAgentLaneGrant[] = sanitizeLaneGrants(loaded?.laneGrants);
  let chatGrants: BuiltInBrowserAgentChatGrant[] = sanitizeChatGrants(loaded?.chatGrants);
  const prompts = new Map<string, PromptEntry>();
  /** Blocks answered to a prompt whose callers were told "pending", by prompt key. */
  const recentBlocksForWaiters = new Map<string, number>();

  // Every prompt with a lane offers "Allow this lane". In "chats I approve"
  // a lane grant would not cover a chat, so that answer also moves the
  // setting to "lanes I approve", the same way "Allow all agents" moves it
  // to "all".
  const laneOffered = (prompt: BuiltInBrowserAgentAccessPrompt): boolean => Boolean(prompt.laneId);

  const snapshot = (): BuiltInBrowserAgentAccessSnapshot => ({
    mode,
    laneGrants: laneGrants.map((grant) => ({ ...grant })),
    chatGrants: chatGrants.map((grant) => ({ ...grant })),
    prompts: [...prompts.values()]
      .filter((entry) => entry.ready)
      .map((entry) => ({ ...entry.prompt, canAllowLane: laneOffered(entry.prompt) })),
  });

  const emitChange = (): void => {
    try {
      args.onChange?.(snapshot());
    } catch {
      // A listener must never break the gate.
    }
  };

  const persist = (): void => {
    try {
      args.store?.write({ mode, laneGrants, chatGrants });
    } catch (error) {
      logger()?.warn("built_in_browser.agent_access_persist_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const findLaneGrant = (projectRoot: string | null, laneId: string): BuiltInBrowserAgentLaneGrant | null => {
    const key = projectRootKey(projectRoot);
    return laneGrants.find((grant) => {
      if (grant.laneId !== laneId) return false;
      // A lane id is unique on its own; the project only disambiguates when
      // both sides know it.
      const grantKey = projectRootKey(grant.projectRoot);
      return !key || !grantKey || grantKey === key;
    }) ?? null;
  };

  const covers = (identity: AgentIdentity): boolean => {
    if (mode === "all") return true;
    const chatSessionId = normalizedString(identity.chatSessionId);
    const laneId = normalizedString(identity.laneId);
    if (chatSessionId && chatGrants.some((grant) => grant.chatSessionId === chatSessionId)) return true;
    // In "chats I approve", a lane grant only covers callers that have no chat
    // to approve (an agent CLI in a lane terminal).
    if (laneId && (mode === "lanes" || !chatSessionId)) {
      return findLaneGrant(normalizedString(identity.projectRoot), laneId) != null;
    }
    return false;
  };

  const promptKeyFor = (identity: AgentIdentity): string | null => {
    const chatSessionId = normalizedString(identity.chatSessionId);
    if (chatSessionId) return `chat:${chatSessionId}`;
    const laneId = normalizedString(identity.laneId);
    return laneId ? `lane:${projectRootKey(normalizedString(identity.projectRoot)) ?? ""}:${laneId}` : null;
  };

  const subjectFor = (identity: AgentIdentity): "chat" | "lane" =>
    normalizedString(identity.chatSessionId) ? "chat" : "lane";

  const closePrompt = (entry: PromptEntry, granted: boolean, decision: string): void => {
    if (prompts.get(entry.key) !== entry) return;
    prompts.delete(entry.key);
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
    if (!granted && entry.toldPending && decision === "block") {
      recentBlocksForWaiters.set(entry.key, Date.now());
    }
    logger()?.info("built_in_browser.agent_access_decided", {
      laneId: entry.prompt.laneId,
      chatSessionId: entry.prompt.chatSessionId,
      decision,
    });
    entry.resolve(granted);
  };

  /** Close every open prompt the current setting and grants now cover. */
  const settleCoveredPrompts = (): void => {
    for (const entry of [...prompts.values()]) {
      if (covers(entry.identity)) closePrompt(entry, true, "covered");
    }
  };

  const openPrompt = (key: string, identity: AgentIdentity): PromptEntry => {
    const chatSessionId = normalizedString(identity.chatSessionId);
    const laneId = normalizedString(identity.laneId);
    let resolve: (granted: boolean) => void = () => {};
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    const entry: PromptEntry = {
      key,
      identity,
      ready: false,
      promise,
      resolve,
      toldPending: false,
      expiryTimer: null,
      prompt: {
        id: randomUUID(),
        chatSessionId,
        chatTitle: null,
        laneId,
        laneName: null,
        projectRoot: normalizedString(identity.projectRoot),
        canAllowLane: false,
        canAllowChat: Boolean(chatSessionId),
        requestedAt: new Date().toISOString(),
      },
    };
    prompts.set(key, entry);
    entry.expiryTimer = setTimeout(() => {
      closePrompt(entry, false, "expired");
      emitChange();
    }, PROMPT_EXPIRY_MS);
    entry.expiryTimer.unref?.();
    void (async () => {
      let names: BuiltInBrowserAgentDescription = {};
      try {
        names = (await args.describeAgent?.({ laneId, chatSessionId })) ?? {};
      } catch {
        names = {};
      }
      entry.prompt.chatTitle = normalizedString(names.chatTitle);
      entry.prompt.laneName = normalizedString(names.laneName);
      entry.prompt.projectRoot ??= normalizedString(names.projectRoot);
      entry.identity = { ...entry.identity, projectRoot: entry.prompt.projectRoot };
      entry.ready = true;
      if (prompts.get(key) === entry) emitChange();
    })();
    return entry;
  };

  /**
   * Ask (or join the open ask) whether `identity` may use the ADE browser.
   *
   * `waitBudgetMs` bounds how long THIS call waits for the human. Past it the
   * call throws {@link BuiltInBrowserApprovalPendingError} and the prompt stays
   * open, so a caller behind a transport with its own timeout (the daemon's
   * bridge) gets a real answer instead of a timeout, and its re-run joins the
   * same prompt. Page-triggered navigations pass no budget: nobody is waiting
   * on them.
   *
   * `url` is not part of the decision. It is reported back so the caller can
   * say what the agent was reaching for.
   */
  const authorizeUrl = async (
    url: string | null | undefined,
    identity: AgentIdentity,
    _reason: string,
    options: { waitBudgetMs?: number | null } = {},
  ): Promise<{ origin: string | null; required: boolean; granted: boolean }> => {
    const origin = browserOrigin(url);
    const key = promptKeyFor(identity);
    if (!key || mode === "all") return { origin, required: false, granted: true };
    if (covers(identity)) return { origin, required: true, granted: true };
    const blockedAt = recentBlocksForWaiters.get(key);
    if (blockedAt != null) {
      if (Date.now() - blockedAt <= BLOCK_ANSWER_REJOIN_MS) {
        return { origin, required: true, granted: false };
      }
      recentBlocksForWaiters.delete(key);
    }

    const entry = prompts.get(key) ?? openPrompt(key, identity);
    const budget = options.waitBudgetMs;
    if (budget == null || !Number.isFinite(budget) || budget <= 0) {
      return { origin, required: true, granted: await entry.promise };
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pending = Symbol("pending");
    const outcome = await Promise.race([
      entry.promise,
      new Promise<typeof pending>((resolve) => {
        timer = setTimeout(() => resolve(pending), budget);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (outcome === pending) {
      entry.toldPending = true;
      throw new BuiltInBrowserApprovalPendingError(subjectFor(identity));
    }
    return { origin, required: true, granted: outcome };
  };

  const assertUrlAccessSync = (_url: string | null | undefined, identity: AgentIdentity): void => {
    if (!promptKeyFor(identity) || covers(identity)) return;
    const subject = subjectFor(identity);
    throw new Error(
      `The user has not allowed this ${subject} to use the ADE browser yet. `
      + `Run ade --socket browser authorize${subject === "chat" ? " from this chat" : ""} to ask them, then try again.`,
    );
  };

  const addLaneGrant = (grant: Omit<BuiltInBrowserAgentLaneGrant, "grantedAt">): void => {
    const key = projectRootKey(grant.projectRoot);
    laneGrants = [
      { ...grant, grantedAt: new Date().toISOString() },
      ...laneGrants.filter((entry) => !(entry.laneId === grant.laneId && projectRootKey(entry.projectRoot) === key)),
    ].slice(0, MAX_SAVED_GRANTS);
  };

  const addChatGrant = (grant: Omit<BuiltInBrowserAgentChatGrant, "grantedAt">): void => {
    chatGrants = [
      { ...grant, grantedAt: new Date().toISOString() },
      ...chatGrants.filter((entry) => entry.chatSessionId !== grant.chatSessionId),
    ].slice(0, MAX_SAVED_GRANTS);
  };

  const gate = (defaults: { projectRoot: string | null }) => {
    const withDefaults = (identity: AgentIdentity): AgentIdentity => ({
      ...identity,
      projectRoot: normalizedString(identity.projectRoot) ?? defaults.projectRoot,
    });
    return {
      /**
       * An agent command's gate: waits at most `waitBudgetMs` for the human (see
       * {@link authorizeUrl}), and names a Block as the user's answer.
       */
      async requireUrlAccess(
        url: string | null | undefined,
        identity: AgentIdentity,
        reason: string,
        options: { waitBudgetMs?: number | null } = {},
      ): Promise<void> {
        const scoped = withDefaults(identity);
        const result = await authorizeUrl(url, scoped, reason, options);
        if (result.granted) return;
        throw new BuiltInBrowserApprovalBlockedError(subjectFor(scoped));
      },
      authorizeUrl: (
        url: string | null | undefined,
        identity: AgentIdentity,
        reason: string,
        options: { waitBudgetMs?: number | null } = {},
      ) => authorizeUrl(url, withDefaults(identity), reason, options),
      assertUrlAccessSync: (url: string | null | undefined, identity: AgentIdentity): void =>
        assertUrlAccessSync(url, withDefaults(identity)),
      isUrlAccessRequiredSync(url: string | null | undefined, identity: AgentIdentity): boolean {
        try {
          assertUrlAccessSync(url, withDefaults(identity));
          return false;
        } catch {
          return true;
        }
      },
      /**
       * A person finished signing in on a page an agent was driving. The agent
       * already had to be allowed to get there, so this grants nothing; it is
       * kept as a record.
       */
      recordHumanAuthentication(url: string, identity: AgentIdentity | null): void {
        logger()?.info("built_in_browser.authenticated_origin_recorded", {
          origin: browserOrigin(url),
          byAgent: Boolean(identity && promptKeyFor(identity)),
        });
      },
    };
  };

  const rootGate = gate({ projectRoot: null });

  return {
    ...rootGate,
    /** The same gate, with `projectRoot` filled in for callers that did not name one. */
    forProjectRoot: (projectRoot: string | null) => gate({ projectRoot: normalizedString(projectRoot) }),
    getSnapshot: snapshot,
    setMode(next: BuiltInBrowserAgentAccessMode): BuiltInBrowserAgentAccessSnapshot {
      const normalized = normalizeBuiltInBrowserAgentAccessMode(next);
      if (normalized !== mode) {
        mode = normalized;
        persist();
        logger()?.info("built_in_browser.agent_access_mode_changed", { mode });
        settleCoveredPrompts();
      }
      emitChange();
      return snapshot();
    },
    /**
     * The human's answer to one prompt. An answer to a prompt that is already
     * closed (answered in another window, expired) changes nothing.
     */
    answerPrompt(promptId: string, answer: BuiltInBrowserAgentAccessAnswer): BuiltInBrowserAgentAccessSnapshot {
      const entry = [...prompts.values()].find((candidate) => candidate.prompt.id === promptId) ?? null;
      if (!entry) return snapshot();
      const { prompt } = entry;
      if (answer === "all") {
        mode = "all";
        persist();
      } else if (answer === "lane" && prompt.laneId && laneOffered(prompt)) {
        if (mode === "chats" && prompt.chatSessionId) {
          mode = "lanes";
          logger()?.info("built_in_browser.agent_access_mode_changed", { mode, via: "allow_lane" });
        }
        addLaneGrant({ projectRoot: prompt.projectRoot, laneId: prompt.laneId, laneName: prompt.laneName });
        persist();
      } else if (answer === "chat" && prompt.chatSessionId) {
        addChatGrant({ chatSessionId: prompt.chatSessionId, chatTitle: prompt.chatTitle, laneName: prompt.laneName });
        persist();
      } else {
        closePrompt(entry, false, "block");
        emitChange();
        return snapshot();
      }
      closePrompt(entry, true, answer);
      settleCoveredPrompts();
      emitChange();
      return snapshot();
    },
    revoke(input: BuiltInBrowserAgentAccessRevokeArgs): BuiltInBrowserAgentAccessSnapshot {
      if (input.kind === "all") {
        laneGrants = [];
        chatGrants = [];
      } else if (input.kind === "lane") {
        const key = projectRootKey(input.projectRoot);
        laneGrants = laneGrants.filter((grant) => !(grant.laneId === input.laneId && projectRootKey(grant.projectRoot) === key));
      } else {
        chatGrants = chatGrants.filter((grant) => grant.chatSessionId !== input.chatSessionId);
      }
      persist();
      emitChange();
      return snapshot();
    },
  };
}

export type BuiltInBrowserAgentAccessController = ReturnType<typeof createBuiltInBrowserAgentAccessController>;
/** The per-caller gate the window services use. */
export type BuiltInBrowserAgentAccessGate = ReturnType<BuiltInBrowserAgentAccessController["forProjectRoot"]>;

function sanitizeLaneGrants(value: unknown): BuiltInBrowserAgentLaneGrant[] {
  if (!Array.isArray(value)) return [];
  const out: BuiltInBrowserAgentLaneGrant[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const laneId = normalizedString(record.laneId);
    if (!laneId) continue;
    out.push({
      projectRoot: normalizedString(record.projectRoot),
      laneId,
      laneName: normalizedString(record.laneName),
      grantedAt: normalizedString(record.grantedAt) ?? new Date(0).toISOString(),
    });
  }
  return out.slice(0, MAX_SAVED_GRANTS);
}

function sanitizeChatGrants(value: unknown): BuiltInBrowserAgentChatGrant[] {
  if (!Array.isArray(value)) return [];
  const out: BuiltInBrowserAgentChatGrant[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const chatSessionId = normalizedString(record.chatSessionId);
    if (!chatSessionId) continue;
    out.push({
      chatSessionId,
      chatTitle: normalizedString(record.chatTitle),
      laneName: normalizedString(record.laneName),
      grantedAt: normalizedString(record.grantedAt) ?? new Date(0).toISOString(),
    });
  }
  return out.slice(0, MAX_SAVED_GRANTS);
}

/** Drive-letter case and separators differ between the daemon, a shell and Electron (windows-quirks §1). */
function projectRootKey(value: string | null | undefined): string | null {
  const normalized = normalizedString(value);
  return normalized ? pathKey(path.resolve(normalized)) : null;
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

function normalizedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
