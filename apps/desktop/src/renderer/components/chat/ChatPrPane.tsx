import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowsClockwise,
  GitPullRequest,
  Stack,
  X,
} from "@phosphor-icons/react";
import { cn } from "../ui/cn";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type { OpenProjectBinding, PrCheck, PrReview, PrStatus, PrSummary, StackLinkOffer } from "../../../shared/types";
import { PrDetailPane, type PrDetailRuntime } from "../prs/detail/PrDetailPane";
import { PrsProvider } from "../prs/state/PrsContext";
import { PrSwitcherMenu, PrSwitcherStepper, type PrSwitcher } from "../prs/shared/PrSwitcher";
import { subscribeChatPrSelections, takeChatPrSelection } from "./chatPrPaneRequests";
import { ChatPrInlineCreator, inputBase } from "./ChatPrInlineCreator";
import { refreshLinkedPrCoalesced } from "../../lib/prReadCache";
import { useMachineEntryForBinding } from "../../state/crossMachineLanes";
import { useChatRuntimeScopeForPin } from "./ChatRuntimeScope";
import { pipelineStateOf } from "../../../shared/prPipelineState";
import { openLanePr, pickPrimaryPr, selectPrimaryLanePr } from "../../lib/lanePrBadge";
import { selectPrsForChatInLane } from "../../../shared/prChatScope";
import { isMergeReady, PrDetails, type RelayState } from "./ChatPrDetails";
import { selectChatPrs } from "../lanes/lanePageModel";
import { Banner } from "../ui/notice";
import { openLaneOnMachinePath } from "../../lib/laneNavigation";

/**
 * "Link a PR by number or URL" — the manual route into the many-to-many model.
 *
 * A chat gets its pull request automatically when it opens one. A pull request
 * that already existed — opened from the PRs tab, from the CLI, or by a
 * teammate — had no way to reach the chat at all, so a thread could show every
 * PR except the one the user was actually working on.
 *
 * The caller hides this row whenever the pane is pinned to another machine.
 * `prs.linkToLane` carries no pin, so it resolves the lane against the bound
 * machine, which does not own this lane. That is the same reason the inline
 * creator is hidden there.
 */
const ChatPrLinkRow = React.memo(function ChatPrLinkRow({
  laneId,
  sessionId,
  onLinked,
}: {
  laneId: string;
  sessionId?: string | null;
  onLinked: (pr: PrSummary) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setError(null);
    setValue("");
  }, []);

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const linked = await window.ade.prs.linkToLane({
        laneId,
        prUrlOrNumber: trimmed,
        sessionId: sessionId ?? null,
      });
      setBusy(false);
      close();
      onLinked(linked);
    } catch (err) {
      // The service already says why (unknown number, wrong repo, no access);
      // showing its own words beats a generic failure line.
      setError(err instanceof Error ? err.message : "Could not link that pull request.");
      setBusy(false);
    }
  }, [busy, close, laneId, onLinked, sessionId, value]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-fg/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-medium text-fg/55 transition-colors hover:border-fg/[0.14] hover:text-fg/85"
      >
        <GitPullRequest size={11} weight="bold" className="opacity-60" />
        Link a PR by number or URL
      </button>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-1.5">
      <input
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void submit();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        placeholder="1237 or a github.com pull request URL"
        aria-label="Pull request number or URL"
        disabled={busy}
        className={inputBase}
      />
      {error ? (
        <p className="px-0.5 text-[11px] leading-4 text-rose-300/90">{error}</p>
      ) : null}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || value.trim().length === 0}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-fg/[0.14] bg-fg/[0.06] px-3 py-1.5 text-[11px] font-medium text-fg/85 transition-colors hover:bg-fg/[0.10] disabled:cursor-default disabled:opacity-50"
        >
          {busy ? (
            <>
              <ArrowsClockwise size={11} weight="bold" className="animate-spin" />
              Linking…
            </>
          ) : (
            "Link"
          )}
        </button>
        <button
          type="button"
          onClick={close}
          disabled={busy}
          className="inline-flex items-center justify-center rounded-lg border border-fg/[0.08] px-3 py-1.5 text-[11px] font-medium text-fg/55 transition-colors hover:text-fg/85 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
});

