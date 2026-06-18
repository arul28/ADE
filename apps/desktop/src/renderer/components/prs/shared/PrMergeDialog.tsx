import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  CaretDown,
  GitMerge,
  Terminal,
  Warning,
} from "@phosphor-icons/react";

import type {
  MergeMethod,
  PrCommit,
  PrStatus,
  PrWithConflicts,
} from "../../../../shared/types/prs";
import { LaneDialogShell } from "../../lanes/LaneDialogShell";
import { COLORS, MONO_FONT, SANS_FONT } from "../../lanes/laneDesignTokens";
import {
  buildDefaultCommitMessage,
  buildMergeCommandLineInstructions,
  canAttemptMerge,
  mergeMethodLabel,
  mergeMethodShortLabel,
} from "./prMergeRailUtils";

export type PrMergeDialogResult = {
  method: MergeMethod;
  commitTitle?: string;
  commitBody?: string;
  bypassRules: boolean;
  expectedHeadSha?: string;
};

export type PrMergeDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pr: PrWithConflicts;
  status: PrStatus | null;
  commits: PrCommit[];
  /** Remembered default method (from localStorage). */
  defaultMethod: MergeMethod;
  actionBusy: boolean;
  onMerge: (result: PrMergeDialogResult) => void;
  /** Persist the chosen method as the new default. */
  onMethodChange?: (method: MergeMethod) => void;
};

const MERGE_METHODS: MergeMethod[] = ["squash", "merge", "rebase"];

