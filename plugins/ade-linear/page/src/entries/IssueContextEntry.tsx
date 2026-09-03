/**
 * The transcript's Linear issue context.
 *
 * The pane the compiled `UserMessageIssueContext` drew under a user message.
 * The app read the turn's own `contextAttachments`; a guest cannot see a
 * transcript, so the same fact arrives the other way round — the lane rows carry
 * `linearIssueLinks`, each `{issueId, issueKey, sessionId}`, and the links whose
 * `sessionId` is this subject's session are exactly the issues that turn
 * carried.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, ChatCircleDots, LinkSimple, Plus, type Icon } from "@phosphor-icons/react";
import { cn, LinearMark, LinearStateIcon, LINEAR_BRAND } from "@ade-dev/ui";

import type { PluginWebviewContext } from "../bridge";
import { IssueContextPane } from "../components/IssueContextPane";
import { LinearIssueSelectModal } from "../components/LinearIssueSelectModal";
import { linearBrowserIssueToLaneIssue } from "../components/LinearIssueBrowser";
import {
  commentProgress,
  getLanes,
  linkIssueToLane,
  openIssueInLinear,
  searchIssues,
  unlinkIssueFromLane,
} from "../host/actions";
import { closeSurface, openSettings, reportHeight, toast } from "../host/ui";
import { useCollectionChanges } from "../host/useHostEntities";
import type { LaneLinearIssue } from "../types";

/**
 * Report this surface's own content height to the host.
 *
 * `ui.resize` is the ONE height channel. The page used to report the same
 * number two other ways — writing it onto `documentElement.style.height` for a
 * host that measured the guest document, and posting an
 * `ade:plugin-webview-height` frame to the parent for a host that listened —
 * and neither was a bridge verb, so neither was something a host was obliged to
 * honour. Both are gone; `host/ui.ts:reportHeight` clamps and delivers.
 *
 * The last reported height is remembered so a `ResizeObserver` firing on every
 * layout tick sends one frame per real change rather than one per tick.
 */
function useContentHeight(): (node: HTMLDivElement | null) => void {
  const observerRef = useRef<ResizeObserver | null>(null);
  const lastRef = useRef<number | null>(null);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    observerRef.current = null;
  }, []);

  return useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    lastRef.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      // `getBoundingClientRect` rather than `offsetHeight`: the cards use
      // fractional padding, and a rounded-down height clips the last border.
      const measured = node.getBoundingClientRect().height;
      if (measured === lastRef.current) return;
      const reported = reportHeight(measured);
      if (reported !== null) lastRef.current = measured;
    };
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    observerRef.current = observer;
    apply();
  }, []);
}

