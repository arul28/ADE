import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsClockwise,
  BookOpenText,
  CaretRight,
  ChatTeardropText,
  CircleNotch,
  DotsThree,
  FileDashed,
  GitBranch,
  GitDiff,
  GitMerge,
  GitPullRequest,
  Hammer,
  Hash,
  LinkSimple,
  SlidersHorizontal,
  Sparkle,
  TerminalWindow,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react";

import type { AgentChatSessionSummary, MergeMethod, PrStatus, PrWithConflicts } from "../../../../shared/types";
import { cn } from "../../ui/cn";
import { COLORS } from "../../lanes/laneDesignTokens";
import { copyTextToClipboard } from "../../../lib/launchPromptClipboard";
import { formatError } from "./prFormatters";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS } from "../../ui/paneMenuTokens";
import { confirmDialog } from "../../ui/dialog";
import {
  buildPrChatPrompt,
  chatLabel,
  handPromptToChat,
  linkedPrChats,
  type PrChatActionKind,
  type PrChatFinding,
} from "./prChatActions";
import { readLastMergeMethod } from "./prMergeRailUtils";
import { useOptionalPrs } from "../state/PrsContext";

/**
 * The PR actions menu. One item model, two renderers: the header's `⋯`
 * dropdown and the sidebar row's right-click menu, so both always list the
 * same actions in the same order with the same guards.
 */

export type PrActionsTarget = Pick<
  PrWithConflicts,
  | "id"
  | "laneId"
  | "githubPrNumber"
  | "repoOwner"
  | "repoName"
  | "headBranch"
  | "baseBranch"
  | "title"
  | "githubUrl"
  | "state"
  | "chatSessionIds"
>;

export type PrActionsContext = {
  pr: PrActionsTarget;
  /** Live merge box, when the caller has it. Null hides status-dependent guards' certainty, not the items. */
  status?: PrStatus | null;
  /** Open review threads, for "Fix open review findings". Undefined hides the item. */
  findings?: PrChatFinding[];
  /** Names of failing checks, for "Fix failing checks". */
  failingChecks?: string[];
  mergeMethod?: MergeMethod;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** After a mutation succeeds (draft, auto-merge, close, reopen). */
  onChanged?: () => void | Promise<void>;
  onError?: (message: string) => void;
  /** Opens the "Manage lane" dialog. Undefined, or a PR with no lane, hides the item. */
  onManageLane?: () => void;
  /** Lane chats the caller already has. When set, the menu does not fetch them again. */
  laneChats?: AgentChatSessionSummary[];
};

type PrMenuItem = {
  id: string;
  label: string;
  description?: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  submenu?: PrMenuItem[];
};

type PrMenuSection = { id: string; label?: string; items: PrMenuItem[] };

const TONE = {
  chat: COLORS.accent,
  findings: COLORS.warning,
  checks: COLORS.danger,
  conflicts: COLORS.danger,
  merge: COLORS.info,
  draft: COLORS.textMuted,
  link: COLORS.textSecondary,
  positive: COLORS.success,
  danger: COLORS.danger,
} as const;

/**
 * Builds the menu. Lane chats load when the menu opens (`ensureChats`), so a
 * sidebar full of rows never lists chats it will not show.
 */
