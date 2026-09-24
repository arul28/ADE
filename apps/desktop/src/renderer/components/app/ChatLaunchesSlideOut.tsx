import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CaretRight, ChatCircleText, Check, TerminalWindow, Warning } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type { ChatLaunchSnapshot } from "../../../shared/types";
import { chatLaunchProgress, chatLaunchStatusLine, isChatLaunchSucceeded } from "../../../shared/chatLaunch";
import {
  chatLaunchStore,
  dismissChatLaunches,
  getChatLaunchOriginClientId,
  useChatLaunchSelector,
  type ChatLaunchEntry,
} from "../../state/chatLaunchStore";
import { STANDARD_EASE } from "../../lib/motion";
import { cn } from "../ui/cn";
import { LaneSetupCard, LaunchStageGlyph } from "../chat/launch/LaneSetupCard";
import { LaunchProgressRail } from "../chat/launch/LaunchProgressRail";
import { useLaunchDurationText } from "../chat/launch/launchClock";
import { LaneIcon } from "../ui/vcsIcons";
import { NoticeIcon } from "../ui/notice/NoticeParts";
import { noticeTone, type NoticeTone } from "../ui/notice/noticeTones";
import { ToastCard } from "../ui/notice/ToastCard";

/** A launch's tone on the shared notice palette: failed is red, like every other failure. */
function launchTone(failed: boolean, succeeded: boolean): NoticeTone {
  if (failed) return "error";
  if (succeeded) return "success";
  return "accent";
}

/**
 * The Launches slide-out: this window's new-lane launches that are NOT showing
 * in a thread — background chats and CLI launches (either mode). A foreground
 * chat is left out because its own thread carries the setup card.
 *
 * Calm by default: one line per launch with a segmented stage rail, expanding
 * to the stage list and its actions on click. It leaves on its own a few
 * seconds after everything it shows has started; a failed launch stays until
 * it is handled or dismissed.
 */

export const CHAT_LAUNCH_SLIDE_OUT_AUTO_DISMISS_MS = 3_000;

