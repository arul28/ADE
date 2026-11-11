import type { AdeCardIcon, AdeCardPayload, AdeCardRow } from "./adeCard";
import type { LaneStart } from "./laneStart";
import type {
  ChatLaunchArgs,
  ChatLaunchCloudStageId,
  ChatLaunchKind,
  ChatLaunchLaneConfig,
  ChatLaunchPhase,
  ChatLaunchQueueMessageArgs,
  ChatLaunchQueuedMessage,
  ChatLaunchSnapshot,
  ChatLaunchStage,
  ChatLaunchStageId,
  ChatLaunchStageStatus,
} from "./types/chatLaunch";

/**
 * Pure helpers for chat launches, shared by the host (`chatLaunchService`),
 * every desktop surface (thread card, sidebar row, launches slide-out) and the
 * browser preview mock, and mirrored by hand in iOS
 * (`WorkChatLaunchPresentation.swift`). Keep the two in step.
 */

export const CHAT_LAUNCH_STAGE_ORDER: readonly ChatLaunchStageId[] = [
  "computer",
  "join",
  "clone",
  "fetch",
  "checkout",
  "environment",
  "agent",
];

/** The stages an ADE Cloud launch runs on the desktop, in order (see `ChatLaunchCloudStageId`). */
export const CHAT_LAUNCH_CLOUD_STAGE_IDS: readonly ChatLaunchCloudStageId[] = ["computer", "join", "clone"];

export function isChatLaunchCloudStageId(id: unknown): id is ChatLaunchCloudStageId {
  return (CHAT_LAUNCH_CLOUD_STAGE_IDS as readonly unknown[]).includes(id);
}

const FINISHED_STAGE_STATUSES: readonly ChatLaunchStageStatus[] = ["done", "skipped", "warning"];

function optionalIso(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function optionalText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * The stages an ADE Cloud launch finished before its computer's brain got it,
 * from untrusted input. Keeps only `computer`, `join` and `clone`, only when
 * finished, once each, in their order; anything else is dropped, because a
 * brain must never show a stage it can't account for.
 */
export function normalizeChatLaunchPriorStages(value: unknown): ChatLaunchStage[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<ChatLaunchCloudStageId, ChatLaunchStage>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!isChatLaunchCloudStageId(record.id) || byId.has(record.id)) continue;
    const status = record.status as ChatLaunchStageStatus;
    if (!FINISHED_STAGE_STATUSES.includes(status)) continue;
    byId.set(record.id, {
      id: record.id,
      status,
      startedAt: optionalIso(record.startedAt),
      endedAt: optionalIso(record.endedAt),
      percent: typeof record.percent === "number" && Number.isFinite(record.percent)
        ? Math.max(0, Math.min(100, Math.round(record.percent)))
        : null,
      detail: optionalText(record.detail, 200),
      error: status === "warning" ? optionalText(record.error, 400) : null,
    });
  }
  return CHAT_LAUNCH_CLOUD_STAGE_IDS.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/**
 * The start a launch's new lane uses: the lane config's own, else the
 * project's default start. Null when the launch works on an existing branch.
 * A launch shows the `fetch` stage exactly when this brings pushed work.
 */
export function chatLaunchLaneStart(
  laneConfig: ChatLaunchLaneConfig | null | undefined,
  defaultStart: LaneStart,
): LaneStart | null {
  if (laneConfig?.mode === "existing") return null;
  return laneConfig?.start ?? defaultStart;
}

/** `ade_card` id prefix of a launch's setup card: `lane-setup:<launchId>`. */
export const LANE_SETUP_CARD_ID_PREFIX = "lane-setup:";

export function laneSetupCardId(launchId: string): string {
  return `${LANE_SETUP_CARD_ID_PREFIX}${launchId}`;
}

export function laneSetupLaunchIdFromCardId(cardId: string | null | undefined): string | null {
  if (!cardId?.startsWith(LANE_SETUP_CARD_ID_PREFIX)) return null;
  return cardId.slice(LANE_SETUP_CARD_ID_PREFIX.length) || null;
}

/** `metrics[].label` under which a `lane_setup` card carries its lane template's name. */
export const LANE_SETUP_CARD_TEMPLATE_METRIC = "Template";

/**
 * Whether a brain can't run a launch of this kind handed to it, from the
 * `chatLaunchKinds` capability it advertised. A chat runs on any brain. Null
 * (its answer couldn't be read) is not refused; a brain that answered without
 * the list predates the kinds, so only `chat` is assumed.
 */
export function chatLaunchKindUnknownToBrain(kind: ChatLaunchKind, brainKinds: readonly string[] | null): boolean {
  if (kind === "chat" || brainKinds === null) return false;
  return !brainKinds.includes(kind);
}

