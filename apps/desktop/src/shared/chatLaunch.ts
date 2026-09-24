import type { AdeCardIcon, AdeCardPayload, AdeCardRow } from "./adeCard";
import type {
  ChatLaunchArgs,
  ChatLaunchKind,
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

export const CHAT_LAUNCH_STAGE_ORDER: readonly ChatLaunchStageId[] = ["fetch", "checkout", "environment", "agent"];

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

function newChatLaunchStage(id: ChatLaunchStageId): ChatLaunchStage {
  return { id, status: "pending", startedAt: null, endedAt: null, percent: null, detail: null, error: null };
}

/** The stages a launch shows, in {@link CHAT_LAUNCH_STAGE_ORDER}. */
function chatLaunchStageIds(args: { includeFetch: boolean; includeEnvironment: boolean }): ChatLaunchStageId[] {
  return CHAT_LAUNCH_STAGE_ORDER.filter((id) =>
    (id !== "fetch" || args.includeFetch) && (id !== "environment" || args.includeEnvironment));
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
  templateName?: string | null;
  nowIso: string;
}): ChatLaunchSnapshot {
  const launch = args.launch;
  const kind: ChatLaunchKind = launch.kind === "cli" ? "cli" : "chat";
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
    baseRef: launch.baseBranch?.trim() || null,
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
    stages: chatLaunchStageIds(args).map(newChatLaunchStage),
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
 * "Setup failed: …", "Lane ready".
 */
export function chatLaunchStatusLine(launch: ChatLaunchSnapshot): string {
  const context = { kind: launch.kind, templateName: launch.templateName };
  if (launch.phase === "cancelled") return "Cancelled";
  if (launch.phase === "failed") {
    const failed = launch.stages.find((stage) => stage.status === "failed");
    const label = failed ? chatLaunchStageLabel(failed.id, context) : "Setup";
    return `${label} failed`;
  }
  if (launch.phase === "completed") return launch.kind === "cli" ? "CLI session started" : "Agent started";
  const active = chatLaunchActiveStage(launch);
  if (!active) return "Setting up lane";
  const label = chatLaunchStageActiveLabel(active.id, context);
  if (active.id === "checkout" && active.percent != null) return `${label} · ${active.percent}%`;
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
    const detail = [stage.error ?? stage.detail, stage.status === "running" ? null : duration || null]
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
