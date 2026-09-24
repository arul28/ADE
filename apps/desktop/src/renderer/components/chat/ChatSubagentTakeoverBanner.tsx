import type { CSSProperties } from "react";
import { ArrowsLeftRight } from "@phosphor-icons/react";

import { Banner } from "../ui/notice";

/**
 * Non-blocking notice above the composer on a subagent chat: this thread still
 * reports to its parent. Take over converts it to a peer; Keep reporting (or
 * dismiss) leaves the channel open. Sending does not answer the prompt.
 */
export function ChatSubagentTakeoverBanner({
  parentTitle,
  onTakeOver,
  onKeepReporting,
  style,
}: {
  parentTitle: string | null;
  onTakeOver: () => void;
  onKeepReporting: () => void;
  /** Outer spacing and width only (the caller lines it up with the composer). */
  style?: CSSProperties;
}) {
  const namedParent = parentTitle?.trim() || null;
  const line = namedParent
    ? `This chat reports back to "${namedParent}". Take it over?`
    : "This chat reports back to its parent. Take it over?";

  return (
    <div data-testid="chat-subagent-takeover-banner" style={{ display: "contents" }}>
      <Banner
        layout="inline"
        style={{ marginBottom: 6, ...style }}
        model={{
          id: "chat-subagent-takeover",
          tone: "accent",
          icon: <ArrowsLeftRight size={13} weight="bold" />,
          title: "Take over this chat?",
          detail: line,
          actions: [
            { label: "Take over", onClick: onTakeOver },
            { label: "Keep reporting", onClick: onKeepReporting },
          ],
          dismiss: { onDismiss: onKeepReporting, title: "Keep reporting", label: "Keep reporting" },
        }}
      />
    </div>
  );
}
