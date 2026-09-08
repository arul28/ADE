import { useNavigate } from "react-router-dom";
import { Play, WarningCircle } from "@phosphor-icons/react";
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
import { ChatTerminalDrawer } from "../chat/ChatTerminalDrawer";
import { FilesTab } from "../files/FilesTab";
import { LaneDiffPane } from "../lanes/LaneDiffPane";
import { LaneGitActionsPane } from "../lanes/LaneGitActionsPane";
import { settingsRouteFor } from "../settings/settingsManifest";
import { cn } from "../ui/cn";
import { isReadOnlyWorkTool, type WorkToolContext } from "./workTools";
import { WORK_TOOL_CHROME_CHIP, WorkToolEmptyLine } from "./workToolChrome";
import { WorkToolReadOnlyView } from "./WorkToolReadOnlyView";

/**
 * One component per Work tool, keyed by tool id.
 *
 * This used to be a 270-line `useMemo` in `WorkSidebar` dispatching through
 * six sequential `if (effectiveTool === "…")` blocks over a hand-maintained
 * 28-entry dependency array — a memo that could never memoize (half its inputs
 * changed on every status event) and a dep list nothing kept honest. A lookup
 * into this map does the same job: React memoizes per component, each panel's
 * guards and empty states live next to the panel they guard, and adding a tool
 * is one entry here plus one in `WORK_TOOL_DEFINITIONS`.
 *
 * Every panel takes the same explicit props object, so the pane hands over one
 * value and the contract is readable in one place.
 */
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
  /**
   * Lane attribution: this tool is attached to a DIFFERENT lane than the one on
   * screen. A real state warning, not an explanation of a capability — the
   * panels drop their controls when a capability is absent rather than
   * narrating it in a banner.
   */
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
 * The pane's empty state: one line, and at most one thing to press.
 *
 * Every tool used to draw a duotone glyph, a headline, a wrapped paragraph
 * explaining the tool, and — in the terminal's case — a second button and a
 * code hint under that. Five elements stacked in a 280px column, none of them
 * the reason you opened the tool. `WorkToolEmptyLine` is the whole anatomy now.
 */
export function WorkToolEmptyState({
  title,
  actions,
}: {
  title: string;
  actions?: ReactNode;
}) {
  return <WorkToolEmptyLine title={title} action={actions} />;
}

/** Every tool below the terminal and the browser needs a lane to talk about. */
function NoLaneNotice() {
  return <WorkToolEmptyLine title="Select a lane to use this tool" />;
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
    return <WorkToolEmptyState title="Select a lane to open shells" />;
  }
  if (!terminalOwnerSessionId) {
    // An ENDED session is the common case here — you left a CLI running, it
    // finished, and the pane still has to be useful. One row, two ghost
    // controls: the sentence explaining what "ended" means was doing no work
    // the header above it was not already doing.
    const endedSession = activeSession?.status && activeSession.status !== "running" ? activeSession : null;
    if (endedSession) {
      return (
        <div className="flex h-full min-h-0 items-center justify-center px-4">
          <div
            data-testid="terminal-ended-card"
            className="flex w-full max-w-[320px] items-center gap-2 rounded-[10px] px-2 py-1.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-border)_70%,transparent)]"
          >
            {/* `formatToolTypeLabel` already ends in "session" for the CLI
                tools ("OpenCode CLI session"), so no second "session" here. */}
            <span className="min-w-0 flex-1 truncate font-sans text-[13px] text-fg/80">
              {formatToolTypeLabel(endedSession.toolType)} ended
            </span>
            <button
              type="button"
              onClick={onResumeEndedSession}
              disabled={resumingSession}
              className={WORK_TOOL_CHROME_CHIP}
            >
              <Play size={12} weight="fill" />
              <span>{resumingSession ? "Resuming…" : "Resume"}</span>
            </button>
            {/* `onClose`, not the pane's `closePane`: this branch only renders
                for the terminal tool, where there is no browser view to park. */}
            <button type="button" onClick={onClose} className={WORK_TOOL_CHROME_CHIP}>
              Close
            </button>
          </div>
        </div>
      );
    }
    return <WorkToolEmptyState title="Start a shell in this lane" />;
  }
  if (pinnedMachineOffline) {
    return <WorkToolEmptyState title={`${pinnedMachineName} is offline`} />;
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
    return <WorkToolEmptyState title={`${pinnedMachineName} is offline`} />;
  }
  const hasDiffSelection = Boolean(selectedPath || selectedCommit);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn("min-h-0 overflow-auto", hasDiffSelection ? "max-h-[58%] shrink-0" : "flex-1")}>
        <LaneGitActionsPane
          key={`work-git:${runtimePin?.key ?? "bound"}:${laneId}`}
          laneId={laneId}
          runtimePin={runtimePin}
          variant="pane"
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
};
