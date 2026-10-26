import React, { useState } from "react";
import { useLiveDurationMs } from "../../lib/liveDuration";
import { CaretDown, CaretRight, Check, ListChecks, Square, Stop, X } from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { formatSubagentDurationMs } from "../../lib/format";
import { pluralCount } from "../../../shared/formatting";
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
import { deriveSubagentCardName, formatSubagentModelLabel, subagentSummaryPlainText } from "../../../shared/chatSubagents";
import { modelMentionEffortLabel } from "../../../shared/modelMentions";
import { formatContextTokens } from "./usage/contextUsageModel";
import {
  subagentCardGridSpan,
  type SubagentCardGridMember,
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
            "absolute -bottom-1 -right-1 flex items-center justify-center rounded-full ring-2 ring-[color:var(--color-bg,#0c0b10)]",
            status === "failed" ? "h-[16px] w-[16px]" : "h-[14px] w-[14px]",
            badge.className,
          )}
        >
          <badge.Icon size={status === "failed" ? 10 : 8} weight="bold" aria-hidden />
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
function SubagentProviderMark({ provider, size = 20 }: { provider?: string | null; size?: number }) {
  const normalized = provider?.trim();
  if (!normalized) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center"
      data-subagent-provider={normalized}
      title={providerDisplayLabel(normalized, normalized)}
    >
      <ToolLogo toolType={chatToolTypeForProvider(normalized)} size={size} className="block shrink-0 opacity-75" />
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

export const CARD_META_TEXT = "font-mono text-[length:calc(var(--chat-font-size)*10/14)] tabular-nums";
/** The card's status word and its one overview line. */
const SUBAGENT_OVERVIEW_TEXT = "font-sans text-[length:calc(var(--chat-font-size)*11/14)]";

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

/** The status word's tone: colour is for meaning, so only these four states differ. */
const SUBAGENT_STATUS_WORD_TONE: Record<SubagentCardStatus, string> = {
  running: "text-[color:var(--color-accent-bright,#C4B5FD)]",
  completed: "text-fg/40",
  failed: "text-rose-300/80",
  stopped: "text-amber-300/60",
};

/**
 * The one layout both subagent cards share — short, so a run of agents reads
 * as a list instead of a wall of paragraphs:
 * `[glyph] [name · status / one overview line] [metrics · provider · stop · open]`.
 * Anything the card does not need to say on its face (agent type, model,
 * effort, tool count, who spawned it) lives in `metaTitle`, the card's
 * tooltip. Fills its grid cell (`h-full`), so cards in one grid row are
 * equally tall.
 */
function SubagentCardFrame({
  agentKey,
  status,
  name,
  statusWord,
  overview,
  overviewTone = "quiet",
  metrics,
  metaTitle,
  action,
  provider,
  workflowName = null,
  open,
  openLabel,
  openTitle,
  testId,
}: {
  agentKey: string;
  status: SubagentCardStatus;
  name: string;
  /** Set on a dynamic workflow's own card: it wears the workflow mark and chip. */
  workflowName?: string | null;
  /** `running` / `done` / `failed` / `stopped` — the day the agent is having. */
  statusWord: string;
  /** The one line under the name: what it is doing, or what it found. */
  overview: string | null;
  overviewTone?: "quiet" | "crit";
  /** Right-aligned counts, mono: tools, tokens, elapsed. */
  metrics: string | null;
  /** The full quiet facts, shown on hover. */
  metaTitle: string;
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
      title={metaTitle}
      className={cn(
        "@container flex h-full w-full min-w-0 items-center gap-2.5 overflow-hidden text-left transition-colors",
        SUBAGENT_CARD_CHROME,
        open && "cursor-pointer",
      )}
    >
      {workflowName ? (
        <span
          aria-hidden
          data-subagent-workflow-mark={workflowName}
          className="grid h-[27px] w-[27px] shrink-0 place-items-center rounded-[9px] border border-amber-200/20 bg-amber-200/[0.08] text-amber-100/85"
        >
          <ListChecks size={14} weight="bold" />
        </span>
      ) : (
        <SubagentCardGlyph agentKey={agentKey} status={status} />
      )}
      {/* Line 1 is the name, edge to edge. Line 2 is who runs it and what it
          is doing, then the controls. State lives on the glyph (spinning ring,
          check, cross), so no status word competes with the name. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 truncate font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold",
              workflowName ? "text-amber-100/90" : "text-fg/85",
            )}
            title={name}
            data-subagent-name
          >
            {name}
          </span>
          {workflowName ? (
            <span className="shrink-0 rounded-sm bg-amber-200/[0.12] px-1 py-px font-sans text-[length:calc(var(--chat-font-size)*9.5/14)] uppercase tracking-[0.05em] text-amber-200/70">
              workflow
            </span>
          ) : null}
          <span className="sr-only">{statusWord}</span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
          <SubagentProviderMark provider={provider} size={14} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              SUBAGENT_OVERVIEW_TEXT,
              overviewTone === "crit" ? "text-rose-200/85" : "text-fg/50",
            )}
            data-subagent-overview
          >
            {overview ?? ""}
          </span>
          {metrics ? (
            <span
              className={cn(
                "hidden shrink-0 whitespace-nowrap @[17rem]:inline",
                CARD_META_TEXT,
                status === "failed" ? "text-rose-300/85" : "text-fg/40",
              )}
            >
              {metrics}
            </span>
          ) : null}
          {action}
          {open ? (
            <button
              type="button"
              onClick={open}
              aria-label={openLabel}
              title={openTitle}
              className="-my-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-fg/35 transition-colors hover:bg-fg/[0.06] hover:text-fg/75 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--chat-accent)]"
            >
              <CaretRight size={11} weight="bold" aria-hidden />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function subagentQuietMetadata(
  event: {
    spawnKind?: "subagent" | "peer" | null;
    provider?: string | null;
    agentType?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
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
  // Only what the agent reported: a parent's model or effort is not shown as the child's.
  const model = formatSubagentModelLabel(event.model);
  if (model) metadata.push(model);
  const effort = event.reasoningEffort?.trim();
  if (effort) metadata.push(modelMentionEffortLabel(effort));
  if (event.background) metadata.push("background");
  return metadata;
}

/**
 * Running card — one row anchored where the agent started, titled with the
 * agent's name (`deriveSubagentCardName`: the task description, else the
 * explicit label, else the agent type; a Codex path reads `Desktop scan`, never
 * `/root/desktop_scan`). Under the name ONE live line says what it is doing.
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
  /** Runtime that owns this agent; drives the quiet provider mark. */
  provider?: string | null;
}) {
  const isRunning = event.status === "running";
  const liveMs = useLiveDurationMs(event.startedAt, isRunning);
  const elapsed = formatSubagentDurationMs(liveMs);

  const workflowName = event.workflowName?.trim() || null;
  // A workflow card is named by the run's `meta.name`; the task description
  // becomes its one line.
  const name = workflowName ?? deriveSubagentCardName(event);
  // Suppress activity text that just echoes the name (e.g. name
  // "Run affected suites" + status "running · Run affected suites · 27s").
  const rawActivity = event.statusLine?.trim() || event.lastToolName?.trim() || null;
  const activity = rawActivity
    && ![name, event.description].some((title) => title && title.toLowerCase().includes(rawActivity.toLowerCase()))
    ? rawActivity
    : null;
  const tools = typeof event.toolCount === "number" && event.toolCount > 0
    ? `${event.toolCount} tool${event.toolCount === 1 ? "" : "s"}`
    : null;
  const metrics = [tools, elapsed].filter((part): part is string => Boolean(part)).join(" · ");
  const metaTitle = [
    name,
    "running",
    ...subagentQuietMetadata(event, provider),
    activity,
    tools,
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
      className="-my-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-fg/40 transition-colors hover:bg-rose-500/10 hover:text-rose-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-400/40"
    >
      <Square size={10} weight="fill" aria-hidden />
    </button>
  ) : null;

  return (
    <SubagentCardFrame
      agentKey={event.agentKey}
      status={event.status}
      name={name}
      statusWord="running"
      overview={activity ?? (workflowName ? event.description : null)}
      metrics={metrics || null}
      workflowName={workflowName}
      metaTitle={metaTitle}
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
 * place). Same short layout and chrome as the running card — the agent's name,
 * its glyph now wearing a status badge, one line of what it found (a failure
 * shows its own message in the error tone), and the counts on the right. The
 * full facts (type, model, effort, tools, worktree, the whole error) are the
 * card's tooltip; the card itself opens the spawned chat or the transcript.
 *
 * Runtime filler (`"Agent completed"`, an all-zero `+0 −0 · 0 files` diff stat)
 * is filtered out by {@link firstMeaningfulSummary}; a stopped agent names who
 * stopped it.
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
  /** Runtime that owns this agent; drives the quiet provider mark. */
  provider?: string | null;
}) {
  const isStopped = event.status === "stopped";
  const isFailed = event.status === "failed";
  const duration = formatSubagentDurationMs(event.durationMs);
  const workflowName = event.workflowName?.trim() || null;
  const name = workflowName ?? deriveSubagentCardName(event);
  // A stopped card's summary is usually just the stop sentence ("Interrupted",
  // "Stopped: the ADE brain restarted"), which the status word already says.
  // Reports are markdown; the one-line preview shows them as plain prose.
  const summary = subagentSummaryPlainText(
    firstMeaningfulSummary(isStopped ? meaningfulStoppedSummary(event) : event.summaryPreview),
  );
  const stopCause = isStopped
    ? (event.stopSource === "user" ? "you interrupted" : (event.stopReason?.trim() || null))
    : null;
  // Without a report of its own, a stopped card says what the agent was doing,
  // WHO stopped it and whether the work survived — a stopped card that only
  // says "stopped" hides the difference between an interrupt and a lost run.
  const stoppedOutcome = isStopped && !summary
    ? [
      subagentSummaryPlainText(event.lastActivity),
      stopCause,
      stoppedResultOutcome(event.resultLanded === true),
    ].filter((part): part is string => Boolean(part)).join(" · ")
    : null;
  const childSessionId = event.childSessionId?.trim() || null;
  const open = childSessionId
    ? () => navigateToSpawnedChat(childSessionId, laneId ?? null)
    : onViewTranscript ?? null;
  const errorText = isFailed ? event.error?.trim() || null : null;
  // A failed agent's message IS its card: its first line shows in the error
  // tone (`error` and the summary hold the same sentence for a failure, so the
  // summary is the fallback, never a second copy). The rest of the error rides
  // the tooltip.
  const errorHeadline = errorText ? (errorText.split(/\r?\n/, 1)[0] ?? "").trim() || null : null;
  const failureMessage = isFailed ? (errorHeadline ?? summary) : null;
  const statusWord = isStopped ? "stopped" : isFailed ? "failed" : "done";
  // A workflow card says what the run was for; "Dynamic workflow … completed"
  // is filler the status word already carries.
  const overview = failureMessage ?? (workflowName ? event.description : null) ?? summary ?? stoppedOutcome;
  const tokens = typeof event.totalTokens === "number" && event.totalTokens > 0
    ? formatContextTokens(event.totalTokens)
    : null;
  const tools = typeof event.toolUseCount === "number" && event.toolUseCount > 0
    ? `${event.toolUseCount} tool${event.toolUseCount === 1 ? "" : "s"}`
    : null;
  const worktreeLabel = event.worktreeBranch?.trim() || null;
  const metrics = [tokens, duration].filter((part): part is string => Boolean(part)).join(" · ");
  const metaTitle = [
    name,
    statusWord,
    ...subagentQuietMetadata(event, provider),
    stopCause,
    duration ? `ran for ${duration}` : null,
    tools,
    tokens ? `${tokens} tokens` : null,
    event.parentLabel ? `spawned by ${event.parentLabel}` : null,
    worktreeLabel ? `worktree ${event.worktreePath || worktreeLabel}` : null,
    errorText,
  ].filter((part): part is string => Boolean(part)).join(" · ");

  return (
    <SubagentCardFrame
      agentKey={event.agentKey}
      status={event.status}
      name={name}
      statusWord={statusWord}
      overview={overview}
      overviewTone={isFailed ? "crit" : "quiet"}
      metrics={metrics || null}
      metaTitle={metaTitle}
      provider={event.provider ?? provider}
      workflowName={workflowName}
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
 * The tally a run's header shows: how many agents are doing what, in the same
 * words the drawer's rows use (`running` / `done` / `failed` / `stopped`).
 */
export function subagentStatusTally(members: readonly { event: { status: SubagentCardStatus } }[]): {
  total: number;
  running: number;
  completed: number;
  failed: number;
  stopped: number;
} {
  const counts = { total: members.length, running: 0, completed: 0, failed: 0, stopped: 0 };
  for (const member of members) {
    const status = member.event.status;
    if (status === "running") counts.running += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "stopped") counts.stopped += 1;
    else counts.completed += 1;
  }
  return counts;
}

/** The `·`-separated status tally both run headers show, zeroes omitted. */
export function subagentStatusParts(counts: ReturnType<typeof subagentStatusTally>): Array<{ key: string; text: string; className: string }> {
  return [
    counts.running > 0
      ? { key: "running", text: `${counts.running} running`, className: SUBAGENT_STATUS_WORD_TONE.running }
      : null,
    counts.completed > 0 ? { key: "done", text: `${counts.completed} done`, className: "text-fg/45" } : null,
    counts.failed > 0 ? { key: "failed", text: `${counts.failed} failed`, className: "text-rose-300/80" } : null,
    counts.stopped > 0 ? { key: "stopped", text: `${counts.stopped} stopped`, className: "text-amber-300/60" } : null,
  ].filter((part): part is { key: string; text: string; className: string } => part !== null);
}
export const SUBAGENT_RUN_HEADER_TEXT = "font-sans text-[length:calc(var(--chat-font-size)*11.5/14)]";

/** An agent run this long earns a header; below it the cards read fine alone. */
export const SUBAGENT_RUN_HEADER_MIN = 4;
/** Identicons drawn in the header's stack before it stops and just counts. */
const SUBAGENT_RUN_HEADER_GLYPHS = 4;

/**
 * One quiet line over a run of agent cards: the stack of the agents' own
 * identicons, the count, and a `·`-separated tally of what each is doing —
 * the same rollup the background-job row (`BackgroundJobRunRow`) gives a run
 * of shell commands. A summary, not a control: no disclosure yet, so it never
 * promises a click it does not honour. The timeline's subagent renderer draws
 * it above a grid of `SUBAGENT_RUN_HEADER_MIN` or more agents; the grid itself
 * stays a layout primitive.
 */
export function SubagentRunHeader({ members }: { members: readonly SubagentCardGridMember[] }) {
  const counts = subagentStatusTally(members);
  const parts = subagentStatusParts(counts);

  return (
    <div
      data-subagent-run-header=""
      data-subagent-run-count={members.length}
      className="mb-1.5 flex min-w-0 items-center gap-2"
    >
      <span aria-hidden className="flex shrink-0 items-center">
        {members.slice(0, SUBAGENT_RUN_HEADER_GLYPHS).map((member, index) => (
          <span
            key={member.key}
            className={cn(
              "inline-flex items-center justify-center rounded-[4px] ring-2 ring-[color:var(--color-bg,#0c0b10)]",
              index > 0 && "-ml-1.5",
            )}
          >
            <ChatSubagentGlyph
              id={member.event.agentKey}
              color={chatSubagentColor(member.event.agentKey)}
              size={16}
            />
          </span>
        ))}
      </span>
      <span className={cn("min-w-0 truncate", SUBAGENT_RUN_HEADER_TEXT)} title={`${members.length} agents`}>
        <span className="text-fg/60">{pluralCount(members.length, "agent")}</span>
        {parts.map((part) => (
          <span key={part.key} className={part.className}> · {part.text}</span>
        ))}
      </span>
    </div>
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
 * no card remounts. Layout only: the run rollup above it is
 * `SubagentRunHeader`, drawn by the timeline's subagent renderer.
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
