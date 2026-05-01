import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, CloudArrowUp, X } from "@phosphor-icons/react";
import type { CursorCloudRepository } from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { openExternalUrl } from "../../lib/openExternal";
import { repoMatchKey } from "../../lib/cursorCloudUtils";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";

const CURSOR_VIOLET = "#A78BFA";

export type CursorCloudInlineLaunchHandle = {
  launchWithPrompt: (promptText: string) => Promise<{ agentId: string } | null>;
};

type Props = {
  cursorModelIds: string[];
  defaultRepoUrl?: string | null;
  defaultBranch?: string | null;
  defaultModelSdkId?: string | null;
  laneGitRemote?: string | null;
  laneId?: string | null;
  onLaunched?: (agentId: string) => void;
  onClose: () => void;
  onMissingFields?: (message: string) => void;
};

type DetectedPr = {
  prUrl: string;
  prNumber: number | null;
  title: string | null;
  headRefName: string | null;
};

function repoLabel(url: string): string {
  if (!url) return "";
  const trimmed = url.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  return trimmed;
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/i, "").trim() || "Cursor Cloud request failed.";
}

function prFallbackLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export const CursorCloudInlineLaunch = forwardRef<CursorCloudInlineLaunchHandle, Props>(function CursorCloudInlineLaunch({
  cursorModelIds,
  defaultRepoUrl,
  defaultBranch,
  defaultModelSdkId,
  laneGitRemote,
  laneId,
  onLaunched,
  onClose,
  onMissingFields,
}, ref) {
  const [repos, setRepos] = useState<CursorCloudRepository[]>([]);
  const [reposLoaded, setReposLoaded] = useState(false);
  const [repoUrl, setRepoUrl] = useState(defaultRepoUrl ?? "");
  const [branch, setBranch] = useState(defaultBranch ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoaded, setBranchesLoaded] = useState(false);
  const [modelId, setModelId] = useState(defaultModelSdkId ?? "");
  const [autoCreatePR, setAutoCreatePR] = useState(false);
  const [workOnCurrentBranch, setWorkOnCurrentBranch] = useState(false);
  const [detectedPr, setDetectedPr] = useState<DetectedPr | null>(null);
  const [prDetectPending, setPrDetectPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingDetectionRef = useRef<Promise<DetectedPr | null> | null>(null);
  const detectedPrRef = useRef<DetectedPr | null>(null);

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    return cursorModelIds
      .filter((id) => id.startsWith("cursor/"))
      .map((id) => {
        const value = id.replace(/^cursor\//, "");
        if (!value || seen.has(value)) return null;
        seen.add(value);
        return { id, value, label: getModelById(id)?.displayName ?? value };
      })
      .filter((entry): entry is { id: string; value: string; label: string } => Boolean(entry));
  }, [cursorModelIds]);

  useEffect(() => {
    let cancelled = false;
    void window.ade.ai
      .cursorCloudListRepositories()
      .then((next) => {
        if (cancelled) return;
        setRepos(next);
        setReposLoaded(true);
        setRepoUrl((current) => {
          if (current) return current;
          if (laneGitRemote) {
            const target = repoMatchKey(laneGitRemote);
            const match = next.find((repo) => repoMatchKey(repo.url) === target);
            if (match) return match.url;
          }
          return next[0]?.url || "";
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setReposLoaded(true);
        setError(errorMessage(err));
      });
    return () => { cancelled = true; };
  }, [laneGitRemote]);

  useEffect(() => {
    if (!defaultBranch) return;
    setBranch((current) => current || defaultBranch);
  }, [defaultBranch]);

  useEffect(() => {
    if (!laneId) return;
    let cancelled = false;
    void window.ade.git
      .listBranches({ laneId })
      .then((items) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const local: string[] = [];
        for (const item of items) {
          if (item.isRemote) continue;
          const name = (item.name ?? "").trim();
          if (!name || seen.has(name)) continue;
          seen.add(name);
          local.push(name);
        }
        setBranches(local);
        setBranchesLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBranchesLoaded(true);
      });
    return () => { cancelled = true; };
  }, [laneId]);

  // When laneGitRemote arrives after the initial repo list, upgrade the
  // auto-selection from "first repo" to the lane's repo.
  useEffect(() => {
    if (!laneGitRemote || repos.length === 0) return;
    const target = repoMatchKey(laneGitRemote);
    if (!target) return;
    const match = repos.find((repo) => repoMatchKey(repo.url) === target);
    if (!match) return;
    setRepoUrl((current) => {
      if (!current) return match.url;
      if (current === repos[0]?.url && current !== match.url) return match.url;
      return current;
    });
  }, [laneGitRemote, repos]);

  useEffect(() => {
    if (!defaultModelSdkId) return;
    setModelId((current) => current || defaultModelSdkId);
  }, [defaultModelSdkId]);

  // Detect open PR for the selected branch. Re-runs whenever lane or branch changes.
  useEffect(() => {
    if (!laneId) {
      setDetectedPr(null);
      detectedPrRef.current = null;
      pendingDetectionRef.current = null;
      setPrDetectPending(false);
      return;
    }
    const trimmedBranch = branch.trim();
    let cancelled = false;
    setPrDetectPending(true);
    setDetectedPr(null);
    detectedPrRef.current = null;
    const detection = window.ade.git
      .getOpenPrForBranch({ laneId, branch: trimmedBranch || undefined })
      .then((result): DetectedPr | null => {
        const next: DetectedPr | null = result && result.prUrl
          ? {
              prUrl: result.prUrl,
              prNumber: result.prNumber,
              title: result.title,
              headRefName: result.headRefName,
            }
          : null;
        if (!cancelled) {
          setDetectedPr(next);
          detectedPrRef.current = next;
          setPrDetectPending(false);
        }
        return next;
      })
      .catch(() => {
        if (!cancelled) {
          setDetectedPr(null);
          detectedPrRef.current = null;
          setPrDetectPending(false);
        }
        return null;
      });
    pendingDetectionRef.current = detection;
    return () => { cancelled = true; };
  }, [laneId, branch]);

  const launchWithPrompt = useCallback(async (rawPrompt: string): Promise<{ agentId: string } | null> => {
    const trimmedPrompt = rawPrompt.trim();
    const trimmedRepo = repoUrl.trim();
    if (!trimmedPrompt) {
      onMissingFields?.("Type a prompt above.");
      return null;
    }
    if (!trimmedRepo) {
      onMissingFields?.("Pick a repository.");
      return null;
    }
    setError(null);
    try {
      const pending = pendingDetectionRef.current;
      if (pending) {
        await Promise.race([
          pending,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 6000)),
        ]);
      }
      // Only reuse a detected PR when the selected repo still matches the lane
      // it was detected against. Otherwise the user could ship a mismatched
      // repoUrl/prUrl pair to the cloud API.
      const detectedRepoKey = repoMatchKey(laneGitRemote);
      const selectedRepoKey = repoMatchKey(trimmedRepo);
      const resolvedPr =
        detectedRepoKey !== "" && detectedRepoKey === selectedRepoKey
          ? detectedPrRef.current
          : null;
      const attachToPr = resolvedPr?.prUrl ?? null;
      const created = await window.ade.ai.cursorCloudCreateRun({
        promptText: trimmedPrompt,
        repoUrl: trimmedRepo,
        startingRef: branch.trim() || null,
        modelId: modelId.trim() || null,
        autoCreatePR: attachToPr ? false : autoCreatePR,
        workOnCurrentBranch: attachToPr ? true : workOnCurrentBranch,
        prUrl: attachToPr,
        skipReviewerRequest: true,
      });
      onLaunched?.(created.agent.agentId);
      return { agentId: created.agent.agentId };
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, [autoCreatePR, branch, laneGitRemote, modelId, onLaunched, onMissingFields, repoUrl, workOnCurrentBranch]);

  useImperativeHandle(ref, () => ({ launchWithPrompt }), [launchWithPrompt]);

  const prPillLabel = detectedPr
    ? detectedPr.prNumber != null
      ? `PR #${detectedPr.prNumber}`
      : prFallbackLabel(detectedPr.prUrl)
    : null;
  const prPillTitle = detectedPr?.title?.trim() || null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <CloudArrowUp size={13} weight="fill" style={{ color: CURSOR_VIOLET }} />
        <span className="font-sans text-[11.5px] font-semibold tracking-tight text-fg/85">Send to Cursor Cloud</span>
        <span className="font-sans text-[10.5px] text-fg/40">— pick a repo and any options, then Send.</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md border border-white/[0.06] text-fg/45 transition-colors hover:border-white/[0.12] hover:text-fg/85"
          title="Cancel cloud send"
          aria-label="Cancel cloud send"
        >
          <X size={11} weight="bold" />
        </button>
      </div>

      <div className="grid gap-1.5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <SmartTooltip forceEnabled content={{ label: "Repository", description: "Connected GitHub repository the cloud agent will clone and edit. We auto-pick the repo your lane points at." }}>
          <label className="group flex min-w-0 items-center gap-1.5 rounded-md border border-white/[0.06] bg-black/15 px-2 py-1.5 transition-colors focus-within:border-violet-300/30">
            <span className="font-sans text-[10px] uppercase tracking-[0.10em] text-fg/35">Repo</span>
            <select
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
              className="min-w-0 flex-1 truncate bg-transparent font-sans text-[11px] text-fg/85 outline-none"
              aria-label="Repository"
            >
              {reposLoaded && repos.length === 0 ? (
                <option value="">No connected repos</option>
              ) : null}
              {!reposLoaded ? <option value="">Loading…</option> : null}
              {repos.map((repo) => (
                <option key={repo.url} value={repo.url}>{repoLabel(repo.url)}</option>
              ))}
            </select>
          </label>
        </SmartTooltip>

        <SmartTooltip forceEnabled content={{ label: "Branch", description: "The branch the cloud agent checks out. Auto-filled from your lane's current branch — change it via the dropdown." }}>
          <label className="group flex min-w-0 items-center gap-1.5 rounded-md border border-white/[0.06] bg-black/15 px-2 py-1.5 transition-colors focus-within:border-violet-300/30">
            <span className="font-sans text-[10px] uppercase tracking-[0.10em] text-fg/35">Branch</span>
            {branchesLoaded && branches.length > 0 ? (
              <select
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                className="min-w-0 flex-1 truncate bg-transparent font-mono text-[11px] text-fg/85 outline-none"
                aria-label="Branch"
              >
                {branch && !branches.includes(branch) ? (
                  <option value={branch}>{branch}</option>
                ) : null}
                {branches.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
            ) : (
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder={defaultBranch || "default"}
                className="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-fg/82 outline-none placeholder:text-fg/25"
                aria-label="Branch"
              />
            )}
          </label>
        </SmartTooltip>

        <SmartTooltip forceEnabled content={{ label: "Model", description: "Cursor model the cloud agent runs with. Auto-filled from your chat composer — you can override it." }}>
          <label className="group flex min-w-0 items-center gap-1.5 rounded-md border border-white/[0.06] bg-black/15 px-2 py-1.5 transition-colors focus-within:border-violet-300/30">
            <span className="font-sans text-[10px] uppercase tracking-[0.10em] text-fg/35">Model</span>
            <select
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              className="min-w-0 flex-1 truncate bg-transparent font-sans text-[11px] text-fg/85 outline-none"
              aria-label="Model"
            >
              {modelOptions.length === 0 ? <option value="">Default</option> : null}
              {modelOptions.map((model) => (
                <option key={model.id} value={model.value}>{model.label}</option>
              ))}
            </select>
          </label>
        </SmartTooltip>
      </div>

      {prDetectPending ? (
        <div
          className="h-7 w-44 animate-pulse rounded-md border border-white/[0.04] bg-white/[0.02]"
          aria-label="Checking for an open pull request"
        />
      ) : detectedPr ? (
        <SmartTooltip
          forceEnabled
          content={{
            label: "PR detected",
            description: "Cursor Cloud will commit to this PR's branch and push when done.",
          }}
        >
          <button
            type="button"
            onClick={() => openExternalUrl(detectedPr.prUrl)}
            className="group inline-flex max-w-full items-center gap-1.5 rounded-md border border-violet-300/30 bg-violet-500/[0.12] px-2.5 py-1 text-violet-100/90 transition-colors hover:border-violet-300/50 hover:bg-violet-500/[0.18]"
            aria-label="Open detected pull request"
          >
            <span className="font-sans text-[10.5px] text-violet-200/70">When done, Cursor Cloud agent will push to</span>
            {prPillLabel ? (
              <span className="font-mono text-[11px] font-medium text-violet-100/95">{prPillLabel}</span>
            ) : null}
            {prPillTitle ? (
              <span className="min-w-0 truncate font-sans text-[11px] text-violet-100/85">{prPillTitle}</span>
            ) : null}
            <ArrowSquareOut size={10} weight="bold" className="shrink-0 text-violet-200/70 transition-colors group-hover:text-violet-100/95" />
          </button>
        </SmartTooltip>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <SmartTooltip
            forceEnabled
            content={{
              label: "Auto-PR",
              description: "When the cloud run finishes, Cursor automatically opens a pull request from the work branch.",
              effect: autoCreatePR ? "On — a PR will be created on completion." : "Off — no PR is created. You can open one manually from the resulting branch.",
            }}
          >
            <button
              type="button"
              onClick={() => setAutoCreatePR((v) => !v)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 font-sans text-[11px] font-medium transition-colors",
                autoCreatePR
                  ? "border-violet-300/30 bg-violet-500/[0.16] text-violet-100/90"
                  : "border-white/[0.06] bg-white/[0.02] text-fg/55 hover:border-white/[0.12] hover:text-fg/80",
              )}
              aria-pressed={autoCreatePR}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", autoCreatePR ? "bg-violet-300" : "bg-white/[0.18]")} aria-hidden />
              Auto-PR
            </button>
          </SmartTooltip>

          <SmartTooltip
            forceEnabled
            content={{
              label: "Work on current branch",
              description: "Commit directly to the branch above instead of creating a new feature branch.",
              effect: workOnCurrentBranch ? "On — pushes to the selected branch." : "Off — Cursor creates a fresh feature branch off the selected branch.",
            }}
          >
            <button
              type="button"
              onClick={() => setWorkOnCurrentBranch((v) => !v)}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 font-sans text-[11px] font-medium transition-colors",
                workOnCurrentBranch
                  ? "border-violet-300/30 bg-violet-500/[0.16] text-violet-100/90"
                  : "border-white/[0.06] bg-white/[0.02] text-fg/55 hover:border-white/[0.12] hover:text-fg/80",
              )}
              aria-pressed={workOnCurrentBranch}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", workOnCurrentBranch ? "bg-violet-300" : "bg-white/[0.18]")} aria-hidden />
              Work on current branch
            </button>
          </SmartTooltip>
        </div>
      )}

      {error ? (
        <div className="font-sans text-[11px] text-red-300/85">{error}</div>
      ) : null}
    </div>
  );
});
