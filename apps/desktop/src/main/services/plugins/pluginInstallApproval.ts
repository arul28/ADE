/**
 * Turning an agent's `plugin.install` into a question the user answers.
 *
 * ## Why this exists
 *
 * The install lifecycle is an operator act, and it stays one. What changed is
 * the shape of the refusal. An agent that had just written a plugin used to get
 * "limited to the machine operator" and hand the user a paragraph of shell
 * ceremony — a packaged Electron path, an `ADE_HOME`, six inherited environment
 * variables to unset — to install the thing the agent had already built. The
 * gate was right; the dead end was not. The person is sitting in the chat. Ask
 * them there.
 *
 * So the agent's call no longer returns a refusal: it BLOCKS on an approval
 * card in that agent's own chat, and on approval the host performs the install
 * under its own authority. The agent never gains a role it did not have.
 *
 * ## Three invariants
 *
 * 1. **The card's words are the host's.** Every sentence comes from the
 *    manifest this process parsed off the source, or from a fact it resolved
 *    itself (which source kind, whether the bundled catalogue vouches). The
 *    only agent-supplied string that reaches the reader is the source itself,
 *    shown verbatim because it is the thing being approved.
 * 2. **The agent cannot answer its own question.** `respondToInput` matches a
 *    waiter by `itemId`, and that id is written into the transcript the agent
 *    can read. The request is therefore raised `operatorOnly`, and the RPC gate
 *    — the one door an agent enters through — refuses to relay an answer to it.
 * 3. **Approval is remembered by the host, not asserted by the caller.** The
 *    approved pairs live in this module's memory, keyed by facts the host
 *    resolved. Nothing in the action arguments can claim a prior approval.
 *
 * ## What "already approved" means
 *
 * The build-test-fix loop is the point: an agent writes a plugin, installs it,
 * the user tries it, the agent fixes it and installs again. Asking again on
 * every iteration would make the loop unusable, so an approved
 * `(pluginId, resolved path)` pair installs without a second prompt.
 *
 * That deliberately means the CODE at an approved path may change freely — the
 * user approved a directory their own agent is editing, and re-approving every
 * save would be theatre. It does NOT extend to a different path, a different
 * plugin id at the same path, or a network source: a git URL is never
 * remembered, because the same URL can serve different code tomorrow and
 * nothing local vouches for what arrives.
 *
 * The record is in-memory and per project. It dies with the process, so a
 * restarted ADE asks again.
 */

import type { AgentChatApprovalDecision } from "../../../shared/types/chat";
import {
  buildPluginInstallApprovalBody,
  buildPluginInstallApprovalTitle,
  buildPluginInstallDisclosure,
  type PluginInstallDisclosure,
} from "../../../shared/plugins/installDisclosure";
import { resolvePluginInstallSource } from "./pluginInstallService";

/** How long the agent's call waits before it stops holding the turn open. */
export const PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;

/* ── The approved-pair record ───────────────────────────────────────────── */

const approvedPairs = new Map<string, Set<string>>();

function projectKey(projectId: string | null): string {
  // A projectless session still gets a bucket rather than sharing one: null is
  // a real scope here (a machine-tab chat), not a wildcard.
  return projectId ?? "\u0000no-project";
}

function pairKey(pluginId: string, canonicalSource: string): string {
  return `${pluginId}\u0000${canonicalSource}`;
}

/**
 * A source string reduced to what a remembered approval is allowed to key on,
 * or null when this source kind is never remembered.
 */
export function canonicalApprovalSource(
  resolution: ReturnType<typeof resolvePluginInstallSource>,
): string | null {
  if (!resolution) return null;
  if (resolution.kind === "path") return resolution.path;
  if (resolution.kind === "builtin") return `builtin:${resolution.pluginId}`;
  // Git: the URL is stable but what it serves is not, and nothing on this
  // machine vouches for what the next fetch brings.
  return null;
}