/** The launches the slide-out shows, oldest first. Pure for tests. */
export function selectSlideOutLaunches(
  entries: Record<string, ChatLaunchEntry>,
  dismissed: Record<string, true>,
  originClientId: string,
): ChatLaunchSnapshot[] {
  return Object.values(entries)
    .map((entry) => entry.snapshot)
    .filter((launch) => launch.originClientId === originClientId
      && (launch.kind === "cli" || launch.mode === "background")
      && launch.phase !== "cancelled"
      && !dismissed[launch.launchId])
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

function useSlideOutLaunches(): ChatLaunchSnapshot[] {
  return useChatLaunchSelector(
    (state) => selectSlideOutLaunches(state.entries, state.dismissed, getChatLaunchOriginClientId()),
    (a, b) => a.length === b.length && a.every((launch, index) => launch === b[index]),
  );
}

/** Cheap boolean for the app shell: is there anything for the slide-out to show? */
export function useChatLaunchSlideOutVisible(): boolean {
  return useChatLaunchSelector(
    (state) => selectSlideOutLaunches(state.entries, state.dismissed, getChatLaunchOriginClientId()).length > 0,
    (a, b) => a === b,
  );
}

export function slideOutHeadline(launches: ChatLaunchSnapshot[]): string {
  const running = launches.filter((launch) => !isChatLaunchSucceeded(launch) && launch.phase !== "failed").length;
  if (running > 0) return `Setting up ${running} lane${running === 1 ? "" : "s"}…`;
  const ready = launches.filter(isChatLaunchSucceeded).length;
  const failed = launches.filter((launch) => launch.phase === "failed").length;
  return [ready ? `${ready} ready` : null, failed ? `${failed} failed` : null].filter(Boolean).join(" · ") || "Launches";
}

function LaunchElapsed({ launch }: { launch: ChatLaunchSnapshot }) {
  const live = !launch.endedAt && launch.phase !== "failed" && !isChatLaunchSucceeded(launch);
  const text = useLaunchDurationText(launch.startedAt, launch.endedAt, live);
  return <span className="shrink-0 tabular-nums text-fg/40">{text}</span>;
}

/**
 * One launch. Memoized on the snapshot object: the store keeps every other
 * launch's snapshot identity when one launch moves, so a checkout tick
 * re-renders only the row it belongs to.
 */
const LaunchRow = React.memo(function LaunchRow({ launch }: { launch: ChatLaunchSnapshot }) {
  const navigate = useNavigate();
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(launch.phase === "failed");
  const failed = launch.phase === "failed";
  const succeeded = isChatLaunchSucceeded(launch);
  useEffect(() => {
    if (failed) setExpanded(true);
  }, [failed]);
  const { done, total } = chatLaunchProgress(launch);
  const canOpen = launch.kind === "chat" ? launch.sessionCreated && Boolean(launch.sessionId) : Boolean(launch.sessionId);
  const open = canOpen
    ? () => {
        const params = new URLSearchParams({ laneId: launch.laneId, sessionId: launch.sessionId ?? "" });
        navigate(`/work?${params.toString()}`);
      }
    : null;
  const KindIcon = launch.kind === "cli" ? TerminalWindow : ChatCircleText;
  const tone = launchTone(failed, succeeded);
  return (
    <li
      data-testid="chat-launch-row"
      data-launch-id={launch.launchId}
      className={cn("px-3 py-2.5 transition-colors", expanded ? "bg-fg/[0.025]" : "hover:bg-fg/[0.03]")}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="flex w-full min-w-0 flex-col gap-1.5 text-left"
      >
        <span className="flex w-full min-w-0 items-center gap-2.5">
          <span className="relative shrink-0" aria-hidden>
            <NoticeIcon tone={tone} size="sm" icon={<KindIcon size={13} weight="bold" />} />
            <span className="absolute -bottom-1 -right-1 grid h-3 w-3 place-items-center rounded-full bg-card">
              {failed ? (
                <LaunchStageGlyph status="failed" size={8} />
              ) : succeeded ? (
                <Check size={7} weight="bold" style={{ color: noticeTone("success").color }} />
              ) : (
                <LaunchStageGlyph status="running" size={9} />
              )}
            </span>
          </span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-fg" title={launch.title}>
            {launch.title || launch.prompt.text}
          </span>
          <span className="shrink-0 rounded-full border border-fg/[0.09] bg-fg/[0.04] px-1.5 py-px text-[10px] text-muted-fg">
            {launch.kind === "cli" ? "CLI" : "Chat"}
          </span>
          <CaretRight
            size={10}
            weight="bold"
            aria-hidden
            className={cn("shrink-0 text-muted-fg/70 transition-transform duration-150", expanded && "rotate-90")}
          />
        </span>
        <span className="flex w-full min-w-0 items-center gap-2 pl-[32px] text-[11px]">
          <span className="inline-flex min-w-0 max-w-[40%] items-center gap-1 text-muted-fg" title={launch.laneName}>
            <LaneIcon size={10} style={{ color: noticeTone("accent").text }} />
            <span className="min-w-0 truncate">{launch.laneName}</span>
          </span>
          <span className="h-3 w-px shrink-0 bg-fg/[0.1]" aria-hidden />
          <span
            className="min-w-0 flex-1 truncate"
            style={{ color: failed || succeeded ? noticeTone(tone).text : "var(--color-muted-fg)" }}
            data-testid="chat-launch-row-status"
          >
            {chatLaunchStatusLine(launch)}
          </span>
          <LaunchElapsed launch={launch} />
        </span>
        <span className="block w-full pl-[32px]" title={`${done} of ${total} steps`}>
          <LaunchProgressRail stages={launch.stages} />
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            key="stages"
            initial={reduceMotion ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: STANDARD_EASE }}
            className="overflow-hidden"
          >
            <div className="ml-[32px] mt-2.5 rounded-lg border border-fg/[0.07] bg-fg/[0.03] px-2.5 pt-0.5 pb-1">
              <LaneSetupCard snapshot={launch} variant="compact" showTitle={false} onOpen={open} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
});

export function ChatLaunchesSlideOut() {
  const launches = useSlideOutLaunches();
  const anyRunning = launches.some((launch) => launch.phase !== "failed" && !isChatLaunchSucceeded(launch));
  const succeededIds = useMemo(
    () => launches.filter(isChatLaunchSucceeded).map((launch) => launch.launchId),
    [launches],
  );
  const succeededKey = succeededIds.join("|");

  // Once nothing it shows is still setting up, successful rows leave after a
  // short beat; failures stay until handled.
  useEffect(() => {
    if (anyRunning || succeededIds.length === 0) return undefined;
    const ids = [...succeededIds];
    const timer = window.setTimeout(() => dismissChatLaunches(ids), CHAT_LAUNCH_SLIDE_OUT_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
    // `succeededKey` stands in for the id list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyRunning, succeededKey]);

  if (launches.length === 0) return null;
  const hasFailure = launches.some((launch) => launch.phase === "failed");
  const tone: NoticeTone = hasFailure ? "error" : anyRunning ? "accent" : "success";
  return (
    <ToastCard
      testId="chat-launches-slide-out"
      model={{
        tone,
        title: <span data-testid="chat-launches-headline">{slideOutHeadline(launches)}</span>,
        icon: anyRunning ? <LaneIcon size={12} weight="bold" /> : hasFailure ? <Warning size={12} weight="bold" /> : <Check size={12} weight="bold" />,
        content: (
          <ul data-testid="chat-launches-list" className="max-h-[min(60vh,420px)] divide-y divide-fg/[0.07] overflow-y-auto">
            {launches.map((launch) => (
              <LaunchRow key={launch.launchId} launch={launch} />
            ))}
          </ul>
        ),
        closeLabel: "Dismiss launches",
        closeTitle: "Dismiss",
      }}
      onClose={() => dismissChatLaunches(launches.map((launch) => launch.launchId))}
    />
  );
}

/** Test seam: what the slide-out would show right now. */
export function currentSlideOutLaunchesForTests(): ChatLaunchSnapshot[] {
  const state = chatLaunchStore.getState();
  return selectSlideOutLaunches(state.entries, state.dismissed, getChatLaunchOriginClientId());
}
