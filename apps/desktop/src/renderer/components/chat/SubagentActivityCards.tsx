import React, { useEffect, useState } from "react";
import { CaretDown, CaretRight, Check, Square, Stop, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatSubagentDurationMs } from "../../lib/format";
import { chatToolTypeForProvider } from "../../lib/sessions";
import { ToolLogo } from "../terminals/ToolLogos";
import { providerDisplayLabel } from "../../../shared/pendingInputLabels";
import { ChatSubagentGlyph, chatSubagentColor } from "./chatSubagentIdentity";
import { navigateToSpawnedChat } from "./spawnNavigation";
import {
  CHAT_CARD_WIDTH_CLASS,
  ChatCard,
  ChatCardDetail,
  ChatCardDetailRow,
  ChatCardRow,
  ChatCardTitle,
  firstMeaningfulSummary,
} from "./chatCardPrimitives";
import { deriveSubagentCardName, subagentSummaryPlainText } from "../../../shared/chatSubagents";
import { formatContextTokens } from "./usage/contextUsageModel";
import {
  subagentCardGridSpan,
  type SubagentResultCardRenderEvent,
  type SubagentSpawnAnchorRenderEvent,
  type SubagentStoppedGroupEvent,
  type SubagentStoppedGroupItem,
  meaningfulStoppedSummary,
} from "./chatTranscriptRows";

// Re-exported for existing importers that reach it through this module.
export { navigateToSpawnedChat };

// ONE row per real subagent: the card is anchored where the agent started and
// settles in place (the collapse converts the spawn row into the result row).
// Running and settled cards share one frame and one chrome, so a grid of mixed
// states reads as one set of cards; only the glyph badge and the status line
// change. Background shell commands get no cards at all — just a compact row
// (`BackgroundJobRunRow`).

/**
 * Live elapsed since a start timestamp, ticking once a second while `running`.
 * The spawn card's live-duration ticker.
 *
 * Anchored to the real start timestamp rather than to mount time, so scrolling
 * the row out of the virtualizer and back keeps the true elapsed instead of
 * restarting from zero. Same shape as `useElapsedLabel` in `SessionStatusLabel`
 * — a state tick on a leaf that renders one line, so the per-second re-render
 * never reaches the memoized transcript rows around it. (`WorkingIndicator`'s
 * ticker is deliberately NOT this: it mutates `textContent` through a ref to
 * avoid a per-second commit on the message list itself.)
 *
 * Returns null for an absent or unparseable timestamp so callers render no
 * duration rather than `NaN`.
 */
function useLiveDurationMs(startedAt: string | null, running: boolean): number | null {
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const anchored = Number.isFinite(startMs) ? startMs : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running || anchored == null) return undefined;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, [running, anchored]);
  if (anchored == null) return null;
  return Math.max(0, nowMs - anchored);
}

type SubagentCardStatus =
  | SubagentSpawnAnchorRenderEvent["status"]
  | SubagentResultCardRenderEvent["status"];

/**
 * The agent's identicon with its state drawn on it: the spinning ring while it
 * runs, then a solid badge over the lower-right once it ends — green check for
 * finished, red X for failed, neutral square for stopped. The same mark sits in
 * the same seat on the running and the finished card, so a card that settles
 * changes its badge, not its layout.
 */
function SubagentCardGlyph({ agentKey, status }: { agentKey: string; status: SubagentCardStatus }) {
  const running = status === "running";
  const badge = running ? null : SUBAGENT_STATUS_BADGE[status];
  return (
    <span
      className="relative flex h-[27px] w-[27px] shrink-0 items-center justify-center"
      data-subagent-glyph-status={status}
    >
      <span className={cn("scale-[1.5]", !running && "opacity-70")}>
        <ChatSubagentGlyph id={agentKey} color={chatSubagentColor(agentKey)} status={running ? "running" : undefined} />
      </span>
      {badge ? (
        <span
          aria-label={badge.label}
          role="img"
          className={cn(
            "absolute -bottom-1 -right-1 flex h-[14px] w-[14px] items-center justify-center rounded-full ring-2 ring-[color:var(--color-bg,#0c0b10)]",
            badge.className,
          )}
        >
          <badge.Icon size={8} weight="bold" aria-hidden />
        </span>
      ) : null}
    </span>
  );
}

