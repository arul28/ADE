import type {
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
  AgentChatMusePermissionMode,
  AgentChatExecutionMode,
  AgentChatFileRef,
  AgentChatContextAttachment,
  AgentChatInteractionMode,
  AgentChatClaudePermissionMode,
  AgentChatCursorConfigValue,
  AgentChatOpenCodePermissionMode,
  AppControlContextItem,
  BuiltInBrowserContextItem,
  IosElementContextItem,
} from "../../shared/types";
import type { CursorCloudServiceTier } from "../../shared/types/config";

// Active jobs are never capped; this only limits retained terminal rows.
export const MAX_DRAFT_LAUNCH_TERMINAL_JOBS = 8;
export const DRAFT_LAUNCH_JOB_STALE_AFTER_MS = 2 * 60 * 1000;

// Hard ceiling on how long a single draft launch may run before we fail it.
// Without this, a remote runtime call that neither resolves nor rejects (e.g. a
// connection dropped mid-switch) would wedge the job in a non-terminal state
// forever, blocking re-submission of the same draft.
export const DRAFT_LAUNCH_TIMEOUT_MS = 90 * 1000;

// Thrown by the legacy/unpinned fallback when an in-flight draft launch has no
// originating project binding to route through and the active project root
// changes. Bound launches pass a pin to mutating runtime calls instead.
export const LAUNCH_PROJECT_CHANGED_MESSAGE =
  "Project changed before the launch finished — it was not started. Use Restore to run it in the current project.";

