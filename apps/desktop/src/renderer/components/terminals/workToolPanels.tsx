import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LaneDiffMode } from "../../../shared/types";
import type { BrowserTabMentionTarget } from "../../../shared/browserTabMention";
import { useWorkSurfaceMountRef, workSurfaceKey } from "../../lib/workToolOnScreen";
import { Play } from "@phosphor-icons/react";
import type { ComponentType, ReactNode } from "react";
import type {
  AgentChatContextAttachment,
  AgentChatFileRef,
  AppControlContextItem,
  GitCommitSummary,
  IosElementContextItem,
  LaneSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
} from "../../../shared/types";
import { useAppStore, type WorkSidebarTab } from "../../state/appStore";
import { formatToolTypeLabel } from "../../lib/sessions";
import { workRuntimeScopeKey } from "../../lib/chatMachineRouting";
import { ChatPrPane } from "../chat/ChatPrPane";
import { IssuesToolPanel } from "../issues/IssuesToolPanel";
import { SideChatToolPanel } from "../chat/SideChatToolPanel";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { ChatMacDesktopPanel } from "../chat/ChatMacDesktopPanel";
import { AppleDevicePane } from "../apple/AppleDevicePane";
import { remoteSimulatorUses } from "../../../shared/chatRemoteWork";
import type { AgentChatRemoteWorkUse } from "../../../shared/types/chat";
import { useRemoteWorkPinResolver } from "../../lib/remoteWorkPins";
import { MachinePlatformLogo } from "../remoteTargets/MachineIdentity";
import { Banner } from "../ui/notice/Banner";
import {
  getAppleMiniPlayerLaneDevice,
  handoffAppleMiniPlayerAsync,
  noteAppleMiniPlayerLaneDevice,
  noteAppleMiniPlayerPoster,
  releaseAppleMiniPlayerHandoverHold,
  retakeAppleMiniPlayer,
} from "../apple/appleMiniPlayerStore";
import { ChatTerminalDrawer } from "../chat/ChatTerminalDrawer";
import { FilesTab } from "../files/FilesTab";
import { LaneGitActionsPane } from "../lanes/LaneGitActionsPane";
import { cn } from "../ui/cn";
import { isReadOnlyWorkTool, type WorkToolContext } from "./workTools";
import { WORK_TOOL_CHROME_CHIP, WORK_TOOL_CHROME_ROW, WorkToolEmptyLine } from "./workToolChrome";
import { WorkToolReadOnlyView } from "./WorkToolReadOnlyView";
import { isWebCodecsAvailable } from "../chat/h264StreamPlayer";
import { macDesktopWebApi } from "../chat/macDesktopWebStream";

/** App Control loads when its tool is first opened; the chat pane shares the chunk. */
const ChatAppControlPanel = lazy(() => import("../chat/ChatAppControlPanel")
  .then((module) => ({ default: module.ChatAppControlPanel })));

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
  canInsertContext: boolean;
  shouldPersistPanelAttachment: boolean;
  resumingSession: boolean;
  selectedPath: string | null;
  selectedMode: LaneDiffMode | null;
  selectedCommit: GitCommitSummary | null;
  onSelectFile: (path: string, mode: LaneDiffMode) => void;
  onSelectCommit: (commit: GitCommitSummary | null) => void;
  onClearDiffSelection: () => void;
  onAddAttachment: ((attachment: AgentChatFileRef) => void) | undefined;
  onAddBuiltInBrowserContext: ((item: unknown) => void) | undefined;
  onAttachBrowserTab: ((tab: BrowserTabMentionTarget) => void) | undefined;
  onAddAppControlContext: ((item: AppControlContextItem) => void) | undefined;
  onAddIosContext: ((item: IosElementContextItem) => void) | undefined;
  /** Attaches an issue to the chat the pane serves; throws with the reason when it cannot. */
  onAddContextAttachment: ((attachment: AgentChatContextAttachment) => void) | undefined;
  onInsertDraft: ((text: string) => void) | undefined;
  onResumeEndedSession: () => void;
  onToolChange: (tool: WorkSidebarTab | null) => void;
  onClose: () => void;
};

