import { useEffect, useMemo, useRef, useState } from "react";
import { SpinnerGap, X } from "@phosphor-icons/react";
import type {
  AppleLaneDevice,
  IosElementContextItem,
  OpenProjectBinding,
} from "../../../../shared/types";
import type { SimRecording } from "../../../../main/services/ios/recording/simRecordingService";
import { cn } from "../../ui/cn";
import { describeAppleError } from "../appleErrors";
import type { IosSimulatorSnapshotElement } from "../appleInspectGeometry";
import { DRAWER_GHOST_BUTTON, DRAWER_ICON_BUTTON } from "./drawerPrimitives";
import { useAppleDrawerActions, type AppleDrawerScope } from "./useAppleDrawerActions";
import type { AppleDrawerContext } from "./drawerContext";
import { AppSection } from "./sections/AppSection";
import { SimulatorSection } from "./sections/SimulatorSection";
import { InspectSection } from "./sections/InspectSection";
import { RecordingSection } from "./sections/RecordingSection";
import { LocationSection } from "./sections/LocationSection";
import { PermissionsSection } from "./sections/PermissionsSection";
import { PushSection } from "./sections/PushSection";
import { PreviewLabSection, type AppleRenderedPreview } from "./sections/PreviewLabSection";
import { EventLogSection } from "./sections/EventLogSection";

/** An element the pane's inspect overlay picked. */
export type AppleInspectNode = IosSimulatorSnapshotElement;

/**
 * The Tools drawer (§8, §11). The pane owns the device and mounts this
 * lazily; the drawer owns nothing but its sections and the one serialized
 * `act()` they share.
 *
 * `pin` is the runtime binding every `window.ade.iosSimulator` call is made
 * with — the spec's "runtime pin". It has to be the binding, not its key,
 * because a bare key cannot reach a remote runtime.
 */
export interface AppleToolsDrawerProps {
  pin: OpenProjectBinding | null;
  laneId: string;
  device: AppleLaneDevice;
  visible: boolean;
  onClose: () => void;
  inspect: { enabled: boolean; setEnabled: (v: boolean) => void; selected: AppleInspectNode | null };
  recording: { active: SimRecording | null; start: () => void; stop: () => void };
  /** null = back to device. */
  onPreviewRendered: (preview: AppleRenderedPreview | null) => void;
  /** The host chat's composer, when there is one. */
  onInsertDraft?: ((text: string) => void) | undefined;
  onAddContext?: ((item: IosElementContextItem) => void) | undefined;
  onSelectInspectNode?: ((node: AppleInspectNode | null) => void) | undefined;
  className?: string;
}

export function AppleToolsDrawer({
  pin,
  laneId,
  device,
  visible,
  onClose,
  inspect,
  recording,
  onPreviewRendered,
  onInsertDraft,
  className,
}: AppleToolsDrawerProps) {
  // A ref, never a dep: the binding object is rebuilt on every cross-machine
  // merge, and depending on its identity would re-read settings on that timer.
  const pinRef = useRef<OpenProjectBinding | null>(pin);
  pinRef.current = pin;
  const scope = useMemo<AppleDrawerScope>(() => ({ laneId, deviceUdid: device.udid, chatSessionId: null }), [device.udid, laneId]);
  const actions = useAppleDrawerActions({ scope, pinRef, visible });
  const [foregroundApp, setForegroundApp] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const reportError = actions.reportError;

  /* The foreground app: the lane's active app session, if the status names one. */
  useEffect(() => {
    if (!visible) return undefined;
    let cancelled = false;
    void window.ade.iosSimulator.getStatus(pinRef.current)
      .then((status) => {
        if (cancelled) return;
        const session = status.activeSession;
        const sameLane = !session?.laneId || session.laneId === laneId;
        setForegroundApp(session && sameLane && session.deviceUdid === device.udid ? session.bundleId : null);
      })
      .catch((cause: unknown) => { if (!cancelled) reportError(cause); });
    return () => { cancelled = true; };
  }, [device.udid, laneId, reportError, visible]);

  useEffect(() => { setShowDetail(false); }, [actions.error]);

  const ctx: AppleDrawerContext = {
    scope,
    device,
    pinRef,
    visible,
    actions,
    foregroundApp,
    setForegroundApp,
  };
  const described = actions.error != null ? describeAppleError(actions.error) : null;

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col bg-bg text-sm", className)} data-testid="apple-tools-drawer">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs font-medium text-fg">Tools</span>
        {actions.pending ? <SpinnerGap size={14} className="animate-spin text-muted-fg" aria-label="Working" /> : null}
        <button type="button" className={cn(DRAWER_ICON_BUTTON, "ml-auto")} aria-label="Close tools" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {described ? (
          <div
            role="alert"
            className="flex flex-col gap-1 border-b border-border bg-[color-mix(in_srgb,var(--color-error)_6%,transparent)] px-3 py-2 text-xs text-[var(--color-error)]"
            data-testid="apple-drawer-error"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">{described.sentence}</span>
              {described.detail ? (
                <button type="button" className={cn(DRAWER_GHOST_BUTTON, "h-5 px-1.5 text-[11px]")} onClick={() => setShowDetail((value) => !value)}>
                  Details
                </button>
              ) : null}
              <button type="button" className={cn(DRAWER_ICON_BUTTON, "h-5 w-5")} aria-label="Dismiss" onClick={actions.clearError}>
                <X size={12} />
              </button>
            </div>
            {showDetail && described.detail ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-fg/70">{described.detail}</pre>
            ) : null}
          </div>
        ) : null}
        {actions.settings === null && !described && visible ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-fg">
            <SpinnerGap size={14} className="animate-spin" aria-hidden="true" /> Reading device settings…
          </div>
        ) : null}
        <AppSection ctx={ctx} />
        <SimulatorSection ctx={ctx} />
        <InspectSection
          ctx={ctx}
          enabled={inspect.enabled}
          setEnabled={inspect.setEnabled}
          selected={inspect.selected}
          onInsertDraft={onInsertDraft}
        />
        <RecordingSection ctx={ctx} active={recording.active} start={recording.start} stop={recording.stop} />
        <LocationSection ctx={ctx} />
        <PermissionsSection ctx={ctx} />
        <PushSection ctx={ctx} />
        <PreviewLabSection ctx={ctx} onPreviewRendered={onPreviewRendered} />
        <EventLogSection ctx={ctx} />
      </div>
    </div>
  );
}
