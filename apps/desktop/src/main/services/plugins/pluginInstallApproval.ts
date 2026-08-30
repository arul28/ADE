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

import type { AgentChatApprovalDecision, PendingInputOrigin } from "../../../shared/types/chat";
import type { PluginManifest } from "../../../shared/plugins/manifest";
import {
  buildPluginInstallApprovalBody,
  buildPluginInstallApprovalTitle,
  buildPluginInstallDisclosure,
  buildPluginRemovalApprovalBody,
  buildPluginRemovalApprovalTitle,
  buildPluginRemovalDisclosure,
  type PluginInstallDisclosure,
  type PluginRemovalDisclosure,
  type PluginRemovalKind,
} from "../../../shared/plugins/installDisclosure";
import { resolvePluginInstallSource } from "./pluginInstallService";

/**
 * How long an install card stands before the host settles it unanswered.
 *
 * **An hour, not ten minutes, and the ten minutes were a real defect.** The
 * loop this gate exists to serve is "an agent builds a plugin and asks the user
 * to install it", and the user is a person who gets up from the desk. A live
 * dogfood run failed twice for exactly that reason: the card settled itself
 * before anyone came back, and the agent read a cancellation the user never
 * made. The install only succeeded on the third try because the user happened
 * to be at the keyboard.
 *
 * Why there is a ceiling at all: on expiry the host does not merely stop
 * waiting, it CANCELS the card (see the timeout branch below), because on this
 * branch an unanswered blocking prompt still blocks the user's next message in
 * that chat. Leaving it live forever would wedge the conversation on a question
 * whose asker is gone. `main` no longer has that wedge — PR #1184 keeps a
 * pending card visible while its asker still waits and reconciles it at read
 * time — so once that merges here, the honest end state is no timeout at all
 * and a card the user answers whenever they return.
 *
 * Note this clock is not the CLI's. `ade actions run` gives up on its own RPC
 * long before this fires; that kills the CALLER, not the card, and the card is
 * then answerable by the next request for the same install (see
 * {@link pendingInstallCards}).
 */
export const PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS = 60 * 60 * 1000;

/* ── The approved-pair record ───────────────────────────────────────────── */

const approvedPairs = new Map<string, Set<string>>();

function projectKey(projectId: string | null): string {
  // A projectless session still gets a bucket rather than sharing one: null is
  // a real scope here (a machine-tab chat), not a wildcard.
  return projectId ?? "\u0000no-project";
}

function pairKey(pluginId: string, canonicalSource: string, grant: string): string {
  return `${pluginId}\u0000${canonicalSource}\u0000${grant}`;
}

/**
 * The part of a manifest a remembered approval is NOT allowed to outlive.
 *
 * The remembered pair deliberately lets the CODE at an approved path change
 * freely — the user approved a directory their own agent is editing, and
 * re-approving every save would be theatre. Three declarations are different:
 * the hosts the plugin's process may contact, the ADE-stored API keys it
 * reads, and the project secrets it opens. All three are things the person
 * agreed to by name, and all three can widen in a later save without the source
 * string moving an inch.
 *
 * So they are part of the key. A manifest that adds a host, a provider key or a
 * project secret does not match the remembered approval, and the card comes
 * back. A manifest that NARROWS also asks again, which is one extra prompt
 * rather than a rule with an exception in it.
 */
export function pluginApprovalGrant(manifest: PluginManifest | null): string {
  if (!manifest) return "";
  const hosts = [...(manifest.network?.hosts ?? [])].sort().join(",");
  const providers = [...(manifest.providerKeys ?? [])].sort().join(",");
  const projectSecrets = [...(manifest.projectSecrets ?? [])].sort().join(",");
  // The overwhelming majority of manifests declare none of the three, and those
  // get the empty string — the same value a caller that omits the argument
  // passes. So the field is genuinely additive: a recorder that never heard of
  // it keeps matching for every plugin that has nothing extra to disclose.
  if (!hosts && !providers && !projectSecrets) return "";
  return `${hosts}|${providers}|${projectSecrets}`;
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
  /** {@link pluginApprovalGrant} of the manifest about to be installed. */
  grant?: string;
}): boolean {
  return approvedPairs
    .get(projectKey(args.projectId))
    ?.has(pairKey(args.pluginId, args.canonicalSource, args.grant ?? "")) === true;
}

