import { useNavigate } from "react-router-dom";
import { Play, Terminal as TerminalIcon, WarningCircle } from "@phosphor-icons/react";
import type { ComponentType, ReactNode } from "react";
import type {
  AgentChatFileRef,
  AppControlContextItem,
  GitCommitSummary,
  IosElementContextItem,
  LaneSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
} from "../../../shared/types";
import type { WorkSidebarTab } from "../../state/appStore";
import { formatToolTypeLabel } from "../../lib/sessions";
import { ChatAppControlPanel } from "../chat/ChatAppControlPanel";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { ChatIosSimulatorPanel } from "../chat/ChatIosSimulatorPanel";
import { ChatPrPane } from "../chat/ChatPrPane";
import { ChatTerminalDrawer } from "../chat/ChatTerminalDrawer";
import { FilesTab } from "../files/FilesTab";
import { LaneDiffPane } from "../lanes/LaneDiffPane";
import { LaneGitActionsPane } from "../lanes/LaneGitActionsPane";
import { settingsRouteFor } from "../settings/settingsManifest";
import { cn } from "../ui/cn";
import { isReadOnlyWorkTool, type WorkToolContext } from "./workTools";
import { WorkToolReadOnlyView } from "./WorkToolReadOnlyView";

/**
 * One component per Work tool, keyed by tool id.
 *
 * This used to be a 270-line `useMemo` in `WorkSidebar` dispatching through
 * seven sequential `if (effectiveTool === "…")` blocks over a hand-maintained
 * 28-entry dependency array — a memo that could never memoize (half its inputs
 * changed on every status event) and a dep list nothing kept honest. A lookup
 * into this map does the same job: React memoizes per component, each panel's
 * guards and empty states live next to the panel they guard, and adding a tool
 * is one entry here plus one in `WORK_TOOL_DEFINITIONS`.
 *
 * Every panel takes the same explicit props object, so the pane hands over one
 * value and the contract is readable in one place.
 */
export type PrRefreshAction = { run: () => void; syncing: boolean };

export type WorkToolPanelProps = {
  laneId: string | null;
  /** The lane's worktree path, for the panels that run inside it. */
  laneRoot: string | null;
  activeLane: LaneSummary | null;
  activeSession: TerminalSessionSummary | null;
  runtimePin: OpenProjectBinding | null;
  /** Chat session the panels attach context to, or null. */
  panelSessionId: string | null;
  /** Session that owns the attached shells; null means there is nothing to attach to. */
  terminalOwnerSessionId: string | null;
  toolContext: WorkToolContext;
  pinnedMachineOffline: boolean;
  pinnedMachineName: string | null;
  /** Lane-attribution or context-disabled prose, shown above the native panels. */
  warningReason: string | null;
  canInsertContext: boolean;
  shouldPersistPanelAttachment: boolean;
  resumingSession: boolean;
  selectedPath: string | null;
  selectedMode: "staged" | "unstaged" | null;
  selectedCommit: GitCommitSummary | null;
  onSelectFile: (path: string, mode: "staged" | "unstaged") => void;
  onSelectCommit: (commit: GitCommitSummary | null) => void;
  onClearDiffSelection: () => void;
  onAddAttachment: ((attachment: AgentChatFileRef) => void) | undefined;
  onAddBuiltInBrowserContext: ((item: unknown) => void) | undefined;
  onAddAppControlContext: ((item: AppControlContextItem) => void) | undefined;
  onAddIosContext: ((item: IosElementContextItem) => void) | undefined;
  onInsertDraft: ((text: string) => void) | undefined;
  onResumeEndedSession: () => void;
  onRegisterPrRefresh: (action: PrRefreshAction | null) => void;
  onToolChange: (tool: WorkSidebarTab | null) => void;
  onClose: () => void;
};

/* ── Shared chrome ────────────────────────────────────────────────────────── */

export function WarningBanner({ message }: { message: string }) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-amber-400/15 bg-amber-500/[0.055] px-3 py-2 text-[11px] leading-4 text-amber-100/85">
      <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0 text-amber-200/80" />
      <span>{message}</span>
    </div>
  );
}

