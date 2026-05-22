import React from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import type { GitCommitSummary } from "../../../shared/types";
import {
  buildCommitContextActions,
  groupCommitContextActions,
  runHistoryGitAction,
  type HistoryGitActionId,
} from "./historyGitActions";
import { cn } from "../ui/cn";

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
  const groups = groupCommitContextActions(actions);

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
          className="z-50 min-w-[220px] rounded-md border border-white/10 bg-[var(--color-card)] p-1 shadow-xl"
        >
          {groups.map((group, groupIndex) => (
            <React.Fragment key={group.id}>
              {groupIndex > 0 ? <ContextMenu.Separator className="my-1 h-px bg-white/[0.06]" /> : null}
              <ContextMenu.Label className="px-2 py-1 font-sans text-[10px] font-semibold text-muted-fg">
                {group.label}
              </ContextMenu.Label>
              {group.actions.map((action) => (
                <ContextMenu.Item
                  key={action.id}
                  disabled={action.disabled}
                  title={action.disabledReason}
                  className={cn(
                    "flex cursor-pointer select-none items-center rounded px-2 py-1.5 font-sans text-[12px] outline-none",
                    action.destructive ? "text-red-200" : "text-fg",
                    "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-white/10",
                  )}
                  onSelect={() => {
                    if (!action.disabled) run(action.id);
                  }}
                >
                  {action.label}
                </ContextMenu.Item>
              ))}
            </React.Fragment>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
