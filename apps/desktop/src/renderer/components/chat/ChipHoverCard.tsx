// Hover cards for transcript chips.
//
// A chip is a POINTER (see `shared/chips.ts`) — deliberately compact, so `#1237`
// tells you nothing about what PR that is without leaving the conversation.
// These cards answer the one question a pointer provokes, in place: what is
// this, and is it still open.
//
// Deliberate constraints:
//
//   - **Never steals focus.** The card is a `pointer-events-none` portal with
//     `role="tooltip"`, not a popover. Nothing inside it is focusable, so the
//     caret stays in the composer and a hover cannot swallow the next keystroke.
//     That is also why this does not use Radix `Popover`, which moves focus into
//     its content by design.
//   - **Placement is the repo's tested module.** `computeTooltipPosition` —
//     flip-before-shift, never over the trigger — the same one the pane and
//     smart tooltips use.
//   - **Degrades to nothing.** No lane, no session row, no PR record, no
//     network: the card simply does not appear. There is no error state for a
//     hover.
//   - **Reads, never fetches, except for PRs.** Lanes, chats, and Linear issues
//     already live in app state. PRs go through `listPrsCoalesced`, the same
//     coalesced reader the composer's `#` suggestions use, and only once the
//     user has actually hovered.
//   - **The CHAT's machine, not the tab's.** A lane id is unique per machine,
//     not globally, so resolving one against the project tab's lane list can
//     match a DIFFERENT lane that happens to share the id — and then print its
//     name and branch. A chat pinned to a remote machine must read that
//     machine's lanes, sessions and PRs, which is what `useChatRuntimeScope()`
//     plus `useLanesForPin` / `useMachineEntryForBinding` resolve. Nothing here
//     touches a global store read.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { Chip } from "../../../shared/chips";
import type {
  LaneSummary,
  OpenProjectBinding,
  PrState,
  TerminalSessionSummary,
} from "../../../shared/types";
import { listPrsCoalesced } from "../../lib/prReadCache";
import { relativeWhen } from "../../lib/format";
import { useLanesForPin, useMachineEntryForBinding } from "../../state/crossMachineLanes";
import { computeTooltipPosition, type TooltipPlacement } from "../ui/tooltipPosition";
import { useChatRuntimeScope } from "./ChatRuntimeScope";

/** Everything a card may read, all of it belonging to the CHAT's machine. */
export type ChipCardSources = {
  lanes: LaneSummary[];
  sessions: TerminalSessionSummary[];
  /** Pin for pin-aware preload calls. Null = the chat runs on the tab's binding. */
  pin: OpenProjectBinding | null;
  /**
   * The chat's project root. Only used to KEY the coalesced PR read: with no
   * pin, `projectKey` falls back to the literal `"active"`, which every project
   * shares, so a read still in flight when the user switches projects would be
   * joined by the new project and answered with the old one's rows.
   */
  rootPath: string | null;
};

const EMPTY_LANES: LaneSummary[] = [];
const EMPTY_SESSIONS: TerminalSessionSummary[] = [];

/** Long enough that skimming a message never flashes cards; short enough to feel attached. */
const HOVER_DELAY_MS = 360;
const GAP = 6;
const VIEWPORT_PAD = 10;

export type ChipCardData =
  | { kind: "pr"; number: number; title: string | null; state: PrState; repo: string | null }
  | { kind: "lane"; name: string; branch: string | null }
  | { kind: "chat"; title: string; lastActivity: string | null }
  | { kind: "linear"; identifier: string; title: string };

type ChipCardTarget =
  | { kind: "pr"; number: number; owner: string | null; repo: string | null }
  | { kind: "lane"; laneId: string }
  | { kind: "chat"; sessionId: string }
  | { kind: "linear"; identifier: string };

function githubPullTarget(url: string): ChipCardTarget | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { kind: "pr", number: Number(match[3]), owner: match[1]!, repo: match[2]!.replace(/\.git$/i, "") };
  } catch {
    return null;
  }
}

/** What entity this chip points at, or null when no card kind covers it. */
export function chipCardTarget(chip: Chip): ChipCardTarget | null {
  const source = chip.source;
  switch (chip.kind) {
    case "pr":
      if (source.origin === "deeplink" && source.target.kind === "pr") {
        return {
          kind: "pr",
          number: source.target.prNumber,
          owner: source.target.repoOwner ?? null,
          repo: source.target.repoName ?? null,
        };
      }
      return source.origin === "url" ? githubPullTarget(source.url) : null;
    case "lane":
      if (source.origin === "deeplink" && source.target.kind === "lane") {
        return { kind: "lane", laneId: source.target.laneId };
      }
      return source.origin === "mention" && source.mentionKind === "lane"
        ? { kind: "lane", laneId: source.id }
        : null;
    case "chat":
      if (source.origin === "deeplink" && source.target.kind === "session") {
        return { kind: "chat", sessionId: source.target.sessionId };
      }
      return source.origin === "mention" && source.mentionKind === "chat"
        ? { kind: "chat", sessionId: source.id }
        : null;
    case "linear_issue":
      return chip.label.trim() ? { kind: "linear", identifier: chip.label.trim().toUpperCase() } : null;
    default:
      return null;
  }
}