const SUBAGENT_STATUS_BADGE: Record<Exclude<SubagentCardStatus, "running">, {
  label: string;
  className: string;
  Icon: typeof Check;
}> = {
  completed: { label: "Finished", className: "bg-emerald-500 text-white", Icon: Check },
  failed: { label: "Failed", className: "bg-rose-500 text-white", Icon: X },
  stopped: { label: "Stopped", className: "bg-zinc-500 text-white", Icon: Square },
};

/**
 * Who is running this subagent, drawn as the same provider mark the Work
 * session rows use (bottom-right of the card, same 20px, same muted tone).
 *
 * A runtime-native subagent runs on the chat's own provider, so the mark is the
 * chat's. A spawned ADE chat can use a different provider; the caller resolves
 * that child's provider when it knows it and this only falls back for an
 * unknown/unresolved session. Renders nothing for a blank provider so a card
 * never grows an empty mark.
 */
function SubagentProviderMark({ provider }: { provider?: string | null }) {
  const normalized = provider?.trim();
  if (!normalized) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center"
      data-subagent-provider={normalized}
      title={providerDisplayLabel(normalized, normalized)}
    >
      <ToolLogo toolType={chatToolTypeForProvider(normalized)} size={20} className="block shrink-0 opacity-75" />
    </span>
  );
}

/**
 * The card container every subagent card wears, running or settled: border,
 * background, radius, and padding. The running card used to take a
 * `--chat-accent` tint that some chats resolve to nothing, which left it
 * frameless beside its framed, finished siblings.
 */
export const SUBAGENT_CARD_CHROME = "rounded-[calc(var(--chat-radius-card)-6px)] border border-fg/[0.07] bg-fg/[0.03] px-3.5 py-3 hover:border-fg/[0.12]";

const CARD_META_TEXT = "font-mono text-[length:calc(var(--chat-font-size)*10/14)] tabular-nums";
const QUIET_ACTION = "inline-flex items-center gap-1 whitespace-nowrap font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] text-fg/45 transition-colors hover:text-fg/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--chat-accent)]";

/**
 * A click anywhere on the card opens it, except on a control inside it and
 * except when the click ended a text selection (a reader copying the summary).
 */
function openOnCardClick(event: React.MouseEvent<HTMLElement>, open: (() => void) | null): void {
  if (!open) return;
  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest("button, a, input, textarea, select, [role='button']");
  if (control && control !== event.currentTarget) return;
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  if (selection && !selection.isCollapsed && selection.toString().trim()) return;
  open();
}

/**
 * The one layout both subagent cards share:
 * `[glyph + status] [name / status line / body] [open · stop | provider mark]`.
 * Fills its grid cell (`h-full`), so cards in one grid row are equally tall.
 */
function SubagentCardFrame({
  agentKey,
  status,
  name,
  statusLine,
  body,
  footer,
  action,
  provider,
  open,
  openLabel,
  openTitle,
  testId,
}: {
  agentKey: string;
  status: SubagentCardStatus;
  name: string;
  statusLine: string | null;
  body?: React.ReactNode;
  footer?: React.ReactNode;
  /** A control other than open (the running card's Stop). */
  action?: React.ReactNode;
  provider?: string | null;
  open: (() => void) | null;
  openLabel: string;
  openTitle: string;
  testId?: string;
}) {
  return (
    <div
      data-subagent-card={status === "running" ? "spawn" : "result"}
      data-subagent-status={status}
      data-testid={testId}
      onClick={open ? (event) => openOnCardClick(event, open) : undefined}
      className={cn(
        "flex h-full w-full min-w-0 items-stretch gap-3 overflow-hidden text-left transition-colors",
        SUBAGENT_CARD_CHROME,
        open && "cursor-pointer",
      )}
    >
      <SubagentCardGlyph agentKey={agentKey} status={status} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="min-w-0 flex-1 truncate font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-fg/85"
            title={name}
            data-subagent-name
          >
            {name}
          </span>
        </div>
        {statusLine ? (
          <div className={cn("mt-1 min-w-0 truncate text-fg/45", CARD_META_TEXT)} title={statusLine}>
            {statusLine}
          </div>
        ) : null}
        {body}
        {footer}
      </div>
      <div className="flex shrink-0 flex-col items-end justify-between gap-2">
        <div className="flex items-center gap-0.5">
          {action}
          {open ? (
            <button
              type="button"
              onClick={open}
              aria-label={openLabel}
              title={openTitle}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg/35 transition-colors hover:bg-fg/[0.06] hover:text-fg/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--chat-accent)]"
            >
              <CaretRight size={12} weight="bold" aria-hidden />
            </button>
          ) : null}
        </div>
        <SubagentProviderMark provider={provider} />
      </div>
    </div>
  );
}

