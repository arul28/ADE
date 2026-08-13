import {
  ATTENTION_CONTRACT_VERSION,
  sanitizeAttentionPreview,
  type AttentionEventKind,
  type AttentionItem,
  type AttentionPhase,
} from "../../../../desktop/src/shared/types/attention";
import type {
  SyncRosterChat,
  SyncRosterChatStatus,
  SyncRosterProject,
} from "../../../../desktop/src/shared/types/sync";
import type { PrNotificationKind } from "../../../../desktop/src/shared/types/prs";
import { isSessionSnoozed } from "../../../../desktop/src/shared/sessionCanonicalState";
import { withActivityFingerprints } from "./activityFingerprint";

/**
 * The Activity projection: `(runs, recentRuns, prActivities, roster)` in, wire
 * `AttentionItem[]` out.
 *
 * Extracted from the push publisher's closure so the one function every phone,
 * notch, and desktop Activity row is derived from can be exercised directly,
 * with a context record instead of a booted publisher. Everything it needs is
 * an explicit input; it owns no state and performs no I/O beyond the roster
 * loader it is handed.
 */

export type AgentRunPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export type AgentRunState = {
  sessionId: string;
  /** Which attached project scope produced this run (for metadata resolution). */
  scopeKey: string;
  /** Chat runs come from agentChatService events; cli runs from PTY signals. */
  kind: "chat" | "cli";
  title: string | null;
  lane: string | null;
  model: string | null;
  agent: string | null;
  phase: AgentRunPhase;
  detail: string | null;
  /** Pending approval item id while phase is waiting_for_approval. */
  itemId: string | null;
  startedAt: number;
  lastActiveAt: number;
  /** Immutable while `phase` is unchanged. */
  statusSinceAt: number;
  metaResolved: boolean;
  /**
   * Live background-task ids for this run, tracked from the `background_task`
   * flavour of `scheduled_work_update`. Agents spawn background work that keeps
   * running after the foreground turn bookends, and desktop already treats that
   * as Working (`sessionCanonicalState.ts` promotes a resting session with live
   * background work back to the `running` phase). This set is the publisher's
   * copy of the same fact — both derive from agentChatService's live
   * background-task level — so Activity cannot publish "is done" over a session
   * that is demonstrably still working.
   */
  backgroundTaskIds: Set<string>;
  /**
   * Planning flavour of a running turn, mirroring what
   * `chatSessionProjection.ts` derives for the sidebar
   * (`interactionMode === "plan"` → `"planning"`). `AttentionPhase` is frozen
   * push-wire vocabulary with no planning value, so this rides alongside it as
   * an additive hint; a reader that ignores it sees exactly today's row.
   */
  chatActivityMode: "planning" | null;
  /** When `chatActivityMode` was last read, so the refresh stays bounded. */
  chatActivityModeCheckedAt: number;
  /**
   * Where the foreground turn landed while background work was still running.
   * The run is held at `running` until the last task drains and then settles
   * here, so the terminal phase is published once — when the work is over.
   */
  deferredTerminalPhase: AgentRunPhase | null;
};

export type PrLiveActivityState = {
  id: string;
  scopeKey: string;
  prId: string | null;
  prNumber: number;
  title: string;
  phase: PrNotificationKind;
  lane: string | null;
  repoOwner: string | null;
  repoName: string | null;
  updatedAt: number;
  statusSinceAt: number;
};

export type PushPrNotification = {
  kind: PrNotificationKind;
  prId?: string | null;
  prNumber: number;
  prTitle: string | null;
  laneId: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
};

/**
 * A roster chat as the publisher reads it. `identityKey` is an additive label
 * rosterBuilder stamps on CTO/identity chats. It stays optional so any roster
 * provider that never sets it still satisfies this contract — the sync roster
 * keeps carrying identity rows for the mobile hub, and only this feed drops
 * them, mirroring what the desktop sidebar already does.
 */
