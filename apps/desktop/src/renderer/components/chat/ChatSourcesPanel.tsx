import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import { copyTextToClipboard } from "../../lib/launchPromptClipboard";
import { openLinkFromUi } from "../../lib/openExternal";
import {
  chatSourceGroup,
  chatSourceInitial,
  chatSourceSubtitle,
  type ChatSource,
  type ChatSourceGroup,
  type ChatSources,
} from "../../../shared/chatSources";
import { useSeenOnScreen, useSourceFavicon } from "./useSourceFavicon";
import { SectionHeader } from "./ChatSubagentsPanel";

const GROUP_ORDER: ReadonlyArray<{ group: ChatSourceGroup; label: string }> = [
  { group: "cited", label: "Cited" },
  { group: "web", label: "Web" },
  { group: "files", label: "Files" },
  { group: "apps", label: "Apps" },
];

/** Rows a group shows before "Show N more". */
export const SOURCES_GROUP_PREVIEW_ROWS = 3;

/**
 * The site's favicon, or the domain's (or file name's) first letter until one
 * arrives and whenever there is none. Icons come from the brain's first-party
 * fetch (`useSourceFavicon`) as data URLs, requested only once the icon is on
 * screen; an icon that fails to decode falls back to the letter.
 */
export function ChatSourceIcon({ source, size = 16 }: { source: ChatSource; size?: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const seen = useSeenOnScreen(ref);
  const favicon = useSourceFavicon(source.domain, seen);
  const [broken, setBroken] = useState<string | null>(null);
  const showFavicon = Boolean(favicon) && favicon !== broken;
  return (
    <span
      ref={ref}
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.55) }}
      className={
        showFavicon
          ? "flex shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
          : "flex shrink-0 items-center justify-center rounded-[4px] border border-white/[0.07] bg-white/[0.04] font-sans font-semibold leading-none text-fg/55"
      }
      data-testid="chat-source-icon"
    >
      {showFavicon ? (
        <img
          src={favicon!}
          alt=""
          draggable={false}
          onError={() => setBroken(favicon)}
          className="h-full w-full object-contain"
        />
      ) : (
        chatSourceInitial(source)
      )}
    </span>
  );
}

function CopyLinkButton({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy link"
      title={copied ? "Copied" : "Copy link"}
      onClick={() => {
        void copyTextToClipboard(link).then((ok) => setCopied(ok));
      }}
      onMouseLeave={() => setCopied(false)}
      className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg/40 opacity-0 transition-opacity hover:bg-white/[0.06] hover:text-fg/80 focus-visible:opacity-100 group-hover:opacity-100"
      data-testid="chat-source-copy"
    >
      {copied ? <Check size={11} weight="bold" aria-hidden /> : <Copy size={11} aria-hidden />}
    </button>
  );
}

/**
 * One row: favicon, one-line title, and the domain muted beside it (a file
 * path or an app's actions go on a quiet second line). Click opens the link;
 * hovering shows a copy button. A title that already names its domain gets no
 * separate domain, so a page is never printed twice.
 */
function SourceRow({ source }: { source: ChatSource }) {
  const subtitle = chatSourceSubtitle(source);
  const inline = Boolean(source.domain);
  const link = source.url ?? source.path ?? null;
  const tooltip = [source.url ?? source.path, source.queries.length ? `Search: ${source.queries.join(" · ")}` : null]
    .filter(Boolean)
    .join("\n");
  const body = (
    <>
      <ChatSourceIcon source={source} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="min-w-0 truncate font-sans text-[12px] font-medium text-fg/82">{source.title}</span>
          {inline && subtitle ? (
            <span className="max-w-[45%] shrink-0 truncate font-sans text-[10.5px] text-muted-fg/45">{subtitle}</span>
          ) : null}
          {source.cited ? (
            <span
              className="shrink-0 rounded-[3px] border border-cyan-300/20 px-1 font-sans text-[9px] font-semibold uppercase leading-[14px] tracking-[0.06em] text-cyan-200/65"
              data-testid="chat-source-cited"
            >
              cited
            </span>
          ) : null}
        </span>
        {!inline && subtitle ? (
          <span className="block truncate font-sans text-[10.5px] leading-4 text-muted-fg/45">{subtitle}</span>
        ) : null}
      </span>
    </>
  );
  const bodyClass = "flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left";
  return (
    <div
      className="group flex min-w-0 items-center rounded-md transition-colors hover:bg-white/[0.035]"
      data-testid="chat-source-row"
    >
      {source.url ? (
        <button
          type="button"
          className={bodyClass}
          title={tooltip || undefined}
          onClick={(event) => openLinkFromUi(source.url, event)}
        >
          {body}
        </button>
      ) : (
        <div className={bodyClass} title={tooltip || undefined}>
          {body}
        </div>
      )}
      {link ? <CopyLinkButton link={link} /> : null}
    </div>
  );
}