export function recordPluginInstallApproval(args: {
  projectId: string | null;
  pluginId: string;
  canonicalSource: string;
  /** What was disclosed and agreed to — see {@link pluginApprovalGrant}. */
  grant?: string;
}): void {
  const key = projectKey(args.projectId);
  const existing = approvedPairs.get(key) ?? new Set<string>();
  existing.add(pairKey(args.pluginId, args.canonicalSource, args.grant ?? ""));
  approvedPairs.set(key, existing);
}

/** Test seam. Never called in production — the record is process-scoped. */
export function resetPluginInstallApprovalsForTests(): void {
  approvedPairs.clear();
}

/* ── The live card, and why a second request must not raise a second one ── */

/**
 * The install card currently standing in one chat.
 *
 * The failure this closes: an agent calls `plugin.install`, the CLI's own RPC
 * deadline expires while the user is away from the desk, the agent reads that
 * as a failure and calls `plugin.install` again — and a SECOND card appears
 * over a first one that is still live and still waiting. Answering either left
 * the other standing with nobody behind it, which is the orphan.
 *
 * So one chat holds at most one install card:
 *
 * - A re-request naming the SAME install joins the standing card and resolves
 *   with the same answer. The user sees one question, answers it once, and both
 *   callers learn what they decided.
 * - A request naming a DIFFERENT install settles the standing card explicitly
 *   (`cancel`, which its waiter reports as `cancelled`) before raising the new
 *   one. Superseded, never abandoned.
 *
 * Keyed on the chat plus what the HOST resolved about the source, never on the
 * caller's arguments — same rule as the approved-pair record.
 */
type PendingInstallCard = {
  key: string;
  result: Promise<PluginInstallApprovalResult>;
  /** Settle the card with no answer, so nothing is left live behind it. */
  supersede: () => Promise<void>;
};

const pendingInstallCards = new Map<string, PendingInstallCard>();

function pendingCardKey(canonicalSource: string | null, source: string, grant: string): string {
  // A git source has no canonical form (`canonicalApprovalSource` returns null
  // because the same URL can serve different code tomorrow), so the raw string
  // stands in. That is the right identity HERE — the question on the card is
  // about that URL — even though it is deliberately not one for the remembered
  // approval.
  return `${canonicalSource ?? `raw:${source}`}\u0000${grant}`;
}

/** Test seam: forget any card this process believes is standing. */
export function resetPendingPluginInstallCardsForTests(): void {
  pendingInstallCards.clear();
}

/* ── The approval itself ────────────────────────────────────────────────── */