/** Linear titles ADE already knows locally, from lanes that link the issue. */
function linearTitleFromLanes(lanes: LaneSummary[], identifier: string): string | null {
  for (const lane of lanes) {
    if (lane.linearIssue?.identifier?.toUpperCase() === identifier) return lane.linearIssue.title || null;
    for (const link of lane.linearIssueLinks ?? []) {
      if (link.issue?.identifier?.toUpperCase() === identifier) return link.issue.title || null;
    }
  }
  return null;
}

/**
 * Resolve one card's contents. `previewTitle` is the already-fetched smart-link
 * title for the same chip, so a Linear issue nobody has linked to a lane still
 * has something to show without a second round trip.
 */
export async function loadChipCardData(
  sources: ChipCardSources,
  target: ChipCardTarget,
  previewTitle: string | null,
): Promise<ChipCardData | null> {
  if (target.kind === "lane") {
    const lane = sources.lanes.find((candidate) => candidate.id === target.laneId);
    return lane ? { kind: "lane", name: lane.name, branch: lane.branchRef || null } : null;
  }
  if (target.kind === "chat") {
    const session = sources.sessions.find((candidate) => candidate.id === target.sessionId);
    if (!session) return null;
    return {
      kind: "chat",
      title: session.title || session.goal || "Untitled chat",
      lastActivity: session.lastActivityAt || session.endedAt || session.startedAt || null,
    };
  }
  if (target.kind === "linear") {
    const title = linearTitleFromLanes(sources.lanes, target.identifier) ?? previewTitle;
    return title ? { kind: "linear", identifier: target.identifier, title } : null;
  }

  // Pinned so the read lands on the chat's machine: a PR row lives in the
  // `.ade` database of the machine that owns its lane, and an unpinned read
  // would query the project tab's machine for a row it does not have.
  const prs = await listPrsCoalesced({ pin: sources.pin, projectRoot: sources.rootPath })
    .catch(() => [] as Awaited<ReturnType<typeof listPrsCoalesced>>);
  const match = prs.find((pr) => {
    if (pr.githubPrNumber !== target.number) return false;
    if (!target.owner || !target.repo) return true;
    return pr.repoOwner?.toLowerCase() === target.owner.toLowerCase()
      && pr.repoName?.toLowerCase() === target.repo.toLowerCase();
  });
  if (!match) return null;
  return {
    kind: "pr",
    number: match.githubPrNumber,
    title: match.title || null,
    state: match.state,
    repo: match.repoOwner && match.repoName ? `${match.repoOwner}/${match.repoName}` : null,
  };
}

const PR_STATE_DOT: Record<PrState, string> = {
  draft: "bg-white/40",
  open: "bg-emerald-400",
  merged: "bg-violet-400",
  closed: "bg-rose-400",
};

