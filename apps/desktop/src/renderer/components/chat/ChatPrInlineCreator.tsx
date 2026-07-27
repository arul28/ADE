import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDown,
  ArrowSquareOut,
  CircleNotch,
  GitPullRequest,
  LockSimple,
  Warning,
} from "@phosphor-icons/react";
import { BranchIcon } from "../ui/vcsIcons";
import { LaneCombobox } from "../terminals/LaneCombobox";
import { LaneLogoMark, laneDisplayColor } from "../terminals/LaneChip";
import { useAppStore } from "../../state/appStore";
import type { PrSummary } from "../../../shared/types";
import { branchNameFromRef, resolveLaneBaseBranch } from "../prs/shared/laneBranchTargets";
import { buildLinearPrReference } from "../../../shared/linearMagicWords";

/**
 * Lightweight pull-request creator embedded in the left PR floating pane. A
 * condensed, single-PR mirror of the PRs-tab `CreatePrModal`, styled with the
 * modal's bold accent.
 *
 * Layout is a "flow": a flat source row (lane + branch, locked) → an arrow
 * connector carrying the ahead/behind/dirty comparison → the canonical
 * `LaneCombobox` target dropdown (no free-text) → title / description / create.
 * There are no section labels: the source is visibly immutable (lock glyph, no
 * box) and the target is visibly a dropdown, so the old uppercase captions and
 * the two identical 46px tiles they distinguished are gone. No PR-type selector
 * here — queue/integration live in the full composer ("Open in PRs tab").
 *
 * Linear magic words and the "Open in ADE" deeplink footer are owned by
 * prService on create (idempotently), so the editable fields stay clean.
 *
 * On success we do NOT navigate: we hand the freshly-created PR up via `onCreated`
 * so ChatPrPane swaps to the live PR-details panel immediately (the subsequent
 * `prs.onEvent` poll just enriches the same row with checks/review state).
 */

// --color-accent is #A78BFA (== Tailwind violet-400); use the named color so the
// /opacity focus modifier resolves (Tailwind can't apply opacity to a var() color).
const inputBase =
  "w-full rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-fg/85 outline-none transition-colors placeholder:text-fg/30 focus:border-violet-400/55 focus:bg-white/[0.05]";