/**
 * The refusal when a launch is cancelled after its agent started (or, for a
 * lane launch, after the lane is set up): from then on the lane is the user's
 * to delete. Shared by the local and ADE Cloud launch hosts.
 */
export function chatLaunchAlreadyStartedMessage(kind: ChatLaunchKind): string {
  if (kind === "lane") return "This lane is already set up. Delete it from the lane menu instead.";
  if (kind === "cli") return "This CLI session already started. Delete its lane from the lane menu instead.";
  return "This chat already started. Delete its lane from the lane menu instead.";
}

/** The `chatLaunchKinds` capability as a brain sent it: the strings only; absent is an empty list. */
export function readChatLaunchKindsCapability(capabilities: unknown): string[] {
  if (!capabilities || typeof capabilities !== "object") return [];
  const kinds = (capabilities as { chatLaunchKinds?: unknown }).chatLaunchKinds;
  return Array.isArray(kinds) ? kinds.filter((kind): kind is string => typeof kind === "string") : [];
}

/** A launch kind from untrusted input; anything unknown is a chat, as before kinds grew. */
export function chatLaunchKindOf(value: unknown): ChatLaunchKind {
  return value === "cli" || value === "lane" ? value : "chat";
}

function newChatLaunchStage(id: ChatLaunchStageId): ChatLaunchStage {
  return { id, status: "pending", startedAt: null, endedAt: null, percent: null, detail: null, error: null };
}

/** The stages a launch shows, in {@link CHAT_LAUNCH_STAGE_ORDER}. */
function chatLaunchStageIds(args: { includeCloud?: boolean; includeFetch: boolean; includeEnvironment: boolean; includeAgent: boolean }): ChatLaunchStageId[] {
  return CHAT_LAUNCH_STAGE_ORDER.filter((id) =>
    (!isChatLaunchCloudStageId(id) || args.includeCloud === true)
    && (id !== "agent" || args.includeAgent)
    && (id !== "fetch" || args.includeFetch)
    && (id !== "environment" || args.includeEnvironment));
}