export function IssueContextEntry({ context }: { context: PluginWebviewContext }): React.ReactElement {
  const measure = useContentHeight();
  const subject = context.subject;
  const sessionId = useMemo(() => {
    if (!subject || subject.kind !== "session") return null;
    return typeof subject.id === "string" && subject.id.length ? subject.id : null;
  }, [subject]);

  const [issues, setIssues] = useState<LaneLinearIssue[]>([]);
  const [laneId, setLaneId] = useState<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(() => {
    if (!sessionId) {
      setIssues([]);
      setLaneId(null);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    void (async () => {
      try {
        const lanes = await getLanes();
        const lane = lanes.find((row) => (row.linearIssueLinks ?? []).some((link) => link.sessionId === sessionId));
        const links = (lane?.linearIssueLinks ?? []).filter((link) => link.sessionId === sessionId);
        if (requestRef.current !== requestId) return;
        setLaneId(lane?.id ?? null);
        if (!links.length) {
          setIssues([]);
          return;
        }
        // One search per link, by the key the link carries — `pageSearchIssues`
        // is the only read the page has that answers a whole issue, and the
        // links carry identity only.
        const resolved = await Promise.all(links.map(async (link) => {
          const key = link.issueKey?.trim();
          if (!key) return null;
          try {
            const result = await searchIssues({ query: key, first: 1 });
            const found = result.issues.find((row) => row.id === link.issueId) ?? result.issues[0] ?? null;
            return found ? linearBrowserIssueToLaneIssue(found) : null;
          } catch {
            return null;
          }
        }));
        if (requestRef.current !== requestId) return;
        setIssues(resolved.filter((row): row is LaneLinearIssue => row != null));
      } catch {
        if (requestRef.current === requestId) setIssues([]);
      }
    })();
  }, [sessionId]);

  useEffect(() => {
    load();
  }, [load]);
  useCollectionChanges(load);

  // Two placements, one surface, two bodies.
  //
  // `chat-card` is the transcript row the compiled `UserMessageIssueContext`
  // drew, and it paints only the chips. `popover` is the chat three-dot menu's
  // Issue context submenu, anchored to the row the reader pressed — and a
  // reader who opened a MENU asked to do something, so an empty chip tray there
  // would be a menu item that opens a blank card. It draws the verbs instead.
  if (context.placement === "popover") {
    return (
      <div ref={measure}>
        <IssueContextPopover
          issues={issues}
          laneId={laneId}
          sessionId={sessionId}
          projectRoot={context.project?.root ?? null}
          onChanged={load}
        />
      </div>
    );
  }

  // Content sizing, and no page-sized ground: the host draws the transcript row
  // around this, so the page paints only the chips.
  return (
    <div ref={measure}>
      <IssueContextPane issues={issues} laneId={laneId} />
    </div>
  );
}

/**
 * The chat menu's Issue context card: attach, detach, open, summary.
 *
 * The four verbs the compiled `chat-header-action` offered, in the place the
 * header button used to be. Three of them were its dropdown menu ("Open in
 * Linear", "Comment progress on the issue") and its press ("Linear issue"); the
 * fourth, attach, was the composer's own picker, which is a menu row of its own
 * now — so this card carries it too, because a chat with no issue attached is
 * exactly the chat a reader opens this card to fix.
 *
 * Every verb goes through the plugin's OWN action ids rather than through a
 * second implementation: `openInLinear` answers `{openUrl}` for the host to act
 * on, and `commentProgress` reads the transcript through `chat.readTranscript`
 * in the child, which is the gated verb for it.
 */
function IssueContextPopover({
  issues,
  laneId,
  sessionId,
  projectRoot,
  onChanged,
}: {
  issues: LaneLinearIssue[];
  laneId: string | null;
  sessionId: string | null;
  projectRoot: string | null;
  onChanged: () => void;
}): React.ReactElement {
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  /**
   * Run one verb, and say what happened.
   *
   * Every action here answers `{ok, message}` rather than throwing, so a
   * refusal is a sentence the reader sees. The card reloads afterwards because
   * three of the four change what it draws.
   */
  const run = useCallback(async (key: string, verb: () => Promise<{ ok: boolean; message?: string | null }>) => {
    setBusy(key);
    try {
      const result = await verb();
      if (result?.message) {
        await toast({ level: result.ok === false ? "error" : "success", message: result.message });
      }
    } catch (error) {
      await toast({ level: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
      onChanged();
    }
  }, [onChanged]);

  return (
    <div className="flex w-full flex-col gap-2 p-2.5">
      {issues.length === 0 ? (
        <p className="px-1 py-1.5 text-[11.5px] leading-relaxed text-muted-fg/70">
          This chat has no Linear issue attached.
        </p>
      ) : (
        issues.map((issue) => (
          <div
            key={issue.id}
            className="rounded-lg border p-2"
            style={{ borderColor: LINEAR_BRAND.borderSubtle, background: LINEAR_BRAND.surface }}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <LinearMark size={10} />
              <span className="shrink-0 font-mono text-[10px] text-fg/80">{issue.identifier}</span>
              <LinearStateIcon stateType={issue.stateType} size={10} />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-fg/85" title={issue.title}>
                {issue.title}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <PopoverVerb
                icon={ArrowSquareOut}
                label="Open in Linear"
                busy={busy === `open:${issue.id}`}
                onPress={() => void run(`open:${issue.id}`, () => openIssueInLinear(issue.id))}
              />
              <PopoverVerb
                icon={ChatCircleDots}
                label="Comment progress"
                disabled={!sessionId}
                busy={busy === `comment:${issue.id}`}
                title={sessionId ? undefined : "Open this from inside a chat."}
                onPress={() => void run(`comment:${issue.id}`, () => commentProgress(sessionId ?? ""))}
              />
              <PopoverVerb
                icon={LinkSimple}
                label="Detach"
                disabled={!laneId}
                busy={busy === `detach:${issue.id}`}
                title={laneId ? undefined : "ADE cannot tell which lane this chat belongs to."}
                onPress={() => void run(`detach:${issue.id}`, () => unlinkIssueFromLane(issue.id, laneId ?? ""))}
              />
            </div>
          </div>
        ))
      )}

      <PopoverVerb
        icon={Plus}
        label="Attach a Linear issue"
        disabled={!laneId}
        title={laneId ? undefined : "ADE cannot tell which lane this chat belongs to."}
        onPress={() => setPicking(true)}
      />

      <LinearIssueSelectModal
        open={picking}
        ariaLabel="Attach Linear issue"
        projectRoot={projectRoot}
        selectedIssue={null}
        actionLabel="Attach issue"
        actionBusyLabel="Attaching issue"
        showBranchPreview={false}
        onOpenChange={setPicking}
        onSelectIssue={(issue) => {
          setPicking(false);
          void run("attach", async () => {
            const result = await linkIssueToLane(issue.id, laneId ?? "");
            // The menu asked one question and it is answered, so the popover
            // gets out of the way — the same close the composer picker performs
            // once it has attached.
            if (result.ok) await closeSurface();
            return result;
          });
        }}
        onOpenLinearSettings={() => void openSettings({ socketId: "connection" })}
      />
    </div>
  );
}

/** One verb button. The card's only chrome, so it lives beside the card. */
function PopoverVerb({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  busy = false,
  title,
}: {
  icon: Icon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string | undefined;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onPress}
      {...(title ? { title } : {})}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2",
        "text-[10.5px] font-medium leading-none text-fg/80 transition-colors",
        "hover:border-violet-400/20 hover:bg-violet-500/[0.06] hover:text-fg",
        "disabled:cursor-not-allowed disabled:opacity-45",
      )}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}