export function isPluginInstallPreapproved(args: {
  projectId: string | null;
  pluginId: string;
  canonicalSource: string;
}): boolean {
  return approvedPairs.get(projectKey(args.projectId))?.has(pairKey(args.pluginId, args.canonicalSource)) === true;
}

export function recordPluginInstallApproval(args: {
  projectId: string | null;
  pluginId: string;
  canonicalSource: string;
}): void {
  const key = projectKey(args.projectId);
  const existing = approvedPairs.get(key) ?? new Set<string>();
  existing.add(pairKey(args.pluginId, args.canonicalSource));
  approvedPairs.set(key, existing);
}

/** Test seam. Never called in production — the record is process-scoped. */
export function resetPluginInstallApprovalsForTests(): void {
  approvedPairs.clear();
}

/* ── The approval itself ────────────────────────────────────────────────── */

export type PluginInstallApprovalChat = {
  requestChatInput(args: {
    chatSessionId: string;
    title: string;
    body: string;
    source?: "ade";
    kind?: "approval";
    allowsFreeform?: boolean;
    operatorOnly?: boolean;
    onItemId?: (itemId: string) => void;
    providerMetadata?: Record<string, unknown>;
    eventDescription?: string;
    eventDetail?: Record<string, unknown>;
    questions?: Array<{
      id?: string;
      header?: string;
      question: string;
      allowsFreeform?: boolean;
      options?: Array<{ label: string; value?: string; description?: string; recommended?: boolean }>;
    }>;
  }): Promise<{ decision: string; answers: Record<string, string[]>; responseText: string | null }>;
  respondToInput(args: {
    sessionId: string;
    itemId: string;
    decision?: AgentChatApprovalDecision;
  }): Promise<void>;
};

export type PluginInstallApprovalResult =
  | {
      allow: true;
      /** `preapproved` skipped the card; `approved` means the user just said yes. */
      reason: "preapproved" | "approved";
      pluginId: string;
      canonicalSource: string | null;
      disclosure: PluginInstallDisclosure;
    }
  | {
      allow: true;
      reason: "approved";
      /** A git source: the id is unknown until the install reads it. */
      pluginId: null;
      canonicalSource: null;
      disclosure: PluginInstallDisclosure;
    }
  | {
      allow: false;
      reason: "denied" | "cancelled" | "timed_out" | "unreadable_source";
      message: string;
      data: Record<string, unknown>;
    };

const APPROVE_VALUE = "install";
const DENY_VALUE = "deny";

/**
 * Ask, or answer from the record.
 *
 * Returns rather than throws so the caller owns the JSON-RPC error shape; every
 * refusal carries the `data.kind` the agent reads to decide what to do next.
 */
