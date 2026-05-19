import type { AdeCodeProvider, RightPaneContent, SubagentSnapshot } from "./types";
import type { SubagentPaneContent as SharedSubagentPaneContent } from "../../../desktop/src/shared/chatSubagents";

export {
  buildSubagentPaneRows,
  buildSubagentTranscriptEvents,
  isLifecycleEventForSnapshot,
  selectedSubagentSnapshot,
  subagentIndexForPaneLine,
  subagentPaneSelectableLineOffsets,
} from "../../../desktop/src/shared/chatSubagents";
export type {
  SubagentPaneRow,
  SubagentPaneSection,
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