export function usePrActionsMenu(context: PrActionsContext) {
  const {
    pr, status, findings, failingChecks, mergeMethod, onRefresh, refreshing, onChanged, onError, onManageLane,
    laneChats: providedChats,
  } = context;
  const [fetchedChats, setFetchedChats] = React.useState<AgentChatSessionSummary[] | null>(null);
  const laneChats = providedChats ?? fetchedChats;
  const [busy, setBusy] = React.useState<string | null>(null);

  const ensureChats = React.useCallback(() => {
    if (!pr.laneId || laneChats !== null) return;
    void window.ade.agentChat
      .list({ laneId: pr.laneId, includeArchived: false })
      .then(setFetchedChats)
      .catch(() => setFetchedChats([]));
  }, [laneChats, pr.laneId]);

  // A different PR (or lane) invalidates the cached chat list.
  React.useEffect(() => {
    setFetchedChats(null);
  }, [pr.id, pr.laneId]);

  // Close and reopen paint the list at once, before the refetch, like a merge.
  const prs = useOptionalPrs();
  const run = React.useCallback(async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
      await onChanged?.();
    } catch (error) {
      onError?.(formatError(error));
    } finally {
      setBusy(null);
    }
  }, [onChanged, onError]);

  const sections = React.useMemo<PrMenuSection[]>(() => {
    const out: PrMenuSection[] = [];
    const open = pr.state === "open" || pr.state === "draft";
    const conflicts = Boolean(status?.mergeConflicts) || status?.mergeStateStatus === "dirty";

    // ── Chat actions ──────────────────────────────────────────────────────
    if (pr.laneId) {
      const laneId = pr.laneId;
      const linked = linkedPrChats(pr, laneChats ?? []);
      const chatItem = ({ id, kind, label, icon, tone, description, extra }: {
        id: string;
        kind: PrChatActionKind;
        label: string;
        icon: React.ReactNode;
        tone: string;
        description?: string;
        extra?: Parameters<typeof buildPrChatPrompt>[2];
      }): PrMenuItem => {
        const prompt = () => buildPrChatPrompt(kind, pr, extra);
        if (linked.length > 1) {
          return {
            id, label, description, icon, tone,
            submenu: [
              ...linked.map<PrMenuItem>((session) => ({
                id: `${id}:${session.sessionId}`,
                label: chatLabel(session),
                icon: <ChatTeardropText size={13} />,
                tone: TONE.chat,
                onSelect: () => handPromptToChat({ laneId, sessionId: session.sessionId, prompt: prompt() }),
              })),
              {
                id: `${id}:new`,
                label: "New chat in lane",
                icon: <Sparkle size={13} />,
                tone: TONE.chat,
                onSelect: () => handPromptToChat({ laneId, sessionId: null, prompt: prompt() }),
              },
            ],
          };
        }
        const target = linked[0] ?? null;
        return {
          id, label, icon, tone,
          description: description ?? (target ? `In ${chatLabel(target)}` : "Starts a chat in this lane"),
          onSelect: () => handPromptToChat({ laneId, sessionId: target?.sessionId ?? null, prompt: prompt() }),
        };
      };
      const items: PrMenuItem[] = [
        chatItem({ id: "ask", kind: "ask", label: "Ask a question", icon: <ChatTeardropText size={14} weight="duotone" />, tone: TONE.chat }),
        chatItem({
          id: "explain", kind: "explain", label: "Explain this PR", icon: <BookOpenText size={14} weight="duotone" />, tone: TONE.chat,
          description: "A walk through the diff and what to read closely",
        }),
      ];
      if (findings && findings.length > 0) {
        items.push(chatItem({
          id: "fix_findings", kind: "fix_findings", label: `Fix open review findings (${findings.length})`,
          icon: <Hammer size={14} weight="duotone" />, tone: TONE.findings, extra: { findings },
        }));
      }
      if (failingChecks && failingChecks.length > 0) {
        items.push(chatItem({
          id: "fix_checks", kind: "fix_checks", label: `Fix failing checks (${failingChecks.length})`,
          icon: <WarningCircle size={14} weight="duotone" />, tone: TONE.checks, extra: { failingChecks },
        }));
      }
      if (open && conflicts) {
        items.push(chatItem({
          id: "resolve_conflicts", kind: "resolve_conflicts", label: "Resolve conflicts",
          icon: <GitDiff size={14} weight="duotone" />, tone: TONE.conflicts,
        }));
      }
      if (open) {
        items.push(chatItem({
          id: "update_description", kind: "update_description", label: "Update the description",
          icon: <Sparkle size={14} weight="duotone" />, tone: TONE.chat, description: "Rewrite it from the current diff",
        }));
      }
      out.push({ id: "chat", label: "Chat", items });
    }

    // ── State ─────────────────────────────────────────────────────────────
    const stateItems: PrMenuItem[] = [];
    if (pr.state === "open") {
      stateItems.push({
        id: "draft", label: "Convert to draft", icon: <FileDashed size={14} />, tone: TONE.draft,
        disabled: busy === "draft",
        onSelect: () => void run("draft", () => window.ade.prs.setDraft({ prId: pr.id, draft: true })),
      });
    } else if (pr.state === "draft") {
      stateItems.push({
        id: "ready", label: "Ready for review", icon: <GitPullRequest size={14} />, tone: TONE.positive,
        disabled: busy === "draft",
        onSelect: () => void run("draft", () => window.ade.prs.setDraft({ prId: pr.id, draft: false })),
      });
    }
    if (pr.state === "open") {
      if (status?.autoMergeEnabled) {
        stateItems.push({
          id: "auto-merge-off", label: "Turn off auto-merge", icon: <GitMerge size={14} />, tone: TONE.merge,
          disabled: busy === "auto-merge",
          onSelect: () => void run("auto-merge", () => window.ade.prs.setAutoMerge({ prId: pr.id, enabled: false })),
        });
      } else if (status?.autoMergeAllowed !== false) {
        stateItems.push({
          id: "auto-merge-on", label: "Enable auto-merge", icon: <GitMerge size={14} weight="duotone" />, tone: TONE.merge,
          description: "GitHub merges it when every requirement passes",
          disabled: busy === "auto-merge",
          onSelect: () => void run("auto-merge", () => window.ade.prs.setAutoMerge({ prId: pr.id, enabled: true, method: readLastMergeMethod(mergeMethod ?? "squash") })),
        });
      } else if (status?.canBypass) {
        // Only an admin can change the setting, so only an admin is told where it is.
        stateItems.push({
          id: "auto-merge-settings", label: "Auto-merge is off for this repo", icon: <GitMerge size={14} />, tone: TONE.draft,
          description: "Open the repository settings",
          onSelect: () => void window.ade.app.openExternal(`https://github.com/${pr.repoOwner}/${pr.repoName}/settings`),
        });
      }
    }
    if (onManageLane && pr.laneId) {
      stateItems.push({
        id: "manage-lane", label: "Manage lane…", icon: <SlidersHorizontal size={14} />, tone: TONE.link,
        onSelect: onManageLane,
      });
    }
    if (onRefresh) {
      stateItems.push({
        id: "refresh", label: refreshing ? "Refreshing…" : "Refresh", icon: <ArrowsClockwise size={14} />, tone: TONE.link,
        disabled: Boolean(refreshing), onSelect: onRefresh,
      });
    }
    if (stateItems.length > 0) out.push({ id: "state", items: stateItems });

    // ── Links ─────────────────────────────────────────────────────────────
    out.push({
      id: "links",
      items: [
        { id: "open", label: "Open on GitHub", icon: <ArrowSquareOut size={14} />, tone: TONE.link, onSelect: () => void window.ade.app.openExternal(pr.githubUrl) },
        { id: "copy-link", label: "Copy link", icon: <LinkSimple size={14} />, tone: TONE.link, onSelect: () => void copyTextToClipboard(pr.githubUrl) },
        { id: "copy-number", label: "Copy PR number", hint: `#${pr.githubPrNumber}`, icon: <Hash size={14} />, tone: TONE.link, onSelect: () => void copyTextToClipboard(`#${pr.githubPrNumber}`) },
        { id: "copy-branch", label: "Copy branch name", icon: <GitBranch size={14} />, tone: TONE.link, onSelect: () => void copyTextToClipboard(pr.headBranch) },
        { id: "copy-checkout", label: "Copy checkout command", hint: "gh", icon: <TerminalWindow size={14} />, tone: TONE.link, onSelect: () => void copyTextToClipboard(`gh pr checkout ${pr.githubPrNumber} --repo ${pr.repoOwner}/${pr.repoName}`) },
      ],
    });

    // ── Close / reopen ────────────────────────────────────────────────────
    if (open) {
      out.push({
        id: "close",
        items: [{
          id: "close", label: "Close pull request", icon: <XCircle size={14} weight="duotone" />, danger: true, tone: TONE.danger,
          disabled: busy === "close",
          onSelect: () => {
            void confirmDialog({
              title: `Close PR #${pr.githubPrNumber}?`,
              message: `${pr.title}\n\nThe branch stays. You can reopen the PR later.`,
              confirmLabel: "Close pull request",
              destructive: true,
            }).then((ok) => {
              if (ok) {
                void run("close", async () => {
                  await window.ade.prs.close({ prId: pr.id });
                  prs?.markPrTerminalLocally(pr, "closed");
                });
              }
            });
          },
        }],
      });
    } else if (pr.state === "closed") {
      out.push({
        id: "reopen",
        items: [{
          id: "reopen", label: "Reopen pull request", icon: <ArrowCounterClockwise size={14} />, tone: TONE.positive,
          disabled: busy === "reopen",
          onSelect: () => void run("reopen", async () => {
            await window.ade.prs.reopen({ prId: pr.id });
            prs?.clearPrTerminalLocally(pr);
          }),
        }],
      });
    }
    return out;
  }, [busy, failingChecks, findings, laneChats, mergeMethod, onManageLane, onRefresh, pr, prs, refreshing, run, status]);

  return { sections, ensureChats, busy };
}