export type ActivityRosterChat = SyncRosterChat & { identityKey?: string | null };
export type ActivityRosterProject = Omit<SyncRosterProject, "chats"> & {
  chats: ActivityRosterChat[];
};

export const RUNNING_TTL_MS = 2 * 60 * 60 * 1000; // 2h for running/starting
export const ATTENTION_RECENT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Idle roster rows are last-known state, not live work. They still need a
 * finite lifetime: with `expiresAt: null` a chat deleted while its machine was
 * offline stayed in the account feed forever, because only the owning machine
 * can tombstone it and it never comes back to do so.
 */
const IDLE_ROSTER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Is background work still running for this run? Kept as a named predicate so
 * every phase decision (publish phase, event kind, terminal-ness) asks the same
 * question rather than each re-deriving it from the set.
 */
export function runHasBackgroundWork(run: AgentRunState): boolean {
  return run.backgroundTaskIds.size > 0;
}

export function providerDisplayName(provider: string | null | undefined): string | null {
  if (!provider) return null;
  switch (provider) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "droid":
      return "Droid";
    case "opencode":
      return "OpenCode";
    case "gemini":
      return "Gemini";
    default:
      return provider.charAt(0).toUpperCase() + provider.slice(1);
  }
}

export function agentAttentionPhase(run: AgentRunState): AttentionPhase {
  if (run.phase === "waiting_for_approval" || run.phase === "waiting_for_input") return "needs_you";
  // Belt and braces over the `deferredTerminalPhase` state machine in
  // `onChatEvent`: whatever route left the run at a quiet phase, a session with
  // live background subagents is Working. This mirrors the phase promotion in
  // apps/desktop/src/shared/sessionCanonicalState.ts, where live background
  // work lifts a resting session back to `running` — the two surfaces
  // disagreeing about the same session is exactly the bug this guards.
  // `failed` is deliberately not overridden: a failure needs the user now, and
  // burying it under "working" would cost them the signal.
  if ((run.phase === "completed" || run.phase === "stale") && runHasBackgroundWork(run)) {
    return "running";
  }
  return run.phase;
}

export function rosterAttentionPhase(status: SyncRosterChatStatus): AttentionPhase {
  switch (status) {
    case "awaiting":
      return "needs_you";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "idle":
      return "stale";
    case "ended":
      return "completed";
  }
}

function rosterActivityTier(
  status: SyncRosterChatStatus,
): "signal" | "ambient" | "idle" {
  switch (status) {
    case "awaiting":
    case "failed":
      return "signal";
    case "running":
      return "ambient";
    case "idle":
    case "ended":
      return "idle";
  }
}

function prActivityTier(phase: AttentionPhase): "signal" | "ambient" {
  return phase === "checks_failing"
    || phase === "changes_requested"
    || phase === "review_requested"
    || phase === "merge_ready"
    ? "signal"
    : "ambient";
}

/**
 * The published phase → agent event kind table. Single source: both the live
 * run path (via `agentAttentionEventKind`) and the roster path call it, so a
 * row's `eventKind` can never disagree with the phase it ships with — they ride
 * the alert fingerprint together, and the relay gates alerts on the pair.
 */
export function agentEventKindForPhase(phase: AttentionPhase): AttentionEventKind {
  switch (phase) {
    case "needs_you":
      return "agent_needs_you";
    case "failed":
      return "agent_failed";
    case "completed":
      return "agent_completed";
    default:
      return "agent_running";
  }
}

/**
 * Derived from the PUBLISHED phase, not the raw run phase: eventKind and phase
 * ride the alert fingerprint together, and a `running` row carrying
 * `agent_completed` would make the relay's alert gating disagree with the row
 * the user sees.
 */
export function agentAttentionEventKind(run: AgentRunState): AttentionEventKind {
  return agentEventKindForPhase(agentAttentionPhase(run));
}

