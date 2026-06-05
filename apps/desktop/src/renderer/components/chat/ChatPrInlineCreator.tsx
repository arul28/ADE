import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowSquareOut,
  CircleNotch,
  GitPullRequest,
  LockSimple,
  Sparkle,
  Warning,
} from "@phosphor-icons/react";
import { BranchIcon } from "../ui/vcsIcons";
import { LaneCombobox } from "../terminals/LaneCombobox";
import { LaneLogoMark, laneDisplayColor } from "../terminals/LaneChip";
import { useAppStore } from "../../state/appStore";
import { branchNameFromRef, resolveLaneBaseBranch } from "../prs/shared/laneBranchTargets";
import {
  buildLinearPrReference,
  buildLinearPrTitle,
  ensureLinearPrReference,
} from "../../../shared/linearMagicWords";

/**
 * Lightweight pull-request creator embedded in the left PR floating pane. A
 * condensed, single-PR mirror of the PRs-tab `CreatePrModal`, styled with the
 * modal's bold accent. Source + target are 2-line lane/branch rows (lane on top
 * tinted with the lane's color, branch indented below) — the source is a locked
 * tile, the target is the canonical `LaneCombobox` dropdown (no free-text). No
 * PR-type selector here — queue/integration live in the full composer ("Open in
 * PRs tab").
 *
 * The "AI draft" button runs ADE's `pr_descriptions` background job (same engine
 * as auto-commit) using the CHAT's active model, and surfaces real failures
 * (`requireAi`) instead of silently returning a template. We deliberately do NOT
 * inject Linear magic words or the "Open in ADE" deeplink footer here — prService
 * owns those trailers on create (idempotently), so the editable fields stay clean.
 *
 * On success we do NOT navigate: ChatPrPane's `prs.onEvent` subscription swaps to
 * the live PR-details panel automatically.
 */

const sectionLabel = "block text-[10px] font-semibold uppercase tracking-[0.08em] text-fg/45";

// --color-accent is #A78BFA (== Tailwind violet-400); use the named color so the
// /opacity focus modifier resolves (Tailwind can't apply opacity to a var() color).
const inputBase =
  "w-full rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-fg/85 outline-none transition-colors placeholder:text-fg/30 focus:border-violet-400/55 focus:bg-white/[0.05]";