function subagentQuietMetadata(
  event: {
    spawnKind?: "subagent" | "peer" | null;
    provider?: string | null;
    agentType?: string | null;
    background?: boolean;
  },
  provider?: string | null,
): string[] {
  const metadata: string[] = [];
  if (event.spawnKind) metadata.push(event.spawnKind);
  const resolvedProvider = event.provider?.trim() || provider?.trim() || "";
  if (resolvedProvider) metadata.push(providerDisplayLabel(resolvedProvider, resolvedProvider));
  const agentType = event.agentType?.trim() || "";
  if (agentType && !agentType.includes("/") && agentType.toLowerCase() !== resolvedProvider.toLowerCase()) {
    metadata.push(agentType.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase()));
  }
  if (event.background) metadata.push("background");
  return metadata;
}

/**
 * Running card — one row anchored where the agent started, titled with the
 * agent's name (`deriveSubagentCardName`: the task description, else the
 * explicit label, else the agent type; a Codex path reads `Desktop scan`, never
 * `/root/desktop_scan`). Under it ONE live status line
 * (`running · <activity> · <N> tools · <elapsed>`), ticking only while running.
 * Clicking the card opens the spawned chat, or the agent's transcript in Chat
 * Info for a runtime-native subagent; Stop ends a native one in place.
 */
export function SubagentSpawnCard({
  event,
  onStop,
  onOpenTranscript,
  laneId,
  provider,
}: {
  event: SubagentSpawnAnchorRenderEvent;
  onStop?: (taskId: string) => void;
  /** Opens a runtime-native agent's transcript; spawned chats navigate instead. */
  onOpenTranscript?: () => void;
  /** Lane of the spawner, forwarded to the navigation event when known. */
  laneId?: string | null;
  /** Runtime that owns this agent; drives the bottom-right provider mark. */
  provider?: string | null;
}) {
  const isRunning = event.status === "running";
  const liveMs = useLiveDurationMs(event.startedAt, isRunning);
  const elapsed = formatSubagentDurationMs(liveMs);

  const name = deriveSubagentCardName(event);
  // Suppress activity text that just echoes the name (e.g. name
  // "Run affected suites" + status "running · Run affected suites · 27s").
  const rawActivity = event.statusLine?.trim() || event.lastToolName?.trim() || null;
  const activity = rawActivity
    && ![name, event.description].some((title) => title && title.toLowerCase().includes(rawActivity.toLowerCase()))
    ? rawActivity
    : null;
  const statusLine = [
    "running",
    ...subagentQuietMetadata(event, provider),
    activity,
    typeof event.toolCount === "number" && event.toolCount > 0
      ? `${event.toolCount} tool${event.toolCount === 1 ? "" : "s"}`
      : null,
    elapsed,
    event.parentLabel ? `spawned by ${event.parentLabel}` : null,
  ].filter((part): part is string => Boolean(part)).join(" · ");

  const childSessionId = event.childSessionId?.trim() || null;
  const open = childSessionId
    ? () => navigateToSpawnedChat(childSessionId, laneId ?? null)
    : onOpenTranscript ?? null;
  const stopControl = onStop && event.taskId ? (
    <button
      type="button"
      aria-label={`Stop ${name}`}
      title="Stop this subagent"
      onClick={(clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        const taskId = event.taskId;
        if (!taskId) return;
        onStop(taskId);
      }}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg/40 transition-colors hover:bg-rose-500/10 hover:text-rose-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-400/40"
    >
      <Square size={10} weight="fill" aria-hidden />
    </button>
  ) : null;

  return (
    <SubagentCardFrame
      agentKey={event.agentKey}
      status={event.status}
      name={name}
      statusLine={statusLine || null}
      action={stopControl}
      provider={event.provider ?? provider}
      open={open}
      openLabel={childSessionId ? `Open ${name}` : `View ${name} transcript`}
      openTitle={childSessionId ? "Open the spawned chat" : "View transcript"}
    />
  );
}