export function prAttentionState(kind: PrNotificationKind): {
  phase: AttentionPhase;
  eventKind: AttentionEventKind;
  tab: "overview" | "activity" | "checks";
} {
  switch (kind) {
    case "checks_failing":
      return { phase: "checks_failing", eventKind: "pr_checks_failing", tab: "checks" };
    case "review_requested":
      return { phase: "review_requested", eventKind: "pr_review_requested", tab: "activity" };
    case "changes_requested":
      return { phase: "changes_requested", eventKind: "pr_changes_requested", tab: "activity" };
    case "merge_ready":
      return { phase: "merge_ready", eventKind: "pr_merge_ready", tab: "overview" };
    case "merged":
      return { phase: "merged", eventKind: "pr_merged", tab: "overview" };
    case "closed":
      return { phase: "closed", eventKind: "pr_closed", tab: "overview" };
    case "opened":
    case "reopened":
      return { phase: "open", eventKind: "pr_opened", tab: "overview" };
  }
}

export function prNotificationCopy(notification: PushPrNotification): {
  title: string;
  body: string;
  interruptionLevel: "passive" | "active" | "time-sensitive" | null;
} {
  const fallbackTitle = notification.prTitle?.trim() || `Pull request #${notification.prNumber}`;
  switch (notification.kind) {
    case "opened":
      return { title: `PR #${notification.prNumber} opened`, body: fallbackTitle, interruptionLevel: "passive" };
    case "reopened":
      return { title: `PR #${notification.prNumber} reopened`, body: fallbackTitle, interruptionLevel: "passive" };
    case "closed":
      return { title: `PR #${notification.prNumber} closed`, body: fallbackTitle, interruptionLevel: "passive" };
    case "merged":
      return { title: `PR #${notification.prNumber} merged`, body: fallbackTitle, interruptionLevel: "active" };
    case "merge_ready":
      return { title: `PR #${notification.prNumber} is ready to merge`, body: notification.prTitle ?? "Required checks passed and it has approval.", interruptionLevel: "active" };
    case "checks_failing":
      return { title: `PR #${notification.prNumber} checks are failing`, body: notification.prTitle ?? "One or more required checks failed.", interruptionLevel: "active" };
    case "changes_requested":
      return { title: `Changes requested on PR #${notification.prNumber}`, body: fallbackTitle, interruptionLevel: "active" };
    case "review_requested":
      return { title: `Review requested on PR #${notification.prNumber}`, body: fallbackTitle, interruptionLevel: "active" };
  }
}

export const runSubject = (run: AgentRunState): string =>
  run.agent?.trim() || run.title?.trim() || "Agent";

export const laneTitleLine = (run: AgentRunState): string => {
  const parts = [run.lane?.trim(), run.title?.trim()].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : run.title?.trim() || "Agent run";
};

/**
 * The row title every Activity surface actually reads. Provider-phase copy
 * ("Cursor is working") used to occupy this slot, so the island, lock screen,
 * and desktop drawer all said the same sentence for every in-flight chat.
 * Privacy-safe lock-screen copy stays on `privacyPreview`.
 */
export function attentionSessionTitle(args: {
  sessionTitle?: string | null;
  laneName?: string | null;
  provider?: string | null;
  phase: AttentionPhase;
}): string {
  const sessionTitle = args.sessionTitle?.trim();
  if (sessionTitle) return sessionTitle;
  const laneName = args.laneName?.trim();
  if (laneName) return laneName;
  return agentAttentionTitle(args.provider?.trim() || "Agent", args.phase);
}