export const ChatPrInlineCreator = React.memo(function ChatPrInlineCreator({
  laneId,
  branchName,
  sessionTitle,
  onCreated,
}: {
  laneId: string;
  branchName?: string | null;
  /**
   * Title of the chat this creator was opened from. When it's a real title (not
   * the placeholder "New chat") it seeds the PR title, which is far closer to a
   * shippable title than the lane → target derivation. Optional: callers without
   * a session (e.g. the Work grid) simply fall back to the derivation.
   */
  sessionTitle?: string | null;
  /**
   * Called the instant `createFromLane` resolves, with the freshly-created PR.
   * The parent swaps to the live PR-details view immediately instead of waiting
   * for the next GitHub polling round-trip (`prs-updated`) to arrive. Required:
   * the success path relies on the parent unmounting this creator, so omitting
   * it would leave the button stuck "Creating…".
   */
  onCreated: (pr: PrSummary) => void;
}) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);

  const lane = useMemo(() => lanes.find((l) => l.id === laneId) ?? null, [lanes, laneId]);
  const primaryLane = useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  const linearIssue = lane?.linearIssue ?? null;

  // Source is the lane's own branch — locked, exactly like the modal.
  const sourceBranch = useMemo(
    () => branchNameFromRef(lane?.branchRef ?? null) || branchName || "(lane branch)",
    [lane?.branchRef, branchName],
  );
  const laneName = lane?.name?.trim() || "This lane";
  const sourceColor = laneDisplayColor(lane?.color); // never null — lanes always have a color

  const defaultBase = useMemo(
    () =>
      resolveLaneBaseBranch({
        lane,
        lanes,
        primaryBranchRef: primaryLane?.branchRef ?? null,
      }),
    [lane, lanes, primaryLane?.branchRef],
  );

  // Target options: every other live lane (one branch per lane = lane.branchRef).
  const targetLanes = useMemo(
    () => lanes.filter((l) => !l.archivedAt && l.id !== laneId),
    [lanes, laneId],
  );
  // Default the target to whichever lane carries the resolved base branch, else
  // the primary lane (main), else the first option.
  const defaultTargetLaneId = useMemo(() => {
    const match = targetLanes.find((l) => branchNameFromRef(l.branchRef) === defaultBase);
    return match?.id ?? primaryLane?.id ?? targetLanes[0]?.id ?? "";
  }, [targetLanes, defaultBase, primaryLane?.id]);

  const [targetLaneId, setTargetLaneId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targetTouchedRef = useRef(false);
  const titleTouchedRef = useRef(false);
  const bodyTouchedRef = useRef(false);

  // Adopt the computed default target until the user picks one.
  useEffect(() => {
    if (targetTouchedRef.current) return;
    if (defaultTargetLaneId) setTargetLaneId(defaultTargetLaneId);
  }, [defaultTargetLaneId]);

  const targetLane = useMemo(
    () => targetLanes.find((l) => l.id === targetLaneId) ?? null,
    [targetLanes, targetLaneId],
  );
  const resolvedBaseBranch = useMemo(
    () => (targetLane ? branchNameFromRef(targetLane.branchRef) : defaultBase) || "",
    [targetLane, defaultBase],
  );
  // Prefer the chat's own title — it describes the work, unlike the lane → target
  // direction, which is never a shippable PR title. "New chat" is the placeholder
  // a session carries before its background rename lands, so it never wins.
  const trimmedSessionTitle = sessionTitle?.trim() ?? "";
  const defaultTitle = useMemo(() => {
    if (trimmedSessionTitle && trimmedSessionTitle !== "New chat") return trimmedSessionTitle;
    const targetName = targetLane?.name?.trim() || resolvedBaseBranch || "target";
    return `${laneName} -> ${targetName}`;
  }, [laneName, resolvedBaseBranch, targetLane?.name, trimmedSessionTitle]);

  // Default the title to the merge direction until the user types their own.
  useEffect(() => {
    if (titleTouchedRef.current) return;
    setTitle(defaultTitle);
  }, [defaultTitle]);

  // Seed the body with the Linear reference line when linked (idempotent with
  // prService's server-side linkage, which owns the canonical trailers).
  useEffect(() => {
    if (bodyTouchedRef.current) return;
    setBody(linearIssue ? `${buildLinearPrReference(linearIssue, true)}\n` : "");
  }, [linearIssue]);

  const cleanError = (err: unknown): string =>
    (err instanceof Error ? err.message : String(err)).replace(
      /^Error invoking remote method '[^']+': (?:Error: )?/,
      "",
    );

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const resolvedTitle = title.trim() || defaultTitle;
      const created = await window.ade.prs.createFromLane({
        laneId,
        title: resolvedTitle,
        body,
        draft: false,
        ...(linearIssue ? { closeLinearIssueOnMerge: true } : {}),
        ...(resolvedBaseBranch ? { baseBranch: resolvedBaseBranch } : {}),
      });
      // createFromLane has already persisted the PR row and returns the full
      // summary — hand it straight to the parent so it swaps to the details view
      // in real time. We deliberately leave busy=true: onCreated unmounts this
      // creator, and the later `prs-updated` poll just enriches the same PR.
      // Production always returns a PrSummary; only the web-preview mock can
      // resolve null — recover the button in that case rather than spinning.
      if (created) {
        onCreated(created);
      } else {
        setBusy(false);
      }
    } catch (err: unknown) {
      setError(cleanError(err));
      setBusy(false);
    }
  }, [body, defaultTitle, laneId, linearIssue, onCreated, resolvedBaseBranch, title]);

  // The full composer (queue / integration + multi-lane ordering) lives in the
  // PRs tab; this just hands off with the lane pre-selected.
  const openFullComposer = useCallback(() => {
    const params = new URLSearchParams({ tab: "normal", create: "1", sourceLaneId: laneId, target: "primary" });
    navigate(`/prs?${params.toString()}`);
  }, [laneId, navigate]);

  const interactive = !busy;

  return (
    <div className="flex flex-col gap-3">
      {/* Source — a flat, boxless row. The lock glyph (not a caption) is what
          says "immutable", so it can't be mistaken for the target dropdown. */}
      <div className="flex min-w-0 items-center gap-2 px-0.5">
        <LaneLogoMark color={sourceColor} size={12} />
        <span
          className="min-w-0 shrink truncate text-[12px] font-semibold"
          style={{ color: sourceColor }}
          title={laneName}
        >
          {laneName}
        </span>
        <BranchIcon size={9} weight="regular" className="shrink-0 opacity-55" />
        <span className="min-w-0 shrink truncate font-mono text-[10px] text-muted-fg/85" title={sourceBranch}>
          {sourceBranch}
        </span>
        <LockSimple size={11} weight="fill" className="ml-auto shrink-0 text-fg/25" />
      </div>

      {/* Connector — the arrow makes source → target read as one route, and
          carries the ahead / behind / dirty comparison. Without lane.status we
          still render the arrow (muted "comparing…") so the flow never collapses. */}
      <div className="flex items-center gap-2 pl-1 text-[11px] text-fg/40">
        <ArrowDown size={12} className="shrink-0" />
        {lane?.status ? (
          <>
            <span className="min-w-0 truncate">
              {lane.status.ahead} ahead · {lane.status.behind} behind ·{" "}
            </span>
            <span
              className="shrink-0 font-medium"
              style={{ color: lane.status.dirty ? "var(--color-warning)" : "var(--color-success)" }}
            >
              {lane.status.dirty ? "dirty" : "clean"}
            </span>
          </>
        ) : (
          <span className="text-fg/30">comparing…</span>
        )}
      </div>

      {/* Target lane + branch — canonical 2-line dropdown, no free text. */}
      <LaneCombobox
        lanes={targetLanes}
        value={targetLaneId}
        onChange={(id) => {
          targetTouchedRef.current = true;
          setTargetLaneId(id);
        }}
        variant="default"
        fullWidth
        placeholder="Select target lane…"
        aria-label="Target lane and branch"
      />

      {/* Title — labelled by aria-label now that the visible caption is gone. */}
      <input
        id="chat-pr-title"
        aria-label="Pull request title"
        value={title}
        onChange={(e) => {
          titleTouchedRef.current = true;
          setTitle(e.target.value);
        }}
        disabled={!interactive}
        placeholder={defaultTitle}
        className={inputBase}
      />

      {/* Body — optional, multi-line. */}
      <textarea
        id="chat-pr-body"
        aria-label="Pull request description"
        value={body}
        onChange={(e) => {
          bodyTouchedRef.current = true;
          setBody(e.target.value);
        }}
        disabled={!interactive}
        rows={3}
        placeholder="What does this change do?"
        className={`${inputBase} resize-none leading-[1.5]`}
      />

      <AnimatePresence initial={false}>
        {error ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="flex items-start gap-1.5 rounded-lg border border-red-400/25 bg-red-500/[0.07] px-2.5 py-1.5 text-[11px] leading-[1.45] text-red-200/90">
              <Warning size={12} weight="fill" className="mt-px shrink-0 text-red-300/80" />
              <span className="min-w-0 break-words">{error}</span>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Create — bold accent, matching the modal's primary action. */}
      <button
        type="button"
        onClick={() => void handleCreate()}
        disabled={!interactive}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[color:var(--color-accent)] px-3 py-2 text-[12px] font-semibold text-[color:var(--color-accent-fg)] shadow-[0_1px_0_rgba(255,255,255,0.08)_inset] transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-55"
      >
        {busy ? (
          <>
            <CircleNotch size={13} weight="bold" className="animate-spin" />
            Creating…
          </>
        ) : (
          <>
            <GitPullRequest size={13} weight="bold" />
            Create pull request
          </>
        )}
      </button>

      {/* Hand off to the full PRs-tab composer (queue / integration / review steps). */}
      <button
        type="button"
        onClick={openFullComposer}
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-white/[0.08] bg-transparent px-3 py-1.5 text-[11px] font-medium text-fg/55 transition-colors hover:border-white/[0.14] hover:text-fg/85 disabled:opacity-50"
      >
        Open in PRs tab
        <ArrowSquareOut size={11} weight="bold" className="opacity-60" />
      </button>
    </div>
  );
});

export default ChatPrInlineCreator;
