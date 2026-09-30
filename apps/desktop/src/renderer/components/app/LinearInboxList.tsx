import React, { useCallback, useEffect, useState } from "react";
import { Archive, ChatCircle, CircleNotch, Tray } from "@phosphor-icons/react";
import type { LinearInboxNotification, LinearIssueRef } from "../../../shared/types";
import { LinearMark, LinearStateIcon } from "../lanes/linearBrand";
import { linearNotificationVerb } from "../../../shared/linearInbox";
import { relativeTimeCompact } from "../../lib/format";
import { LinearAssigneeAvatar } from "./LinearIssueBrowserRows";
import { cn } from "../ui/cn";
import { showToast } from "./toast/toastStore";

/**
 * The connected person's Linear inbox inside the Linear pane. Opening an item
 * marks it read and shows its issue in the detail pane; items about issues a
 * lane works on say so.
 */
export function LinearInboxList({
  onOpenIssue,
  laneIssueIds,
  onUnreadCountChange,
}: {
  onOpenIssue: (ref: LinearIssueRef) => void;
  /** Issue ids that one of this project's lanes is linked to. */
  laneIssueIds?: ReadonlySet<string>;
  onUnreadCountChange?: (count: number) => void;
}) {
  const [items, setItems] = useState<LinearInboxNotification[] | null>(null);
  const [includeRead, setIncludeRead] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const cto = window.ade?.cto;
    if (!cto?.getLinearInbox) return;
    try {
      const next = await cto.getLinearInbox({ first: 50, includeRead });
      setItems(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the Linear inbox.");
    }
  }, [includeRead]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const mark = useCallback(async (item: LinearInboxNotification, action: "read" | "archive") => {
    // Optimistic: drop or mark the item now, and put it back if Linear refuses.
    const removeFromUnread = action === "archive" || !includeRead;
    setItems((current) => {
      if (!current) return current;
      if (removeFromUnread) return current.filter((entry) => entry.id !== item.id);
      return current.map((entry) => (entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry));
    });
    try {
      await window.ade?.cto?.markLinearNotification?.({ notificationId: item.id, action });
    } catch (err) {
      setItems((current) => {
        if (!current) return current;
        if (removeFromUnread) return current.some((entry) => entry.id === item.id) ? current : [...current, item].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return current.map((entry) => (entry.id === item.id ? item : entry));
      });
      showToast({
        tone: "error",
        icon: <LinearMark size={14} />,
        title: action === "archive" ? "Couldn't archive the notification" : "Couldn't mark the notification read",
        message: err instanceof Error ? err.message : "Linear did not accept the change.",
      });
    }
  }, [includeRead]);

  // The unread count follows the list itself, so quick clicks never count from a stale copy.
  useEffect(() => {
    if (items && !includeRead) onUnreadCountChange?.(items.length);
  }, [includeRead, items, onUnreadCountChange]);

  const open = (item: LinearInboxNotification) => {
    if (!item.issueId && item.url) {
      window.ade?.app?.openExternal?.(item.url);
    } else if (item.issueId && item.issueIdentifier) {
      onOpenIssue({
        id: item.issueId,
        identifier: item.issueIdentifier,
        title: item.issueTitle ?? item.issueIdentifier,
        stateId: "",
        stateName: item.issueStateName ?? "",
        stateType: item.issueStateType ?? "",
      });
    }
    if (!item.readAt) void mark(item, "read");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-linear-pane="inbox">
      <div className="flex shrink-0 items-center gap-1 border-b border-white/[0.05] px-3 py-1.5">
        {(["unread", "all"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={cn(
              "rounded-md px-2 py-1 text-[11px] transition-colors",
              (mode === "all") === includeRead ? "bg-white/[0.08] text-fg" : "text-muted-fg/60 hover:bg-white/[0.04] hover:text-fg/85",
            )}
            onClick={() => setIncludeRead(mode === "all")}
          >
            {mode === "unread" ? "Unread" : "All"}
          </button>
        ))}
        {items == null && !error ? <CircleNotch size={11} className="ml-auto animate-spin text-muted-fg/50" /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {error ? (
          <div className="px-4 py-10 text-center text-[12px] text-muted-fg/60">{error}</div>
        ) : items && items.length === 0 ? (
          <div className="grid place-items-center gap-2 px-4 py-14 text-center text-[12px] text-muted-fg/55">
            <Tray size={22} className="text-muted-fg/35" />
            {includeRead ? "Nothing in your Linear inbox." : "You're caught up."}
          </div>
        ) : (
          (items ?? []).map((item) => {
            const onLane = item.issueId ? laneIssueIds?.has(item.issueId) === true : false;
            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                data-linear-inbox-item={item.id}
                onClick={() => open(item)}
                onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(item); } }}
                className={cn(
                  "group/inbox flex w-full items-start gap-2.5 border-b border-white/[0.04] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]",
                  !item.readAt && "bg-[color:var(--color-accent,#A78BFA)]/[0.03]",
                )}
              >
                <span className="mt-0.5 shrink-0">
                  <LinearAssigneeAvatar name={item.actorName ?? "Linear"} avatarUrl={item.actorAvatarUrl} size={24} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[12px] text-fg/85">
                    {!item.readAt ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--color-accent,#A78BFA)]" aria-label="Unread" /> : null}
                    <span className="truncate">
                      {item.subtitle ? (
                        <span className="text-fg/85">{item.subtitle}</span>
                      ) : (
                        <>
                          <span className="font-medium text-fg/95">{item.actorName ?? "Linear"}</span>{" "}
                          <span className="text-muted-fg/70">{linearNotificationVerb(item.type)}</span>{" "}
                          {item.issueIdentifier ? <span className="font-mono text-[11px] text-muted-fg/80">{item.issueIdentifier}</span> : null}
                        </>
                      )}
                    </span>
                    <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-muted-fg/45">{relativeTimeCompact(item.createdAt)}</span>
                  </span>
                  {item.issueTitle || item.title ? (
                    <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-fg/70">
                      {item.issueStateType ? <LinearStateIcon stateType={item.issueStateType} size={11} /> : null}
                      {item.issueIdentifier ? <span className="shrink-0 font-mono text-[11px] text-muted-fg/60">{item.issueIdentifier}</span> : null}
                      <span className="truncate">{item.issueTitle ?? item.title}</span>
                      {onLane ? (
                        <span className="shrink-0 rounded-full border border-white/[0.1] px-1.5 py-[2px] text-[9.5px] leading-none text-muted-fg/70">Your lane</span>
                      ) : null}
                    </span>
                  ) : null}
                  {item.commentBody ? (
                    <span className="mt-1 flex items-start gap-1.5 text-[11.5px] leading-snug text-muted-fg/60">
                      <ChatCircle size={11} className="mt-[2px] shrink-0" />
                      <span className="line-clamp-2">{item.commentBody}</span>
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  title="Archive"
                  aria-label="Archive"
                  className="invisible mt-0.5 shrink-0 rounded p-1 text-muted-fg/50 transition-colors hover:bg-white/[0.06] hover:text-fg group-hover/inbox:visible"
                  onClick={(event) => { event.stopPropagation(); void mark(item, "archive"); }}
                >
                  <Archive size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
