import type { ReactNode } from "react";

/**
 * One scroll for everything that used to be a chat-actions tab.
 *
 * Progress (subagents, background work) is first, then proof when this chat
 * has any, then whatever else the provider adds (Codex sources, Droid
 * missions). There is no tab strip: the header icon is the only control.
 */
export function ChatActionsDrawerPanel({
  agentsContent,
  proofContent,
  extras,
}: {
  agentsContent: ReactNode;
  proofContent?: ReactNode;
  extras?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <div className="min-h-0 flex-1 overflow-auto">
        {agentsContent}
        {proofContent}
        {extras}
      </div>
    </div>
  );
}