function SourceGroup({
  label,
  group,
  items,
  expanded,
  onToggle,
}: {
  label: string;
  group: ChatSourceGroup;
  items: ChatSource[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const hidden = items.length - SOURCES_GROUP_PREVIEW_ROWS;
  const visible = expanded || hidden <= 0 ? items : items.slice(0, SOURCES_GROUP_PREVIEW_ROWS);
  return (
    <div data-testid={`chat-sources-group-${group}`}>
      <div className="mb-0.5 flex items-center gap-1.5 px-1.5 font-sans text-[10px] font-semibold uppercase tracking-[0.08em] text-fg/35">
        <span>{label}</span>
        <span className="font-mono font-normal text-fg/25">{items.length}</span>
      </div>
      {visible.map((source) => <SourceRow key={source.id} source={source} />)}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="ml-[30px] mt-0.5 rounded px-1 py-0.5 font-sans text-[10.5px] text-fg/45 transition-colors hover:bg-white/[0.04] hover:text-fg/75"
          data-testid={`chat-sources-toggle-${group}`}
        >
          {expanded ? "Show less" : `Show ${hidden} more`}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The drawer's Sources section, for every provider: what the chat drew on,
 * grouped Cited → Web → Files → Apps (each source in exactly one group). A
 * group shows its first three rows and a "Show N more" toggle. Renders `null`
 * when there is nothing — the drawer owns scrolling, borders, and the empty
 * state.
 *
 * `turnId` narrows the list to one turn (the thread's "N sources" chip opens it
 * that way); `onShowAll` clears that filter.
 */
export function ChatSourcesPanel({
  sources,
  turnId = null,
  onShowAll,
}: {
  sources: ChatSources;
  turnId?: string | null;
  onShowAll?: () => void;
}) {
  const turnSources = turnId ? sources.byTurn.get(turnId) ?? null : null;
  const list = turnSources ?? sources.sources;
  const rootRef = useRef<HTMLElement | null>(null);
  // Expanded groups, per view: the whole chat and each turn keep their own.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const viewKey = turnSources ? `turn:${turnId}` : "all";
  const [collapsed, setCollapsed] = useState(false);

  // Opened from a turn's chip: bring the section into view inside the drawer.
  useEffect(() => {
    if (turnSources) rootRef.current?.scrollIntoView?.({ block: "start" });
  }, [turnId, turnSources]);

  if (list.length === 0) return null;
  const grouped = new Map<ChatSourceGroup, ChatSource[]>();
  for (const source of list) {
    const group = chatSourceGroup(source);
    const bucket = grouped.get(group);
    if (bucket) bucket.push(source);
    else grouped.set(group, [source]);
  }

  return (
    <section ref={rootRef} className="pb-3" data-testid="chat-sources-panel">
      <SectionHeader
        label="Sources"
        hint={String(list.length)}
        tone="sources"
        emphasized
        sticky
        collapsible
        collapsed={collapsed}
        onToggle={() => setCollapsed((current) => !current)}
        action={turnSources ? (
          <button
            type="button"
            onClick={onShowAll}
            className="rounded px-1.5 py-0.5 font-sans text-[10.5px] text-fg/45 transition-colors hover:bg-white/[0.04] hover:text-fg/75"
            data-testid="chat-sources-show-all"
          >
            This turn · Show all
          </button>
        ) : undefined}
      />
      {collapsed ? null : (
      <div className="mt-1 space-y-3 px-4">
        {GROUP_ORDER.map(({ group, label }) => {
          const items = grouped.get(group);
          if (!items?.length) return null;
          const key = `${viewKey}:${group}`;
          return (
            <SourceGroup
              key={group}
              label={label}
              group={group}
              items={items}
              expanded={expanded.has(key)}
              onToggle={() => setExpanded((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })}
            />
          );
        })}
      </div>
      )}
    </section>
  );
}