/**
 * Row titles and privacy-safe previews, by published phase.
 *
 * Tables, not ternary ladders: the live-run path and the roster path publish
 * the same vocabulary for the same phase, and expressing that twice is how they
 * drifted — the run path used to title `stale` "is working" while the roster
 * path (and the desktop's "Stale" label) called it idle. A `Partial` record
 * with an explicit fallback keeps a new `AttentionPhase` from silently
 * acquiring a wrong title.
 *
 * `stale` is the wire name of a state the user is never shown that word for.
 * Its one user-facing word is "idle", set by the canonical state table in
 * apps/desktop/src/renderer/components/activity/activityPresentation.ts
 * (`ACTIVITY_STATE_GLYPHS.idle` → label "Idle", `activityStateSentence` →
 * "<Agent> is idle"). The lock screen, the row label and the detail sheet all
 * describe the same fact, so they get the same word — one state must never
 * arrive as "Stale" here, "has gone quiet" there and "idle" in the title.
 */
const AGENT_TITLE_SUFFIX_BY_PHASE: Partial<Record<AttentionPhase, string>> = {
  needs_you: "needs you",
  failed: "failed",
  // "Done", not "finished": the shared status vocabulary in
  // apps/desktop/src/shared/sessionStatusPresentation.ts labels the ready/idle
  // tier "Done" on every surface, and a push title that disagrees with the row
  // the user taps through to is a bug.
  completed: "is done",
  stale: "is idle",
};
const AGENT_TITLE_SUFFIX_FALLBACK = "is working";

const AGENT_PRIVACY_PREVIEW_BY_PHASE: Partial<Record<AttentionPhase, string>> = {
  needs_you: "An ADE agent needs your input.",
  failed: "An ADE agent run failed.",
  completed: "An ADE agent is done.",
  // "An ADE agent is idle." — same subject ("An ADE agent") and same verb
  // phrase as the title suffix above. The old "An ADE agent session is idle."
  // named a different subject for the same row.
  stale: "An ADE agent is idle.",
};
const AGENT_PRIVACY_PREVIEW_FALLBACK = "An ADE agent is working.";

export function agentAttentionTitle(subject: string, phase: AttentionPhase): string {
  return `${subject} ${AGENT_TITLE_SUFFIX_BY_PHASE[phase] ?? AGENT_TITLE_SUFFIX_FALLBACK}`;
}

export function agentAttentionPrivacyPreview(phase: AttentionPhase): string {
  return AGENT_PRIVACY_PREVIEW_BY_PHASE[phase] ?? AGENT_PRIVACY_PREVIEW_FALLBACK;
}