/**
 * The pane's empty state, in the terminal drawer's own language.
 *
 * A bare sentence centred in 600px of black reads as a failure — that is what
 * "Continue this OpenCode CLI session before opening an attached terminal." was
 * doing here while the drawer three lines below had a proper icon, headline and
 * button. Same anatomy in both places: a duotone glyph, a headline you can act
 * on, one line of explanation, then whatever actions exist.
 */
export function WorkToolEmptyState({
  title,
  message,
  actions,
  hint,
}: {
  title: string;
  message: string;
  actions?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-5 text-center">
      <TerminalIcon size={22} weight="duotone" className="text-fg/25" />
      <div className="flex flex-col gap-1">
        <p className="font-sans text-[13px] font-semibold text-fg/80">{title}</p>
        <p className="max-w-[240px] font-sans text-[11.5px] leading-[17px] text-muted-fg">{message}</p>
      </div>
      {actions}
      {hint}
    </div>
  );
}

/** The one line that tells you these shells are also an agent surface. */
function TerminalCliHint() {
  return (
    <p className="font-sans text-[11px] leading-4 text-muted-fg/65">
      Agents read and drive these shells with{" "}
      <code className="rounded bg-white/[0.05] px-1 py-px font-mono text-[10.5px] text-fg/70">ade terminal</code>
    </p>
  );
}

const TERMINAL_EMPTY_PRIMARY_CLASS = cn(
  "inline-flex h-8 items-center gap-2 rounded-md border border-violet-400/24 bg-violet-500/[0.10] px-3",
  "font-sans text-[12px] font-medium text-fg/88 transition-colors",
  "hover:border-violet-400/40 hover:bg-violet-500/[0.16] hover:text-fg",
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
  "disabled:cursor-default disabled:opacity-45",
);

const TERMINAL_EMPTY_SECONDARY_CLASS = cn(
  "inline-flex h-8 items-center rounded-md border border-white/[0.10] px-3 font-sans text-[12px]",
  "font-medium text-muted-fg transition-colors hover:border-white/20 hover:text-fg",
  "focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)]",
  "disabled:cursor-default disabled:opacity-45",
);

/** Every tool below the terminal and the browser needs a lane to talk about. */
function NoLaneNotice() {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-muted-fg">
      Select a lane or open a Work session to use the sidebar.
    </div>
  );
}

/** The native panels share one frame: optional warning bar, then the panel. */
function NativePanelFrame({
  warningReason,
  padded,
  children,
}: {
  warningReason: string | null;
  padded?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {warningReason ? <WarningBanner message={warningReason} /> : null}
      <div className={cn("min-h-0 flex-1", padded ? "overflow-auto px-3 py-3" : "overflow-hidden")}>
        {children}
      </div>
    </div>
  );
}

/* ── Panels ───────────────────────────────────────────────────────────────── */

function WorkTerminalTool({
  laneId,
  activeSession,
  terminalOwnerSessionId,
  pinnedMachineOffline,
  pinnedMachineName,
  resumingSession,
  runtimePin,
  onResumeEndedSession,
  onClose,
}: WorkToolPanelProps) {
  if (!laneId) {
    return (
      <WorkToolEmptyState
        title="No lane selected"
        message="Pick a lane or open a Work session and its shells appear here."
      />
    );
  }
  if (!terminalOwnerSessionId) {
    // An ENDED session is the common case here — you left a CLI running, it
    // finished, and the pane still has to be useful. It gets the one action
    // that makes shells possible again instead of a sentence telling you to go
    // and find that action yourself.
    const endedSession = activeSession?.status && activeSession.status !== "running" ? activeSession : null;
    if (endedSession) {
      return (
        <WorkToolEmptyState
          title="This session has ended"
          // `formatToolTypeLabel` already ends in "session" for the CLI tools
          // ("OpenCode CLI session"), so no second "session" here.
          message={`Resume this ${formatToolTypeLabel(endedSession.toolType)} to attach shells to it again.`}
          actions={(
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onResumeEndedSession}
                disabled={resumingSession}
                className={TERMINAL_EMPTY_PRIMARY_CLASS}
              >
                <Play size={13} weight="fill" />
                <span>{resumingSession ? "Resuming…" : "Resume session"}</span>
              </button>
              {/* `onClose`, not the pane's `closePane`: this branch only renders
                  for the terminal tool, where there is no browser view to park. */}
              <button type="button" onClick={onClose} className={TERMINAL_EMPTY_SECONDARY_CLASS}>
                Close
              </button>
            </div>
          )}
          hint={<TerminalCliHint />}
        />
      );
    }
    return (
      <WorkToolEmptyState
        title="Start a shell in this lane"
        message="Shells attach to a chat or a running agent CLI session. Open one and they land here."
        hint={<TerminalCliHint />}
      />
    );
  }
  if (pinnedMachineOffline) {
    return (
      <WorkToolEmptyState
        title={`${pinnedMachineName} is offline`}
        message="Its shells are still there. They come back when the machine answers again."
      />
    );
  }
  return (
    <ChatTerminalDrawer
      // Remount on a machine change so a foreign machine's tabs can never paint
      // into the machine you just switched to.
      key={`work-terminal:${runtimePin?.key ?? "bound"}:${terminalOwnerSessionId}`}
      variant="panel"
      open
      onToggle={onClose}
      laneId={laneId}
      chatSessionId={terminalOwnerSessionId}
      runtimePin={runtimePin}
      emptyMessage="Shells you open here stay attached to this session."
    />
  );
}

