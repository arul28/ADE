import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowsClockwise,
  CaretRight,
  ChatCircle,
  CheckCircle,
  XCircle,
  Clock,
  Eye,
  GitCommit,
  WarningCircle,
} from "@phosphor-icons/react";

import type { PrTimelineEvent } from "../../../../shared/types/prs";
import { COLORS, MONO_FONT, fgTint } from "../../lanes/laneDesignTokens";
import { relativeWhen } from "../../../lib/format";
import { PrAgentAvatar } from "./PrAgentAvatar";
import { describeBotGroup, digestPreview, type PrNeedsAttentionItem } from "../../../../shared/prConversationDigest";
import { PR_DESCRIPTION_BOT_EVENT_PREFIX } from "../../../../shared/prBodyBotSections";
import type { DigestRenderItem } from "./prDigestTimelineModel";

/* ══════════════════ Digest rows (Overview triage layout) ══════════════════ */

const ATTENTION_TONE = COLORS.warning;
/** Rows of the open list before "Show more": the block must never bury the thread. */
const ATTENTION_VISIBLE_ROWS = 6;

function countOf(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * Bot blocks split out of the PR body become synthetic bot comments. The PR
 * author wrote that text, so the UI must not show it as a real bot comment.
 */
function isPrDescriptionBotEvent(event: Pick<PrTimelineEvent, "id">): boolean {
  return event.id.startsWith(PR_DESCRIPTION_BOT_EVENT_PREFIX);
}

function DescriptionSourceNote() {
  return (
    <span
      data-testid="pr-digest-desc-bot-note"
      className="shrink-0 text-[11px]"
      style={{ color: COLORS.textDim }}
      title="This text is in the PR description. The PR author can edit it."
    >
      from the PR description
    </span>
  );
}

/**
 * State glyph for a review. Approved and changes-requested have fixed glyphs;
 * every other state uses the `fallback` glyph (chat bubble or eye).
 */
export function reviewStateIcon(state: string, size = 13, fallback: "chat" | "eye" = "chat"): ReactNode {
  if (state === "approved") return <CheckCircle size={size} weight="fill" style={{ color: COLORS.success }} />;
  if (state === "changes_requested") return <WarningCircle size={size} weight="fill" style={{ color: COLORS.danger }} />;
  const Fallback = fallback === "eye" ? Eye : ChatCircle;
  return <Fallback size={size} weight="bold" style={{ color: COLORS.textMuted }} />;
}

function commitUrl(owner: string, repo: string, sha: string): string {
  return `https://github.com/${owner}/${repo}/commit/${sha}`;
}

// Monospace short-SHA chip; the smallest visible unit of a commit identity.
// When a `url` is given it opens the commit on GitHub externally.
function ShortShaChip({ sha, url }: { sha: string; url?: string }) {
  const baseStyle = {
    color: COLORS.textDim,
    fontFamily: MONO_FONT,
    background: COLORS.recessedBg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 5,
    padding: "1px 5px",
  } as const;
  if (!url) {
    return <span className="shrink-0 text-[10px]" style={baseStyle}>{sha}</span>;
  }
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void window.ade.app.openExternal(url); }}
      className="shrink-0 text-[10px] hover:underline"
      style={{ ...baseStyle, cursor: "pointer" }}
    >
      {sha}
    </button>
  );
}