export async function requestPluginInstallApproval(args: {
  chat: PluginInstallApprovalChat;
  chatSessionId: string;
  projectId: string | null;
  source: string;
  builtinPluginsRoot?: string | null;
  timeoutMs?: number;
}): Promise<PluginInstallApprovalResult> {
  const resolution = resolvePluginInstallSource(
    args.source,
    args.builtinPluginsRoot === undefined ? {} : { builtinPluginsRoot: args.builtinPluginsRoot },
  );
  if (!resolution) {
    // Refusing here rather than prompting is the honest branch: ADE cannot say
    // what this source is, so a card asking the user to approve it would be
    // asking them to vouch for a string neither of us can read.
    return {
      allow: false,
      reason: "unreadable_source",
      message:
        `ADE can't read "${args.source}" as a plugin source. `
        + "Give a directory on this machine that contains a plugin.json, a plugin id ADE ships, or a git URL.",
      data: { kind: "plugin_install_source_unreadable", source: args.source },
    };
  }

  const manifest = resolution.kind === "git" ? null : resolution.manifest;
  const disclosure = buildPluginInstallDisclosure({
    source: args.source,
    sourceKind: resolution.kind,
    manifest,
  });
  const canonicalSource = canonicalApprovalSource(resolution);

  if (disclosure.pluginId && canonicalSource
    && isPluginInstallPreapproved({
      projectId: args.projectId,
      pluginId: disclosure.pluginId,
      canonicalSource,
    })) {
    return {
      allow: true,
      reason: "preapproved",
      pluginId: disclosure.pluginId,
      canonicalSource,
      disclosure,
    };
  }

  const title = buildPluginInstallApprovalTitle(disclosure);
  const body = buildPluginInstallApprovalBody(disclosure);
  // Kept so a timeout can settle the card instead of leaving a live prompt with
  // nobody listening behind it.
  let itemId: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  const asked = args.chat.requestChatInput({
    chatSessionId: args.chatSessionId,
    title,
    body,
    source: "ade",
    kind: "approval",
    allowsFreeform: false,
    operatorOnly: true,
    onItemId: (id) => {
      itemId = id;
    },
    providerMetadata: {
      pluginInstall: true,
      ...(disclosure.pluginId ? { pluginId: disclosure.pluginId } : {}),
      source: disclosure.source,
      sourceKind: disclosure.sourceKind,
      trust: disclosure.trust,
      ...(disclosure.version ? { version: disclosure.version } : {}),
    },
    eventDescription: title,
    eventDetail: {
      pluginInstall: {
        ...(disclosure.pluginId ? { pluginId: disclosure.pluginId } : {}),
        displayName: disclosure.displayName,
        source: disclosure.source,
        sourceKind: disclosure.sourceKind,
        trust: disclosure.trust,
        ...(disclosure.version ? { version: disclosure.version } : {}),
        adds: disclosure.adds,
      },
    },
    questions: [{
      id: "plugin_install",
      header: "Plugin install",
      question: title,
      allowsFreeform: false,
      options: [
        {
          label: "Install",
          value: APPROVE_VALUE,
          description: disclosure.trust === "official"
            ? "Ships with ADE."
            : "Runs with the same access as tools you install yourself.",
        },
        { label: "Don't install", value: DENY_VALUE },
      ],
    }],
  });

  const timeoutMs = args.timeoutMs ?? PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS;
  const timedOut = Symbol("timed-out");
  const race = await Promise.race([
    asked,
    new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (race === timedOut) {
    // Settle the card rather than abandon it: an unanswered prompt also blocks
    // the user's next message in this chat, so leaving it live would wedge the
    // conversation on a question whose asker has already given up.
    if (itemId) {
      await args.chat
        .respondToInput({ sessionId: args.chatSessionId, itemId, decision: "cancel" })
        .catch(() => undefined);
    }
    return {
      allow: false,
      reason: "timed_out",
      message: `Nobody answered the install request for ${disclosure.displayName}. Ask again when they are back at the keyboard.`,
      data: {
        kind: "plugin_install_approval_timed_out",
        source: disclosure.source,
        ...(disclosure.pluginId ? { pluginId: disclosure.pluginId } : {}),
      },
    };
  }

  const answered = race;
  const chosen = answered.answers?.plugin_install?.[0];
  // Both gates have to agree. The decision is what the approval UI sends; the
  // answer is what an options list sends. Requiring both means a surface that
  // reports one without the other cannot be read as consent.
  const accepted = (answered.decision === "accept" || answered.decision === "accept_for_session")
    && chosen !== DENY_VALUE;

  if (!accepted) {
    const cancelled = answered.decision === "cancel" || answered.decision === "none";
    return {
      allow: false,
      reason: cancelled ? "cancelled" : "denied",
      message: cancelled
        ? `The install request for ${disclosure.displayName} was dismissed. Nothing was installed.`
        : `${disclosure.displayName} was not installed — the request was declined. Don't retry it; ask what they'd rather do.`,
      data: {
        kind: cancelled ? "plugin_install_cancelled" : "plugin_install_denied",
        source: disclosure.source,
        ...(disclosure.pluginId ? { pluginId: disclosure.pluginId } : {}),
      },
    };
  }

  return {
    allow: true,
    reason: "approved",
    pluginId: disclosure.pluginId,
    canonicalSource,
    disclosure,
  } as PluginInstallApprovalResult;
}
