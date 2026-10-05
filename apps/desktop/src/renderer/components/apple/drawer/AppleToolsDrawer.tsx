import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpinnerGap, X } from "@phosphor-icons/react";
import type { AppleLaneDevice, OpenProjectBinding } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { PaneTooltip } from "../../ui/PaneTooltip";
import { describeAppleError } from "../appleErrors";
import {
  DRAWER_GHOST_BUTTON,
  DRAWER_ICON_BUTTON,
  Group,
  isAppleDrawerGroupId,
  type AppleDrawerGroupId,
} from "./drawerPrimitives";
import { useAppleDrawerActions, type AppleDrawerScope } from "./useAppleDrawerActions";
import type { AppleDrawerContext } from "./drawerContext";
import { AppSection } from "./sections/AppSection";
import { DeviceSection } from "./sections/DeviceSection";
import { CaptureSection } from "./sections/CaptureSection";
import { PreviewLabSection, type AppleRenderedPreview } from "./sections/PreviewLabSection";
import {
  patchChatCompanionUiState,
  readChatCompanionUiState,
} from "../../chat/chatCompanionUiState";

/**
 * The Tools drawer (round 4 §B1/§B2). The pane owns the device and mounts this
 * lazily; the drawer owns nothing but its four groups and the one serialized
 * `act()` they share.
 *
 * Round 3 stacked NINE flat sections in one scroll — App, Simulator, Inspect,
 * Recording, Location, Permissions, Push, Preview Lab, Event log — every row
 * outlined, on a transparent column. Four collapsible cards replace them, one
 * open at a time:
 *
 * | Device      | Appearance, Text size, accessibility, Location, Status bar |
 * | App         | Foreground, Relaunch/Terminate, Open URL, Launch, Permissions, Push, Event log |
 * | Capture     | The lane's recordings |
 * | Preview Lab | Target, Render, Watch file, workspace actions |
 *
 * Inspect and Record are gone from here entirely: both are rail toggles now,
 * because both act on the PICTURE, and a control for the picture belongs beside
 * it rather than two columns away.
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
  /** null = back to device. */
  onPreviewRendered: (preview: AppleRenderedPreview | null) => void;
  /**
   * The chat this pane acts for. The open group is remembered per chat, so the
   * conversation you come back to opens on the card you left it on.
   * Null on a chatless surface, where the choice is remembered for the session
   * only — there is nowhere to key a persisted value to.
   */
  chatSessionId?: string | null;
  /**
   * The recording the RAIL is making right now, or null.
   *
   * Record left the drawer in round 4, which also took away the Capture card's
   * only way of knowing that a recording had just finished. This is that
   * signal, and nothing more: its identity changes on start and goes null on
   * stop, so one effect keyed on it re-reads the library once per transition.
   */
  activeRecordingId?: string | null;
  /**
   * Opens a finished recording in the proof drawer (round 3 §A3). Optional
   * because a surface without a proof drawer still renders the row — it falls
   * back to opening the file itself.
   */
  onOpenProof?: ((artifactId: string) => void) | undefined;
  className?: string;
}

const GROUP_TITLES: Record<AppleDrawerGroupId, string> = {
  device: "Device",
  app: "App",
  capture: "Capture",
  "preview-lab": "Preview Lab",
};

const DEFAULT_GROUP: AppleDrawerGroupId = "device";

/**
 * The open group for a chatless surface.
 *
 * Module-level rather than component state because the drawer is mounted lazily
 * and unmounted with the pane; a `useState` here would reopen on Device every
 * time the tools pane is toggled. Not persisted: with no chat there is no key
 * to persist it under, and inventing one would be the parallel store round 3
 * banned.
 */
let sessionGroup: AppleDrawerGroupId | null = DEFAULT_GROUP;

/**
 * Which group is open, and the writer that remembers it.
 *
 * Per chat, in the same `chatCompanionUiState` record every other per-chat
 * drawer/pane flag lives in — one store, so a chat's UI state is one row rather
 * than one row plus an Apple-shaped satellite.
 */
export function useAppleDrawerGroup(chatSessionId: string | null): {
  open: AppleDrawerGroupId | null;
  toggle: (id: AppleDrawerGroupId) => void;
} {
  const [open, setOpen] = useState<AppleDrawerGroupId | null>(() => {
    if (!chatSessionId) return sessionGroup;
    const stored = readChatCompanionUiState(chatSessionId).appleToolsGroup;
    if (stored === null) return null;
    return isAppleDrawerGroupId(stored) ? stored : DEFAULT_GROUP;
  });

  const toggle = useCallback((id: AppleDrawerGroupId) => {
    setOpen((current) => {
      // Clicking the open card's header closes it — a drawer you can collapse
      // to four headers is how you get the device back at a narrow width.
      const next = current === id ? null : id;
      if (chatSessionId) patchChatCompanionUiState(chatSessionId, { appleToolsGroup: next });
      else sessionGroup = next;
      return next;
    });
  }, [chatSessionId]);

  return { open, toggle };
}