function WorkBrowserTool(props: WorkToolPanelProps) {
  const {
    laneId,
    toolContext,
    runtimePin,
    panelSessionId,
    warningReason,
    canInsertContext,
    shouldPersistPanelAttachment,
    onAddAttachment,
    onAddBuiltInBrowserContext,
    onInsertDraft,
  } = props;
  // A surface that cannot drive the tool shows what the desktop is doing with
  // it instead. Checked before the native panel so it never mounts a stubbed
  // namespace it would only fail against.
  if (isReadOnlyWorkTool("browser", toolContext)) {
    return <WorkToolReadOnlyView tool="browser" laneId={laneId} />;
  }
  return (
    <NativePanelFrame warningReason={warningReason}>
      <ChatBuiltInBrowserPanel
        key={`work-browser:${runtimePin?.key ?? "bound"}`}
        sessionId={panelSessionId}
        runtimePin={runtimePin}
        onAddAttachment={shouldPersistPanelAttachment ? onAddAttachment : undefined}
        onAddContext={canInsertContext ? onAddBuiltInBrowserContext : undefined}
        onInsertDraft={canInsertContext ? onInsertDraft : undefined}
      />
    </NativePanelFrame>
  );
}

function WorkGitTool({
  laneId,
  runtimePin,
  pinnedMachineOffline,
  pinnedMachineName,
  selectedPath,
  selectedMode,
  selectedCommit,
  onSelectFile,
  onSelectCommit,
  onClearDiffSelection,
}: WorkToolPanelProps) {
  const navigate = useNavigate();
  if (!laneId) return <NoLaneNotice />;
  if (pinnedMachineOffline) {
    return (
      <WorkToolEmptyState
        title={`${pinnedMachineName} is offline`}
        message="Git for this lane lives on that machine, so there is nothing to read from here yet."
      />
    );
  }
  const hasDiffSelection = Boolean(selectedPath || selectedCommit);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("min-h-0 overflow-auto", hasDiffSelection ? "max-h-[58%] shrink-0" : "flex-1")}>
        <LaneGitActionsPane
          key={`work-git:${runtimePin?.key ?? "bound"}:${laneId}`}
          laneId={laneId}
          runtimePin={runtimePin}
          autoRebaseEnabled={false}
          onOpenSettings={() => navigate(settingsRouteFor("lanes-git.lane-templates"))}
          onSelectFile={onSelectFile}
          onSelectCommit={onSelectCommit}
          onClearDiffSelection={onClearDiffSelection}
          selectedPath={selectedPath}
          selectedMode={selectedMode}
          selectedCommit={selectedCommit}
          selectedCommitSha={selectedCommit?.sha ?? null}
        />
      </div>
      {hasDiffSelection ? (
        <div className="min-h-0 flex-1 border-t border-white/[0.08]">
          <LaneDiffPane
            laneId={laneId}
            runtimePin={runtimePin}
            selectedPath={selectedPath}
            selectedFileMode={selectedMode}
            selectedCommit={selectedCommit}
            liveSync
          />
        </div>
      ) : null}
    </div>
  );
}