export const PrMergeDialog = memo(function PrMergeDialog({
  open,
  onOpenChange,
  pr,
  status,
  commits,
  defaultMethod,
  actionBusy,
  onMerge,
  onMethodChange,
}: PrMergeDialogProps) {
  const [method, setMethod] = useState<MergeMethod>(defaultMethod);
  const [commitTitle, setCommitTitle] = useState("");
  const [commitBody, setCommitBody] = useState("");
  const [methodMenuOpen, setMethodMenuOpen] = useState(false);
  const [bypassRules, setBypassRules] = useState(false);
  const [overrideArmed, setOverrideArmed] = useState(false);
  const [showCli, setShowCli] = useState(false);
  const [staleHead, setStaleHead] = useState(false);

  const methodMenuRef = useRef<HTMLDivElement | null>(null);
  const overrideArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Head SHA captured when the dialog opened — drives the stale-head guard.
  const openedHeadShaRef = useRef<string | null>(null);

  const showCommitEditor = method !== "rebase";
  const canBypass = Boolean(status?.canBypass) && status?.mergeStateStatus === "blocked";
  const mergeEnabled = canAttemptMerge({ pr, status, bypassRules });

  const computeDefaults = useCallback(
    (forMethod: MergeMethod) =>
      buildDefaultCommitMessage({
        method: forMethod,
        prTitle: pr.title,
        prNumber: pr.githubPrNumber,
        headBranch: pr.headBranch,
        baseBranch: pr.baseBranch,
        repoOwner: pr.repoOwner,
        commits,
      }),
    [commits, pr.baseBranch, pr.githubPrNumber, pr.headBranch, pr.repoOwner, pr.title],
  );

  // Seed the editor + capture the head SHA each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setMethod(defaultMethod);
    const defaults = computeDefaults(defaultMethod);
    setCommitTitle(defaults.title);
    setCommitBody(defaults.body);
    setBypassRules(false);
    setOverrideArmed(false);
    setStaleHead(false);
    openedHeadShaRef.current = status?.headSha ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Re-fill defaults when the user switches method while the dialog is open.
  const handleSelectMethod = useCallback(
    (next: MergeMethod) => {
      setMethod(next);
      setMethodMenuOpen(false);
      onMethodChange?.(next);
      const defaults = computeDefaults(next);
      setCommitTitle(defaults.title);
      setCommitBody(defaults.body);
    },
    [computeDefaults, onMethodChange],
  );

  // Stale-head guard: if the PR head advances while the dialog is open, warn
  // and refresh the default commit message off the new head.
  useEffect(() => {
    if (!open) return;
    const captured = openedHeadShaRef.current;
    const current = status?.headSha ?? null;
    if (captured && current && captured !== current) {
      setStaleHead(true);
      openedHeadShaRef.current = current;
      const defaults = computeDefaults(method);
      setCommitTitle(defaults.title);
      setCommitBody(defaults.body);
    }
  }, [computeDefaults, method, open, status?.headSha]);

  // Reset the bypass arm if bypass becomes unavailable.
  useEffect(() => {
    if (!canBypass) {
      setBypassRules(false);
      setOverrideArmed(false);
    }
  }, [canBypass]);

  useEffect(() => {
    if (!methodMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!methodMenuRef.current?.contains(event.target as Node)) setMethodMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [methodMenuOpen]);

  useEffect(() => () => {
    if (overrideArmTimer.current) clearTimeout(overrideArmTimer.current);
  }, []);

  const handleResetDefaults = useCallback(() => {
    const defaults = computeDefaults(method);
    setCommitTitle(defaults.title);
    setCommitBody(defaults.body);
  }, [computeDefaults, method]);

  const cliInstructions = useMemo(
    () =>
      buildMergeCommandLineInstructions({
        repoOwner: pr.repoOwner,
        repoName: pr.repoName,
        prNumber: pr.githubPrNumber,
        method,
        bypassRules,
      }),
    [bypassRules, method, pr.githubPrNumber, pr.repoName, pr.repoOwner],
  );

  const submitMerge = useCallback(() => {
    if (actionBusy || !mergeEnabled) return;
    onMerge({
      method,
      commitTitle: showCommitEditor ? commitTitle : undefined,
      commitBody: showCommitEditor ? commitBody : undefined,
      bypassRules,
      expectedHeadSha: status?.headSha ?? undefined,
    });
  }, [actionBusy, bypassRules, commitBody, commitTitle, mergeEnabled, method, onMerge, showCommitEditor, status?.headSha]);

  const handlePrimaryClick = useCallback(() => {
    // Override path requires a deliberate second click (arm/confirm).
    if (bypassRules) {
      if (overrideArmed) {
        if (overrideArmTimer.current) clearTimeout(overrideArmTimer.current);
        setOverrideArmed(false);
        submitMerge();
        return;
      }
      setOverrideArmed(true);
      if (overrideArmTimer.current) clearTimeout(overrideArmTimer.current);
      overrideArmTimer.current = setTimeout(() => setOverrideArmed(false), 4000);
      return;
    }
    submitMerge();
  }, [bypassRules, overrideArmed, submitMerge]);

  const primaryLabel = actionBusy
    ? "Merging…"
    : bypassRules
      ? (overrideArmed ? "Click again to override" : "Override & merge")
      : `Confirm ${mergeMethodShortLabel(method).toLowerCase()}`;

  return (
    <LaneDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title={`Merge pull request #${pr.githubPrNumber}`}
      icon={GitMerge}
      busy={actionBusy}
      widthClassName="w-[min(660px,calc(100vw-2rem))]"
    >
      <div className="flex flex-col gap-4">
        {staleHead ? (
          <div
            data-testid="pr-merge-stale-head"
            className="flex items-start gap-2 rounded-lg px-3 py-2 text-[11px] leading-snug"
            style={{
              color: COLORS.warning,
              background: "color-mix(in srgb, var(--color-warning) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--color-warning) 28%, transparent)",
              fontFamily: SANS_FONT,
            }}
          >
            <Warning size={14} weight="fill" style={{ flexShrink: 0, marginTop: 1 }} />
            PR updated since you opened — defaults refreshed.
          </div>
        ) : null}

        {/* Method dropdown */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
            Merge method
          </span>
          <div className="relative" ref={methodMenuRef}>
            <button
              type="button"
              onClick={() => setMethodMenuOpen((o) => !o)}
              className="flex h-9 w-full items-center justify-between rounded-md px-3 text-[12px] font-medium"
              style={{
                color: COLORS.textPrimary,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
                fontFamily: SANS_FONT,
              }}
              data-testid="pr-merge-method-select"
            >
              <span className="inline-flex items-center gap-2">
                <GitMerge size={13} weight="bold" style={{ color: COLORS.accent }} />
                {mergeMethodLabel(method)}
              </span>
              <CaretDown size={12} weight="bold" style={{ color: COLORS.textMuted }} />
            </button>
            {methodMenuOpen ? (
              <div
                className="absolute left-0 top-full z-30 mt-1 w-full rounded-md py-1 shadow-lg"
                style={{ background: COLORS.cardBgSolid, border: `1px solid ${COLORS.outlineBorder}` }}
              >
                {MERGE_METHODS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => handleSelectMethod(m)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px]"
                    style={{
                      color: method === m ? COLORS.accent : COLORS.textPrimary,
                      fontFamily: SANS_FONT,
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    {mergeMethodLabel(m)}
                    <span style={{ color: COLORS.textDim, fontFamily: MONO_FONT, fontSize: 10 }}>{mergeMethodShortLabel(m)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {/* Commit message editor (squash + merge only) */}
        {showCommitEditor ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: COLORS.textMuted, fontFamily: SANS_FONT }}>
                Commit message
              </span>
              <button
                type="button"
                onClick={handleResetDefaults}
                className="inline-flex items-center gap-1 text-[10px]"
                style={{ color: COLORS.accent, background: "none", border: "none", cursor: "pointer", fontFamily: SANS_FONT }}
              >
                <ArrowCounterClockwise size={11} weight="bold" />
                Reset to GitHub default
              </button>
            </div>
            <input
              value={commitTitle}
              onChange={(e) => setCommitTitle(e.target.value)}
              placeholder="Commit title"
              aria-label="Commit title"
              data-testid="pr-merge-commit-title"
              className="h-9 rounded-md px-3 text-[12px]"
              style={{
                color: COLORS.textPrimary,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
                fontFamily: SANS_FONT,
                outline: "none",
              }}
            />
            <textarea
              value={commitBody}
              onChange={(e) => setCommitBody(e.target.value)}
              placeholder="Optional extended description"
              aria-label="Commit body"
              data-testid="pr-merge-commit-body"
              rows={9}
              className="resize-y rounded-md px-3 py-2 text-[12px]"
              style={{
                color: COLORS.textSecondary,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
                fontFamily: MONO_FONT,
                lineHeight: 1.5,
                outline: "none",
                minHeight: 180,
              }}
            />
          </div>
        ) : (
          <div
            className="rounded-md px-3 py-2 text-[11px] leading-snug"
            style={{
              color: COLORS.textMuted,
              background: COLORS.recessedBg,
              border: `1px solid ${COLORS.border}`,
              fontFamily: SANS_FONT,
            }}
          >
            Rebase replays each commit from <span style={{ fontFamily: MONO_FONT }}>{pr.headBranch}</span> onto{" "}
            <span style={{ fontFamily: MONO_FONT }}>{pr.baseBranch}</span> — no merge commit message.
          </div>
        )}

        {/* Bypass (admins only, only when blocked) */}
        {canBypass ? (
          <label
            className="flex items-start gap-2 text-[11px]"
            style={{ color: COLORS.textMuted, fontFamily: SANS_FONT, lineHeight: 1.45 }}
          >
            <input
              type="checkbox"
              checked={bypassRules}
              disabled={actionBusy}
              onChange={(e) => setBypassRules(e.target.checked)}
              className="mt-0.5"
              style={{ accentColor: COLORS.danger }}
              data-testid="pr-merge-bypass-checkbox"
            />
            Merge without waiting for requirements to be met (you have bypass permission).
          </label>
        ) : null}

        {/* CLI instructions (collapsible) */}
        <div>
          <button
            type="button"
            onClick={() => setShowCli((o) => !o)}
            className="inline-flex items-center gap-1 text-[11px]"
            style={{ color: COLORS.accent, background: "none", border: "none", cursor: "pointer", fontFamily: SANS_FONT }}
          >
            <Terminal size={12} />
            View command line instructions
          </button>
          {showCli ? (
            <pre
              className="mt-2 overflow-x-auto rounded-md px-2.5 py-2 text-[10px]"
              style={{
                fontFamily: MONO_FONT,
                color: COLORS.textSecondary,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.border}`,
              }}
            >
              {cliInstructions}
            </pre>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-end gap-2 border-t pt-4" style={{ borderColor: COLORS.border }}>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          disabled={actionBusy}
          className="inline-flex h-8 items-center rounded-md px-3 text-[11px] font-medium"
          style={{
            color: COLORS.textSecondary,
            background: "transparent",
            border: `1px solid ${COLORS.border}`,
            fontFamily: SANS_FONT,
            opacity: actionBusy ? 0.6 : 1,
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!mergeEnabled || actionBusy}
          onClick={handlePrimaryClick}
          data-testid="pr-merge-primary-button"
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-3.5 text-[11px] font-semibold"
          style={{
            color: "#fff",
            background: !mergeEnabled
              ? COLORS.recessedBg
              : bypassRules
                ? `linear-gradient(135deg, ${COLORS.danger} 0%, #b91c1c 100%)`
                : `linear-gradient(135deg, ${COLORS.success} 0%, #16a34a 100%)`,
            border: `1px solid ${!mergeEnabled ? COLORS.border : bypassRules ? COLORS.danger : COLORS.success}`,
            opacity: actionBusy ? 0.6 : 1,
            fontFamily: SANS_FONT,
          }}
        >
          <GitMerge size={12} weight="bold" />
          {primaryLabel}
        </button>
      </div>
    </LaneDialogShell>
  );
});

export default PrMergeDialog;