/**
 * A settled agent's card, in the running card's place (the row settles in
 * place). Same layout and chrome as the running card — the agent's name, its glyph now wearing a status badge,
 * a `ran for 1m` line with counters, then the report (clamped to three lines).
 * The card opens the spawned chat or the transcript, like the running card, so
 * there is no separate "view transcript" link.
 *
 * Runtime filler (`"Agent completed"`, an all-zero `+0 −0 · 0 files` diff stat)
 * is filtered out by {@link firstMeaningfulSummary}. A failure keeps its full error behind a quiet
 * `Details` disclosure; a stopped agent names who stopped it.
 */
export function SubagentResultCard({
  event,
  laneId,
  onViewTranscript,
  provider,
}: {
  event: SubagentResultCardRenderEvent;
  laneId?: string | null;
  onViewTranscript?: () => void;
  /** Runtime that owns this agent; drives the bottom-right provider mark. */
  provider?: string | null;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isStopped = event.status === "stopped";
  const isFailed = event.status === "failed";
  const duration = formatSubagentDurationMs(event.durationMs);
  const name = deriveSubagentCardName(event);
  // A stopped card's summary is usually just the stop sentence ("Interrupted",
  // "Stopped: the ADE brain restarted"), which the status line already says.
  // Reports are markdown; the clamped preview shows them as plain prose.
  const summary = subagentSummaryPlainText(
    firstMeaningfulSummary(isStopped ? meaningfulStoppedSummary(event) : event.summaryPreview),
  );
  // Without a report of its own, a stopped card says what the agent was doing
  // and whether its work survived, so a grid cell is never an empty frame.
  const stoppedOutcome = isStopped && !summary
    ? [subagentSummaryPlainText(event.lastActivity), stoppedResultOutcome(event.resultLanded === true)]
      .filter((part): part is string => Boolean(part))
      .join(" · ")
    : null;
  const childSessionId = event.childSessionId?.trim() || null;
  const open = childSessionId
    ? () => navigateToSpawnedChat(childSessionId, laneId ?? null)
    : onViewTranscript ?? null;
  const errorText = isFailed ? event.error?.trim() || null : null;

  const stopCause = isStopped
    ? (event.stopSource === "user" ? "you interrupted" : (event.stopReason?.trim() || null))
    : null;
  const statusLine = [
    isStopped ? "stopped" : isFailed ? "failed" : null,
    ...subagentQuietMetadata(event, provider),
    stopCause,
    duration ? `ran for ${duration}` : null,
    typeof event.toolUseCount === "number" && event.toolUseCount > 0
      ? `${event.toolUseCount} tool${event.toolUseCount === 1 ? "" : "s"}`
      : null,
    typeof event.totalTokens === "number" && event.totalTokens > 0
      ? `${formatContextTokens(event.totalTokens)} tokens`
      : null,
    event.parentLabel ? `spawned by ${event.parentLabel}` : null,
  ].filter((part): part is string => Boolean(part)).join(" · ");

  const worktreeLabel = event.worktreeBranch?.trim() || null;
  const footer = errorText || worktreeLabel ? (
    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      {errorText ? (
        <button
          type="button"
          onClick={() => setDetailsOpen((value) => !value)}
          aria-expanded={detailsOpen}
          className={QUIET_ACTION}
        >
          {detailsOpen ? <CaretDown size={11} weight="bold" aria-hidden /> : <CaretRight size={11} weight="bold" aria-hidden />}
          Details
        </button>
      ) : null}
      {worktreeLabel ? (
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(event.worktreePath || worktreeLabel)}
          title={`Copy ${event.worktreePath || worktreeLabel}`}
          className={cn(QUIET_ACTION, "min-w-0 font-mono")}
        >
          <span className="truncate">worktree: {worktreeLabel}</span>
        </button>
      ) : null}
    </div>
  ) : null;

  return (
    <SubagentCardFrame
      agentKey={event.agentKey}
      status={event.status}
      name={name}
      statusLine={statusLine || null}
      body={(
        <>
          {summary ? (
            <div
              className="mt-1.5 line-clamp-3 whitespace-normal break-words text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/66"
              data-subagent-summary
            >
              {summary}
            </div>
          ) : null}
          {stoppedOutcome ? (
            <div
              className="mt-1.5 line-clamp-2 whitespace-normal break-words text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/50"
              data-subagent-stopped-outcome
            >
              {stoppedOutcome}
            </div>
          ) : null}
          {errorText && detailsOpen ? (
            <div className="mt-1.5 whitespace-pre-wrap break-words rounded-md border border-fg/[0.08] bg-fg/[0.04] px-2.5 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] leading-relaxed text-fg/62">
              {errorText}
            </div>
          ) : null}
        </>
      )}
      footer={footer}
      provider={event.provider ?? provider}
      open={open}
      openLabel={childSessionId ? `Open ${name}` : `View ${name} transcript`}
      openTitle={childSessionId ? "Open the spawned chat" : "View transcript"}
      testId={isStopped ? "subagent-stopped-card" : undefined}
    />
  );
}