export type PluginInstallApprovalChat = {
  requestChatInput(args: {
    chatSessionId: string;
    title: string;
    body: string;
    description?: string;
    source?: "ade";
    kind?: "approval";
    /**
     * Who the card is really about. The host raises every plugin gate under its
     * own `source: "ade"`, so without this the reader gets ADE's mark and the
     * word "ADE" above a decision about somebody else's code. See
     * {@link PendingInputOrigin}.
     */
    origin?: PendingInputOrigin;
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
      options?: Array<{
        label: string;
        value?: string;
        description?: string;
        recommended?: boolean;
        decision?: AgentChatApprovalDecision;
      }>;
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
      /**
       * What the reader agreed to beyond the source — see
       * {@link pluginApprovalGrant}. Pass it back to
       * {@link recordPluginInstallApproval} so a manifest that later widens its
       * network or provider keys asks again instead of riding the memory of an
       * approval given for a narrower one.
       */
      grant: string;
      disclosure: PluginInstallDisclosure;
    }
  | {
      allow: true;
      reason: "approved";
      /** A git source: the id is unknown until the install reads it. */
      pluginId: null;
      canonicalSource: null;
      grant: string;
      disclosure: PluginInstallDisclosure;
    }
  | {
      allow: false;
      reason: "denied" | "cancelled" | "timed_out" | "unreadable_source";
      message: string;
      data: Record<string, unknown>;
    };

/**
 * The card's identity, built from the manifest the host already parsed.
 *
 * Null for a source with no readable manifest — a git URL nothing has cloned
 * yet. That card genuinely does not know which plugin it is about, and drawing
 * a name for it would be the card inventing the one fact the reader is there to
 * check. It falls back to ADE's own mark, which is honest: ADE is asking.
 *
 * Nothing here comes from the agent's arguments. `displayName` and `icon` are
 * the manifest's, `pluginId` is the id the host resolved, and every one of them
 * is already on the card's prose — this only lets the header draw them.
 */
export function pluginApprovalOrigin(args: {
  pluginId: string | null;
  displayName: string;
  manifest: PluginManifest | null;
}): PendingInputOrigin | null {
  const pluginId = args.pluginId?.trim();
  if (!pluginId) return null;
  const displayName = args.displayName.trim() || pluginId;
  const icon = args.manifest?.icon?.trim();
  const accent = args.manifest?.accent?.trim();
  return {
    kind: "plugin",
    pluginId,
    displayName,
    ...(icon ? { icon } : {}),
    ...(accent ? { accent } : {}),
  };
}

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
  const grant = pluginApprovalGrant(manifest);

  if (disclosure.pluginId && canonicalSource
    && isPluginInstallPreapproved({
      projectId: args.projectId,
      pluginId: disclosure.pluginId,
      canonicalSource,
      grant,
    })) {
    return {
      allow: true,
      reason: "preapproved",
      pluginId: disclosure.pluginId,
      canonicalSource,
      grant,
      disclosure,
    };
  }

  const cardKey = pendingCardKey(canonicalSource, args.source, grant);
  const standing = pendingInstallCards.get(args.chatSessionId);
  if (standing) {
    // The same question, asked again. Join the card the user is already
    // looking at rather than stacking a second one on top of it — this is the
    // ordinary retry after the CALLER's own RPC deadline expired.
    if (standing.key === cardKey) return await standing.result;
    // A different question. Settle the old card explicitly so nothing is left
    // live with no caller behind it, then ask the new one.
    await standing.supersede();
    if (pendingInstallCards.get(args.chatSessionId) === standing) {
      pendingInstallCards.delete(args.chatSessionId);
    }
  }

  const title = buildPluginInstallApprovalTitle(disclosure);
  const body = buildPluginInstallApprovalBody(disclosure);
  // Kept so a timeout, or a superseding request, can settle the card instead of
  // leaving a live prompt with nobody listening behind it.
  let itemId: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  // Resolved the moment the chat tells us which item the card became. A
  // superseding request awaits this rather than reading `itemId` directly: the
  // two requests can be one microtask apart, and cancelling "whatever card is
  // up" needs the id even when it has not been reported yet.
  let announceItemId: (id: string | null) => void = () => {};
  const itemIdKnown = new Promise<string | null>((resolve) => {
    announceItemId = resolve;
  });

  const asked = args.chat.requestChatInput({
    chatSessionId: args.chatSessionId,
    title,
    body,
    // The disclosure IS the card. Without this the card falls back to the first
    // question, which is the title again, and the person approving filesystem
    // and network access for third-party code reads nothing but its name.
    description: body,
    source: "ade",
    kind: "approval",
    ...(() => {
      const origin = pluginApprovalOrigin({
        pluginId: disclosure.pluginId,
        displayName: disclosure.displayName,
        manifest,
      });
      return origin ? { origin } : {};
    })(),
    allowsFreeform: false,
    operatorOnly: true,
    onItemId: (id) => {
      itemId = id;
      announceItemId(id);
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
      // `decision` is what makes these the card's actual buttons rather than
      // the generic Accept/Accept all/Decline trio. "Accept all" has no meaning
      // here — one install is not a standing grant — so it is simply not offered.
      options: [
        {
          label: "Install",
          value: APPROVE_VALUE,
          decision: "accept",
          description: disclosure.trust === "official"
            ? "Ships with ADE."
            : "Runs with the same access as tools you install yourself.",
        },
        { label: "Don't install", value: DENY_VALUE, decision: "decline" },
      ],
    }],
  });
  // The chat never reported an id — a runtime that raised no card, or one that
  // failed. Unblocks anyone waiting to supersede it.
  void asked.then(() => announceItemId(itemId), () => announceItemId(itemId));

  const settleCard = async (): Promise<void> => {
    const id = itemId ?? await itemIdKnown;
    if (!id) return;
    await args.chat
      .respondToInput({ sessionId: args.chatSessionId, itemId: id, decision: "cancel" })
      .catch(() => undefined);
  };

  const answer = (async (): Promise<PluginInstallApprovalResult> => {
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
      // Settle the card rather than abandon it: on this branch an unanswered
      // prompt also blocks the user's next message in this chat, so leaving it
      // live would wedge the conversation on a question whose asker has already
      // given up. See PLUGIN_INSTALL_APPROVAL_TIMEOUT_MS for what changes once
      // PR #1184 merges here.
      await settleCard();
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
      grant,
      disclosure,
    } as PluginInstallApprovalResult;
  })();

  const entry: PendingInstallCard = {
    key: cardKey,
    result: answer,
    supersede: async () => {
      if (timer) clearTimeout(timer);
      await settleCard();
      // Awaited so the superseding request never raises its own card while the
      // old one is still on screen. `answer` cannot reject — every branch above
      // returns a value — so there is nothing here to swallow.
      await answer;
    },
  };
  pendingInstallCards.set(args.chatSessionId, entry);
  try {
    return await answer;
  } finally {
    if (pendingInstallCards.get(args.chatSessionId) === entry) {
      pendingInstallCards.delete(args.chatSessionId);
    }
  }
}