function clipLaunchTitle(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * The one constructor for a launch's first snapshot. The host builds it in
 * `start`; a client builds the identical optimistic copy before the host
 * answers, so the two never disagree about title, prompt, or stages.
 */
export function createChatLaunchSnapshot(args: {
  launch: ChatLaunchArgs;
  laneId: string;
  laneName: string;
  includeFetch: boolean;
  includeEnvironment: boolean;
  /** An ADE Cloud launch on the desktop: the `computer`, `join` and `clone` rows come first, pending. */
  includeCloud?: boolean;
  /** Finished stages from before this host got the launch; shown first, as they are. */
  priorStages?: ChatLaunchStage[];
  templateName?: string | null;
  nowIso: string;
}): ChatLaunchSnapshot {
  const launch = args.launch;
  const kind = chatLaunchKindOf(launch.kind);
  const prompt = String(launch.prompt ?? "");
  const chat = kind === "chat" ? launch.chat : undefined;
  return {
    launchId: launch.launchId,
    kind,
    mode: launch.mode === "background" ? "background" : "foreground",
    sessionId: kind === "chat" ? launch.launchId : null,
    laneId: args.laneId,
    laneName: args.laneName,
    laneNaming: false,
    branchRef: null,
    baseRef: null,
    worktreePath: null,
    templateName: args.templateName ?? null,
    title: launch.title?.trim() || clipLaunchTitle(launch.displayPrompt?.trim() || prompt || "New chat", 80) || "New chat",
    prompt: {
      text: chat?.message.text ?? prompt,
      displayText: launch.displayPrompt ?? chat?.message.displayText ?? null,
      attachments: launch.attachments ?? chat?.message.attachments ?? [],
    },
    modelId: launch.modelId ?? chat?.create.modelId ?? null,
    phase: "running",
    stages: [
      ...(args.priorStages ?? []).map((stage) => ({ ...stage })),
      // A lane launch starts nothing in the lane, so it has no agent stage.
      ...chatLaunchStageIds({ ...args, includeCloud: args.includeCloud === true && !args.priorStages?.length, includeAgent: kind !== "lane" })
        .map(newChatLaunchStage),
    ],
    error: null,
    laneCreated: false,
    sessionCreated: false,
    agentStarted: false,
    queuedMessages: [],
    originClientId: launch.originClientId ?? null,
    startedAt: args.nowIso,
    endedAt: null,
    updatedAt: args.nowIso,
    sequence: 0,
  };
}

export function chatLaunchStageLabel(
  id: ChatLaunchStageId,
  context: { kind: ChatLaunchKind; templateName?: string | null },
): string {
  switch (id) {
    case "computer":
      return "Make computer";
    case "join":
      return "Join your account";
    case "clone":
      return "Clone repository";
    case "fetch":
      return "Fetch base branch";
    case "checkout":
      return "Check out files";
    case "environment":
      return context.templateName ? "Apply lane template" : "Set up environment";
    case "agent":
      return context.kind === "cli" ? "Start CLI session" : "Start agent";
  }
}

/** Present-tense label for the stage currently running ("Checking out files"). */
function chatLaunchStageActiveLabel(
  id: ChatLaunchStageId,
  context: { kind: ChatLaunchKind; templateName?: string | null },
): string {
  switch (id) {
    case "computer":
      return "Making computer";
    case "join":
      return "Joining your account";
    case "clone":
      return "Cloning repository";
    case "fetch":
      return "Fetching base branch";
    case "checkout":
      return "Checking out files";
    case "environment":
      return context.templateName ? "Applying lane template" : "Setting up environment";
    case "agent":
      return context.kind === "cli" ? "Starting CLI session" : "Starting agent";
  }
}

/**
 * The one builder for a queued message. The host stamps the id and time; a
 * client building an optimistic copy passes its own.
 */
export function toQueuedMessage(
  args: Pick<ChatLaunchQueueMessageArgs, "text" | "displayText" | "attachments">,
  meta: { id: string; createdAt: string },
): ChatLaunchQueuedMessage {
  return {
    id: meta.id,
    text: args.text,
    ...(args.displayText ? { displayText: args.displayText } : {}),
    ...(args.attachments?.length ? { attachments: args.attachments } : {}),
    createdAt: meta.createdAt,
  };
}

export function isChatLaunchTerminal(phase: ChatLaunchPhase): boolean {
  return phase === "completed" || phase === "cancelled";
}

/** A launch still owns the chat's first moments: the thread shows its card, the composer queues. */
export function isChatLaunchPending(launch: Pick<ChatLaunchSnapshot, "phase" | "agentStarted">): boolean {
  return !launch.agentStarted && (launch.phase === "running" || launch.phase === "failed" || launch.phase === "awaiting-client");
}

/** The agent (or CLI session) is up: completed, or started early and not since failed or cancelled. */
export function isChatLaunchSucceeded(launch: Pick<ChatLaunchSnapshot, "phase" | "agentStarted">): boolean {
  return launch.phase === "completed" || (launch.agentStarted && launch.phase !== "failed" && launch.phase !== "cancelled");
}

/**
 * A stage finished in warning (Start anyway, or an environment that failed
 * after Start now). On a completed launch this reads "set up with warnings",
 * never a clean setup and never a failed one: its agent is running.
 */
export function chatLaunchHasWarnings(launch: Pick<ChatLaunchSnapshot, "stages">): boolean {
  return launch.stages.some((stage) => stage.status === "warning" || stage.status === "failed");
}

function chatLaunchActiveStage(launch: Pick<ChatLaunchSnapshot, "stages">): ChatLaunchStage | null {
  return launch.stages.find((stage) => stage.status === "running")
    ?? launch.stages.find((stage) => stage.status === "failed")
    ?? launch.stages.find((stage) => stage.status === "pending")
    ?? null;
}

/**
 * The launch in one short line, for the sidebar row and the slide-out:
 * "Checking out files · 62%", "Applying lane template · Install dependencies",
 * "Fetching latest main (last fetched 2 days ago)", "Lane ready".
 */
export function chatLaunchStatusLine(launch: ChatLaunchSnapshot): string {
  const context = { kind: launch.kind, templateName: launch.templateName };
  if (launch.phase === "cancelled") return "Cancelled";
  if (launch.phase === "failed") {
    const failed = launch.stages.find((stage) => stage.status === "failed");
    const label = failed ? chatLaunchStageLabel(failed.id, context) : "Setup";
    return `${label} failed`;
  }
  if (launch.phase === "completed") {
    return launch.kind === "cli" ? "CLI session started" : launch.kind === "lane" ? "Lane ready" : "Agent started";
  }
  const active = chatLaunchActiveStage(launch);
  if (!active) return "Setting up lane";
  const label = chatLaunchStageActiveLabel(active.id, context);
  // A stale base names what it is waiting on. The generic label does not.
  if (active.id === "fetch" && active.detail?.trim()) return active.detail.trim();
  if ((active.id === "checkout" || active.id === "clone") && active.percent != null) return `${label} · ${active.percent}%`;
  // "Confirm in the window that opened": the one stage that can wait on the person.
  if (active.id === "join" && active.status === "running" && active.detail?.trim()) return `${label} · ${active.detail.trim()}`;
  if (active.id === "environment") {
    const step = active.steps?.find((entry) => entry.status === "running");
    if (step) return `${label} · ${step.label}`;
  }
  return label;
}

/** Stages finished (done/skipped/warning) over stages shown, for compact progress rails. */
export function chatLaunchProgress(launch: Pick<ChatLaunchSnapshot, "stages">): { done: number; total: number } {
  const total = launch.stages.length;
  const done = launch.stages.filter((stage) =>
    stage.status === "done" || stage.status === "skipped" || stage.status === "warning").length;
  return { done, total };
}

/** Apply an incoming snapshot only if it is newer than the one held. */
export function mergeChatLaunchSnapshot(
  current: ChatLaunchSnapshot | null | undefined,
  next: ChatLaunchSnapshot,
): ChatLaunchSnapshot {
  if (!current || current.launchId !== next.launchId) return next;
  return next.sequence >= current.sequence ? next : current;
}

export function chatLaunchStageDurationMs(stage: Pick<ChatLaunchStage, "startedAt" | "endedAt">, nowMs = Date.now()): number | null {
  if (!stage.startedAt) return null;
  const start = Date.parse(stage.startedAt);
  if (!Number.isFinite(start)) return null;
  const end = stage.endedAt ? Date.parse(stage.endedAt) : nowMs;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function formatChatLaunchDuration(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function laneSetupRowIcon(status: ChatLaunchStageStatus): AdeCardIcon {
  switch (status) {
    case "done":
    case "warning":
      // Finished, just not as asked; the row's warning tone says so.
      return "pass";
    case "running":
      return "running";
    case "failed":
      return "fail";
    case "skipped":
      return "skipped";
    default:
      return "queued";
  }
}

/**
 * The launch's `ade_card` (variant `lane_setup`). The host writes it into the
 * chat transcript; clients render the same payload as a stand-in until the
 * host's copy arrives. Each row carries `key` = its stage id, so readers never
 * have to match on the English label; the template name (if any) rides in the
 * `Template` metric.
 */
export function buildLaneSetupCard(snapshot: ChatLaunchSnapshot, nowMs: number): AdeCardPayload {
  const context = { kind: snapshot.kind, templateName: snapshot.templateName };
  const rows: AdeCardRow[] = snapshot.stages.map((stage) => {
    const duration = formatChatLaunchDuration(chatLaunchStageDurationMs(stage, nowMs));
    // A warning keeps its detail ("Fetch timed out; using …") and adds why it warns.
    const text = stage.status === "warning" && stage.error && stage.detail
      ? `${stage.detail} — ${stage.error}`
      : stage.error ?? stage.detail;
    const detail = [text, stage.status === "running" ? null : duration || null]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    return {
      key: stage.id,
      icon: laneSetupRowIcon(stage.status),
      text: chatLaunchStageLabel(stage.id, context),
      detail: detail || null,
      ...(stage.status === "failed" || stage.status === "warning" ? { tone: "warning" as const } : {}),
    };
  });
  const allSettled = snapshot.stages.every((stage) => stage.status !== "pending" && stage.status !== "running");
  // A failed stage is a failed setup until the launch completes; after that
  // the agent runs, so it reads as a warning (the same rule as the live card).
  const failed = snapshot.phase === "failed"
    || (snapshot.phase !== "completed" && snapshot.stages.some((stage) => stage.status === "failed"));
  const warned = !failed && chatLaunchHasWarnings(snapshot);
  const durationMs = snapshot.endedAt
    ? chatLaunchStageDurationMs({ startedAt: snapshot.startedAt, endedAt: snapshot.endedAt }, nowMs)
    : null;
  const durationText = formatChatLaunchDuration(durationMs);
  const base = snapshot.baseRef ? ` from ${snapshot.baseRef}` : "";
  const title = failed
    ? "Lane setup failed"
    : allSettled
      ? warned
        ? durationText ? `Lane set up with warnings in ${durationText}` : "Lane set up with warnings"
        : durationText ? `Lane set up in ${durationText}` : "Lane set up"
      : "Setting up lane";
  const fallbackText = failed
    ? `Lane ${snapshot.laneName} setup failed: ${snapshot.error ?? "unknown error"}`
    : allSettled
      ? `Lane ${snapshot.laneName} set up${base}${durationText ? ` in ${durationText}` : ""}.`
      : `Setting up lane ${snapshot.laneName}${base}…`;
  return {
    cardId: laneSetupCardId(snapshot.launchId),
    variant: "lane_setup",
    state: allSettled && !failed ? "terminal" : "live",
    title,
    subtitle: `${snapshot.laneName}${base}${snapshot.templateName ? ` · ${snapshot.templateName}` : ""}`,
    ...(snapshot.templateName ? { metrics: [{ label: LANE_SETUP_CARD_TEMPLATE_METRIC, value: snapshot.templateName }] } : {}),
    rows,
    fallbackText,
    durationMs,
  };
}
