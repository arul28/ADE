import type {
  AgentChatFileRef,
  IosElementContextItem,
  IosSimulatorDrawerMode,
  OpenProjectBinding,
} from "../../../shared/types";
import { AppleDevicePane } from "../apple/AppleDevicePane";

/**
 * The Apple tool's host.
 *
 * It used to own a `Device / Preview Lab` toggle and a second full surface
 * behind it. Preview Lab is a section of the device's own tools drawer now, so
 * there is no choice left to make here and no header to make it in: this is
 * the one place the chat drawer and the Work tools pane agree on what props
 * the pane takes, and nothing else.
 */

type ChatIosSimulatorPanelProps = {
  sessionId: string | null;
  laneId?: string | null;
  projectRoot: string | null;
  controlDisabledReason?: string | null;
  ignoreChatOwnership?: boolean;
  onAddContext?: (item: IosElementContextItem) => void;
  /** Accepted for call-site compatibility; the pane attaches nothing today. */
  onAddAttachment?: (attachment: AgentChatFileRef) => void;
  onInsertDraft?: (text: string) => void;
  /** Legacy: the drawer had modes. Kept so callers need not change. */
  drawerModeRequest?: { mode: IosSimulatorDrawerMode; nonce: number } | null;
  runtimePin?: OpenProjectBinding | null;
};

export function ChatIosSimulatorPanel({
  sessionId,
  laneId = null,
  projectRoot,
  ignoreChatOwnership = false,
  onAddContext,
  onInsertDraft,
  runtimePin = null,
}: ChatIosSimulatorPanelProps) {
  return (
    <AppleDevicePane
      sessionId={sessionId}
      laneId={laneId}
      projectRoot={projectRoot}
      runtimePin={runtimePin}
      ignoreChatOwnership={ignoreChatOwnership}
      onAddContext={onAddContext}
      onInsertDraft={onInsertDraft}
    />
  );
}
