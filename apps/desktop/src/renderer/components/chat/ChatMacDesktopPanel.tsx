import {
  useMacDesktopPanelController,
  type ChatMacDesktopPanelProps,
} from "./useMacDesktopPanelController";
import { MacDesktopPaneView } from "./MacDesktopPaneView";

export {
  MAC_DESKTOP_CONNECT_SLOW_MS,
  MAC_DESKTOP_FULLSCREEN_Z,
  MAC_DESKTOP_HANDOVER_FRAME_TTL_MS,
} from "./useMacDesktopPanelController";
export type { ChatMacDesktopPanelProps, MacDesktopChromeScope } from "./useMacDesktopPanelController";

export function ChatMacDesktopPanel(props: ChatMacDesktopPanelProps) {
  const controller = useMacDesktopPanelController(props);
  return <MacDesktopPaneView controller={controller} />;
}
