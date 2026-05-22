import React from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { GitCommitSummary } from "../../../shared/types";
import {
  buildCommitContextActions,
  runHistoryGitAction,
  type HistoryGitActionId,
} from "./historyGitActions";

type HistoryGitContextMenuProps = {
  laneId: string;
  commit: GitCommitSummary;
  isHead: boolean;
  hasWorktree: boolean;
  children: React.ReactNode;
  onNotice?: (message: string) => void;
  onError?: (message: string) => void;
  navigate?: (path: string) => void;
};

export function HistoryGitContextMenu({
  laneId,
  commit,
  isHead,
  hasWorktree,
  children,
  onNotice,
  onError,
  navigate,
}: HistoryGitContextMenuProps) {
  const actions = buildCommitContextActions({ commit, isHead, hasWorktree });

  const run = (actionId: HistoryGitActionId) => {
    void runHistoryGitAction({
      actionId,
      laneId,
      commit,
      onNotice,
      onError,
      navigate,
    });
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="z-50 min-w-[200px] rounded-md border border-white/10 bg-[var(--color-card)] p-1 shadow-xl"
        >
          {actions.map((action) => (
            <ContextMenu.Item
              key={action.id}
              disabled={action.disabled}
              title={action.disabledReason}
              className="flex cursor-pointer select-none items-center rounded px-2 py-1.5 font-sans text-[12px] text-fg outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-white/10"
              onSelect={() => {
                if (!action.disabled) run(action.id);
              }}
            >
              {action.label}
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
