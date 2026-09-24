import type { ReactElement } from "react";
import { ArrowsInSimple, ArrowsOutSimple, PictureInPicture } from "@phosphor-icons/react";
import type { WorkLiveScreenTool } from "../../state/workLiveCardState";
import {
  isWorkLivePreviewEnabled,
  setWorkLivePreviewEnabledForChat,
  useChatCompanionUiState,
} from "../chat/chatCompanionUiState";
import { WorkToolChromeButton } from "./workToolChrome";
import { useWorkToolsMaximize } from "./workToolsMaximize";

/**
 * The two controls every screen tool's own chrome row carries.
 *
 * They used to live in the tools pane's TAB STRIP, where they acted on the tool
 * on screen from inside the strip that switches between tools. That strip is
 * about tabs; these are about the tool. Moving them onto the tool's own row puts
 * them beside the controls that already act on it, and makes them available in
 * the full-screen layout too, where the strip was still drawn but the tool felt
 * like the whole page.
 *
 * The preview toggle is per chat and per tool, default ON. The maximize button
 * only renders where a pane can actually maximize (the Work sidebar provides
 * the context; a floating card or the web client does not).
 */
export const WORK_TOOL_PREVIEW_TOGGLE_LABEL = "Show preview when minimized";
export const WORK_TOOL_MAXIMIZE_PANE_LABEL = "Maximize pane";
export const WORK_TOOL_RESTORE_PANE_LABEL = "Restore pane";

export function WorkToolPreviewControls({
  tool,
  chatSessionId,
  /**
   * False where the surface already owns a maximize control — the Mac Desktop
   * row's full-screen button is the same toggle, and two buttons for one state
   * is one too many.
   */
  showMaximize = true,
  /** Distinguishes the pane's row from full screen's in the same tree. */
  testIdSuffix = "",
}: {
  tool: WorkLiveScreenTool;
  chatSessionId: string | null;
  showMaximize?: boolean;
  testIdSuffix?: string;
}): ReactElement {
  const companionUi = useChatCompanionUiState(chatSessionId);
  const previewEnabled = isWorkLivePreviewEnabled(companionUi, tool);
  const maximize = useWorkToolsMaximize();
  return (
    <>
      <WorkToolChromeButton
        label={WORK_TOOL_PREVIEW_TOGGLE_LABEL}
        onClick={() => setWorkLivePreviewEnabledForChat(chatSessionId, tool, !previewEnabled)}
        // Without a chat there is nowhere to remember the choice, so the
        // control states the default and does nothing.
        disabled={!chatSessionId}
        active={previewEnabled}
        testId={`work-tool-preview-toggle${testIdSuffix}`}
      >
        <PictureInPicture size={16} weight={previewEnabled ? "fill" : "regular"} />
      </WorkToolChromeButton>
      {showMaximize && maximize ? (
        <WorkToolChromeButton
          label={maximize.maximized ? WORK_TOOL_RESTORE_PANE_LABEL : WORK_TOOL_MAXIMIZE_PANE_LABEL}
          onClick={() => maximize.setMaximized(!maximize.maximized)}
          active={maximize.maximized}
          testId={`work-tool-maximize${testIdSuffix}`}
        >
          {maximize.maximized ? <ArrowsInSimple size={16} /> : <ArrowsOutSimple size={16} />}
        </WorkToolChromeButton>
      ) : null}
    </>
  );
}