export function DigestRowShell({
  index,
  start,
  measure,
  dataAttr,
  children,
}: {
  index: number;
  start: number;
  measure: (node: HTMLElement | null) => void;
  dataAttr?: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={measure}
      data-index={index}
      data-digest-row={dataAttr ?? "block"}
      style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${start}px)`, paddingBottom: 10 }}
    >
      {children}
    </div>
  );
}

function threadLocation(path: string | null | undefined, line: number | null | undefined): string | null {
  if (!path) return null;
  const file = path.split("/").pop() ?? path;
  return line ? `${file}:${line}` : file;
}

export function NeedsAttentionBlock({
  item,
  onOpen,
  onFixInChat,
  onFixChecksInChat,
  onOpenChecks,
}: {
  item: Extract<DigestRenderItem, { kind: "attention" }>;
  onOpen: (eventId: string) => void;
  onFixInChat?: (item: PrNeedsAttentionItem) => void;
  /** Hands the failing checks to the chat. Omitted hides the button. */
  onFixChecksInChat?: () => void;
  onOpenChecks?: () => void;
}) {
  // One line by default: a reader opens a PR to see what is in it, so the
  // description stays on top of the page and this line says what waits.
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? item.items : item.items.slice(0, ATTENTION_VISIBLE_ROWS);
  const hidden = item.items.length - visible.length;
  const fromPeople = item.items.filter((entry) => !entry.identity.isBot).length;
  const summary = [
    item.failingChecks.length ? countOf(item.failingChecks.length, "check fails", "checks fail") : null,
    item.items.length
      ? `${countOf(item.items.length, "open thread", "open threads")}${fromPeople && fromPeople < item.items.length ? `, ${fromPeople} from people` : ""}`
      : null,
  ].filter(Boolean).join(" · ");
  return (
    <section
      data-testid="pr-digest-attention"
      aria-label="Needs you"
      className="relative overflow-hidden rounded-[10px]"
      style={{ background: `color-mix(in srgb, ${ATTENTION_TONE} ${open ? 6 : 5}%, transparent)` }}
    >
      <button
        type="button"
        data-testid="pr-digest-attention-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-fg/[0.03]"
        style={{ background: "transparent", border: "none", cursor: "pointer" }}
      >
        <WarningCircle size={13} weight="fill" style={{ color: ATTENTION_TONE, flexShrink: 0 }} />
        <span className="shrink-0 text-[12px] font-semibold" style={{ color: COLORS.textPrimary }}>Needs you</span>
        <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: COLORS.textSecondary }}>{summary}</span>
        <CaretRight
          size={12}
          weight="bold"
          className="shrink-0 transition-transform"
          style={{ color: COLORS.textMuted, transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        />
      </button>
      {open ? (
      <ul className="flex flex-col pb-1.5">
        {item.failingChecks.length > 0 ? (
          <li>
            <div
              data-testid="pr-digest-attention-checks"
              // A row that opens the Checks tab, where the host has one.
              {...(onOpenChecks ? {
                role: "button",
                tabIndex: 0,
                onClick: onOpenChecks,
                onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpenChecks();
                  }
                },
              } : {})}
              className={`group flex items-center gap-2.5 px-4 py-1.5 transition-colors ${onOpenChecks ? "cursor-pointer hover:bg-fg/[0.035]" : ""}`}
            >
              <XCircle size={16} weight="fill" style={{ color: COLORS.danger, flexShrink: 0 }} />
              <span className="shrink-0 text-[12px] font-medium" style={{ color: COLORS.textPrimary }}>
                {item.failingChecks.length === 1 ? "1 check fails" : `${item.failingChecks.length} checks fail`}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: COLORS.textSecondary }} title={item.failingChecks.join(", ")}>
                {item.failingChecks.join(", ")}
              </span>
              {onFixChecksInChat ? (
                <button
                  type="button"
                  data-testid="pr-digest-fix-checks-in-chat"
                  onClick={(event) => {
                    event.stopPropagation();
                    onFixChecksInChat();
                  }}
                  className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium opacity-80 transition-opacity group-hover:opacity-100"
                  style={{
                    color: COLORS.accent,
                    background: `color-mix(in srgb, ${COLORS.accent} 14%, transparent)`,
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  Fix in chat
                </button>
              ) : null}
            </div>
          </li>
        ) : null}
        {visible.map((entry) => {
          const where = threadLocation(entry.entry.path, entry.entry.line);
          return (
            <li key={entry.entry.id}>
              <div
                role="button"
                tabIndex={0}
                data-testid="pr-digest-attention-row"
                onClick={() => onOpen(entry.entry.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(entry.entry.id);
                  }
                }}
                className="group flex cursor-pointer items-center gap-2.5 px-4 py-1.5 transition-colors hover:bg-fg/[0.035]"
              >
                <PrAgentAvatar login={entry.entry.author} isBot={entry.identity.isBot} avatarUrl={entry.entry.avatarUrl} size={16} />
                <span className="shrink-0 text-[12px] font-medium" style={{ color: COLORS.textPrimary }}>
                  {entry.identity.displayName}
                </span>
                {where ? (
                  <span className="shrink-0 font-mono text-[11px]" style={{ color: COLORS.textMuted }} title={entry.entry.path ?? undefined}>
                    {where}
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: COLORS.textSecondary }}>
                  {digestPreview(entry.entry.body)}
                </span>
                {onFixInChat ? (
                  <button
                    type="button"
                    data-testid="pr-digest-fix-in-chat"
                    onClick={(event) => {
                      event.stopPropagation();
                      onFixInChat(entry);
                    }}
                    className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium opacity-80 transition-opacity group-hover:opacity-100"
                    style={{
                      color: COLORS.accent,
                      background: `color-mix(in srgb, ${COLORS.accent} 14%, transparent)`,
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    Fix in chat
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      ) : null}
      {open && hidden > 0 ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mb-2 ml-4 text-[11px] font-medium hover:underline"
          style={{ color: COLORS.textMuted, background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          Show {hidden} more
        </button>
      ) : null}
    </section>
  );
}

export function PushDivider({
  item,
  repoOwner,
  repoName,
}: {
  item: Extract<DigestRenderItem, { kind: "push" }>;
  repoOwner: string;
  repoName: string;
}) {
  const { push } = item;
  const url = repoOwner && repoName ? commitUrl(repoOwner, repoName, push.sha) : undefined;
  return (
    <div
      data-testid="pr-digest-push"
      id={`pr-timeline-${push.id}`}
      className="flex items-center gap-2 pt-3 text-[11px]"
      style={{ color: COLORS.textMuted }}
    >
      {push.forcePushed ? (
        <ArrowsClockwise size={12} weight="bold" style={{ flexShrink: 0 }} />
      ) : (
        <GitCommit size={13} weight="bold" style={{ flexShrink: 0 }} />
      )}
      <ShortShaChip sha={push.shortSha} url={url} />
      <span className="min-w-0 truncate" style={{ color: COLORS.textSecondary }} title={push.subject}>
        {push.subject.split("\n")[0]}
      </span>
      {push.commitCount > 1 ? <span className="shrink-0">· {push.commitCount} commits</span> : null}
      {push.forcePushed ? <span className="shrink-0">· force-pushed</span> : null}
      <span className="shrink-0">· {relativeWhen(push.at)}</span>
      {/* The rule only fills spare width; it never takes it from the subject. */}
      <span aria-hidden className="h-px min-w-0 flex-1" style={{ background: COLORS.borderMuted }} />
    </div>
  );
}

function entryStateIcon(event: PrTimelineEvent): ReactNode {
  if (event.type === "review_thread") {
    if (event.isOutdated) return <Clock size={12} weight="bold" style={{ color: COLORS.textDim }} />;
    if (event.isResolved) return <CheckCircle size={12} weight="fill" style={{ color: COLORS.checkPass }} />;
    return <WarningCircle size={12} weight="fill" style={{ color: ATTENTION_TONE }} />;
  }
  if (event.type === "review") return reviewStateIcon(event.state, 12, "eye");
  return <ChatCircle size={12} weight="bold" style={{ color: COLORS.textMuted }} />;
}

function entryLine(event: PrTimelineEvent): { where: string | null; text: string } {
  if (event.type === "review_thread") {
    return { where: threadLocation(event.path, event.line ?? event.originalLine), text: digestPreview(event.firstCommentBody ?? event.comments?.[0]?.body) };
  }
  if (event.type === "review") {
    const text = digestPreview(event.body);
    return { where: null, text: text || (event.state === "approved" ? "Approved" : "Reviewed") };
  }
  if (event.type === "issue_comment") return { where: null, text: digestPreview(event.body) || "Comment" };
  return { where: null, text: "" };
}

export function BotGroupRow({
  item,
  focusedEventId,
  onFocus,
  renderEntry,
}: {
  item: Extract<DigestRenderItem, { kind: "bot-group" }>;
  focusedEventId: string | null;
  onFocus: (id: string) => void;
  /** Full card for one open entry (the same card the thread uses). */
  renderEntry: (event: PrTimelineEvent) => ReactNode;
}) {
  const { group, events } = item;
  const containsFocused = focusedEventId != null && events.some((event) => event.id === focusedEventId);
  const [open, setOpen] = useState(false);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);
  // A jump from Needs attention or the rail opens the row and that one entry.
  useEffect(() => {
    if (!containsFocused) return;
    setOpen(true);
    setOpenEntryId(focusedEventId);
  }, [containsFocused, focusedEventId]);
  const expanded = open || containsFocused;
  const hasOpen = group.openThreadCount > 0;
  const allFromDescription = events.length > 0 && events.every(isPrDescriptionBotEvent);
  return (
    <div
      data-testid="pr-digest-bot-group"
      data-agent={group.key}
      className="rounded-[10px] transition-colors"
      style={{ background: expanded ? fgTint(3) : "transparent" }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-fg/[0.035]"
        style={{ background: "transparent", border: "none", cursor: "pointer" }}
      >
        <PrAgentAvatar login={group.identity.login} isBot avatarUrl={group.avatarUrl} size={20} />
        <span className="shrink-0 text-[12.5px] font-medium" style={{ color: COLORS.textPrimary }}>
          {group.identity.displayName}
        </span>
        {allFromDescription ? <DescriptionSourceNote /> : null}
        <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: hasOpen ? ATTENTION_TONE : COLORS.textMuted }}>
          {describeBotGroup(group)}
        </span>
        <span className="shrink-0 text-[11px]" style={{ color: COLORS.textDim }}>{relativeWhen(group.latestAt)}</span>
        <CaretRight
          size={12}
          weight="bold"
          className="shrink-0 transition-transform"
          style={{ color: COLORS.textMuted, transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
        />
      </button>
      {expanded ? (
        <ul className="flex flex-col gap-0.5 px-2 pb-2">
          {events.map((event) => {
            const line = entryLine(event);
            const entryOpen = openEntryId === event.id;
            return (
              <li key={event.id} id={`pr-timeline-${event.id}`} data-event-id={event.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpenEntryId(entryOpen ? null : event.id);
                    if (!entryOpen) onFocus(event.id);
                  }}
                  aria-expanded={entryOpen}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-fg/[0.04]"
                  style={{ background: "transparent", border: "none", cursor: "pointer" }}
                >
                  <span className="inline-flex shrink-0">{entryStateIcon(event)}</span>
                  {!allFromDescription && isPrDescriptionBotEvent(event) ? <DescriptionSourceNote /> : null}
                  {line.where ? (
                    <span className="shrink-0 font-mono text-[11px]" style={{ color: COLORS.textMuted }}>{line.where}</span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: COLORS.textSecondary }}>{line.text}</span>
                </button>
                {entryOpen ? <div className="px-1 pb-2 pt-1">{renderEntry(event)}</div> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