// Reject `promise` if it has not settled within DRAFT_LAUNCH_TIMEOUT_MS. The
// underlying runtime call is not cancellable (Electron IPC), so on timeout it
// keeps running detached — `onTimeout` lets the caller raise an abort flag that
// its per-mutation guard checks, so the detached promise cannot perform a late
// irreversible step (create a lane/session) after the job is already failed.
export function withDraftLaunchTimeout<T>(
  promise: Promise<T>,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out. The runtime may have disconnected — use Restore to try again.`));
    }, DRAFT_LAUNCH_TIMEOUT_MS);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}

export type NativeControlState = {
  interactionMode: AgentChatInteractionMode;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
  droidPermissionMode: AgentChatDroidPermissionMode;
  copilotPermissionMode?: import("../../shared/types/chat").AgentChatCopilotPermissionMode;
  copilotContextTier?: import("../../shared/types/chat").AgentChatCopilotContextTier;
  copilotAutoTier?: import("../../shared/types/chat").AgentChatCopilotAutoTier | null;
  musePermissionMode: AgentChatMusePermissionMode;
  cursorModeId: string | null;
  cursorConfigValues: Record<string, AgentChatCursorConfigValue>;
};

export type DraftLaunchSnapshot = {
  text: string;
  draft: string;
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  /** "ultrafast" when Fast was set to Codex's Ultrafast tier; absent is plain Fast. */
  fastTier?: "ultrafast" | null;
  cursorCloudServiceTier: CursorCloudServiceTier | null;
  executionMode: AgentChatExecutionMode;
  interactionMode: AgentChatInteractionMode;
  nativeControls: NativeControlState;
  attachments: AgentChatFileRef[];
  /** Renderer-only identities aligned one-to-one with attachments. */
  attachmentDraftIds?: string[];
  contextAttachments: AgentChatContextAttachment[];
  iosContextItems: IosElementContextItem[];
  appControlContextItems: AppControlContextItem[];
  builtInBrowserContextItems: BuiltInBrowserContextItem[];
  visualContextPrefix: string;
  visualContextDisplayChips: string;
  isLiteralSlashCommand: boolean;
  /**
   * Wall-clock ms of the Enter press that started this launch, for the send
   * timing (`clientSubmittedAtMs`). Absent for a launch with no Enter.
   */
  submittedAtMs?: number;
};

export type PreparedDraftLaunch = DraftLaunchSnapshot & {
  finalText: string;
  finalDisplayText: string;
  selectedAttachments: AgentChatFileRef[];
  selectedContextAttachments: AgentChatContextAttachment[];
};

export type BackgroundLaunchNotice = {
  laneId: string;
  laneName: string;
  sessionId: string;
  draftKind: "chat" | "cli";
};

export type DraftLaunchMode = "foreground" | "background";
export type DraftLaunchKind = BackgroundLaunchNotice["draftKind"];
export type DraftLaunchJobStatus = "naming-lane" | "creating-lane" | "starting-session" | "sending-prompt" | "ready" | "failed";

/**
 * Where the launch is headed. Cursor Cloud takes the same stages as a local launch — make the
 * lane, start the agent, hand over the prompt — but each stage takes visibly longer and happens
 * off this machine, so the status line says so rather than claiming a local session is starting.
 */
export type DraftLaunchTarget = "local" | "cursor-cloud" | "devin-cloud";

export type DraftLaunchJob = {
  id: string;
  mode: DraftLaunchMode;
  draftKind: DraftLaunchKind;
  target: DraftLaunchTarget;
  status: DraftLaunchJobStatus;
  title: string;
  laneId: string | null;
  laneName: string | null;
  sessionId: string | null;
  namingModelId: string | null;
  error: string | null;
  warning: string | null;
  autoOpen: boolean;
  createdAtMs: number;
  snapshot: DraftLaunchSnapshot;
  /** `markNewDraftRequests()` at the send; a later request means the person moved on. */
  newDraftMarkAtSend?: NewDraftRequestMark;
};

/**
 * Counts the person's requests for a new draft in each project tab: ⌘⇧N, the
 * New chat button and the Chat/CLI switch (`showDraftKind`), and "New chat"
 * from the palette, a lane's menu or a chip (`openStartChatDraft`). A launch
 * notes its project's count when it is sent.
 * When the count has changed by the time its chat or CLI starts, the person
 * asked for something else in that project meanwhile, so the launch must not
 * take the screen back: the new session shows in the list instead. A request
 * in another project tab does not count.
 */
const newDraftRequestsByProject = new Map<string, number>();

export type NewDraftRequestMark = { projectStateKey: string; count: number };

export function noteNewDraftRequested(projectStateKey: string | null): void {
  const key = projectStateKey ?? "";
  newDraftRequestsByProject.set(key, (newDraftRequestsByProject.get(key) ?? 0) + 1);
}

export function markNewDraftRequests(projectStateKey: string | null): NewDraftRequestMark {
  const key = projectStateKey ?? "";
  return { projectStateKey: key, count: newDraftRequestsByProject.get(key) ?? 0 };
}

/** False when the person asked for a new draft in the launch's project after its send. */
export function launchMayOpenItsSession(markAtSend: NewDraftRequestMark | undefined): boolean {
  return markAtSend === undefined
    || markAtSend.count === (newDraftRequestsByProject.get(markAtSend.projectStateKey) ?? 0);
}

/**
 * The Work URL key that marks an open written by a launch
 * (`/work?sessionId=…&launchOpen=1`), so only that URL is checked below; a
 * session opened from the palette, a lane or a deeplink is not.
 */
export const LAUNCH_URL_OPEN_PARAM = "launchOpen";

/**
 * Sessions a launch opened through the Work URL, with the project's mark at
 * that open. The Work page applies that URL only once the session is in its
 * list, which can come after the person asked for a new draft; the draft then
 * keeps the screen.
 */
const urlOpenMarksBySessionId = new Map<string, NewDraftRequestMark>();
const URL_OPEN_MARKS_MAX = 32;

export function noteLaunchUrlOpen(sessionId: string, projectStateKey: string | null): void {
  urlOpenMarksBySessionId.delete(sessionId);
  urlOpenMarksBySessionId.set(sessionId, markNewDraftRequests(projectStateKey));
  // A URL that never applies leaves its entry; keep the newest few.
  for (const oldest of urlOpenMarksBySessionId.keys()) {
    if (urlOpenMarksBySessionId.size <= URL_OPEN_MARKS_MAX) break;
    urlOpenMarksBySessionId.delete(oldest);
  }
}

/**
 * For a launch's Work URL (`LAUNCH_URL_OPEN_PARAM`), when it applies: false
 * when a new draft was asked for since the launch opened the session. Reading
 * it ends the launch's entry.
 */
export function takeLaunchUrlOpenAllowed(sessionId: string): boolean {
  const mark = urlOpenMarksBySessionId.get(sessionId);
  urlOpenMarksBySessionId.delete(sessionId);
  return launchMayOpenItsSession(mark);
}

export function isDraftLaunchJobTerminal(status: DraftLaunchJobStatus): boolean {
  return status === "ready" || status === "failed";
}

export function isDraftLaunchJobStale(job: DraftLaunchJob, nowMs: number): boolean {
  return !isDraftLaunchJobTerminal(job.status)
    && nowMs - job.createdAtMs >= DRAFT_LAUNCH_JOB_STALE_AFTER_MS;
}

export function pruneDraftLaunchJobs(jobs: DraftLaunchJob[]): DraftLaunchJob[] {
  const active = jobs.filter((job) => !isDraftLaunchJobTerminal(job.status));
  const terminal = jobs.filter((job) => isDraftLaunchJobTerminal(job.status));
  const remainingTerminalSlots = active.length > 0
    ? Math.max(MAX_DRAFT_LAUNCH_TERMINAL_JOBS - active.length, 1)
    : MAX_DRAFT_LAUNCH_TERMINAL_JOBS;
  return [
    ...active,
    ...terminal.slice(0, remainingTerminalSlots),
  ];
}
