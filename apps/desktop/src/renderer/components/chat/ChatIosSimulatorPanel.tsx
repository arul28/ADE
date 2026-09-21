import { useCallback, useEffect, useState } from "react";
import { BracketsCurly, DeviceMobile } from "@phosphor-icons/react";
import type {
  AgentChatFileRef,
  IosElementContextItem,
  IosSimulatorDrawerMode,
  IosSimulatorPreviewTarget,
  OpenProjectBinding,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { WORK_TOOL_CHROME_BUTTON } from "../terminals/workToolChrome";
import { AppleDeviceColumn } from "../apple/AppleDeviceColumn";
import { useChatRuntimeScopeForPin } from "./ChatRuntimeScope";
import { IosSimPreviewLab, previewLaunchEnvironment } from "./IosSimPreviewLab";

/**
 * The Apple tool's host: two surfaces and the toggle between them.
 *
 * Everything the drawer used to do itself — the live view, pointer input, the
 * inspector, the launch stepper, the device tools, the tool chips — moved into
 * `AppleDeviceColumn`, which owns the device end to end. Preview Lab moved into
 * `IosSimPreviewLab`, which needs Xcode rather than a simulator. What is left
 * here is the choice between them, and nothing else.
 */

type SimulatorSurface = "device" | "preview";

type ChatIosSimulatorPanelProps = {
  sessionId: string | null;
  laneId?: string | null;
  projectRoot: string | null;
  controlDisabledReason?: string | null;
  ignoreChatOwnership?: boolean;
  onAddContext?: (item: IosElementContextItem) => void;
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
  onInsertDraft?: (text: string) => void;
  drawerModeRequest?: { mode: IosSimulatorDrawerMode; nonce: number } | null;
  runtimePin?: OpenProjectBinding | null;
  /**
   * The column's `×`. Present only when this panel IS a column — the Apple
   * pane in the Work tab — and absent inside the tools pane, which has its own
   * close control in the pane header.
   */
  onClose?: () => void;
};

const SURFACE_TOGGLE_BUTTON = cn(WORK_TOOL_CHROME_BUTTON, "w-auto gap-1.5 px-2 text-[12px] font-medium");
const SURFACE_TOGGLE_ACTIVE = "bg-white/[0.09] text-fg";

function SurfaceToggle({
  surface,
  onSelect,
}: {
  surface: SimulatorSurface;
  onSelect: (next: SimulatorSurface) => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5" data-testid="ios-surface-toggle">
      <button
        type="button"
        className={cn(SURFACE_TOGGLE_BUTTON, surface === "device" ? SURFACE_TOGGLE_ACTIVE : null)}
        aria-pressed={surface === "device"}
        onClick={() => onSelect("device")}
        data-testid="ios-surface-device"
      >
        <DeviceMobile size={14} />
        Device
      </button>
      <button
        type="button"
        className={cn(SURFACE_TOGGLE_BUTTON, surface === "preview" ? SURFACE_TOGGLE_ACTIVE : null)}
        aria-pressed={surface === "preview"}
        onClick={() => onSelect("preview")}
        data-testid="ios-surface-preview"
      >
        <BracketsCurly size={14} />
        Preview Lab
      </button>
    </div>
  );
}

export function ChatIosSimulatorPanel({
  sessionId,
  laneId = null,
  projectRoot,
  controlDisabledReason = null,
  ignoreChatOwnership = false,
  onAddContext,
  onAddAttachment,
  onInsertDraft,
  drawerModeRequest,
  runtimePin = null,
  onClose,
}: ChatIosSimulatorPanelProps) {
  const [surface, setSurface] = useState<SimulatorSurface>("device");

  /**
   * The old `interact` and `inspect` modes are gone — inspect is a toggle
   * inside the column now — so every request that is not `preview` means "show
   * me the device".
   */
  useEffect(() => {
    if (!drawerModeRequest) return;
    setSurface(drawerModeRequest.mode === "preview" ? "preview" : "device");
  }, [drawerModeRequest]);

  // The column titles itself "<device> · <lane>" and names the machine when it
  // is not this one, so both come from the chat's own scope rather than the
  // project tab's: a pinned chat's lane is absent from the tab's lane list.
  const chatScope = useChatRuntimeScopeForPin(runtimePin, laneId);
  const laneName = chatScope.lane?.name ?? laneId ?? "this lane";

  /**
   * Preview Lab's "View in simulator" crosses back to the device surface.
   *
   * The launch itself lives here rather than in either surface: the preview
   * target supplies the environment, the column owns the device, and neither
   * should have to reach into the other to run one build.
   */
  const viewInSimulator = useCallback((target: IosSimulatorPreviewTarget) => {
    setSurface("device");
    void window.ade.iosSimulator.launch({
      chatSessionId: sessionId,
      ...(laneId ? { laneId } : { projectRoot }),
      build: true,
      mode: "live",
      environment: previewLaunchEnvironment(target),
    }, runtimePin).catch(() => {});
  }, [laneId, projectRoot, runtimePin, sessionId]);

  const toggle = <SurfaceToggle surface={surface} onSelect={setSurface} />;

  if (surface === "preview") {
    return (
      <IosSimPreviewLab
        sessionId={sessionId}
        laneId={laneId}
        projectRoot={projectRoot}
        runtimePin={runtimePin}
        controlDisabledReason={controlDisabledReason}
        onAddContext={onAddContext}
        onAddAttachment={onAddAttachment}
        onInsertDraft={onInsertDraft}
        headerExtra={toggle}
        onViewInSimulator={viewInSimulator}
      />
    );
  }

  return (
    <AppleDeviceColumn
      sessionId={sessionId}
      laneId={laneId}
      laneName={laneName}
      projectRoot={projectRoot}
      runtimePin={runtimePin}
      controlDisabledReason={controlDisabledReason}
      ignoreChatOwnership={ignoreChatOwnership}
      machineName={chatScope.isRemote ? chatScope.machineName : null}
      onAddContext={onAddContext}
      onInsertDraft={onInsertDraft}
      headerExtra={toggle}
      onClose={onClose}
    />
  );
}