/**
 * Per-card span classes for the card grid. The grid has six tracks (the least
 * common multiple of 1, 2, and 3 columns), and each card spans `6 / columns`
 * of them, except in a short last row, whose cards share the full width
 * equally (`subagentCardGridSpan`). Which column count applies comes from a
 * container query on the grid's own width, at the same breakpoints as
 * `subagentCardGridColumns` (two columns from 472px, three from 712px). The
 * class strings are literal so Tailwind can see them.
 */
const SPAN_ONE_COLUMN = "col-span-6";
const SPAN_AT_TWO_COLUMNS: Record<number, string> = {
  3: "@min-[472px]:col-span-3",
  6: "@min-[472px]:col-span-6",
};
const SPAN_AT_THREE_COLUMNS: Record<number, string> = {
  2: "@min-[712px]:col-span-2",
  3: "@min-[712px]:col-span-3",
  6: "@min-[712px]:col-span-6",
};

/** The span classes for card `index` of `count` at every column count. */
export function subagentCardGridCellClass(index: number, count: number): string {
  return cn(
    SPAN_ONE_COLUMN,
    SPAN_AT_TWO_COLUMNS[subagentCardGridSpan(index, count, 2)],
    SPAN_AT_THREE_COLUMNS[subagentCardGridSpan(index, count, 3)],
  );
}

/**
 * Consecutive subagent cards, running and settled alike, side by side
 * (`subagent_card_grid`). A lone card renders through this too, with one
 * member, so a card joining it keeps the first one mounted. Rows fill left to
 * right at up to three per row; a short last row stretches its cards to the
 * full width (5 cards: 3 on top, 2 wide below; 4: 3 + 1 full width; 7: 3 + 3
 * + 1). Full rows never reflow when a card joins, so a new spawn never moves
 * an earlier card. Cells stretch, so every card in a grid row is as tall as
 * the tallest. A count change only rewrites span classes on the keyed cells;
 * no card remounts.
 */
export function SubagentCardGrid<Member extends { key: string }>({
  members,
  renderCard,
}: {
  members: readonly Member[];
  renderCard: (member: Member) => React.ReactNode;
}) {
  return (
    <div
      data-subagent-card-grid=""
      data-subagent-card-count={members.length}
      className={cn(CHAT_CARD_WIDTH_CLASS, "@container grid grid-cols-6 items-stretch gap-2")}
    >
      {members.map((member, index) => (
        <div
          key={member.key}
          data-subagent-card-key={member.key}
          className={cn("flex min-w-0", subagentCardGridCellClass(index, members.length))}
        >
          {renderCard(member)}
        </div>
      ))}
    </div>
  );
}