function useWorkToolMountScope(runtimePin: OpenProjectBinding | null): string {
  const bound = useAppStore((s) => s.projectBinding);
  return workRuntimeScopeKey(runtimePin, bound);
}

/* ── Shared chrome ────────────────────────────────────────────────────────── */

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
function NoLaneEmptyLine() {
  return <WorkToolEmptyLine title="Select a lane to use this tool" />;
}

/**
 * The native panels share one frame. It has no lane warning: a pane only ever
 * shows its own lane's tool, so there is no other lane's session to warn about.
 */
function NativePanelFrame({
  padded,
  frameRef,
  children,
}: {
  padded?: boolean;
  /** Registers the tool as mounted, for `ade ui show`. */
  frameRef?: (element: HTMLDivElement | null) => void;
  children: ReactNode;
}) {
  return (
    <div ref={frameRef} className="flex h-full min-h-0 flex-col">
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
  const mountScope = useWorkToolMountScope(runtimePin);
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
      // Remount when the session's *effective* machine changes, not when the
      // pin flips from null (bound) to an explicit pin for the same machine.
      key={`work-terminal:${mountScope}:${terminalOwnerSessionId}`}
      open
      onToggle={onClose}
      laneId={laneId}
      chatSessionId={terminalOwnerSessionId}
      runtimePin={runtimePin}
      runtimeScopeKey={mountScope}
      remoteWork={activeSession?.remoteWork ?? null}
    />
  );
}

function WorkBrowserTool(props: WorkToolPanelProps) {
  const {
    laneId,
    toolContext,
    runtimePin,
    panelSessionId,
    canInsertContext,
    shouldPersistPanelAttachment,
    onAddAttachment,
    onAddBuiltInBrowserContext,
    onAttachBrowserTab,
    onInsertDraft,
  } = props;
  const mountScope = useWorkToolMountScope(runtimePin);
  // `ade ui show browser` answers "shown" only once this is on screen.
  const mountRef = useWorkSurfaceMountRef<HTMLDivElement>(workSurfaceKey("browser", mountScope, laneId ?? null));
  // A surface that cannot drive the tool shows what the desktop is doing with
  // it instead. Checked before the native panel so it never mounts a stubbed
  // namespace it would only fail against.
  if (isReadOnlyWorkTool("browser", toolContext)) {
    return (
      <div ref={mountRef} className="contents">
        <WorkToolReadOnlyView tool="browser" laneId={laneId} />
      </div>
    );
  }
  return (
    <NativePanelFrame frameRef={mountRef}>
      <ChatBuiltInBrowserPanel
        key={`work-browser:${mountScope}`}
        sessionId={panelSessionId}
        groupLaneId={laneId}
        runtimePin={runtimePin}
        onAddAttachment={shouldPersistPanelAttachment ? onAddAttachment : undefined}
        onAddContext={canInsertContext ? onAddBuiltInBrowserContext : undefined}
        // A chat on another machine reaches this desktop's tabs through the
        // desktop its last message came from (`remoteBrowserForwarder`), and
        // the attached block tells its agent where the tab is.
        onAttachTab={canInsertContext ? onAttachBrowserTab : undefined}
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
  const mountScope = useWorkToolMountScope(runtimePin);
  if (!laneId) return <NoLaneEmptyLine />;
  if (pinnedMachineOffline) {
    return <WorkToolEmptyState title={`${pinnedMachineName} is offline`} />;
  }
  // The pane shows the selected file or commit's diff itself, in place of the
  // file list, so it gets the full height. Wrapping it in an auto-height box
  // and mounting a second diff below squeezed the pane's own sections to
  // nothing and loaded every diff twice.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <LaneGitActionsPane
        key={`work-git:${mountScope}:${laneId}`}
        laneId={laneId}
        runtimePin={runtimePin}
        onSelectFile={onSelectFile}
        onSelectCommit={onSelectCommit}
        onClearDiffSelection={onClearDiffSelection}
        selectedPath={selectedPath}
        selectedMode={selectedMode}
        selectedCommit={selectedCommit}
        selectedCommitSha={selectedCommit?.sha ?? null}
      />
    </div>
  );
}

