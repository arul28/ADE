import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaretDown, CircleNotch, GitMerge, Sparkle, Stack, Warning } from "@phosphor-icons/react";
import type { AgentChatSessionSummary, LaneSummary, OpenProjectBinding } from "../../../shared/types";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { machineIdForBinding } from "../../../shared/machineIdentity";
import { extractError } from "../../lib/format";
import { useLaneChatHandoff } from "../../lib/laneChatHandoff";
import { buildLaneCatchUpPrompt, newestLaneWorkChat, type LaneCatchUpPromptInput } from "../../lib/laneCatchUpPrompt";
import { useAppStore } from "../../state/appStore";
import { requestCrossMachineLanesForMachine } from "../../state/crossMachineLanes";
import { READABLE_TOAST_DURATION_MS, showToast } from "../app/toast/toastStore";
import { AnchoredMenu, type AnchoredMenuPlacement } from "../ui/AnchoredMenu";
import { Banner } from "../ui/notice";
import { Z_LAYERS } from "../ui/zLayers";
import { COLORS } from "./laneDesignTokens";
import {
  laneCatchUpHasInlineHost,
  laneCatchUpKey,
  laneCatchUpOptions,
  patchLaneCatchUp,
  readLaneCatchUp,
  useLaneCatchUpFailureHost,
  useLaneCatchUpState,
  type LaneCatchUpFailure,
} from "./laneCatchUp";
import { requestLaneRebaseNeedsRescan, type LaneRebaseLine } from "./laneRebaseNeeds";
import { laneBranchLabel } from "./sidebar/laneSidebarModel";

/**
 * Where a lane's catch-up runs. `laneId` is the lane's id on its own machine;
 * `pin` is that machine when it is not the tab's (null keeps the tab's route);
 * `machineId` names it for refreshing its lane list afterwards.
 */
export type LaneCatchUpTarget =
  | { ok: true; laneId: string; pin: OpenProjectBinding | null; machineId: string | null }
  | { ok: false; reason: string };

export type LaneCatchUpTriggerState = {
  open: boolean;
  busy: "rebase" | "merge" | null;
  toggle: () => void;
};

function chatTitle(session: Pick<AgentChatSessionSummary, "title" | "sessionId">): string {
  const title = session.title?.trim();
  return title && title.length > 0 ? title : "the lane's chat";
}

/**
 * "Ask an agent": a chat draft in the lane, never sent. The lane's newest
 * Work chat gets it (it knows the lane's intent); else a new chat in the lane.
 * Every call goes to the lane's machine.
 */
export function useLaneCatchUpAskAgent(pin: OpenProjectBinding | null) {
  const handOff = useLaneChatHandoff(pin, { startDraftInLane: true });
  return useCallback(async (laneId: string, prompt: string, knownChats?: AgentChatSessionSummary[] | null) => {
    const chats = knownChats ?? await window.ade.agentChat
      .list({ laneId, includeArchived: false }, pin)
      .catch(() => [] as AgentChatSessionSummary[]);
    const chat = newestLaneWorkChat(chats);
    handOff({ laneId, sessionId: chat?.sessionId ?? null, prompt });
  }, [handOff, pin]);
}

function failureIsTheUsersToFix(message: string): boolean {
  return /conflict|uncommitted|in progress/i.test(message);
}

export type LaneCatchUpOutcome =
  | { ok: true; upToDate: boolean }
  | { ok: false; failure: LaneCatchUpFailure };

/**
 * Run a direct catch-up on the lane's machine: the rebase engine
 * (`lanes.rebaseStart`, no push) or `git.mergeBaseIn`. Both undo themselves
 * on a conflict. Marks the lane busy while it runs, records a failure for the
 * lane's overview, toasts a success unless `quiet`, and refreshes the lane
 * list it came from. Resolves to null when this lane is already running one.
 */