type MenuParts = typeof DropdownMenu | typeof ContextMenu;

function renderItems(Parts: MenuParts, sections: PrMenuSection[]): React.ReactNode {
  return sections.map((section, sectionIndex) => (
    <React.Fragment key={section.id}>
      {sectionIndex > 0 ? <Parts.Separator className={MENU_SEPARATOR_CLASS} /> : null}
      {section.label ? <Parts.Label className={MENU_LABEL_CLASS}>{section.label}</Parts.Label> : null}
      {section.items.map((item) => renderItem(Parts, item))}
    </React.Fragment>
  ));
}

function ItemBody({ item }: { item: PrMenuItem }) {
  return (
    <>
      <span className="mt-px inline-flex shrink-0 self-start" style={{ color: item.tone }}>{item.icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" style={item.danger ? { color: COLORS.danger } : undefined}>{item.label}</span>
        {item.description ? (
          <span className="truncate text-[10.5px] text-muted-fg/70">{item.description}</span>
        ) : null}
      </span>
      {item.hint ? <span className="shrink-0 font-mono text-[10px] text-muted-fg/60">{item.hint}</span> : null}
    </>
  );
}

function renderItem(Parts: MenuParts, item: PrMenuItem): React.ReactNode {
  if (item.submenu) {
    return (
      <Parts.Sub key={item.id}>
        <Parts.SubTrigger className={MENU_ITEM_CLASS} data-testid={`pr-action-${item.id}`}>
          <ItemBody item={item} />
          <CaretRight size={11} className="shrink-0 text-muted-fg/60" />
        </Parts.SubTrigger>
        <Parts.Portal>
          <Parts.SubContent className={MENU_CONTENT_CLASS} sideOffset={4}>
            {item.submenu.map((child) => renderItem(Parts, child))}
          </Parts.SubContent>
        </Parts.Portal>
      </Parts.Sub>
    );
  }
  return (
    <Parts.Item
      key={item.id}
      className={cn(MENU_ITEM_CLASS, "items-start")}
      disabled={item.disabled}
      onSelect={() => item.onSelect?.()}
      data-testid={`pr-action-${item.id}`}
    >
      <ItemBody item={item} />
    </Parts.Item>
  );
}

/** The header's `⋯` button. */
export function PrActionsDropdown(props: PrActionsContext & { triggerClassName?: string }) {
  const { sections, ensureChats, busy } = usePrActionsMenu(props);
  return (
    <DropdownMenu.Root onOpenChange={(open) => { if (open) ensureChats(); }}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="More pull request actions"
          data-testid="pr-actions-trigger"
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-md text-fg/80 transition-colors hover:bg-white/[0.07] hover:text-fg",
            props.triggerClassName,
          )}
        >
          {busy ? <CircleNotch size={15} className="animate-spin" /> : <DotsThree size={18} weight="bold" />}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={6} className={cn(MENU_CONTENT_CLASS, "min-w-[260px]")}>
          {renderItems(DropdownMenu, sections)}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Wraps a sidebar PR row so a right-click opens the same menu. */
export function PrActionsContextMenu({ children, ...props }: PrActionsContext & { children: React.ReactNode }) {
  const { sections, ensureChats } = usePrActionsMenu(props);
  return (
    <ContextMenu.Root onOpenChange={(open) => { if (open) ensureChats(); }}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={cn(MENU_CONTENT_CLASS, "min-w-[260px]")}>
          {renderItems(ContextMenu, sections)}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