function WorkFilesTool({ laneId, runtimePin }: WorkToolPanelProps) {
  const mountScope = useWorkToolMountScope(runtimePin);
  if (!laneId) return <NoLaneEmptyLine />;
  return (
    <FilesTab
      key={`work-files:${mountScope}`}
      preferredLaneId={laneId}
      pin={runtimePin}
      embedded
    />
  );
}

/**
 * A canvas that has never been handed a frame is 300×150 — the HTML default —
 * and `H264StreamView` only sizes it on the first decode. Drawn with
 * `alpha: false`, that placeholder reads as solid black.
 *
 * It matters because the poster below is painted full-bleed over the floating
 * player: photographing an unsized canvas would hand the handover a black
 * rectangle and stretch it across the picture, which is precisely the failure
 * the poster exists to prevent. Closing the pane before the first frame ever
 * arrives is an ordinary thing to do, so this is an ordinary case, not an edge.
 *
 * Sized-but-different is the test rather than "non-zero": no Apple device
 * decodes at exactly 300×150, so an untouched canvas is unambiguous.
 */
function hasDecodedFrame(canvas: HTMLCanvasElement): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  return canvas.width !== 300 || canvas.height !== 150;
}

/**
 * The iOS tool: this lane's simulator, or the one this chat drives on another
 * machine through its work copy (`ade apple … --machine`), chosen with one row
 * when there is more than one. There is no start control for the other
 * machine's simulator: the agent starts it, and the tool only shows it.
 */
function WorkIosTool(props: WorkToolPanelProps) {
  const { activeSession, laneId, toolContext } = props;
  const remoteUses = remoteSimulatorUses(activeSession);
  const resolvePin = useRemoteWorkPinResolver(remoteUses.length > 0);
  const laneOption = laneId && toolContext.supportsIosSimulator ? "lane" : null;
  const options = [
    ...remoteUses.map((use) => ({ key: use.machineKey, label: use.machineName, use })),
    ...(laneOption ? [{ key: "lane", label: "This lane", use: null }] : []),
  ];
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  // The newest machine the chat used, unless the user picked another.
  const chosen = options.find((option) => option.key === chosenKey) ?? options[0] ?? null;
  if (!chosen) return <WorkIosDevice {...props} />;
  const switcher = options.length > 1 ? (
    <div className={WORK_TOOL_CHROME_ROW} data-testid="ios-target-switcher">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => setChosenKey(option.key)}
          className={cn(WORK_TOOL_CHROME_CHIP, option.key === chosen.key ? "bg-fg/[0.08] text-fg" : "")}
        >
          {option.use ? <MachinePlatformLogo platform={option.use.machinePlatform} size={12} weight="bold" fallback /> : null}
          <span>{option.use ? `Simulator · ${option.label}` : option.label}</span>
        </button>
      ))}
    </div>
  ) : null;
  if (!chosen.use) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {switcher}
        <div className="min-h-0 flex-1"><WorkIosDevice {...props} /></div>
      </div>
    );
  }
  const use = chosen.use;
  const remotePin = resolvePin(use);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {switcher}
      <div className="min-h-0 flex-1">
        {remotePin === "unreachable" ? (
          <WorkToolEmptyState title={`This window is not connected to ${use.machineName}`} />
        ) : (
          <RemoteWorkSimulator key={`${remotePin.key}:${use.workCopyLaneId}`} {...props} use={use} remotePin={remotePin} />
        )}
      </div>
    </div>
  );
}