/**
 * Left floating info-pane for an ADE chat's pull request. Mirrors the right
 * Chat-actions pane: when a PR exists we show its live, webhook-driven status +
 * quick actions; when none exists we embed a compact inline PR creator
 * (ChatPrInlineCreator) so the user never leaves the Work tab.
 *
 * Live data flow: the GitHub webhook relay lands events in the main process,
 * which fires `prs-updated`; we re-read the lane's summary and hot-refresh the
 * enriched detail (checks / reviews / merge status) immediately rather than
 * waiting for the next background polling tick.
 */

const titleBarIconButton =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-fg/45 transition-colors hover:bg-fg/[0.06] hover:text-fg/85 disabled:pointer-events-none disabled:opacity-40";


export const ChatPrPane = React.memo(function ChatPrPane({
  laneId,
  branchName,
  sessionTitle = null,
  sessionId = null,
  onClose,
  runtimePin = null,
  variant = "pane",
}: {
  laneId: string;
  branchName?: string | null;
  /**
   * Title of the chat this pane belongs to. Forwarded to the inline creator so a
   * new PR defaults to a title that describes the work. Optional — surfaces
   * without a session (the Work grid) fall back to the lane → target derivation.
   */
  sessionTitle?: string | null;
  /** The chat whose explicit PR links should be shown first. */
  sessionId?: string | null;
  /** Closes the pane — wired to the title bar's ✕ (the header PR pill also toggles it). */
  onClose?: () => void;
  /** See `ChatGitToolbar.runtimePin` — the machine this lane's PR row lives on. */
  runtimePin?: OpenProjectBinding | null;
  /**
   * `pane` is the compact card. `tools` is the Work tools tab: the create form
   * when nothing is open, and the PRs-tab detail view stacked for a narrow pane
   * when a pull request exists.
   */
  variant?: "pane" | "tools";
}) {
  const navigate = useNavigate();
  // Also rendered from the Work view area, which has no chat scope above it,
  // so the scope is derived from the pin this pane is handed.
  const scope = useChatRuntimeScopeForPin(runtimePin, laneId);
  const projectRoot = scope.rootPath;
  // Keep the PR refresh callback keyed to the lane identity, not the lanes
  // collection. Lane status refreshes replace that array frequently, and
  // making it a dependency would tear down/recreate the PR event pump.
  const laneType = scope.lane?.laneType ?? "worktree";
  const laneBranchRef = scope.lane?.branchRef ?? null;
  const laneBaseRef = scope.lane?.baseRef ?? null;
  const laneHeadBranchRef = scope.lane?.branchDrift?.headBranchRef ?? "";
  const laneExpectedBranchRef = scope.lane?.branchDrift?.expectedBranchRef ?? "";
  const laneForPr = useMemo(() => ({
    id: laneId,
    laneType,
    branchRef: laneBranchRef ?? branchName ?? "",
    baseRef: laneBaseRef ?? "",
    branchDrift: laneHeadBranchRef
      ? { expectedBranchRef: laneExpectedBranchRef, headBranchRef: laneHeadBranchRef }
      : null,
  }), [branchName, laneBaseRef, laneBranchRef, laneExpectedBranchRef, laneHeadBranchRef, laneId, laneType]);
  // See `ChatGitToolbar`: a local pin is a fresh object on every cross-machine
  // merge, so effects key on the stable pin key and read the object via a ref.
  const runtimePinRef = useRef<OpenProjectBinding | null>(runtimePin);
  runtimePinRef.current = runtimePin;
  const runtimePinKey = runtimePin?.key ?? null;
  const pinMachine = useMachineEntryForBinding(runtimePin);
  const pinMachineName = pinMachine?.machineName ?? null;
  const pinMachineId = pinMachine?.machineId ?? null;
  const [pr, setPr] = useState<PrSummary | null>(null);
  const prRef = useRef<PrSummary | null>(pr);
  prRef.current = pr;
  // Every PR linked to this chat. The pane used to keep only the primary, so a
  // second PR had nowhere to appear even once the data layer allowed one.
  const [linkedPrs, setLinkedPrs] = useState<PrSummary[]>([]);
  // Set when the user picks a non-primary PR from the list. A ref, not state:
  // `refresh` is a stable callback other effects depend on, so reading a state
  // value inside it would capture the value from the render that created it.
  const pinnedPrIdRef = useRef<string | null>(null);
  const pinnedChatKeyRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { copy, copied } = useCopyToClipboard();
  const [checks, setChecks] = useState<PrCheck[] | null>(null);
  const [reviews, setReviews] = useState<PrReview[] | null>(null);
  const [status, setStatus] = useState<PrStatus | null>(null);
  const [relay, setRelay] = useState<RelayState>(null);
  // GitHub stack-link offer for the selected PR (only when this chat can add
  // unclaimed stack siblings). "Not now" hides it for the session+stack.
  const [stackOffer, setStackOffer] = useState<StackLinkOffer | null>(null);
  const [dismissedOfferKey, setDismissedOfferKey] = useState<string | null>(null);
  const [stackLinkError, setStackLinkError] = useState<string | null>(null);
  const [stackLinkBusy, setStackLinkBusy] = useState(false);
  // Manual title-bar ↻ sync in flight.
  const [syncing, setSyncing] = useState(false);
  // Backend reconcile-on-focus running (project-scoped); drives the subtle
  // "syncing" spin on the ↻. Hidden on idle after a short debounce so a fast
  // reconcile does not flicker.
  const [reconciling, setReconciling] = useState(false);
  const reconcileHideTimerRef = useRef<number | null>(null);
  const currentPrIdRef = useRef<string | null>(null);
  const laneIdRef = useRef(laneId);
  const refreshRequestRef = useRef(0);
  laneIdRef.current = laneId;

  const setCurrentPr = useCallback((nextPr: PrSummary | null) => {
    currentPrIdRef.current = nextPr?.id ?? null;
    setPr(nextPr);
  }, []);

  const refresh = useCallback(async (options: { live?: boolean } = {}) => {
    const requestId = refreshRequestRef.current + 1;
    refreshRequestRef.current = requestId;
    const requestIsCurrent = () => laneIdRef.current === laneId && refreshRequestRef.current === requestId;
    // A pin belongs to one chat's list; never let it select across a switch.
    if (pinnedChatKeyRef.current !== `${laneId}:${sessionId ?? ""}`) {
      pinnedChatKeyRef.current = `${laneId}:${sessionId ?? ""}`;
      pinnedPrIdRef.current = null;
    }
    // A PR pill elsewhere (header, session card, lane divider) asked for this one.
    const requestedPrId = takeChatPrSelection(laneId, sessionId ?? null);
    if (requestedPrId) pinnedPrIdRef.current = requestedPrId;
    let cached: PrSummary | null = null;
    // Published together with the selected PR, and only once the request is
    // still the current one: this list is scoped to ONE lane+chat, so a read
    // that resolves after the pane switched chats would otherwise paint the
    // previous chat's PR chips under the new chat — and stick, whenever the
    // stale read lands after the fresh one.
    let nextLinkedPrs: PrSummary[] = [];
    try {
      if (typeof window.ade.prs.listAll === "function") {
        const allPrs = await window.ade.prs.listAll(runtimePinRef.current);
        const scopedPrs = selectPrsForChatInLane(allPrs, laneId, sessionId);
        const visiblePrs = selectChatPrs(laneForPr, scopedPrs, sessionId);
        nextLinkedPrs = visiblePrs;
        const pinnedId = pinnedPrIdRef.current;
        cached = (pinnedId ? visiblePrs.find((entry) => entry.id === pinnedId) : null)
          ?? pickPrimaryPr(visiblePrs)
          ?? selectPrimaryLanePr(laneForPr, scopedPrs);
      } else {
        const legacy = await window.ade.prs.getForLane(laneId, runtimePinRef.current);
        nextLinkedPrs = legacy ? [legacy] : [];
        cached = selectPrimaryLanePr(laneForPr, legacy ? [legacy] : []);
      }
      if (!requestIsCurrent()) return;
      setLinkedPrs(nextLinkedPrs);
      setCurrentPr(cached);
      setLoading(false);
      if (options.live && cached && !cached.unmapped) {
        const refreshed = await refreshLinkedPrCoalesced(cached, { projectRoot, pin: runtimePinRef.current });
        if (!requestIsCurrent()) return;
        setCurrentPr(refreshed);
      }
    } catch {
      if (!cached && requestIsCurrent()) setCurrentPr(null);
    } finally {
      if (requestIsCurrent()) setLoading(false);
    }
    // See ChatGitToolbar: read via ref, but the identity must still follow the
    // pin so the effects keyed on it re-read from the new machine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneForPr, laneId, projectRoot, runtimePinKey, sessionId, setCurrentPr]);

  // The inline creator hands us the freshly-created PR the moment createFromLane
  // resolves — swap to the details view instantly rather than waiting for the
  // next relay round-trip (`prs-updated`) to refresh the row.
  const handleCreated = useCallback((created: PrSummary) => {
    setCurrentPr(created);
  }, [setCurrentPr]);

  // A link adds a row to the chat's list rather than replacing one, so unlike a
  // create it must re-read the list. Pin the new PR first: the refresh selects
  // the primary, and a user who just named a PR means to look at that one.
  const handleLinked = useCallback((linked: PrSummary) => {
    pinnedPrIdRef.current = linked.id;
    setCurrentPr(linked);
    void refresh({ live: true });
  }, [refresh, setCurrentPr]);

  useEffect(() => { void refresh({ live: true }); }, [refresh]);

  // The pane is already on screen when a PR pill asks for another PR.
  useEffect(() => subscribeChatPrSelections((requestedLaneId) => {
    if (requestedLaneId === laneId) void refresh();
  }), [laneId, refresh]);

  // Manual title-bar ↻: force a best-effort sync of this lane's PR (heals
  // merged/closed state, or maps a merged-but-unmapped PR on the branch), then
  // re-read the pane's PR. Moved here from ChatGitToolbar so the chat header
  // stays a status strip and every PR affordance lives in this pane.
  const handleSyncLanePr = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await window.ade.prs.syncLanePr(laneId, runtimePinRef.current);
    } catch {
      // best-effort
    } finally {
      setSyncing(false);
    }
    void refresh({ live: true });
  }, [laneId, refresh, syncing]);

  // Backend reconcile-on-focus spinner (project-scoped), in its OWN subscription
  // keyed only on stable deps (laneId/projectRoot via refresh) — NOT the PR row.
  // Previously this lived in the PR-row-dependent subscription below, so the
  // idle branch's own refresh() (which mutates the PR row) re-ran that effect
  // within the 300ms window and its cleanup clearTimeout'd the pending hide,
  // stranding `reconciling` at true and spinning the ↻ forever. Here the hide
  // timer lives in a ref cleared only on unmount, so a PR-row change can no
  // longer strand it.
  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      if (event.type !== "pr-reconcile") return;
      // Debounce the hide so a fast reconcile doesn't flicker.
      if (event.state === "running") {
        if (reconcileHideTimerRef.current != null) {
          window.clearTimeout(reconcileHideTimerRef.current);
          reconcileHideTimerRef.current = null;
        }
        setReconciling(true);
      } else {
        if (reconcileHideTimerRef.current != null) {
          window.clearTimeout(reconcileHideTimerRef.current);
        }
        reconcileHideTimerRef.current = window.setTimeout(() => {
          setReconciling(false);
          reconcileHideTimerRef.current = null;
        }, 300);
        // A reconcile just healed backend state — re-read the lane's PR.
        void refresh();
      }
    }, runtimePinRef.current);
    return () => {
      unsubscribe();
    };
  }, [refresh, runtimePinKey]);

  // Clear the reconcile hide timer ONLY on unmount — never on a re-subscribe —
  // so the debounce can't be stranded mid-flight.
  useEffect(() => {
    return () => {
      if (reconcileHideTimerRef.current != null) {
        window.clearTimeout(reconcileHideTimerRef.current);
        reconcileHideTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event) => {
      const currentPrId = currentPrIdRef.current;
      if (event.type === "pr-notification") {
        if (event.laneId === laneId || event.prId === currentPrId) void refresh();
        return;
      }
      if (event.type !== "prs-updated") return;
      const eventIncludesLanePr = event.prs.some((next) => next.laneId === laneId);
      const eventIncludesCurrentPr = currentPrId ? event.prs.some((next) => next.id === currentPrId) : false;
      if (eventIncludesLanePr || eventIncludesCurrentPr || !currentPrId) {
        void refresh();
      } else {
        setCurrentPr(null);
      }
    }, runtimePinRef.current);
    return unsubscribe;
  }, [laneId, refresh, runtimePinKey, setCurrentPr]);

  // Hot-refresh enriched detail (checks / reviews / merge status) whenever this
  // PR's content changes — driven by the relay's `prs-updated`, not a timer.
  const enrichedKeyRef = useRef<string | null>(null);
  // Which PR the currently-held checks/reviews/status belong to. The chips
  // above switch the selected PR synchronously, so without this the previous
  // PR's checks, reviews and merge status stayed on screen — under the new
  // PR's title, and driving the pane's red/green accent — for as long as the
  // three GitHub reads took.
  const enrichedPrIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pr) {
      enrichedKeyRef.current = null;
      enrichedPrIdRef.current = null;
      setChecks(null);
      setReviews(null);
      setStatus(null);
      return;
    }
    if (pr.unmapped) {
      enrichedKeyRef.current = null;
      enrichedPrIdRef.current = null;
      setChecks(null);
      setReviews(null);
      setStatus(null);
      return;
    }
    if (enrichedPrIdRef.current !== pr.id) {
      enrichedPrIdRef.current = pr.id;
      setChecks(null);
      setReviews(null);
      setStatus(null);
    }
    const key = `${pr.id}:${pr.updatedAt}:${pr.headSha ?? ""}`;
    if (enrichedKeyRef.current === key) return;
    enrichedKeyRef.current = key;
    const prId = pr.id;
    let cancelled = false;
    void Promise.allSettled([
      window.ade.prs.getChecks(prId, runtimePinRef.current),
      window.ade.prs.getReviews(prId, runtimePinRef.current),
      window.ade.prs.getStatus(prId, runtimePinRef.current),
    ]).then(([c, r, s]) => {
      if (cancelled) return;
      if (c.status === "fulfilled") setChecks(c.value);
      if (r.status === "fulfilled") setReviews(r.value);
      if (s.status === "fulfilled") setStatus(s.value);
    });
    return () => { cancelled = true; };
  }, [pr, runtimePinKey]);

  // GitHub stack siblings this chat could add: offer to link the whole stack.
  // Only read when the selected PR is stacked and the chat has an identity.
  useEffect(() => {
    setStackLinkError(null);
    if (!sessionId || !pr?.stack || typeof window.ade.prs.getStackLinkOffer !== "function") {
      setStackOffer(null);
      return;
    }
    let cancelled = false;
    void window.ade.prs.getStackLinkOffer({ sessionId, prId: pr.id }, runtimePinRef.current)
      .then((offer) => {
        if (cancelled) return;
        const linkable = (offer?.siblings ?? []).filter((sibling) => !sibling.claimedByOtherChat);
        setStackOffer(linkable.length > 0 ? offer : null);
      })
      .catch(() => {
        if (!cancelled) setStackOffer(null);
      });
    return () => { cancelled = true; };
  }, [pr?.id, pr?.stack, sessionId]);

  const stackOfferKey = stackOffer ? `${stackOffer.sessionId}:${stackOffer.stackNumber}` : null;
  const visibleStackOffer = stackOffer && stackOfferKey !== dismissedOfferKey ? stackOffer : null;

  const linkStack = useCallback(async () => {
    if (!visibleStackOffer) return;
    setStackLinkBusy(true);
    setStackLinkError(null);
    try {
      const result = await window.ade.prs.linkChatStack({
        sessionId: visibleStackOffer.sessionId,
        stackNumber: visibleStackOffer.stackNumber,
        prId: visibleStackOffer.prId,
      }, runtimePinRef.current);
      if (!result?.ok) {
        setStackLinkError("Could not link this GitHub stack.");
        return;
      }
      setDismissedOfferKey(`${visibleStackOffer.sessionId}:${visibleStackOffer.stackNumber}`);
      await refresh({ live: true });
    } catch (error) {
      setStackLinkError(error instanceof Error ? error.message : "Could not link this GitHub stack.");
    } finally {
      setStackLinkBusy(false);
    }
  }, [refresh, visibleStackOffer]);

  // Best-effort: is the webhook relay actually connected for this repo? Drives
  // the live/stale/offline dot so the pane reflects real webhook status.
  const prRepoOwner = pr?.repoOwner ?? null;
  const prRepoName = pr?.repoName ?? null;
  useEffect(() => {
    // Relay status describes one repository's webhook, so it must not outlive
    // the repo it was read for: selecting a PR in another repo (or one with no
    // repo yet) has to drop back to the recency-based dot rather than keep
    // claiming the previous repo's webhook is live.
    if (!prRepoOwner || !prRepoName) {
      setRelay(null);
      return;
    }
    let cancelled = false;
    setRelay(null);
    window.ade.github
      .getAppInstallationStatus({ owner: prRepoOwner, name: prRepoName })
      .then((s) => {
        if (cancelled || !s) return;
        setRelay({ configured: Boolean(s.relayConfigured), webhookActive: s.webhookState === "active" });
      })
      .catch(() => { /* leave relay unknown → recency-based dot */ });
    return () => { cancelled = true; };
  }, [prRepoOwner, prRepoName]);

  // Same rule the sidebar badge follows: a PR id only resolves on the machine
  // that owns it, so a pinned pane's "Open in ADE" would land on an empty PRs
  // tab. `openLanePr` sends a foreign PR to GitHub instead.
  const openInAde = useCallback(() => {
    if (!pr) return;
    openLanePr(pr, { foreign: Boolean(runtimePin), navigate });
  }, [pr, navigate, runtimePin]);

  const openInGitHub = useCallback(async () => {
    if (!pr) return;
    try {
      await window.ade.app.openExternal(pr.githubUrl);
    } catch {
      try { window.open(pr.githubUrl, "_blank", "noopener,noreferrer"); } catch { /* noop */ }
    }
  }, [pr]);

  const copyLink = useCallback(async () => {
    if (!pr) return;
    await copy(pr.githubUrl);
  }, [copy, pr]);

  // Ambient status accent on the pane's inner edge: red while checks fail,
  // green while it's merge-ready. Kept as an inset shadow so it never shifts
  // layout. Recomputed from the same enriched data the body renders.
  const accentShadow = useMemo(() => {
    if (!pr) return undefined;
    if (isMergeReady(pr, status)) return "inset 3px 0 0 0 rgba(52,211,153,0.55)";
    const failing =
      pr.checksStatus === "failing" ||
      (checks?.some((check) => pipelineStateOf(check) === "failed") ?? false);
    if (failing) return "inset 3px 0 0 0 rgba(248,113,113,0.5)";
    return undefined;
  }, [pr, status, checks]);

  // The ↻ spins for a manual sync in flight OR a backend reconcile-on-focus.
  const syncSpinning = syncing || reconciling;

  const selectLinkedPr = useCallback((prId: string) => {
    const entry = linkedPrs.find((candidate) => candidate.id === prId);
    if (!entry) return;
    pinnedPrIdRef.current = entry.id;
    setCurrentPr(entry);
  }, [linkedPrs, setCurrentPr]);
  const prSwitcher = useMemo<PrSwitcher | null>(
    () => (linkedPrs.length > 1 && pr
      ? { prs: linkedPrs, selectedId: pr.id, onSelect: selectLinkedPr }
      : null),
    [linkedPrs, pr, selectLinkedPr],
  );

  // The embedded detail view reads description, timeline, files, commits and
  // activity itself. Without the pin those reads went to this window's machine,
  // which has no row for another machine's PR, so the body stayed empty.
  const detailRuntime = useMemo<PrDetailRuntime | null>(() => {
    if (!runtimePin) return null;
    return {
      pin: runtimePin,
      machineName: pinMachineName ?? "this lane's machine",
      onOpenLane: () => {
        if (pinMachineId) navigate(openLaneOnMachinePath(laneId, pinMachineId));
        // The machine entry has not loaded: open the PR on its machine instead.
        else if (prRef.current) openLanePr(prRef.current, { foreign: true, navigate });
      },
    };
    // Keyed on the stable pin key; see `runtimePinRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laneId, navigate, pinMachineId, pinMachineName, runtimePinKey]);

  if (variant === "tools") {
    if (loading) {
      return <p className="px-3 py-6 text-center text-[12px] text-fg/40">Loading…</p>;
    }
    if (pr) {
      return (
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <div className="min-h-0 min-w-0 flex-1">
            <PrsProvider active={false}>
              <PrDetailPane
                pr={{ ...pr, conflictAnalysis: null }}
                status={status}
                checks={checks ?? []}
                reviews={reviews ?? []}
                comments={[]}
                detailBusy={false}
                lanes={scope.lane ? [scope.lane] : []}
                mergeMethod="squash"
                runtime={detailRuntime}
                prSwitcher={prSwitcher}
                onRefresh={async () => { await refresh({ live: true }); }}
                onNavigate={(path) => navigate(path)}
              />
            </PrsProvider>
          </div>
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto p-3.5">
        <p className="px-1 pb-3 text-[12px] font-medium text-fg/70">No pull request open</p>
        {runtimePin ? (
          <p className="px-1 text-[12px] leading-relaxed text-fg/40">
            Switch to {pinMachineName ?? "this chat's machine"} to open one.
          </p>
        ) : (
          <>
            <ChatPrInlineCreator
              laneId={laneId}
              branchName={branchName ?? null}
              sessionTitle={sessionTitle}
              sessionId={sessionId}
              onCreated={handleCreated}
            />
            <ChatPrLinkRow laneId={laneId} sessionId={sessionId} onLinked={handleLinked} />
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col font-sans" style={accentShadow ? { boxShadow: accentShadow } : undefined}>
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-fg/[0.06] px-3">
        <GitPullRequest size={12} weight="bold" className="shrink-0 text-fg/45" />
        <span className="min-w-0 truncate text-[11.5px] font-medium text-fg/70">
          {prSwitcher && pr ? `#${pr.githubPrNumber}` : "Pull request"}
        </span>
        {prSwitcher ? <PrSwitcherMenu switcher={prSwitcher} /> : null}
        {prSwitcher ? <PrSwitcherStepper switcher={prSwitcher} className="ml-1" /> : null}
        <button
          type="button"
          onClick={() => void handleSyncLanePr()}
          disabled={syncing}
          className={cn(titleBarIconButton, "ml-auto")}
          title={syncSpinning ? "Syncing PR status…" : "Refresh pull request"}
          aria-label="Refresh pull request"
        >
          <ArrowsClockwise size={12} weight="bold" className={cn(syncSpinning && "animate-spin")} />
        </button>
        <button
          type="button"
          onClick={onClose}
          className={titleBarIconButton}
          title="Close"
          aria-label="Close pull request panel"
        >
          <X size={12} weight="bold" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
        {loading ? (
          <p className="px-1 py-6 text-center text-[12px] text-fg/40">Loading…</p>
        ) : pr ? (
          <>
          <PrDetails
            pr={pr}
            checks={checks}
            reviews={reviews}
            status={status}
            relay={relay}
            copied={copied}
            onOpenAde={openInAde}
            onOpenGitHub={() => void openInGitHub()}
            onCopy={() => void copyLink()}
          />
          {visibleStackOffer ? (
            <div className="pt-2">
              <Banner
                layout="inline"
                model={{
                  id: `pr-stack-offer:${visibleStackOffer.sessionId}:${visibleStackOffer.stackNumber}`,
                  tone: "accent",
                  icon: <Stack size={13} weight="fill" />,
                  title: `Also in GitHub Stack #${visibleStackOffer.stackNumber}`,
                  detail: visibleStackOffer.siblings
                    .filter((sibling) => !sibling.claimedByOtherChat)
                    .map((sibling) => `#${sibling.githubPrNumber}`)
                    .join(", "),
                  actions: [
                    { label: "Link stack", onClick: () => void linkStack(), disabled: stackLinkBusy },
                    { label: "Not now", onClick: () => setDismissedOfferKey(stackOfferKey) },
                  ],
                  busy: stackLinkBusy,
                  ...(stackLinkError ? { error: stackLinkError } : {}),
                }}
              />
            </div>
          ) : null}
          {runtimePin ? null : (
            <ChatPrLinkRow laneId={laneId} sessionId={sessionId} onLinked={handleLinked} />
          )}
          </>
        ) : runtimePin ? (
          // Reading a foreign lane's PR is now routed to its machine; CREATING
          // one is not. The creator derives its branch, base and Linear link
          // from `state.lanes` — the bound machine's lanes, which do not contain
          // this lane — and `createFromLane` is unpinned, so it would run
          // against the wrong machine. Say so instead of offering a button that
          // cannot work.
          <p className="px-1 py-6 text-center text-[12px] leading-relaxed text-fg/40">
            No pull request yet.
            <br />
            Switch to {pinMachineName ?? "this chat's machine"} to open one.
          </p>
        ) : (
          <>
            <ChatPrInlineCreator
              laneId={laneId}
              branchName={branchName ?? null}
              sessionTitle={sessionTitle}
              sessionId={sessionId}
              onCreated={handleCreated}
            />
            <ChatPrLinkRow laneId={laneId} sessionId={sessionId} onLinked={handleLinked} />
          </>
        )}
      </div>
    </div>
  );
});

export default ChatPrPane;