/**
 * The fan-in cell: ONE card standing in for a run of subagents that all ended
 * for the same reason, instead of a wall of identical result cards.
 *
 * Head row is the count and the shared cause; each agent is a detail row inside
 * the same card, which is what keeps a mass stop (a dozen — or fifty — agents)
 * legible at a glance. Collapsible, expanded by default up to a handful of
 * agents. Never a red error block — neither an interrupt nor a usage limit is
 * something that broke.
 */
/**
 * The one sentence this card exists to get right.
 *
 * "N agents stopped when you interrupted" is reserved for `stopSource: "user"`.
 * An ADE brain restart, a sibling brain claiming the chat, and a provider that
 * ended the turn under the agents all used to render as the reader's own Stop
 * press, which is both false and the most annoying possible false thing for a
 * card to say. Anything that is not the user names itself instead.
 */
type StoppedAttributionEvent = Pick<SubagentStoppedGroupEvent, "stopSource" | "stopReason">;

function stoppedAttributionSuffix(event: StoppedAttributionEvent): string {
  if (event.stopSource === "user") return " when you interrupted";
  const reason = event.stopReason?.trim();
  return reason ? `: ${reason}` : "";
}

/** Status line for the individual card that represents one stopped agent. */
export function stoppedResultStatusLine(event: StoppedAttributionEvent): string {
  return event.stopSource === "user"
    ? "Stopped — interrupted"
    : `Stopped${stoppedAttributionSuffix(event)}`;
}

export function stoppedGroupHeadline(agents: string, event: SubagentStoppedGroupEvent): string {
  if (event.cause === "usage_limit") return `${agents} stopped · usage limit`;
  return `${agents} stopped${stoppedAttributionSuffix(event)}`;
}

/** Title plus what the agent was actually doing when it ended. */
export function stoppedGroupItemLabel(item: SubagentStoppedGroupItem, separator = " · "): string {
  // Titles and progress lines can be markdown; the one-line row shows plain text.
  const title = subagentSummaryPlainText(item.title) ?? item.title;
  const activity = subagentSummaryPlainText(item.lastActivity);
  return activity ? `${title}${separator}${activity}` : title;
}

/**
 * Whether this agent's work survived. A folded row that only says "stopped"
 * hides the difference between a report that had already landed and one that
 * was lost mid-flight — which is the whole question the reader has.
 */
export function stoppedGroupItemOutcome(item: SubagentStoppedGroupItem): string {
  return stoppedResultOutcome(item.resultLanded);
}

export function stoppedResultOutcome(resultLanded: boolean): string {
  return resultLanded ? "report landed" : "work lost";
}

export function SubagentStoppedGroupCard({
  event,
}: {
  event: SubagentStoppedGroupEvent;
}) {
  const count = event.count;
  const [expanded, setExpanded] = useState(count <= 6);
  const agents = `${count} ${count === 1 ? "agent" : "agents"}`;
  const headline = stoppedGroupHeadline(agents, event);

  return (
    <ChatCard skin="rail" tone="warn">
      <ChatCardRow
        tone="warn"
        icon={Stop}
        action={(
          <span className="text-amber-100/55">
            {expanded ? <CaretDown size={12} weight="bold" aria-hidden /> : <CaretRight size={12} weight="bold" aria-hidden />}
          </span>
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="min-w-0 text-left"
        >
          <ChatCardTitle className="text-amber-100/85">{headline}</ChatCardTitle>
        </button>
      </ChatCardRow>
      {expanded ? (
        <ChatCardDetail>
          {event.items.map((item) => (
            <ChatCardDetailRow
              key={item.agentKey}
              tone="idle"
              label={stoppedGroupItemLabel(item)}
              value={stoppedGroupItemOutcome(item)}
              title={stoppedGroupItemLabel(item, " — ")}
            />
          ))}
        </ChatCardDetail>
      ) : null}
    </ChatCard>
  );
}