export const ChatPrInlineCreator = React.memo(function ChatPrInlineCreator({
  laneId,
  branchName,
  chatModelId,
}: {
  laneId: string;
  branchName?: string | null;
  /** The active chat session's model — the AI draft runs on this exact model. */
  chatModelId?: string | null;
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
  const [drafting, setDrafting] = useState(false);
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

  // Default the title: Linear-flavored when linked, else lane name / branch.
  useEffect(() => {
    if (titleTouchedRef.current) return;
    const next = linearIssue
      ? buildLinearPrTitle(linearIssue)
      : lane?.name?.trim() || branchName?.trim() || "";
    if (next) setTitle(next);
  }, [linearIssue, lane?.name, branchName]);

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

  const handleDraftAI = useCallback(async () => {
    setDrafting(true);
    setError(null);
    try {
      // Runs the pr_descriptions background job on the chat's active model and
      // surfaces real failures (requireAi) instead of returning a stub template.
      const result = await window.ade.prs.draftDescription({
        laneId,
        requireAi: true,
        ...(resolvedBaseBranch ? { baseBranch: resolvedBaseBranch } : {}),
        ...(chatModelId ? { model: chatModelId } : {}),
      });
      const nextTitle =
        linearIssue && !result.title.includes(linearIssue.identifier)
          ? buildLinearPrTitle(linearIssue)
          : result.title;
      const nextBody = linearIssue
        ? ensureLinearPrReference(result.body, linearIssue, true, { preserveExisting: false })
        : result.body;
      titleTouchedRef.current = true;
      bodyTouchedRef.current = true;
      setTitle(nextTitle);
      setBody(nextBody);
    } catch (err: unknown) {
      setError(cleanError(err));
    } finally {
      setDrafting(false);
    }
  }, [resolvedBaseBranch, laneId, linearIssue, chatModelId]);

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const resolvedTitle =
        linearIssue && !title.trim()
          ? buildLinearPrTitle(linearIssue)
          : title.trim() || lane?.name || branchName || "PR";
      await window.ade.prs.createFromLane({
        laneId,
        title: resolvedTitle,
        body,
        draft: false,
        ...(linearIssue ? { closeLinearIssueOnMerge: true } : {}),
        ...(resolvedBaseBranch ? { baseBranch: resolvedBaseBranch } : {}),
      });
      // Success: ChatPrPane's prs.onEvent subscription swaps to the details view
      // automatically, so we leave busy=true until this unmounts.
    } catch (err: unknown) {
      setError(cleanError(err));
      setBusy(false);
    }
  }, [body, branchName, lane?.name, laneId, linearIssue, resolvedBaseBranch, title]);

  // The full composer (queue / integration + multi-lane ordering) lives in the
  // PRs tab; this just hands off with the lane pre-selected.
  const openFullComposer = useCallback(() => {
    const params = new URLSearchParams({ tab: "normal", create: "1", sourceLaneId: laneId, target: "primary" });
    navigate(`/prs?${params.toString()}`);
  }, [laneId, navigate]);

  const interactive = !busy && !drafting;

  return (
    <div className="flex flex-col gap-3.5">
      {/* Source lane + branch — locked. Mirrors a LaneCombobox row (lane tinted
          with its color on top, branch indented below) but immutable. */}
      <div className="flex flex-col gap-1.5">
        <span className={sectionLabel}>Source lane and branch</span>
        <div className="flex min-h-[40px] items-center gap-2 rounded-lg border border-white/[0.05] bg-white/[0.02] px-2.5 py-1.5">
          <LaneLogoMark color={sourceColor} size={12} />
          <div className="flex min-w-0 flex-1 flex-col leading-[1.2]">
            <span className="truncate text-[12px] font-semibold" style={{ color: sourceColor }} title={laneName}>
              {laneName}
            </span>
            <span className="mt-0.5 inline-flex min-w-0 items-center gap-1 text-[10px] text-muted-fg/85" title={sourceBranch}>
              <BranchIcon size={9} weight="regular" className="shrink-0 opacity-55" />
              <span className="min-w-0 truncate font-mono">{sourceBranch}</span>
            </span>
          </div>
          <LockSimple size={11} weight="fill" className="ml-0.5 shrink-0 text-fg/25" />
        </div>
      </div>

      {/* Target lane + branch — canonical 2-line dropdown, no free text. */}
      <div className="flex flex-col gap-1.5">
        <span className={sectionLabel}>Target lane and branch</span>
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
      </div>

      {/* Comparison — compact ahead / behind / clean from lane.status. */}
      {lane?.status ? (
        <div className="flex items-center gap-3 text-[11px]">
          <span><span className="font-semibold text-fg/85">{lane.status.ahead}</span> <span className="text-fg/40">ahead</span></span>
          <span><span className="font-semibold text-fg/85">{lane.status.behind}</span> <span className="text-fg/40">behind</span></span>
          <span
            className="font-semibold uppercase tracking-wide"
            style={{ color: lane.status.dirty ? "var(--color-warning)" : "var(--color-success)" }}
          >
            {lane.status.dirty ? "Dirty" : "Clean"}
          </span>
        </div>
      ) : null}

      {/* Title. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label htmlFor="chat-pr-title" className={sectionLabel}>Title</label>
          <button
            type="button"
            onClick={() => void handleDraftAI()}
            disabled={!interactive}
            title="Draft title & description with AI (uses this chat's model)"
            className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-accent)] transition-opacity hover:opacity-80 disabled:opacity-50"
          >
            {drafting ? (
              <CircleNotch size={11} weight="bold" className="animate-spin" />
            ) : (
              <Sparkle size={11} weight="fill" />
            )}
            {drafting ? "Drafting…" : "AI draft"}
          </button>
        </div>
        <input
          id="chat-pr-title"
          value={title}
          onChange={(e) => {
            titleTouchedRef.current = true;
            setTitle(e.target.value);
          }}
          disabled={!interactive}
          placeholder={lane?.name ?? branchName ?? "Pull request title"}
          className={inputBase}
        />
      </div>

      {/* Body — optional, multi-line. */}
      <div className="flex flex-col gap-1.5">
        <label htmlFor="chat-pr-body" className={sectionLabel}>Description <span className="normal-case text-fg/25">(optional)</span></label>
        <textarea
          id="chat-pr-body"
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
      </div>

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