/* ── Removal, disable and enable ────────────────────────────────────────── */

/**
 * The other half of the install card, and it is deliberately symmetric.
 *
 * An agent that has just built and installed a plugin could not remove it or
 * even turn it back on: those three verbs were flat `plugin_role_denied`
 * refusals, and the skill correctly forbids the one workaround (unsetting
 * `ADE_CHAT_SESSION_ID`). So a diagnostic run could put third-party code on the
 * machine with the user's consent and then had to hand them shell ceremony to
 * take it off again, and a plugin that stopped working could not be restarted
 * from the conversation that noticed
 * (docs/reports/ade-plugins-agent-diagnostic-2026-08-26.md §5, §9).
 *
 * The gate is not relaxed. The caller's role never changes, the host raises a
 * card in the caller's own chat, and the verb runs on the host's authority only
 * after the person answers — exactly as `install` does.
 *
 * ## An approved install NEVER pre-approves a removal
 *
 * {@link recordPluginInstallApproval} exists so a build-test-fix loop does not
 * re-ask on every save, and that memory is scoped to installing. Removal reads
 * nothing from it and writes nothing to it: deleting a plugin and its stored
 * data is its own consent every single time, and "you approved installing this
 * an hour ago" is not an answer to "may I delete it".
 */
export type PluginRemovalApprovalResult =
  | { allow: true; disclosure: PluginRemovalDisclosure }
  | {
      allow: false;
      reason: "denied" | "cancelled" | "timed_out";
      message: string;
      data: Record<string, unknown>;
    };

const REMOVAL_APPROVE_VALUE = "proceed";
const REMOVAL_DENY_VALUE = "keep";

/** The card's two buttons, in each verb's own words. */
function removalOptionLabels(kind: PluginRemovalKind): { approve: string; deny: string } {
  switch (kind) {
    case "uninstall":
      return { approve: "Remove", deny: "Keep" };
    case "disable":
      return { approve: "Turn off", deny: "Leave on" };
    case "enable":
      return { approve: "Turn on", deny: "Leave off" };
  }
}