function validTimestampMs(
  value: string | null | undefined,
  fallback: number,
): number {
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The project scope fields an item's `project` ref is built from. */
export type AttentionScopeRef = {
  projectName: string;
  projectRoot: string | null;
};

/**
 * One item's cross-machine project ref. Built in exactly one place: the three
 * item kinds used to spell it out separately and each called the memoized
 * `canonicalProjectId` twice for the same root, so a change to the fallback
 * order had three sites to find.
 */
export function attentionProjectRef(
  projectId: string,
  name: string,
  rootPath: string | null | undefined,
  canonicalProjectId: (rootPath: string | null | undefined) => string | null,
): AttentionItem["project"] {
  const canonicalId = canonicalProjectId(rootPath);
  return {
    projectId,
    ...(canonicalId ? { canonicalId } : {}),
    name,
    rootPath: rootPath ?? null,
  };
}

/** The account-directory identity, as the publisher can resolve it. */
export type AccountMachineIdentity = { machineKey: string; deviceId?: string | null };

/**
 * The published machine identity. Two keys, and they are not interchangeable:
 *
 * - `machineKey` is the push-registration identity. The relay authenticates a
 *   publish with it and rejects any item or tombstone whose id is not
 *   `agent:<machineKey>:…` / `pull-request:<machineKey>:…` (see
 *   `parseAttentionItem` and `ownsItemId` in apps/push-relay/src/attention.ts).
 *   Item ids are therefore married to this key and cannot be re-namespaced
 *   without tombstoning every row every account already holds.
 * - `accountMachineKey` is the account-directory / sync-relay identity. It is
 *   the one that is stable across ADE surfaces and the one deep links carry.
 *
 * So: ids key on `machineKey`, identity keys on `accountMachineKey`. Readers
 * group and de-duplicate machines by `accountMachineKey ?? machineKey`, never
 * by `machineKey` alone — the two keys are minted independently, which is how
 * one physical Mac used to render as two rows across surfaces.
 *
 * A blank key would silently defeat that fallback, and the relay's 32–64 hex
 * check would drop the entire item rather than just the field, so empty
 * strings normalize to null here.
 */
export function attentionMachineRef(args: {
  machineKey: string;
  accountMachineIdentity: AccountMachineIdentity | null;
  machineName: string;
  lastSeenAtMs: number;
}): AttentionItem["machine"] {
  return {
    machineKey: args.machineKey,
    accountMachineKey: args.accountMachineIdentity?.machineKey?.trim() || null,
    deviceId: args.accountMachineIdentity?.deviceId?.trim() || null,
    name: args.machineName,
    online: true,
    lastSeenAt: new Date(args.lastSeenAtMs).toISOString(),
  };
}

/** Everything `buildAttentionItems` reads, stated explicitly. */
export type AttentionItemBuildContext = {
  nowMs: number;
  includeRoster: boolean;
  machineKey: string;
  accountMachineIdentity: AccountMachineIdentity | null;
  machineName: string;
  /** Live runs; later entries win over `recentRuns` on the same session id. */
  runs: ReadonlyMap<string, AgentRunState>;
  recentRuns: ReadonlyMap<string, AgentRunState>;
  prActivities: ReadonlyMap<string, PrLiveActivityState>;
  scopes: ReadonlyMap<string, AttentionScopeRef>;
  /**
   * Phase-entry anchors for roster rows, mutated in place: a roster snapshot
   * carries no "since" of its own, so the publisher remembers when each row
   * last changed status. Rows absent from this build are pruned.
   */
  rosterPhaseAnchors: Map<string, { status: SyncRosterChatStatus; statusSinceAt: number }>;
  loadRoster: () => Promise<ActivityRosterProject[]>;
  canonicalProjectId: (rootPath: string | null | undefined) => string | null;
  /** Monotonic revision floors, so a republished row never moves backwards. */
  lastPublishedRevisionById: ReadonlyMap<string, number>;
  remoteAcknowledgedRevisionById: ReadonlyMap<string, number>;
};

function buildRunItems(context: AttentionItemBuildContext, machine: AttentionItem["machine"]): AttentionItem[] {
  const attentionRuns = new Map<string, AgentRunState>([
    ...context.recentRuns,
    ...context.runs,
  ]);
  return [...attentionRuns.values()].map((run): AttentionItem => {
    const scope = context.scopes.get(run.scopeKey);
    const phase = agentAttentionPhase(run);
    const subject = runSubject(run);
    const preview = sanitizeAttentionPreview(
      run.detail?.trim() || laneTitleLine(run),
    );
    const expiresAt = new Date(
      run.lastActiveAt
        + (
          run.phase === "running" || run.phase === "starting" || run.phase === "stale"
            ? RUNNING_TTL_MS
            : ATTENTION_RECENT_TTL_MS
        ),
    ).toISOString();
    const actions: AttentionItem["actions"] = [
      { id: "open", kind: "open", label: "Open" },
    ];
    if (run.phase === "waiting_for_approval" && run.itemId) {
      actions.unshift(
        {
          id: "approve",
          kind: "approve",
          label: "Approve",
          payload: { sessionId: run.sessionId, itemId: run.itemId },
        },
        {
          id: "deny",
          kind: "deny",
          label: "Deny",
          destructive: true,
          payload: { sessionId: run.sessionId, itemId: run.itemId },
        },
      );
    } else if (run.phase === "waiting_for_input") {
      actions.unshift({
        id: "answer",
        kind: "answer",
        label: "Answer",
        payload: { sessionId: run.sessionId },
      });
    }
    return withActivityFingerprints({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      id: `agent:${context.machineKey}:${run.sessionId}`,
      revision: run.lastActiveAt,
      fingerprint: "",
      activityTier: phase === "needs_you" || phase === "failed" ? "signal" : "ambient",
      kind: "agent",
      eventKind: agentEventKindForPhase(phase),
      phase,
      machine,
      project: attentionProjectRef(
        run.scopeKey,
        scope?.projectName ?? "ADE project",
        scope?.projectRoot,
        context.canonicalProjectId,
      ),
      laneId: null,
      laneName: run.lane,
      provider: run.agent,
      model: run.model,
      // Additive: only present while the chat really is in planning mode, so
      // an item without it reads exactly as it does today.
      ...(phase === "running" && run.chatActivityMode === "planning"
        ? { chatActivityMode: "planning" as const }
        : {}),
      title: attentionSessionTitle({
        sessionTitle: run.title,
        laneName: run.lane,
        provider: subject,
        phase,
      }),
      preview,
      privacyPreview: agentAttentionPrivacyPreview(phase),
      detail: run.detail ? sanitizeAttentionPreview(run.detail, 1_000) : null,
      recentActivity: run.detail ? [sanitizeAttentionPreview(run.detail)] : [],
      planProgress: null,
      destination: {
        kind: "session",
        sessionId: run.sessionId,
        itemId: run.itemId,
      },
      actions,
      occurredAt: new Date(run.startedAt).toISOString(),
      updatedAt: new Date(run.lastActiveAt).toISOString(),
      statusSince: new Date(run.statusSinceAt).toISOString(),
      seenAt: null,
      dismissedAt: null,
      expiresAt,
    });
  });
}

async function buildRosterItems(
  context: AttentionItemBuildContext,
  machine: AttentionItem["machine"],
  snoozedItemIds: Set<string>,
): Promise<AttentionItem[]> {
  if (!context.includeRoster) return [];
  const projects = await context.loadRoster();
  const items = projects.flatMap((project): AttentionItem[] => {
    const laneNames = new Map(project.lanes.map((lane) => [lane.id, lane.name]));
    const rosterChatIds = new Set(project.chats.map((chat) => chat.id));
    return project.chats.filter((chat) => {
      // CTO/identity chats are ADE's own assistant threads, not user work.
      // The desktop sidebar strips them, so the feed the user compares
      // against that sidebar must strip them too. The roster itself still
      // carries the rows — the mobile hub renders them.
      if (chat.identityKey?.trim()) return false;
      // Shells attached to a visible chat are one piece of work, not two:
      // the sidebar nests them under their parent row, so publishing 1 + N
      // Activity items per chat inflates every count the user compares
      // against. Same split as above: the roster keeps them, the feed folds
      // them into the parent.
      const parentId = chat.chatSessionId?.trim();
      return !(parentId && parentId !== chat.id && rosterChatIds.has(parentId));
    }).map((chat): AttentionItem => {
      let phase = rosterAttentionPhase(chat.status);
      let activityTier = rosterActivityTier(chat.status);
      // Snooze is a visibility overlay, not a phase. Activity still has to
      // stop counting a snoozed row as working — otherwise ADE-121-style
      // until-asked chats inflate the island's working tally forever.
      // Failed and needs-you stay visible: those are the rows the glance is
      // for, and filing them away would hide the reason you opened it.
      const revision = validTimestampMs(chat.lastActivityAt, context.nowMs);
      const activityAt = new Date(revision).toISOString();
      const id = `agent:${context.machineKey}:${chat.id}`;
      if (
        isSessionSnoozed(chat, context.nowMs)
        && phase !== "failed"
        && phase !== "needs_you"
      ) {
        phase = "stale";
        activityTier = "idle";
        snoozedItemIds.add(id);
      }
      const existingAnchor = context.rosterPhaseAnchors.get(id);
      const statusSinceAt = existingAnchor?.status === chat.status
        ? existingAnchor.statusSinceAt
        : Math.max(revision, (existingAnchor?.statusSinceAt ?? -1) + 1);
      context.rosterPhaseAnchors.set(id, { status: chat.status, statusSinceAt });
      const provider = providerDisplayName(chat.provider ?? chat.toolType);
      const preview = sanitizeAttentionPreview(
        chat.attentionMessage?.trim()
          || chat.statusNote?.trim()
          || chat.preview?.trim()
          || chat.title?.trim()
          || laneNames.get(chat.laneId)
          || "ADE session",
      );
      const actions: AttentionItem["actions"] = [
        { id: "open", kind: "open", label: "Open" },
      ];
      if (phase === "needs_you") {
        actions.unshift({
          id: "answer",
          kind: "answer",
          label: "Answer",
          payload: { sessionId: chat.id },
        });
      }
      return withActivityFingerprints({
        contractVersion: ATTENTION_CONTRACT_VERSION,
        id,
        revision,
        fingerprint: "",
        activityTier,
        kind: "agent",
        eventKind: agentEventKindForPhase(phase),
        phase,
        machine,
        project: attentionProjectRef(
          project.projectId,
          project.displayName,
          project.rootPath,
          context.canonicalProjectId,
        ),
        laneId: chat.laneId,
        laneName: laneNames.get(chat.laneId) ?? null,
        provider,
        model: chat.model ?? null,
        title: attentionSessionTitle({
          sessionTitle: chat.title,
          laneName: laneNames.get(chat.laneId) ?? null,
          provider,
          phase,
        }),
        preview,
        privacyPreview: agentAttentionPrivacyPreview(phase),
        detail: chat.statusNote ? sanitizeAttentionPreview(chat.statusNote, 1_000) : null,
        recentActivity: [],
        planProgress: null,
        destination: {
          kind: "session",
          sessionId: chat.id,
          itemId: null,
        },
        actions,
        occurredAt: activityAt,
        updatedAt: activityAt,
        statusSince: new Date(statusSinceAt).toISOString(),
        seenAt: null,
        dismissedAt: null,
        expiresAt: new Date(
          revision
            + (
              activityTier === "idle"
                ? IDLE_ROSTER_TTL_MS
                : phase === "running"
                  ? RUNNING_TTL_MS
                  : ATTENTION_RECENT_TTL_MS
            ),
        ).toISOString(),
      });
    });
  });
  const rosterItemIds = new Set(items.map((item) => item.id));
  for (const id of context.rosterPhaseAnchors.keys()) {
    if (!rosterItemIds.has(id)) context.rosterPhaseAnchors.delete(id);
  }
  return items;
}

function buildPrItems(
  context: AttentionItemBuildContext,
  machine: AttentionItem["machine"],
): AttentionItem[] {
  return [...context.prActivities.values()].map((pr): AttentionItem => {
    const scope = context.scopes.get(pr.scopeKey);
    const mapped = prAttentionState(pr.phase);
    const title = prNotificationCopy({
      kind: pr.phase,
      prNumber: pr.prNumber,
      prTitle: pr.title,
      laneId: null,
    }).title;
    const actions: AttentionItem["actions"] = [
      { id: "open", kind: "open", label: "Open pull request" },
    ];
    if (pr.phase === "checks_failing" && pr.prId) {
      actions.unshift({
        id: "rerun_checks",
        kind: "rerun_checks",
        label: "Rerun checks",
        payload: { prId: pr.prId, prNumber: pr.prNumber },
      });
    }
    return withActivityFingerprints({
      contractVersion: ATTENTION_CONTRACT_VERSION,
      id: `pull-request:${context.machineKey}:${pr.id}`,
      revision: pr.updatedAt,
      fingerprint: "",
      activityTier: prActivityTier(mapped.phase),
      kind: "pull_request",
      eventKind: mapped.eventKind,
      phase: mapped.phase,
      machine,
      project: attentionProjectRef(
        pr.scopeKey,
        scope?.projectName ?? "ADE project",
        scope?.projectRoot,
        context.canonicalProjectId,
      ),
      laneId: null,
      laneName: pr.lane,
      provider: "GitHub",
      model: null,
      title,
      preview: sanitizeAttentionPreview(pr.title),
      privacyPreview: `Pull request #${pr.prNumber} changed state.`,
      detail: null,
      recentActivity: [],
      planProgress: null,
      destination: {
        kind: "pull_request",
        prId: pr.prId,
        repoOwner: pr.repoOwner,
        repoName: pr.repoName,
        number: pr.prNumber,
        tab: mapped.tab,
      },
      actions,
      occurredAt: new Date(pr.updatedAt).toISOString(),
      updatedAt: new Date(pr.updatedAt).toISOString(),
      statusSince: new Date(pr.statusSinceAt).toISOString(),
      seenAt: null,
      dismissedAt: null,
      expiresAt: new Date(pr.updatedAt + ATTENTION_RECENT_TTL_MS).toISOString(),
    });
  });
}

function shouldKeepRosterItem(
  rosterItem: AttentionItem | undefined,
  liveItem: AttentionItem,
  snoozedItemIds: ReadonlySet<string>,
): boolean {
  if (!rosterItem) return false;
  if (
    rosterItem.phase === "running"
    && (liveItem.phase === "completed" || liveItem.phase === "stale")
  ) {
    return true;
  }
  if (
    (rosterItem.phase === "failed" || rosterItem.phase === "needs_you")
    && (
      liveItem.phase === "running"
      || liveItem.phase === "starting"
      || liveItem.phase === "stale"
      || liveItem.phase === "completed"
    )
  ) {
    return true;
  }
  return snoozedItemIds.has(liveItem.id)
    && liveItem.phase !== "needs_you"
    && liveItem.phase !== "failed";
}

export async function buildAttentionItems(
  context: AttentionItemBuildContext,
): Promise<AttentionItem[]> {
  const machine = attentionMachineRef({
    machineKey: context.machineKey,
    accountMachineIdentity: context.accountMachineIdentity,
    machineName: context.machineName,
    lastSeenAtMs: context.nowMs,
  });

  const runItems = buildRunItems(context, machine);
  const snoozedItemIds = new Set<string>();
  const rosterItems = await buildRosterItems(context, machine, snoozedItemIds);
  const prItems = buildPrItems(context, machine);

  const agentItems = new Map<string, AttentionItem>();
  for (const item of rosterItems) agentItems.set(item.id, item);
  // Live state is authoritative on the shared terminal_sessions.id/sessionId
  // namespace and therefore wins every collision with a roster row — with
  // three exceptions:
  //
  // 1. The publisher's view of a run can go quiet (a provider bookend, a
  //    missed event) while the roster, which reads the booted runtime, still
  //    reports the session running. A frozen terminal run must not bury a
  //    row that a live runtime says is working.
  // 2. A live run stuck at `running` must not paint over a roster `failed`
  //    or `needs_you`. That is how "phase 3 running; will hold before phase 4"
  //    showed as working on the island while the session had already failed.
  // 3. A snoozed roster row must not be revived as working by a stale live
  //    run. Snooze is a visibility overlay; Activity still has to honor it.
  for (const item of runItems) {
    const rosterItem = agentItems.get(item.id);
    if (shouldKeepRosterItem(rosterItem, item, snoozedItemIds)) continue;
    agentItems.set(item.id, item);
  }
  return [...agentItems.values(), ...prItems].map((item) => {
    const revision = Math.max(
      item.revision,
      context.lastPublishedRevisionById.get(item.id) ?? 0,
      context.remoteAcknowledgedRevisionById.get(item.id) ?? 0,
    );
    return revision === item.revision ? item : { ...item, revision };
  });
}