function WorkFilesTool({ laneId, runtimePin }: WorkToolPanelProps) {
  if (!laneId) return <NoLaneNotice />;
  return (
    <FilesTab
      key={`work-files:${runtimePin?.key ?? "bound"}`}
      preferredLaneId={laneId}
      pin={runtimePin}
      embedded
    />
  );
}

function WorkPrTool({
  laneId,
  activeLane,
  activeSession,
  panelSessionId,
  runtimePin,
  onRegisterPrRefresh,
  onToolChange,
}: WorkToolPanelProps) {
  if (!laneId) return <NoLaneNotice />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatPrPane
        key={`work-pr:${runtimePin?.key ?? "bound"}:${laneId}`}
        laneId={laneId}
        branchName={activeLane?.branchRef ?? null}
        sessionTitle={activeSession?.title ?? null}
        sessionId={panelSessionId}
        runtimePin={runtimePin}
        onClose={() => onToolChange(null)}
        // The shell header above already says "Pull request" and owns the close
        // button; the pane's refresh moves up into it.
        chromeless
        onRegisterRefresh={onRegisterPrRefresh}
      />
    </div>
  );
}

function WorkIosTool({
  laneId,
  laneRoot,
  panelSessionId,
  runtimePin,
  warningReason,
  canInsertContext,
  shouldPersistPanelAttachment,
  onAddAttachment,
  onAddIosContext,
  onInsertDraft,
}: WorkToolPanelProps) {
  if (!laneId) return <NoLaneNotice />;
  return (
    <NativePanelFrame warningReason={warningReason} padded>
      <ChatIosSimulatorPanel
        key={`work-ios:${runtimePin?.key ?? "bound"}`}
        sessionId={panelSessionId}
        laneId={laneId}
        runtimePin={runtimePin}
        projectRoot={laneRoot}
        controlDisabledReason={null}
        ignoreChatOwnership
        onAddAttachment={shouldPersistPanelAttachment ? onAddAttachment : undefined}
        onAddContext={canInsertContext ? onAddIosContext : undefined}
        onInsertDraft={canInsertContext ? onInsertDraft : undefined}
      />
    </NativePanelFrame>
  );
}

function WorkAppControlTool({
  laneId,
  laneRoot,
  toolContext,
  panelSessionId,
  runtimePin,
  warningReason,
  canInsertContext,
  shouldPersistPanelAttachment,
  onAddAttachment,
  onAddAppControlContext,
  onInsertDraft,
}: WorkToolPanelProps) {
  // Before the lane gate, and before the panel: a read-only surface has
  // something to say whether or not a lane is selected, and must not mount a
  // stubbed namespace.
  if (isReadOnlyWorkTool("app-control", toolContext)) {
    return <WorkToolReadOnlyView tool="app-control" laneId={laneId} />;
  }
  if (!laneId) return <NoLaneNotice />;
  return (
    <NativePanelFrame warningReason={warningReason} padded>
      <ChatAppControlPanel
        key={`work-appcontrol:${runtimePin?.key ?? "bound"}`}
        sessionId={panelSessionId}
        laneId={laneId}
        runtimePin={runtimePin}
        projectRoot={laneRoot}
        controlDisabledReason={null}
        onAddAttachment={shouldPersistPanelAttachment ? onAddAttachment : undefined}
        onAddContext={canInsertContext ? onAddAppControlContext : undefined}
        onInsertDraft={canInsertContext ? onInsertDraft : undefined}
      />
    </NativePanelFrame>
  );
}

export const WORK_TOOL_COMPONENTS: Record<WorkSidebarTab, ComponentType<WorkToolPanelProps>> = {
  terminal: WorkTerminalTool,
  browser: WorkBrowserTool,
  git: WorkGitTool,
  files: WorkFilesTool,
  ios: WorkIosTool,
  "app-control": WorkAppControlTool,
  pr: WorkPrTool,
};
