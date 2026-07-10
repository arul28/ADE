import type { AdeCodeProvider, RightPaneContent, SubagentSnapshot } from "./types";
import type { SubagentPaneContent as SharedSubagentPaneContent } from "../../../desktop/src/shared/chatSubagents";

export {
  buildSubagentPaneRows,
  buildSubagentTranscriptEvents,
  isLifecycleEventForSnapshot,
  selectedSubagentSnapshot,
  SUBAGENT_PANE_ROSTER_CAPACITY,
  subagentIndexForPaneLine,
  subagentPaneSelectableLineOffsets,
  subagentTranscriptMessagesToEvents,
  windowSubagentPaneRows,
} from "../../../desktop/src/shared/chatSubagents";
export type {
  SubagentPaneDisclosureSection,
  SubagentPaneRow,
  SubagentPaneSection,
  SubagentPaneTarget,
  SubagentPaneViewSection,
  SubagentPaneViewState,
} from "../../../desktop/src/shared/chatSubagents";

export type SubagentPaneContent = SharedSubagentPaneContent & {
  provider: AdeCodeProvider;
  snapshots: SubagentSnapshot[];
};

export function subagentPaneContentFromRightPane(content: RightPaneContent): SubagentPaneContent | null {
  if (content.kind === "chat-info") {
    return {
      provider: content.info.provider,
      snapshots: content.info.snapshots,
    };
  }
  return null;
}