function ChipCardBody({ data }: { data: ChipCardData }) {
  if (data.kind === "pr") {
    return (
      <>
        <div className="flex items-center gap-1.5 text-[11px] text-white/60">
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${PR_STATE_DOT[data.state]}`} />
          <span className="font-medium text-white/85">#{data.number}</span>
          <span className="capitalize">{data.state}</span>
          {data.repo ? <span className="truncate">· {data.repo}</span> : null}
        </div>
        {data.title ? <div className="mt-1 line-clamp-2 text-[12px] text-white/90">{data.title}</div> : null}
      </>
    );
  }
  if (data.kind === "lane") {
    return (
      <>
        <div className="truncate text-[12px] font-medium text-white/90">{data.name}</div>
        {data.branch ? <div className="mt-0.5 truncate font-mono text-[11px] text-white/55">{data.branch}</div> : null}
      </>
    );
  }
  if (data.kind === "chat") {
    return (
      <>
        <div className="line-clamp-2 text-[12px] font-medium text-white/90">{data.title}</div>
        {data.lastActivity
          ? <div className="mt-0.5 text-[11px] text-white/55">Last activity {relativeWhen(data.lastActivity)}</div>
          : null}
      </>
    );
  }
  return (
    <>
      <div className="text-[11px] font-medium text-white/60">{data.identifier}</div>
      <div className="mt-0.5 line-clamp-2 text-[12px] text-white/90">{data.title}</div>
    </>
  );
}

export type ChipHoverCard = {
  /** True when this chip has a card kind at all — drives the native-title swap. */
  supported: boolean;
  /** True while the card is on screen. */
  visible: boolean;
  triggerRef: (node: HTMLElement | null) => void;
  /** Spread onto the chip element; all passive, none of them focus-moving. */
  triggerProps: {
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
    onFocus?: () => void;
    onBlur?: () => void;
    "aria-describedby"?: string;
  };
  /** Portal node. Render it as a sibling of the chip; it is out of flow. */
  card: ReactNode;
};

/**
 * Hover-card behavior for one chip, returned as props to spread rather than a
 * wrapper element: a chip lives inline in flowing prose, and wrapping it in a
 * positioned box would change how the sentence wraps around it.
 */
export function useChipHoverCard(chip: Chip, previewTitle: string | null): ChipHoverCard {
  const cardId = useId();
  // The machine this CHAT runs on. `AgentChatMessageList` sits under
  // `ChatRuntimeScopeProvider`, exactly like `UserMessageIssueContext` next
  // door, so the scope is already the right answer here — no prop drilling and,
  // crucially, no global store read of the project tab's lanes.
  const scope = useChatRuntimeScope();
  const machine = useMachineEntryForBinding(scope.binding);
  const scopedLanes = useLanesForPin(scope.binding);
  // Held in a ref, not in the effect's deps: a lane-status refresh replaces
  // these arrays constantly, and depending on them would reload an open card on
  // every tick. This is the ref form the chat-scope lint rule sanctions.
  const sourcesRef = useRef<ChipCardSources>({ lanes: EMPTY_LANES, sessions: EMPTY_SESSIONS, pin: null, rootPath: null });
  sourcesRef.current = {
    lanes: scopedLanes ?? EMPTY_LANES,
    sessions: machine?.sessions ?? EMPTY_SESSIONS,
    pin: scope.pin,
    rootPath: scope.rootPath,
  };
  // A stable key, so re-pinning the chat reloads an open card without the
  // binding object's identity churn doing it on every merge.
  const pinKey = scope.pin?.key ?? null;

  // `chip` is stable per message (memoized parse), so a PR chip parses its
  // GitHub URL once rather than on every re-render of the transcript.
  const target = useMemo(() => chipCardTarget(chip), [chip]);
  const supported = target !== null;

  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ChipCardData | null>(null);
  const [coords, setCoords] = useState<TooltipPlacement | null>(null);
  const triggerElementRef = useRef<HTMLElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current === null) return;
    clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  const close = useCallback(() => {
    clearShowTimer();
    setOpen(false);
    setCoords(null);
  }, [clearShowTimer]);

  const openNow = useCallback(() => {
    clearShowTimer();
    setOpen(true);
  }, [clearShowTimer]);

  const openAfterDelay = useCallback(() => {
    clearShowTimer();
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null;
      setOpen(true);
    }, HOVER_DELAY_MS);
  }, [clearShowTimer]);

  useEffect(() => clearShowTimer, [clearShowTimer]);

  // Load on demand. Two hundred chips in a transcript must cost zero reads
  // until one of them is actually hovered.
  useEffect(() => {
    if (!open || !target) return;
    let cancelled = false;
    void loadChipCardData(sourcesRef.current, target, previewTitle)
      .catch(() => null)
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, [open, target, previewTitle, pinKey]);

  // Escape dismisses, and any scroll does too: the card is absolutely placed
  // against a trigger that a scrolling transcript moves out from under it.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open || !data) return;
    const trigger = triggerElementRef.current;
    const card = cardRef.current;
    if (!trigger || !card) return;
    const triggerBox = trigger.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const next = computeTooltipPosition({
      preferredSide: "top",
      trigger: {
        top: triggerBox.top,
        left: triggerBox.left,
        right: triggerBox.right,
        bottom: triggerBox.bottom,
        width: triggerBox.width,
        height: triggerBox.height,
      },
      tooltip: { width: cardBox.width, height: cardBox.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gap: GAP,
      pad: VIEWPORT_PAD,
    });
    setCoords((prev) => (
      prev && prev.x === next.x && prev.y === next.y && prev.side === next.side ? prev : next
    ));
  }, [open, data]);

  const triggerRef = useCallback((node: HTMLElement | null) => {
    triggerElementRef.current = node;
  }, []);

  const visible = supported && open && data !== null;

  const card = open && data && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={cardRef}
          id={cardId}
          role="tooltip"
          data-chip-hover-card={data.kind}
          className={
            "pointer-events-none fixed z-[70] max-w-[300px] rounded-lg border border-white/12"
            + " bg-[#16161b]/95 px-2.5 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.45)] backdrop-blur-sm"
          }
          style={{
            top: coords?.y ?? 0,
            left: coords?.x ?? 0,
            // Measured before it is placed: keep the first frame invisible so
            // the card never flashes at the top-left corner of the window.
            visibility: coords ? "visible" : "hidden",
          }}
        >
          <ChipCardBody data={data} />
        </div>,
        document.body,
      )
    : null;

  if (!supported) {
    return { supported: false, visible: false, triggerRef, triggerProps: {}, card: null };
  }

  return {
    supported: true,
    visible,
    triggerRef,
    triggerProps: {
      onMouseEnter: openAfterDelay,
      onMouseLeave: close,
      // Keyboard parity: tabbing onto a chip shows its card immediately. The
      // card itself is inert, so focus stays exactly where the user put it.
      onFocus: openNow,
      onBlur: close,
      ...(visible ? { "aria-describedby": cardId } : {}),
    },
    card,
  };
}