export async function runLaneCatchUpDirect(args: {
  action: "rebase" | "merge";
  laneId: string;
  pin: OpenProjectBinding | null;
  machineId: string | null;
  laneName: string;
  baseBranch: string;
  prompt: (failure: LaneCatchUpPromptInput["failure"]) => LaneCatchUpPromptInput;
  refreshLanes: () => Promise<unknown>;
  quiet?: boolean;
}): Promise<LaneCatchUpOutcome | null> {
  const { action, laneId, pin, laneName: name } = args;
  const key = laneCatchUpKey(laneId, pin);
  if (readLaneCatchUp(key).busy) return null;
  patchLaneCatchUp(key, { busy: action, failure: null });
  try {
    let upToDate: boolean;
    if (action === "rebase") {
      const start = await window.ade.lanes.rebaseStart({ laneId, pushMode: "none", actor: "user" }, pin);
      const run = start.run;
      if (run.state === "failed" || run.failedLaneId || run.error) {
        const files = run.lanes.find((entry) => entry.laneId === run.failedLaneId)?.conflictingFiles ?? [];
        throw new Error(files.length > 0
          ? `Rebasing onto origin/${args.baseBranch} conflicts in ${files.length} file${files.length === 1 ? "" : "s"} (${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}). The rebase was undone; nothing changed.`
          : run.error ?? "Rebase failed.");
      }
      upToDate = run.lanes.every((entry) => entry.status === "skipped");
      if (!args.quiet) {
        showToast({
          tone: "success",
          title: upToDate ? `${name} is already up to date` : `Rebased ${name} onto ${run.baseBranch || args.baseBranch}`,
          message: "Nothing was pushed.",
        });
      }
    } else {
      const result = await window.ade.git.mergeBaseIn({ laneId }, pin);
      upToDate = result.upToDate;
      if (!args.quiet) {
        showToast({
          tone: "success",
          title: result.upToDate ? `${name} is already up to date` : `Merged ${result.mergedRef} into ${name}`,
          message: result.fetched
            ? "Nothing was pushed."
            : `Could not fetch, so the last known ${result.mergedRef} was used. Nothing was pushed.`,
        });
      }
    }
    patchLaneCatchUp(key, { busy: null });
    return { ok: true, upToDate };
  } catch (error) {
    const message = stripElectronErrorWrapper(extractError(error));
    const failure: LaneCatchUpFailure = { action, message, laneId, pin, prompt: args.prompt({ action, error: message }) };
    patchLaneCatchUp(key, { busy: null, failure });
    return { ok: false, failure };
  } finally {
    try {
      if (pin) requestCrossMachineLanesForMachine(args.machineId ?? machineIdForBinding(pin));
      else {
        await args.refreshLanes();
        requestLaneRebaseNeedsRescan();
      }
    } catch {
      // The next lane refresh picks it up.
    }
  }
}

/**
 * The lane's Catch up button and its menu. One component for every place a
 * lane says it is behind: the overview's status line, the sidebar row, and
 * the Git pane's header. The trigger is the caller's; this owns the menu, the
 * safety rules (`laneCatchUpOptions`), the direct rebase or merge, and where
 * a failure is shown (the lane's overview when it is on screen, else a toast).
 */
