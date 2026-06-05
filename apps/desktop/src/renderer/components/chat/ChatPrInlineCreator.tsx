import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { CircleNotch, GitPullRequest, Warning } from "@phosphor-icons/react";
import { BranchIcon } from "../ui/vcsIcons";
import { useAppStore } from "../../state/appStore";
import type { GitBranchSummary } from "../../../shared/types";
import { resolveLaneBaseBranch } from "../prs/shared/laneBranchTargets";

/**
 * Compact inline pull-request creator embedded directly in the left PR
 * floating pane. Replaces the route-away "Create pull request" handoff: the
 * user picks a target branch + title and submits without leaving the Work tab.
 *
 * On success we rely on the parent ChatPrPane's `prs.onEvent` subscription to
 * swap to the PR-details view, so this component only triggers creation. A tiny
 * "Open full composer" link routes power users to the full modal in the PRs
 * tab. Background stays transparent so the floating pane's sidebar tone shows
 * through — neutral greys + one violet accent, matching the shared pane design.
 */

const fieldLabel =
  "block text-[10px] font-medium uppercase tracking-wide text-fg/40";

const inputBase =
  "w-full rounded-lg border border-white/[0.07] bg-white/[0.03] px-2.5 py-1.5 text-[12px] text-fg/85 outline-none transition-colors placeholder:text-fg/30 focus:border-violet-400/40 focus:bg-white/[0.05]";

export const ChatPrInlineCreator = React.memo(function ChatPrInlineCreator({
  laneId,
  branchName,
}: {
  laneId: string;
  branchName?: string | null;
}) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);

  const lane = useMemo(() => lanes.find((l) => l.id === laneId) ?? null, [lanes, laneId]);
  const primaryLane = useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);

  const defaultBase = useMemo(
    () =>
      resolveLaneBaseBranch({
        lane,
        lanes,
        primaryBranchRef: primaryLane?.branchRef ?? null,
      }),
    [lane, lanes, primaryLane?.branchRef],
  );

  const [baseBranch, setBaseBranch] = useState("");
  const [title, setTitle] = useState("");
  const [branches, setBranches] = useState<GitBranchSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const baseTouchedRef = useRef(false);
  const titleTouchedRef = useRef(false);

  // Default the target branch to the lane's resolved base until the user edits it.
  useEffect(() => {
    if (baseTouchedRef.current) return;
    if (defaultBase) setBaseBranch(defaultBase);
  }, [defaultBase]);

  // Default the title to the lane name (fallback: branch name) until edited.
  useEffect(() => {
    if (titleTouchedRef.current) return;
    const fallback = lane?.name?.trim() || branchName?.trim() || "";
    if (fallback) setTitle(fallback);
  }, [lane?.name, branchName]);

  // Load branch list for the target-branch picker (same source the modal uses).
  useEffect(() => {
    const sourceLaneId = primaryLane?.id ?? laneId;
    if (!sourceLaneId) return;
    let cancelled = false;
    window.ade.git
      .listBranches({ laneId: sourceLaneId })
      .then((list) => {
        if (!cancelled) setBranches(list);
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [primaryLane?.id, laneId]);

  const branchOptions = useMemo(() => {
    const seen = new Set<string>();
    const options: string[] = [];
    for (const b of branches) {
      const name = b.isRemote ? b.name.replace(/^[^/]+\//, "") : b.name;
      if (!seen.has(name)) {
        seen.add(name);
        options.push(name);
      }
    }
    return options.sort((a, b) => a.localeCompare(b));
  }, [branches]);

  const compare = lane?.status ?? null;

  const handleCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmedTitle = title.trim();
      const trimmedBase = baseBranch.trim();
      await window.ade.prs.createFromLane({
        laneId,
        title: trimmedTitle || lane?.name || branchName || "PR",
        body: "",
        draft: false,
        ...(trimmedBase ? { baseBranch: trimmedBase } : {}),
      });
      // Success: ChatPrPane's prs.onEvent subscription swaps to the details
      // view automatically, so we leave busy=true until this unmounts.
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
      setBusy(false);
    }
  }, [baseBranch, branchName, lane?.name, laneId, title]);

  const openFullComposer = useCallback(() => {
    const params = new URLSearchParams({ tab: "normal", create: "1", sourceLaneId: laneId, target: "primary" });
    navigate(`/prs?${params.toString()}`);
  }, [laneId, navigate]);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-[1.5] text-fg/55">No pull request yet — open one for this lane.</p>

      <div className="flex flex-col gap-1">
        <label htmlFor="chat-pr-target" className={fieldLabel}>Target branch</label>
        <div className="relative">
          <BranchIcon
            size={12}
            weight="bold"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg/35"
          />
          <input
            id="chat-pr-target"
            list="chat-pr-branch-options"
            value={baseBranch}
            onChange={(e) => {
              baseTouchedRef.current = true;
              setBaseBranch(e.target.value);
            }}
            disabled={busy}
            placeholder="main"
            spellCheck={false}
            className={`${inputBase} pl-7 font-mono`}
          />
          <datalist id="chat-pr-branch-options">
            {branchOptions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="chat-pr-title" className={fieldLabel}>Title</label>
        <input
          id="chat-pr-title"
          value={title}
          onChange={(e) => {
            titleTouchedRef.current = true;
            setTitle(e.target.value);
          }}
          disabled={busy}
          placeholder={lane?.name ?? branchName ?? "Pull request title"}
          className={inputBase}
        />
      </div>

      {compare && (compare.ahead > 0 || compare.behind > 0 || compare.dirty) ? (
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-fg/40">
          <span><span className="text-fg/55">{compare.ahead}</span> ahead</span>
          <span><span className="text-fg/55">{compare.behind}</span> behind</span>
          <span className={compare.dirty ? "text-amber-300/80" : "text-emerald-300/70"}>
            {compare.dirty ? "dirty" : "clean"}
          </span>
        </div>
      ) : null}

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

      <button
        type="button"
        onClick={() => void handleCreate()}
        disabled={busy}
        className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-violet-400/25 bg-violet-500/10 px-3 py-2 text-[12px] font-medium text-violet-100 transition-colors hover:bg-violet-500/15 disabled:cursor-default disabled:opacity-70"
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

      <button
        type="button"
        onClick={openFullComposer}
        disabled={busy}
        className="self-start text-[11px] text-fg/35 underline-offset-2 transition-colors hover:text-fg/60 hover:underline disabled:opacity-50"
      >
        Open full composer
      </button>
    </div>
  );
});

export default ChatPrInlineCreator;