/** Test seam: the chatless surface's remembered group must not leak between tests. */
export function resetAppleDrawerGroupForTests(): void {
  sessionGroup = DEFAULT_GROUP;
}

export function AppleToolsDrawer({
  pin,
  laneId,
  device,
  visible,
  onClose,
  onPreviewRendered,
  chatSessionId = null,
  activeRecordingId = null,
  onOpenProof,
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
  const group = useAppleDrawerGroup(chatSessionId);
  const reportError = actions.reportError;

  /*
   * The foreground app, asked of the device itself every two seconds while the
   * App group is open, so an app opened from the home screen or from Xcode shows
   * up too. When the device reports only SpringBoard, fall back to the lane's
   * active app session, which is what ADE last launched here.
   *
   * Gated on the group rather than on the drawer: this is the App card's one
   * fact, and round 3 polled it from every drawer whatever was on screen.
   */
  const wantsForeground = visible && group.open === "app";
  useEffect(() => {
    if (!wantsForeground) return undefined;
    let cancelled = false;
    const api = window.ade.iosSimulator;
    const read = async () => {
      try {
        const front = await api.getForegroundApp({ laneId, deviceUdid: device.udid }, pinRef.current);
        if (cancelled) return;
        if (front?.bundleId) {
          setForegroundApp(front.bundleId);
          return;
        }
        const status = await api.getStatus(pinRef.current);
        if (cancelled) return;
        const session = status.activeSession;
        const sameLane = !session?.laneId || session.laneId === laneId;
        setForegroundApp(session && sameLane && session.deviceUdid === device.udid ? session.bundleId : null);
      } catch (cause: unknown) {
        if (!cancelled) reportError(cause);
      }
    };
    void read();
    const timer = window.setInterval(() => { void read(); }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [device.udid, laneId, reportError, wantsForeground]);

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
    /* §B4: opaque `bg-surface` and its own `border-l`. Round 2 painted the
       drawer `bg-bg` at pane opacity over a LIVE device, so the simulator was
       legible through the switches. */
    <div
      className={cn("flex h-full min-h-0 w-full min-w-0 flex-col border-l border-border bg-surface text-sm", className)}
      data-testid="apple-tools-drawer"
    >
      <div className="flex h-9 min-w-0 shrink-0 flex-nowrap items-center gap-2 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">Tools</span>
        {actions.pending ? <SpinnerGap size={14} className="shrink-0 animate-spin text-muted-fg" aria-label="Working" /> : null}
        <PaneTooltip label="Close tools" side="bottom">
          <button type="button" className={cn(DRAWER_ICON_BUTTON, "shrink-0")} aria-label="Close tools" onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </PaneTooltip>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        {described ? (
          <div
            role="alert"
            className="flex min-w-0 flex-col gap-1 border-b border-border bg-[color-mix(in_srgb,var(--color-error)_10%,var(--color-surface))] px-3 py-2 text-xs text-[var(--color-error)]"
            data-testid="apple-drawer-error"
          >
            <div className="flex min-w-0 flex-nowrap items-center gap-2">
              <span className="min-w-0 flex-1 break-words">{described.sentence}</span>
              {described.detail ? (
                <button type="button" className={cn(DRAWER_GHOST_BUTTON, "h-5 px-1.5 text-[11px]")} onClick={() => setShowDetail((value) => !value)}>
                  Details
                </button>
              ) : null}
              <PaneTooltip label="Dismiss" side="bottom">
                <button type="button" className={cn(DRAWER_ICON_BUTTON, "h-5 w-5 shrink-0")} aria-label="Dismiss" onClick={actions.clearError}>
                  <X size={12} aria-hidden="true" />
                </button>
              </PaneTooltip>
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
        <div className="flex min-w-0 flex-col gap-2 p-2.5">
          <Group
            id="device"
            title={GROUP_TITLES.device}
            open={group.open === "device"}
            onToggle={group.toggle}
            testId="apple-drawer-device"
          >
            <DeviceSection ctx={ctx} />
          </Group>
          <Group
            id="app"
            title={GROUP_TITLES.app}
            open={group.open === "app"}
            onToggle={group.toggle}
            testId="apple-drawer-app"
          >
            <AppSection ctx={ctx} />
          </Group>
          <Group
            id="capture"
            title={GROUP_TITLES.capture}
            open={group.open === "capture"}
            onToggle={group.toggle}
            testId="apple-drawer-capture"
          >
            <CaptureSection ctx={ctx} activeRecordingId={activeRecordingId} onOpenProof={onOpenProof} />
          </Group>
          <Group
            id="preview-lab"
            title={GROUP_TITLES["preview-lab"]}
            open={group.open === "preview-lab"}
            onToggle={group.toggle}
            testId="apple-drawer-preview-lab"
          >
            <PreviewLabSection ctx={ctx} onPreviewRendered={onPreviewRendered} />
          </Group>
        </div>
      </div>
    </div>
  );
}
