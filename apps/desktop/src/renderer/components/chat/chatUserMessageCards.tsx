import { useState } from "react";
import { ChatTeardropText } from "@phosphor-icons/react";
import {
  splitChatOutputContextSegments,
  type ChatOutputContextSegment,
} from "../../../shared/chatOutputContext";
import { threadReviewCountLabel, type ParsedThreadReviewComment } from "../../../shared/threadComments";
import { cn } from "../ui/cn";
import { ChipText } from "./ChipText";
import { MarkdownBlock } from "./chatMarkdownBlock";
import type { WorkspacePathLocation } from "./chatWorkspacePaths";

/*
 * How a user's own message reads back in the transcript: markdown detection,
 * "Add to chat" quote cards, and the card for thread comments a send carried.
 */

const MARKDOWN_HEADING_LINE = /^#{1,6}\s+\S/m;
const MARKDOWN_FENCE_LINE = /^\s*(```|~~~)/m;
const MARKDOWN_LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\S/gm;

/**
 * True when a user message is a markdown DOCUMENT (a handoff brief, a pasted
 * spec), not a chat line that happens to contain an asterisk. Such a message
 * renders as formatted markdown; everything else keeps its exact text.
 */
export function userTextLooksLikeMarkdown(text: string): boolean {
  if (text.length < 80) return false;
  if (MARKDOWN_HEADING_LINE.test(text) || MARKDOWN_FENCE_LINE.test(text)) return true;
  return (text.match(MARKDOWN_LIST_LINE)?.length ?? 0) >= 3;
}

/**
 * A quote the user pulled from an agent reply with "Add to chat", shown as a
 * quote card rather than an opaque chip, so the sent message reads as
 * "about this: my reply". Long quotes clamp to a few lines and open on click.
 */
function ChatOutputContextQuoteCard({ quote }: { quote: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = quote.length > 240 || quote.split("\n").length > 4;
  return (
    <div
      className="my-1 flex min-w-0 gap-2 rounded-md bg-[color:color-mix(in_srgb,var(--chat-accent)_8%,transparent)] py-1.5 pl-2 pr-2.5 font-sans"
      data-testid="user-message-chat-context-chip"
      title={long && !expanded ? quote : undefined}
    >
      <span aria-hidden className="w-[3px] shrink-0 self-stretch rounded-full bg-[var(--chat-accent)] opacity-70" />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "whitespace-pre-wrap break-words text-[length:calc(var(--chat-font-size)*12.5/14)] italic leading-[1.55] text-white/70",
            long && !expanded && "line-clamp-4",
          )}
        >
          {quote}
        </div>
        {long ? (
          <button
            type="button"
            className="mt-0.5 text-[length:calc(var(--chat-font-size)*10.5/14)] text-[color:color-mix(in_srgb,var(--chat-accent)_70%,white)] hover:underline"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Show less" : "Show all"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Prose with "Add to chat" quotes in it: each quote as a card, the text
 * between them as typed. The cards are blocks, so the blank lines the
 * composer put around each quote are dropped instead of drawn as empty rows.
 */
export function ChatContextSegments({ segments }: { segments: ChatOutputContextSegment[] }) {
  return (
    <>
      {segments.map((segment, idx) => {
        if (segment.kind === "context") return <ChatOutputContextQuoteCard key={`chat-context-${idx}`} quote={segment.quote} />;
        const text = segment.text.replace(/^\s*\n/, "").replace(/\n\s*$/, "");
        // Each run sits between block cards, so a block of its own reads the
        // same, and its chips (an attached browser tab) still draw as pills.
        return text.trim() ? <ChipText key={`chat-text-${idx}`} text={text} /> : null;
      })}
    </>
  );
}

/** What the user typed, with any "Add to chat" quotes shown as quote cards. */
export function UserTypedText({
  text,
  onOpenWorkspacePath,
}: {
  text: string;
  onOpenWorkspacePath?: (path: string | WorkspacePathLocation) => void;
}) {
  const segments = splitChatOutputContextSegments(text);
  if (!segments.some((segment) => segment.kind === "context")) {
    return userTextLooksLikeMarkdown(text) ? (
      <MarkdownBlock markdown={text} tone="bubble" onOpenWorkspacePath={onOpenWorkspacePath} />
    ) : (
      <ChipText className="whitespace-pre-wrap break-words text-[length:var(--chat-font-size)] leading-[1.7] text-white" text={text} />
    );
  }
  return (
    <div className="whitespace-pre-wrap break-words text-[length:var(--chat-font-size)] leading-[1.7] text-white">
      <ChatContextSegments segments={segments} />
    </div>
  );
}

/**
 * The thread comments a send carried, as the user sees them in their own
 * message: each quote with its note. The raw review block stays in `text`
 * for the agent; this is only how it reads back.
 */
export function ThreadReviewSentCard({ comments }: { comments: ParsedThreadReviewComment[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? comments : comments.slice(0, 3);
  return (
    <div className="min-w-0 rounded-md bg-black/15 px-2.5 py-2 font-sans" data-testid="user-message-thread-review">
      <div className="mb-1.5 flex items-center gap-1.5 text-[length:calc(var(--chat-font-size)*11/14)] font-semibold text-[color:color-mix(in_srgb,var(--chat-accent)_55%,white)]">
        <ChatTeardropText size={13} weight="fill" aria-hidden />
        {threadReviewCountLabel(comments.length)}
      </div>
      <ol className="flex flex-col gap-2">
        {shown.map((comment) => (
          <li key={comment.n} className="flex min-w-0 gap-2">
            <span aria-hidden className="w-[3px] shrink-0 self-stretch rounded-full bg-[var(--chat-accent)] opacity-60" />
            <div className="min-w-0 flex-1">
              <div className="line-clamp-2 text-[length:calc(var(--chat-font-size)*11.5/14)] italic leading-[1.5] text-white/55" title={comment.quote}>
                {comment.quote}
              </div>
              <div className="whitespace-pre-wrap break-words text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.55] text-white/90">
                {comment.note}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {comments.length > 3 ? (
        <button
          type="button"
          className="mt-1.5 text-[length:calc(var(--chat-font-size)*10.5/14)] text-[color:color-mix(in_srgb,var(--chat-accent)_70%,white)] hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : `Show all ${comments.length}`}
        </button>
      ) : null}
    </div>
  );
}