export async function requestPluginRemovalApproval(args: {
  chat: PluginInstallApprovalChat;
  chatSessionId: string;
  kind: PluginRemovalKind;
  pluginId: string;
  displayName: string;
  version: string | null;
  /** The installed manifest, or null when ADE cannot read one for it. */
  manifest: PluginManifest | null;
  timeoutMs?: number;
}): Promise<PluginRemovalApprovalResult> {
  const disclosure = buildPluginRemovalDisclosure({
    kind: args.kind,
    pluginId: args.pluginId,
    displayName: args.displayName,
    version: args.version,
    manifest: args.manifest,
  });
  const title = buildPluginRemovalApprovalTitle(disclosure);
  const body = buildPluginRemovalApprovalBody(disclosure);
  const labels = removalOptionLabels(args.kind);
  // Every refusal is named for the verb that was refused, so an agent handling
  // `plugin_uninstall_denied` cannot mistake it for a declined install.
  const errorKind = (suffix: string): string => `plugin_${args.kind}_${suffix}`;

  let itemId: string | null = null;
  let timer: NodeJS.Timeout | null = null;

  const asked = args.chat.requestChatInput({
    chatSessionId: args.chatSessionId,
    title,
    body,
    description: body,
    source: "ade",
    kind: "approval",
    ...(() => {
      const origin = pluginApprovalOrigin({
        pluginId: disclosure.pluginId,
        displayName: disclosure.displayName,
        manifest: args.manifest,
      });
      return origin ? { origin } : {};
    })(),
    allowsFreeform: false,
    operatorOnly: true,
    onItemId: (id) => {
      itemId = id;
    },
    providerMetadata: {
      pluginLifecycle: args.kind,
      pluginId: disclosure.pluginId,
      ...(disclosure.version ? { version: disclosure.version } : {}),
    },
    eventDescription: title,
    eventDetail: {
      pluginLifecycle: {
        kind: args.kind,
        pluginId: disclosure.pluginId,
        displayName: disclosure.displayName,
        ...(disclosure.version ? { version: disclosure.version } : {}),
        items: disclosure.items,
      },
    },
    questions: [{
      id: "plugin_lifecycle",
      header: args.kind === "uninstall" ? "Remove plugin" : "Plugin",
      question: title,
      allowsFreeform: false,
      options: [
        {
          label: labels.approve,
          value: REMOVAL_APPROVE_VALUE,
          decision: "accept",
          ...(args.kind === "uninstall" && disclosure.storesData
            ? { description: "Deletes its stored data too." }
            : {}),
        },
        { label: labels.deny, value: REMOVAL_DENY_VALUE, decision: "decline" },
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
    // Settled rather than abandoned, for the same reason install settles its
    // own: a live prompt nobody is listening behind blocks the user's next
    // message in this chat.
    if (itemId) {
      await args.chat
        .respondToInput({ sessionId: args.chatSessionId, itemId, decision: "cancel" })
        .catch(() => undefined);
    }
    return {
      allow: false,
      reason: "timed_out",
      message: `Nobody answered the request about ${disclosure.displayName}. Ask again when they are back at the keyboard.`,
      data: { kind: errorKind("approval_timed_out"), pluginId: disclosure.pluginId },
    };
  }

  const answered = race;
  const chosen = answered.answers?.plugin_lifecycle?.[0];
  // Both gates have to agree, exactly as the install card requires: a surface
  // that reports one without the other cannot be read as consent.
  const accepted = (answered.decision === "accept" || answered.decision === "accept_for_session")
    && chosen !== REMOVAL_DENY_VALUE;
  if (accepted) return { allow: true, disclosure };

  const cancelled = answered.decision === "cancel" || answered.decision === "none";
  return {
    allow: false,
    reason: cancelled ? "cancelled" : "denied",
    message: cancelled
      ? `The request about ${disclosure.displayName} was dismissed. Nothing changed.`
      : `${disclosure.displayName} was left as it is — the request was declined. Don't retry it; ask what they'd rather do.`,
    data: {
      kind: errorKind(cancelled ? "cancelled" : "denied"),
      pluginId: disclosure.pluginId,
    },
  };
}
