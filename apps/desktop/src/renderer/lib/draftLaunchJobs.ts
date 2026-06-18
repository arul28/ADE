import type {
  AgentChatCodexApprovalPolicy,
  AgentChatCodexConfigSource,
  AgentChatCodexSandbox,
  AgentChatDroidPermissionMode,
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

// Active jobs are never capped; this only limits retained terminal rows.
export const MAX_DRAFT_LAUNCH_TERMINAL_JOBS = 8;
export const DRAFT_LAUNCH_JOB_STALE_AFTER_MS = 2 * 60 * 1000;

// Hard ceiling on how long a single draft launch may run before we fail it.
// Without this, a remote runtime call that neither resolves nor rejects (e.g. a
// connection dropped mid-switch) would wedge the job in a non-terminal state
// forever, blocking re-submission of the same draft.
export const DRAFT_LAUNCH_TIMEOUT_MS = 90 * 1000;

// Thrown when the active project changes out from under an in-flight draft
// launch. The launch captures the originating project's binding when it starts
// and aborts before any mutating runtime call (lane create / session start) if
// the active project has drifted, so it can never create a lane or session in
// the wrong project. The job surfaces as a Restorable failure.
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
  cursorModeId: string | null;
  cursorConfigValues: Record<string, AgentChatCursorConfigValue>;
};

export type DraftLaunchSnapshot = {
  text: string;
  draft: string;
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  executionMode: AgentChatExecutionMode;
  interactionMode: AgentChatInteractionMode;
  nativeControls: NativeControlState;
  attachments: AgentChatFileRef[];
  contextAttachments: AgentChatContextAttachment[];
  iosContextItems: IosElementContextItem[];
  appControlContextItems: AppControlContextItem[];
  builtInBrowserContextItems: BuiltInBrowserContextItem[];
  visualContextPrefix: string;
  visualContextDisplayChips: string;
  isLiteralSlashCommand: boolean;
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

export type DraftLaunchJob = {
  id: string;
  mode: DraftLaunchMode;
  draftKind: DraftLaunchKind;
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
};

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
