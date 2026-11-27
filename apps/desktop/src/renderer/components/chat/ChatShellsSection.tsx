import { useMemo, useState } from "react";
import { DotsThree } from "@phosphor-icons/react";
import { Banner } from "../ui/notice";
import type { OpenProjectBinding, TerminalSessionSummary } from "../../../shared/types";
import type { ChatReadFailure } from "./chatMachinePin";
import { canonicalInputFromSummary, sessionCanonicalUiState, sessionStatusDisplay } from "../../lib/terminalAttention";
import { sessionElapsedAnchor } from "../../../shared/sessionStatusPresentation";
import { focusWorkSession, openWorkSessionMenu } from "../../lib/workSessionRequests";
import { cn } from "../ui/cn";
import { SessionStatusLabel } from "../terminals/SessionStatusLabel";

/** Rows the section shows before it folds the rest behind "N more". */
export const SHELLS_ACTIVE_CAP = 6;

/**
 * The terminals attached to one chat: what the chat-actions pane's Shells
 * section draws.
 *
 * Its own module rather than a corner of the subagents panel: shells and
 * subagents are different things, and this is the only place that knows how a
 * shell row behaves. Every row opens the shell in the Work tab, or raises the
 * Work list's own context menu (host and handlers included — see
 * `workSessionRequests`); a status line comes from the same pipeline the Work
 * sidebar rows use, so a shell never invents its own vocabulary.
 *
 * A failed read is not drawn here: `ChatTerminalsReadNotice` states it once
 * for shells and watches together.
 */
export function ChatShellsSection({
  shells,
  pin = null,
}: {
  shells: TerminalSessionSummary[];
  /** The chat's machine; a shell there must open and act there, not here. */
  pin?: OpenProjectBinding | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? shells : shells.slice(0, SHELLS_ACTIVE_CAP);

  return (
    <>
      <div className="space-y-px px-2 pb-1">
        {visible.map((shell) => (
          <ShellRow key={shell.id} shell={shell} pin={pin} />
        ))}
      </div>
      {!showAll && shells.length > SHELLS_ACTIVE_CAP ? (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mx-2 flex w-[calc(100%-1rem)] items-center rounded-md px-2 py-1 text-left font-sans text-[10.5px] text-fg/40 transition-colors hover:bg-fg/[0.035] hover:text-fg/60"
        >
          Show all ({shells.length - SHELLS_ACTIVE_CAP} more)
        </button>
      ) : null}
    </>
  );
}

/**
 * The one notice for a chat's shells and terminal watches that could not be
 * read, instead of a red box per section (notices.md: never a false empty
 * state, and never two alarms for one cause).
 *
 * Both reads go to the chat's computer, so they usually fail together and for
 * the same reason. When that reason is only that the computer is out of reach
 * (not connected yet, the link dropped, an ADE Cloud computer asleep), it is a
 * quiet neutral line with no Report: ADE reads again by itself once the link
 * is back. Any other failure is an error that carries its raw text, so the
 * person sees it and a report holds it.
 */
export function ChatTerminalsReadNotice({
  shellsFailure,
  watchesFailure,
  onRetry,
}: {
  shellsFailure: ChatReadFailure | null;
  watchesFailure: ChatReadFailure | null;
  onRetry?: () => void;
}) {
  if (!shellsFailure && !watchesFailure) return null;
  const actions = onRetry ? [{ label: "Retry", onClick: onRetry }] : undefined;
  const failures = [shellsFailure, watchesFailure].filter((failure): failure is ChatReadFailure => failure != null);
  if (failures.every((failure) => failure.unreachable)) {
    return (
      <div className="px-2 pb-3">
        <Banner
          layout="inline"
          testId="chat-terminals-unreachable"
          announce={false}
          model={{
            id: "chat-terminals-unreachable",
            tone: "neutral",
            title: "Can’t reach this chat’s computer right now.",
            detail: "Its shells and terminal watches show here again once it’s back.",
            actions,
          }}
        />
      </div>
    );
  }
  const what = shellsFailure && watchesFailure
    ? "shells and terminal watches"
    : shellsFailure ? "shells" : "terminal watches";
  const failure = failures.find((entry) => !entry.unreachable) ?? failures[0]!;
  return (
    <div className="px-2 pb-3">
      <Banner
        layout="inline"
        testId="chat-terminals-error"
        model={{
          id: "chat-terminals-load",
          tone: "error",
          title: `Couldn’t load this chat’s ${what}.`,
          error: failure.detail || undefined,
          report: {
            surface: "chat_terminals_read",
            code: shellsFailure && !shellsFailure.unreachable ? "chat_shells_read_failed" : "chat_terminal_watches_read_failed",
            technicalDetail: failure.detail || null,
          },
          actions,
        }}
      />
    </div>
  );
}

/**
 * One attached shell: the sidebar's status line, its title, and two gestures —
 * click opens the shell in full view, right-click (or `⋯`) raises the Work
 * list's own menu. `title` carries what the shell last said, so the quiet row
 * still answers "what is this?" on hover.
 */
function ShellRow({ shell, pin }: { shell: TerminalSessionSummary; pin: OpenProjectBinding | null }) {
  const attentionInput = useMemo(() => canonicalInputFromSummary(shell), [shell]);
  const presentation = sessionStatusDisplay(attentionInput);
  const canonical = useMemo(() => sessionCanonicalUiState(attentionInput), [attentionInput]);
  const elapsedSince = sessionElapsedAnchor(shell, canonical.phase, canonical.liveness);
  const label = (shell.goal ?? shell.title).trim() || "Shell";
  const lastLine = typeof shell.lastOutputPreview === "string"
    ? shell.lastOutputPreview.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? ""
    : "";
  const details = [lastLine, shell.toolType].filter((part): part is string => Boolean(part)).join(" · ");
  const openMenu = (point: { x: number; y: number }) => openWorkSessionMenu(shell, point, pin);

  return (
    <div className="group grid min-h-[34px] grid-cols-[minmax(0,1fr)_auto] items-center gap-1 px-2 py-1 transition-colors hover:bg-fg/[0.04]">
      <button
        type="button"
        onClick={() => focusWorkSession(shell.id, shell.laneId, pin)}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu({ x: event.clientX, y: event.clientY });
        }}
        title={details || label}
        className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-left"
      >
        <span className="min-w-0 truncate font-sans text-[12.5px] leading-5 text-fg/75">{label}</span>
        <SessionStatusLabel
          presentation={presentation}
          elapsedSince={elapsedSince}
          futureAt={shell.nextWakeAt}
          timestampLabel=""
          compact
        />
      </button>
      <button
        type="button"
        aria-label={`${label} actions`}
        title="Actions"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu({ x: rect.right, y: rect.bottom });
        }}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-md text-fg/30 opacity-0",
          "transition-all hover:bg-fg/[0.06] hover:text-fg/75 group-hover:opacity-100 focus-visible:opacity-100",
        )}
      >
        <DotsThree aria-hidden size={14} weight="bold" />
      </button>
    </div>
  );
}