export function LaneCatchUpMenu({
  lane,
  line,
  target,
  hasPr = false,
  inProgress = false,
  placement = "bottom-start",
  onFinished,
  trigger,
}: {
  /** The lane's record (name, branch, git status). */
  lane: Pick<LaneSummary, "name" | "branchRef" | "status">;
  line: LaneRebaseLine;
  target: LaneCatchUpTarget;
  /** The lane has a pull request, so its branch is on the remote. */
  hasPr?: boolean;
  /** A rebase or merge is in progress (the Git pane knows; the lane status knows rebases). */
  inProgress?: boolean;
  placement?: AnchoredMenuPlacement;
  /** After a direct rebase or merge, success or not. */
  onFinished?: () => void;
  trigger: (state: LaneCatchUpTriggerState) => React.ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const laneId = target.ok ? target.laneId : null;
  const pin = target.ok ? target.pin : null;
  const pinKey = pin?.key ?? null;
  const machineId = target.ok ? target.machineId : null;
  const key = laneId ? laneCatchUpKey(laneId, pin) : null;
  const { busy } = useLaneCatchUpState(key);
  const askAgentIn = useLaneCatchUpAskAgent(pin);

  // Read when the menu opens, from the lane's machine: is the branch on the
  // remote, and which chat would get the draft.
  const [syncPushed, setSyncPushed] = useState<boolean | null>(null);
  const [chats, setChats] = useState<AgentChatSessionSummary[] | null>(null);
  // A fresh conflict check (`git merge-tree` against the base) on the lane's
  // own machine, so a lane on another computer is checked like a local one.
  const [check, setCheck] = useState<
    { state: "checking" } | { state: "done"; predicted: boolean; files: string[] } | { state: "failed" }
  >({ state: "checking" });
  useEffect(() => {
    if (!open || !laneId) return;
    let cancelled = false;
    setSyncPushed(null);
    setChats(null);
    setCheck({ state: "checking" });
    // A host without the check rejects here, which reads as "couldn't check".
    void Promise.resolve().then(() => window.ade.rebase.getNeed(laneId, pin))
      .then((need) => {
        if (cancelled) return;
        // No need means nothing to catch up with now: nothing to conflict.
        setCheck(need
          ? { state: "done", predicted: need.conflictPredicted, files: need.conflictPredicted ? need.conflictingFiles ?? [] : [] }
          : { state: "done", predicted: false, files: [] });
      })
      .catch((error) => {
        console.warn("lane_catch_up.conflict_check_failed", error);
        if (!cancelled) setCheck({ state: "failed" });
      });
    void window.ade.git.getSyncStatus({ laneId }, pin)
      .then((status) => { if (!cancelled) setSyncPushed(status ? status.hasUpstream : null); })
      .catch(() => {});
    void window.ade.agentChat.list({ laneId, includeArchived: false }, pin)
      .then((rows) => { if (!cancelled) setChats(rows); })
      .catch(() => { if (!cancelled) setChats([]); });
    return () => { cancelled = true; };
    // Keyed on the machine's key: a rebuilt pin for the same machine is the same target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, laneId, pinKey]);

  // A tracked upstream or a PR means pushed for sure; otherwise ask git.
  const statusPushed = hasPr || (lane.status?.remoteBehind ?? -1) >= 0;
  const pushed = statusPushed ? true : syncPushed;
  const checkedLine = check.state === "done"
    ? { conflictPredicted: check.predicted, conflictingFiles: check.files }
    : { conflictPredicted: null, conflictingFiles: [] as string[] };
  const options = laneCatchUpOptions({
    line: checkedLine,
    conflictCheck: check.state,
    dirty: Boolean(lane.status?.dirty),
    inProgress: inProgress || Boolean(lane.status?.rebaseInProgress),
    pushed,
    mergeAvailable: typeof window.ade?.git?.mergeBaseIn === "function",
  });

  const promptInput = useCallback((failure: LaneCatchUpPromptInput["failure"] = null): LaneCatchUpPromptInput => ({
    laneName: lane.name,
    branch: laneBranchLabel(lane.branchRef),
    baseBranch: line.baseBranch,
    kind: line.kind,
    behindBy: line.behindBy,
    mergedPrNumber: line.mergedPrNumber,
    pushed,
    conflictingFiles: check.state === "done" ? check.files : line.conflictingFiles,
    failure,
  }), [check, lane.branchRef, lane.name, line, pushed]);

  const close = useCallback(() => setOpen(false), []);

  const askAgent = useCallback(() => {
    if (!laneId) return;
    setOpen(false);
    void askAgentIn(laneId, buildLaneCatchUpPrompt(promptInput()), chats);
  }, [askAgentIn, chats, laneId, promptInput]);

  const runDirect = useCallback(async (action: "rebase" | "merge") => {
    if (!laneId) return;
    setOpen(false);
    const outcome = await runLaneCatchUpDirect({
      action,
      laneId,
      pin,
      machineId,
      laneName: lane.name,
      baseBranch: line.baseBranch,
      prompt: promptInput,
      refreshLanes,
    });
    if (outcome && !outcome.ok && !laneCatchUpHasInlineHost(laneCatchUpKey(laneId, pin))) {
      // The lane's overview shows a failure inline; from anywhere else, a toast.
      const failure = outcome.failure;
      showToast({
        tone: "error",
        title: `Couldn't ${action === "rebase" ? "rebase" : "merge into"} ${lane.name}`,
        message: failure.message,
        durationMs: READABLE_TOAST_DURATION_MS,
        actions: [{
          label: "Ask an agent",
          onClick: () => {
            patchLaneCatchUp(laneCatchUpKey(laneId, pin), { failure: null });
            void askAgentIn(laneId, buildLaneCatchUpPrompt(failure.prompt));
          },
        }],
      });
    }
    onFinished?.();
  }, [askAgentIn, lane.name, laneId, line.baseBranch, machineId, onFinished, pin, promptInput, refreshLanes]);

  const toggle = useCallback(() => {
    if (!target.ok) {
      showToast({ tone: "warning", title: "Can't catch up this lane", message: target.reason });
      return;
    }
    setOpen((prev) => !prev);
  }, [target]);

  // The first row (Ask an agent, the default) takes focus; arrows move between rows.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>("[role=\"menuitem\"]")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // The menu is portalled, but React still bubbles to the row that owns it
    // (the sidebar's J/K and Enter): keep keys inside the menu.
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      anchorRef.current?.querySelector<HTMLElement>("button")?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role=\"menuitem\"]"));
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const base = line.baseBranch;
  const newestChat = useMemo(() => (chats ? newestLaneWorkChat(chats) : null), [chats]);
  const behindLabel = line.kind === "built_on_merged"
    ? line.mergedPrNumber ? `carries #${line.mergedPrNumber}` : "built on merged work"
    : `${line.behindBy} behind`;

  return (
    <>
      <span ref={anchorRef} className="inline-flex min-w-0 shrink-0" onClick={(event) => event.stopPropagation()}>
        {trigger({ open, busy, toggle })}
      </span>
      <AnchoredMenu
        open={open}
        anchorRef={anchorRef}
        onClose={close}
        placement={placement}
        offset={4}
        zIndex={Z_LAYERS.popover}
        remeasureKey={`${options.rebase}:${options.merge}:${options.blocker ?? ""}:${newestChat?.sessionId ?? ""}`}
        role="menu"
        aria-label={`Catch up with ${base}`}
        className="ade-liquid-glass-menu"
        data-testid="lane-catch-up-menu"
        onKeyDown={onMenuKeyDown}
        onClick={(event) => event.stopPropagation()}
        style={{ width: 312, padding: 4, borderRadius: 12 }}
      >
        <div ref={menuRef} className="flex flex-col">
          <div className="flex items-baseline gap-2 px-2.5 pb-1.5 pt-1.5 text-[11px]" style={{ color: COLORS.textMuted }}>
            <span className="min-w-0 truncate">
              Catch up with <span className="font-medium" style={{ color: COLORS.textPrimary }}>{base}</span>
            </span>
            <span className="ml-auto shrink-0 tabular-nums">{behindLabel}</span>
          </div>
          <CatchUpRow
            icon={<Sparkle size={15} weight="duotone" />}
            hue={COLORS.accent}
            title="Ask an agent"
            detail={newestChat
              ? `Drafts the steps in ${chatTitle(newestChat)}; you send it`
              : "Drafts the steps in a new chat; you send it"}
            onSelect={askAgent}
            testId="lane-catch-up-agent"
          />
          {options.rebase ? (
            <CatchUpRow
              icon={<Stack size={15} weight="duotone" />}
              hue={COLORS.info}
              title="Rebase now"
              detail={`Replays this lane on origin/${base}; not pushed yet`}
              tooltip={`Rebase onto origin/${base}. The branch was never pushed, so nothing shared is rewritten. If it conflicts, it is undone and nothing changes. Nothing is pushed.`}
              disabled={busy != null}
              onSelect={() => { void runDirect("rebase"); }}
              testId="lane-catch-up-rebase"
            />
          ) : null}
          {options.merge ? (
            <CatchUpRow
              icon={<GitMerge size={15} weight="duotone" />}
              hue={COLORS.success}
              title={`Merge ${base} in`}
              detail={`Adds a merge commit from origin/${base}; safe when pushed`}
              tooltip={`Fetch, then merge origin/${base} into this lane. It rewrites nothing. If it conflicts, it is undone and nothing changes. Nothing is pushed.`}
              disabled={busy != null}
              onSelect={() => { void runDirect("merge"); }}
              testId="lane-catch-up-merge"
            />
          ) : null}
          {options.blocker ? (
            <div
              className="mx-1 mt-1 flex items-center gap-1.5 border-t px-1.5 pb-1 pt-2 text-[11px]"
              style={{ color: COLORS.textMuted, borderColor: "color-mix(in srgb, var(--color-fg) 8%, transparent)" }}
              data-testid="lane-catch-up-blocker"
            >
              <Warning size={12} weight="fill" className="shrink-0" style={{ color: COLORS.warning }} />
              <span className="min-w-0 truncate" title={checkedLine.conflictingFiles.join("\n") || undefined}>{options.blocker}</span>
            </div>
          ) : null}
        </div>
      </AnchoredMenu>
    </>
  );
}

/**
 * The text trigger: "Catch up ▾", or "Rebasing…" / "Merging…" while a direct
 * catch-up runs. `xs` is the inline size for the sidebar row's line.
 */
export function LaneCatchUpButton({
  state,
  size = "sm",
  ghost = false,
  title,
  testId = "lane-catch-up",
}: {
  state: LaneCatchUpTriggerState;
  size?: "sm" | "xs";
  ghost?: boolean;
  title?: string;
  testId?: string;
}) {
  const label = state.busy === "rebase" ? "Rebasing…" : state.busy === "merge" ? "Merging…" : "Catch up";
  return (
    <button
      type="button"
      className={ghost ? "kit-btn kit-btn-ghost shrink-0" : "kit-btn shrink-0"}
      data-size={size}
      style={size === "xs" ? { gap: 3 } : undefined}
      title={title}
      aria-haspopup="menu"
      aria-expanded={state.open}
      disabled={state.busy != null}
      onClick={(event) => {
        event.stopPropagation();
        state.toggle();
      }}
      data-testid={testId}
    >
      {state.busy ? <CircleNotch size={size === "xs" ? 10 : 12} className="animate-spin" aria-hidden /> : null}
      {label}
      {state.busy ? null : <CaretDown size={size === "xs" ? 9 : 10} weight="bold" aria-hidden style={{ opacity: 0.6 }} />}
    </button>
  );
}

function CatchUpRow({
  icon,
  hue,
  title,
  detail,
  tooltip,
  disabled = false,
  onSelect,
  testId,
}: {
  icon: React.ReactNode;
  hue: string;
  title: string;
  detail: string;
  tooltip?: string;
  disabled?: boolean;
  onSelect: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={tooltip ?? `${title}. ${detail}.`}
      onClick={onSelect}
      data-testid={testId}
      className="group flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors duration-100 hover:bg-fg/[0.06] focus-visible:bg-fg/[0.07] disabled:cursor-default disabled:opacity-45"
    >
      <span
        aria-hidden
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        style={{ color: hue, background: `color-mix(in srgb, ${hue} 14%, transparent)` }}
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="truncate text-[12.5px] font-medium leading-[17px]" style={{ color: COLORS.textPrimary }}>{title}</span>
        <span className="truncate text-[11px] leading-[15px]" style={{ color: COLORS.textMuted }}>{detail}</span>
      </span>
    </button>
  );
}

/**
 * A failed catch-up of this lane, shown in the lane's overview with "Ask an
 * agent", which hands the agent the error. Mounting it makes this the place
 * the lane's failures show (not a toast).
 */
export function LaneCatchUpFailureBanner({ laneId, pin }: { laneId: string; pin: OpenProjectBinding | null }) {
  const key = laneCatchUpKey(laneId, pin);
  const failure = useLaneCatchUpFailureHost(key);
  const askAgentIn = useLaneCatchUpAskAgent(pin);
  if (!failure) return null;
  const expected = failureIsTheUsersToFix(failure.message);
  return (
    <Banner
      layout="inline"
      model={{
        id: `lane-catch-up-failure:${key}`,
        tone: expected ? "warning" : "error",
        title: failure.action === "rebase" ? "The rebase didn't go through" : "The merge didn't go through",
        detail: failure.message,
        actions: [{
          label: "Ask an agent",
          icon: <Sparkle size={13} weight="duotone" />,
          onClick: () => {
            patchLaneCatchUp(key, { failure: null });
            void askAgentIn(failure.laneId, buildLaneCatchUpPrompt(failure.prompt));
          },
        }],
        dismiss: { onDismiss: () => patchLaneCatchUp(key, { failure: null }) },
        report: expected ? false : { surface: "lane_catch_up" },
      }}
    />
  );
}