/**
 * The other machine's simulator for this chat's work copy, once that copy
 * has one. Nothing is started from here: with no device yet, it says so.
 */
function RemoteWorkSimulator(props: WorkToolPanelProps & {
  use: AgentChatRemoteWorkUse & { workCopyLaneId: string };
  remotePin: OpenProjectBinding;
}) {
  const { use, remotePin } = props;
  const laneId = use.workCopyLaneId;
  const [state, setState] = useState<"loading" | "device" | "none" | { error: string }>("loading");
  useEffect(() => {
    let cancelled = false;
    const api = window.ade?.iosSimulator;
    const read = () => {
      void api?.deviceList?.({ laneId, installed: false }, remotePin)
        .then((listed) => { if (!cancelled) setState(listed?.lane ? "device" : "none"); })
        .catch((error: unknown) => { if (!cancelled) setState({ error: error instanceof Error ? error.message : String(error) }); });
    };
    read();
    // The agent starts or gives back the device there; follow it.
    const unsubscribe = api?.onEvent?.((event) => {
      if (event.type === "apple.device.state" && (!event.laneId || event.laneId === laneId)) read();
    }, remotePin);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
    // Keyed by the component's key (pin key + lane); the pin object is stable for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId]);
  if (state === "loading") return <WorkToolEmptyState title={`Reading ${use.machineName}…`} />;
  if (state === "none") return <WorkToolEmptyState title={`No simulator on ${use.machineName} for this chat right now`} />;
  if (typeof state === "object") {
    return (
      <div className="p-3">
        <Banner
          layout="inline"
          model={{ id: `remote-simulator-${use.machineKey}`, tone: "error", title: `Couldn't read the simulator on ${use.machineName}`, error: state.error }}
        />
      </div>
    );
  }
  return <WorkIosDevice {...props} laneId={laneId} laneRoot={null} runtimePin={remotePin} />;
}

function WorkIosDevice({
  laneId,
  laneRoot,
  panelSessionId,
  runtimePin,
  canInsertContext,
  onAddIosContext,
  onInsertDraft,
}: WorkToolPanelProps) {
  const mountScope = useWorkToolMountScope(runtimePin);
  /**
   * The device follows the pane out of the door.
   *
   * Closing the tools pane, or switching to another tool, must not leave a
   * running simulator with nothing on screen at all — no picture, no control,
   * no hint that a device is still up. Unmounting this panel floats it over
   * the chat instead, unless the user has closed the player for that
   * device. Mounting takes it back: two live views of one device is the
   * handoff failing, not succeeding.
   */
  const pinRef = useRef(runtimePin);
  pinRef.current = runtimePin;
  const sessionRef = useRef(panelSessionId);
  sessionRef.current = panelSessionId;
  /**
   * The pane's own DOM, kept through the unmount.
   *
   * A callback ref that never takes the `null` React hands it on detach, so the
   * layout cleanup below can still reach the decoder's canvas. The subtree is
   * already out of the document by the time the next tool renders; holding it
   * costs one detached node until this panel mounts again, and it is the only
   * way to photograph the last frame — a canvas keeps its pixels after it is
   * removed, but a ref React has already cleared points at nothing.
   */
  const paneNodeRef = useRef<HTMLDivElement | null>(null);
  const holdPaneNode = useCallback((node: HTMLDivElement | null) => {
    if (node) paneNodeRef.current = node;
  }, []);

  /*
   * Keep the handover's cache warm while the tool is open.
   *
   * One read on mount and one per device-state event — no poll. The handover
   * itself is synchronous and must stay that way, so the name and family it
   * needs have to be here BEFORE the pane goes, not fetched after it.
   */
  useEffect(() => {
    if (!laneId) return undefined;
    let cancelled = false;
    const api = window.ade?.iosSimulator;
    const read = () => {
      if (!api?.deviceList) return;
      void api.deviceList({ laneId, installed: true }, pinRef.current)
        .then((listed) => {
          if (cancelled) return;
          const lane = listed?.lane ?? null;
          noteAppleMiniPlayerLaneDevice({ laneId, runtimePin: pinRef.current }, lane
            ? { udid: lane.udid, name: lane.name, runtime: lane.runtime, family: lane.family }
            : null);
        })
        .catch(() => {});
    };
    read();
    const unsubscribe = api?.onEvent?.((event) => {
      if (event.type !== "apple.device.state") return;
      if (event.laneId && event.laneId !== laneId) return;
      read();
    }, pinRef.current);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [laneId]);

  /*
   * The handover, in a LAYOUT effect.
   *
   * Three things have to happen in this order for the floating player to appear
   * without a gap, and only the mutation phase can give it to us:
   *
   *  1. photograph the last frame — the pane's canvas is still in the tree here
   *     and gone by the passive phase;
   *  2. take a lease on the stream, BEFORE the pane's own stream hook gives its
   *     one back (that release is a passive cleanup, so it comes after this);
   *  3. open the player, so its mount is flushed in this same commit rather
   *     than a round trip later.
   *
   * Doing all three in a passive cleanup behind a `deviceList` await leaves a
   * visible moment with no picture anywhere.
   */
  /*
   * The other half of the retake: give the hold back now that the pane holds a
   * lease of its own.
   *
   * A passive effect in the PARENT, which React runs after every effect in the
   * subtree below it — so the pane's stream hook has already acquired by the
   * time this fires, and the count goes 2 → 1 rather than through zero. The
   * hold expires by itself if this never runs; that is the safety net, not the
   * mechanism.
   */
  useEffect(() => {
    if (!laneId) return;
    releaseAppleMiniPlayerHandoverHold();
  });

  // `ade apple show` answers "shown" only once this is on screen.
  const mountRef = useWorkSurfaceMountRef<HTMLDivElement>(laneId ? workSurfaceKey("ios", mountScope, laneId) : null);

  useLayoutEffect(() => {
    if (!laneId) return undefined;
    retakeAppleMiniPlayer();
    return () => {
      const canvas = paneNodeRef.current?.querySelector("canvas");
      const udid = getAppleMiniPlayerLaneDevice({ laneId, runtimePin: pinRef.current })?.udid ?? null;
      if (canvas && udid && hasDecodedFrame(canvas)) {
        try {
          // JPEG, not PNG: this is a photograph of a screen that is about to be
          // replaced by the real thing, and a 300 KB PNG of it would cost more
          // to hand around than the frame it is standing in for.
          noteAppleMiniPlayerPoster(udid, canvas.toDataURL("image/jpeg", 0.7));
        } catch {
          // A tainted canvas is a poster we do without.
        }
      }
      void handoffAppleMiniPlayerAsync({
        laneId,
        chatSessionId: sessionRef.current,
        runtimePin: pinRef.current,
      });
    };
  }, [laneId]);
  if (!laneId) return <NoLaneEmptyLine />;
  // Deliberately NOT `padded`. The Apple pane fills its host: the tools pane's
  // 12px gutter and scroll container turned the device back into the drawer
  // this rebuild replaced.
  return (
    <NativePanelFrame frameRef={mountRef}>
      {/* `contents`, so this ref holder generates no box at all and the pane
          stays the flex child it was — the node exists only to be queried for
          the decoder canvas during the unmount above. */}
      <div ref={holdPaneNode} className="contents">
        <AppleDevicePane
          key={`work-ios:${mountScope}`}
          sessionId={panelSessionId}
          laneId={laneId}
          runtimePin={runtimePin}
          projectRoot={laneRoot}
          ignoreChatOwnership
          onAddContext={canInsertContext ? onAddIosContext : undefined}
          onInsertDraft={canInsertContext ? onInsertDraft : undefined}
        />
      </div>
    </NativePanelFrame>
  );
}

function WorkAppControlTool({
  laneId,
  laneRoot,
  activeLane,
  toolContext,
  panelSessionId,
  runtimePin,
  canInsertContext,
  shouldPersistPanelAttachment,
  onAddAttachment,
  onAddAppControlContext,
  onInsertDraft,
}: WorkToolPanelProps) {
  const mountScope = useWorkToolMountScope(runtimePin);
  // `ade app-control show` answers "shown" only once this is on screen, and
  // the floating App Control player stays hidden while it is.
  const mountRef = useWorkSurfaceMountRef<HTMLDivElement>(laneId ? workSurfaceKey("app-control", mountScope, laneId) : null);
  // Before the lane gate, and before the panel: a read-only surface has
  // something to say whether or not a lane is selected, and must not mount a
  // stubbed namespace.
  if (isReadOnlyWorkTool("app-control", toolContext)) {
    return (
      <div ref={mountRef} className="contents">
        <WorkToolReadOnlyView tool="app-control" laneId={laneId} />
      </div>
    );
  }
  if (!laneId) return <NoLaneEmptyLine />;
  return (
    <NativePanelFrame padded>
      <Suspense fallback={null}>
        <div ref={mountRef} className="h-full min-h-0">
          <ChatAppControlPanel
            // One session per lane: another lane is another session, read afresh.
            key={`work-appcontrol:${mountScope}:${laneId}`}
            sessionId={panelSessionId}
            laneId={laneId}
            laneName={activeLane?.name ?? null}
            runtimePin={runtimePin}
            projectRoot={laneRoot}
            controlDisabledReason={null}
            onAddAttachment={shouldPersistPanelAttachment ? onAddAttachment : undefined}
            onAddContext={canInsertContext ? onAddAppControlContext : undefined}
            onInsertDraft={canInsertContext ? onInsertDraft : undefined}
          />
        </div>
      </Suspense>
    </NativePanelFrame>
  );
}

/**
 * Whether the hosted web client can show the full lane-screen pane.
 *
 * The host has to serve the live stream, takeover and the window and capture
 * commands (`supportsFullPane`), and this browser has to decode H.264. A host
 * from before those commands, or a browser without WebCodecs, keeps the
 * watch-only pane, which still starts, stops, watches and takes control.
 * A synchronous read of the connection's hello; the pin picks the machine.
 */
function webClientHasFullDesktopPane(runtimePin: WorkToolPanelProps["runtimePin"]): boolean {
  if (!isWebCodecsAvailable()) return false;
  return macDesktopWebApi()?.supportsFullPane?.(runtimePin ?? undefined) === true;
}

/**
 * The lane's private macOS screen.
 *
 * On the hosted web client this is the same full panel when the host serves
 * it (`webClientHasFullDesktopPane`): the picture over the sync push stream,
 * takeover and real input through the web lease, and the window and capture
 * controls through their sync commands. An older host gets the watch-only
 * pane. Everywhere else — including a Windows or Linux desktop watching a
 * Mac-hosted lane — this is the full panel: the display lives on the runtime
 * host, so the viewer's own platform never enters into it.
 */
function WorkMacDesktopTool({
  laneId,
  activeLane,
  toolContext,
  panelSessionId,
  runtimePin,
}: WorkToolPanelProps) {
  const mountScope = useWorkToolMountScope(runtimePin);
  // `ade mac-desktop show` answers "shown" only once this is on screen.
  const mountRef = useWorkSurfaceMountRef<HTMLDivElement>(laneId ? workSurfaceKey("mac-desktop", mountScope, laneId) : null);
  if (isReadOnlyWorkTool("mac-desktop", toolContext) && !webClientHasFullDesktopPane(runtimePin)) {
    return (
      <div ref={mountRef} className="contents">
        <WorkToolReadOnlyView tool="mac-desktop" laneId={laneId} />
      </div>
    );
  }
  if (!laneId) return <NoLaneEmptyLine />;
  return (
    <NativePanelFrame padded frameRef={mountRef}>
      <ChatMacDesktopPanel
        key={`work-mac-desktop:${mountScope}`}
        laneId={laneId}
        laneName={activeLane?.name ?? null}
        sessionId={panelSessionId}
        runtimePin={runtimePin}
      />
    </NativePanelFrame>
  );
}

function WorkWindowsDesktopTool(props: WorkToolPanelProps) {
  const { laneId, activeLane, toolContext, panelSessionId, runtimePin } = props;
  const mountScope = useWorkToolMountScope(runtimePin);
  const mountRef = useWorkSurfaceMountRef<HTMLDivElement>(
    laneId ? workSurfaceKey("windows-desktop", mountScope, laneId) : null,
  );
  if (isReadOnlyWorkTool("windows-desktop", toolContext) && !webClientHasFullDesktopPane(runtimePin)) {
    return (
      <div ref={mountRef} className="contents">
        <WorkToolReadOnlyView tool="windows-desktop" laneId={laneId} />
      </div>
    );
  }
  if (!laneId) return <NoLaneEmptyLine />;
  // Reuses the Mac Desktop pane: it reads the lane's seat from the runtime and
  // renders the Windows cards when `status.windowsDesktop` is present. Only one
  // of the two panes is ever available, because the host platform picks one.
  return (
    <NativePanelFrame padded frameRef={mountRef}>
      <ChatMacDesktopPanel
        key={`work-windows-desktop:${mountScope}`}
        desktopTool="windows-desktop"
        laneId={laneId}
        laneName={activeLane?.name ?? null}
        sessionId={panelSessionId}
        runtimePin={runtimePin}
      />
    </NativePanelFrame>
  );
}

function WorkPrTool({
  laneId,
  activeLane,
  activeSession,
  runtimePin,
  panelSessionId,
}: WorkToolPanelProps) {
  if (!laneId) return <NoLaneEmptyLine />;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <ChatPrPane
        laneId={laneId}
        branchName={activeLane?.branchRef ?? null}
        sessionTitle={activeSession?.title ?? null}
        sessionId={panelSessionId}
        runtimePin={runtimePin}
        variant="tools"
      />
    </div>
  );
}

/**
 * Issues opened from this lane's chats. Needs no lane: an issue read from a
 * projectless chat still has somewhere to open. "Attach to chat" appears only
 * when the pane serves a chat or draft it can attach to.
 */
function WorkIssuesTool({ laneId, canInsertContext, onAddContextAttachment }: WorkToolPanelProps) {
  return (
    <IssuesToolPanel
      laneId={laneId}
      onAttachToChat={canInsertContext ? onAddContextAttachment : undefined}
    />
  );
}

/**
 * The read-only side chat of the chat the pane serves (`/side`). It runs on
 * that chat's machine, so it takes the chat's pin.
 */
function WorkSideChatTool({ laneId, activeSession, panelSessionId, runtimePin }: WorkToolPanelProps) {
  return (
    <SideChatToolPanel
      mainSessionId={panelSessionId}
      rowSideChatSessionId={activeSession?.id === panelSessionId ? activeSession?.sideChatSessionId ?? null : null}
      laneId={laneId}
      runtimePin={runtimePin}
    />
  );
}

export const WORK_TOOL_COMPONENTS: Record<WorkSidebarTab, ComponentType<WorkToolPanelProps>> = {
  terminal: WorkTerminalTool,
  browser: WorkBrowserTool,
  git: WorkGitTool,
  files: WorkFilesTool,
  ios: WorkIosTool,
  "app-control": WorkAppControlTool,
  "mac-desktop": WorkMacDesktopTool,
  "windows-desktop": WorkWindowsDesktopTool,
  pr: WorkPrTool,
  issues: WorkIssuesTool,
  "side-chat": WorkSideChatTool,
};
