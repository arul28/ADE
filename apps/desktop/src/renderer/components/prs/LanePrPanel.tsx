import React from "react";
import { useNavigate } from "react-router-dom";
import type { CreatePrFromLaneArgs, LandResult, MergeMethod, PrCheck, PrReview, PrStatus, PrSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { cn } from "../ui/cn";

function branchNameFromRef(ref: string): string {
  const trimmed = ref.trim();
  if (trimmed.startsWith("refs/heads/")) return trimmed.slice("refs/heads/".length);
  return trimmed;
}

function titleFromBranch(branch: string): string {
  const normalized = branch.replace(/^feature\//i, "").replace(/[-_/]+/g, " ").trim();
  if (!normalized) return branch;
  return normalized.replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseCsvList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function stateChip(state: PrSummary["state"]): { label: string; className: string } {
  if (state === "draft") return { label: "draft", className: "text-purple-200 border-purple-700/60 bg-purple-900/20" };
  if (state === "open") return { label: "open", className: "text-sky-200 border-sky-700/60 bg-sky-900/20" };
  if (state === "merged") return { label: "merged", className: "text-emerald-200 border-emerald-700/60 bg-emerald-900/20" };
  return { label: "closed", className: "text-muted-fg border-border bg-card/30" };
}

function checksChip(status: PrSummary["checksStatus"]): { label: string; className: string } {
  if (status === "passing") return { label: "checks: passing", className: "text-emerald-200 border-emerald-700/60 bg-emerald-900/20" };
  if (status === "failing") return { label: "checks: failing", className: "text-red-200 border-red-700/60 bg-red-900/20" };
  if (status === "pending") return { label: "checks: pending", className: "text-amber-200 border-amber-700/60 bg-amber-900/20" };
  return { label: "checks: none", className: "text-muted-fg border-border bg-card/30" };
}

function reviewsChip(status: PrSummary["reviewStatus"]): { label: string; className: string } {
  if (status === "approved") return { label: "reviews: approved", className: "text-emerald-200 border-emerald-700/60 bg-emerald-900/20" };
  if (status === "changes_requested") return { label: "reviews: changes requested", className: "text-amber-200 border-amber-700/60 bg-amber-900/20" };
  if (status === "requested") return { label: "reviews: requested", className: "text-sky-200 border-sky-700/60 bg-sky-900/20" };
  return { label: "reviews: none", className: "text-muted-fg border-border bg-card/30" };
}

export function LanePrPanel({ laneId }: { laneId: string | null }) {
  const navigate = useNavigate();
  const lanes = useAppStore((s) => s.lanes);
  const lane = React.useMemo(() => (laneId ? lanes.find((l) => l.id === laneId) ?? null : null), [laneId, lanes]);
  const primaryLane = React.useMemo(() => lanes.find((l) => l.laneType === "primary") ?? null, [lanes]);
  const parentLane = React.useMemo(
    () => (lane?.parentLaneId ? lanes.find((l) => l.id === lane.parentLaneId) ?? null : null),
    [lane, lanes]
  );

  const [pr, setPr] = React.useState<PrSummary | null>(null);
  const [status, setStatus] = React.useState<PrStatus | null>(null);
  const [checks, setChecks] = React.useState<PrCheck[]>([]);
  const [reviews, setReviews] = React.useState<PrReview[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [showCreate, setShowCreate] = React.useState(false);
  const [linkValue, setLinkValue] = React.useState("");
  const [labelsDraft, setLabelsDraft] = React.useState("");
  const [reviewersDraft, setReviewersDraft] = React.useState("");

  const defaultBaseBranch = React.useMemo(() => {
    if (!lane) return branchNameFromRef(primaryLane?.branchRef ?? "main");
    if (parentLane) return branchNameFromRef(parentLane.branchRef);
    const primaryBranch = primaryLane?.branchRef ?? lane.baseRef;
    return branchNameFromRef(primaryBranch);
  }, [lane, parentLane, primaryLane?.branchRef]);
  const defaultHeadBranch = lane ? branchNameFromRef(lane.branchRef) : "";

  const [createDraft, setCreateDraft] = React.useState<CreatePrFromLaneArgs>(() => ({
    laneId: laneId ?? "",
    title: lane ? titleFromBranch(defaultHeadBranch) : "",
    body: "",
    draft: false,
    baseBranch: defaultBaseBranch
  }));

  const [mergeMethod, setMergeMethod] = React.useState<MergeMethod>("squash");
  const [mergeResult, setMergeResult] = React.useState<LandResult | null>(null);

  const refresh = React.useCallback(async () => {
    if (!laneId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await window.ade.prs.getForLane(laneId);
      setPr(next);
      setStatus(null);
      setChecks([]);
      setReviews([]);
      if (next) {
        // Refresh server-side fields.
        const refreshed = await window.ade.prs.refresh({ prId: next.id }).then((rows) => rows[0] ?? next);
        setPr(refreshed);
        const [s, c, r] = await Promise.all([
          window.ade.prs.getStatus(refreshed.id).catch(() => null),
          window.ade.prs.getChecks(refreshed.id).catch(() => []),
          window.ade.prs.getReviews(refreshed.id).catch(() => [])
        ]);
        if (s) setStatus(s);
        setChecks(c);
        setReviews(r);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPr(null);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [laneId]);

  React.useEffect(() => {
    setPr(null);
    setStatus(null);
    setChecks([]);
    setReviews([]);
    setError(null);
    setShowCreate(false);
    setMergeResult(null);
    setLabelsDraft("");
    setReviewersDraft("");
    if (!laneId || !lane) return;
    setCreateDraft({
      laneId,
      title: titleFromBranch(branchNameFromRef(lane.branchRef)),
      body: "",
      draft: false,
      baseBranch: defaultBaseBranch
    });
    void refresh();
  }, [laneId, lane, parentLane, defaultBaseBranch, refresh]);

  // Subscribe to PR events for real-time sync
  React.useEffect(() => {
    const unsub = window.ade.prs.onEvent((event) => {
      if (event.type === "prs-updated") {
        // Update PR summary directly from event payload if our lane's PR is in it
        if (pr) {
          const updated = event.prs.find((p) => p.id === pr.id);
          if (updated) setPr(updated);
        }
      } else if (event.type === "pr-notification" && event.laneId === laneId) {
        void refresh();
      }
    });
    return unsub;
  }, [laneId, pr?.id, refresh]);

  if (!laneId || !lane) {
    return <EmptyState title="No lane selected" description="Select a lane to create or view its PR." />;
  }

  const createPr = async () => {
    setLoading(true);
    setError(null);
    setMergeResult(null);
    try {
      const labels = parseCsvList(labelsDraft);
      const reviewers = parseCsvList(reviewersDraft);
      const created = await window.ade.prs.createFromLane({
        ...createDraft,
        laneId,
        ...(labels.length ? { labels } : {}),
        ...(reviewers.length ? { reviewers } : {})
      });
      setPr(created);
      setShowCreate(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const linkPr = async () => {
    if (!linkValue.trim()) return;
    setLoading(true);
    setError(null);
    setMergeResult(null);
    try {
      const linked = await window.ade.prs.linkToLane({ laneId, prUrlOrNumber: linkValue.trim() });
      setPr(linked);
      setLinkValue("");
      setShowCreate(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const mergePr = async () => {
    if (!pr) return;
    setLoading(true);
    setError(null);
    setMergeResult(null);
    try {
      const res = await window.ade.prs.land({ prId: pr.id, method: mergeMethod });
      setMergeResult(res);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const pushChanges = async () => {
    setLoading(true);
    setError(null);
    setMergeResult(null);
    try {
      await window.ade.git.push({ laneId });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const draftFromPack = async () => {
    setLoading(true);
    setError(null);
    try {
      const drafted = await window.ade.prs.draftDescription(laneId);
      setCreateDraft((prev) => ({ ...prev, title: drafted.title, body: drafted.body }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const updateDescription = async () => {
    if (!pr) return;
    setLoading(true);
    setError(null);
    try {
      const drafted = await window.ade.prs.draftDescription(laneId);
      await window.ade.prs.updateDescription({ prId: pr.id, body: drafted.body });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (!pr) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold text-fg">Pull Request</div>
            <div className="text-[11px] text-muted-fg">lane: {lane.name}</div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-7" onClick={() => navigate("/settings")}>
              GitHub Settings
            </Button>
            <Button size="sm" variant="primary" className="h-7" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "Close" : "Create / Link"}
            </Button>
          </div>
        </div>

        {error ? <div className="mt-2 rounded bg-red-950/20 p-2 text-xs text-red-300">{error}</div> : null}

        {!showCreate ? (
          <div className="mt-3">
            <EmptyState title="No PR linked" description="Create a PR for this lane, or link an existing PR by URL or number." />
          </div>
        ) : (
          <div className="mt-3 flex-1 min-h-0 overflow-auto space-y-3">
            <div className="rounded-xl shadow-card bg-card/50 p-3">
              <div className="mb-2 text-xs font-semibold text-fg">Create PR</div>
              <div className="grid gap-2">
                <label className="text-[11px] text-muted-fg">
                  Title
                  <input
                    value={createDraft.title}
                    onChange={(e) => setCreateDraft((p) => ({ ...p, title: e.target.value }))}
                    className="mt-1 h-8 w-full rounded bg-muted/30 px-2 text-xs outline-none focus:ring-1 focus:ring-accent"
                  />
                </label>
                <label className="text-[11px] text-muted-fg">
                  Base branch
                  <input
                    value={createDraft.baseBranch ?? ""}
                    onChange={(e) => setCreateDraft((p) => ({ ...p, baseBranch: e.target.value }))}
                    className="mt-1 h-8 w-full rounded bg-muted/30 px-2 text-xs outline-none focus:ring-1 focus:ring-accent"
                    placeholder={defaultBaseBranch}
                  />
                </label>
                <div className="text-[11px] text-muted-fg">
                  Head branch: <span className="font-medium text-fg">{defaultHeadBranch}</span>
                </div>
                <div className="rounded bg-muted/20 px-2 py-1 text-[11px] text-muted-fg">
                  PR will be: <span className="font-medium text-fg">{defaultHeadBranch}</span>{" "}
                  → <span className="font-medium text-fg">{createDraft.baseBranch || defaultBaseBranch}</span>
                </div>
                <label className="text-[11px] text-muted-fg">
                  Body (markdown)
                  <textarea
                    value={createDraft.body}
                    onChange={(e) => setCreateDraft((p) => ({ ...p, body: e.target.value }))}
                    className="mt-1 h-[140px] w-full resize-none rounded bg-muted/30 p-2 text-xs outline-none focus:ring-1 focus:ring-accent"
                    placeholder="Write PR description…"
                  />
                </label>
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="text-[11px] text-muted-fg">
                    Labels (comma-separated)
                    <input
                      value={labelsDraft}
                      onChange={(e) => setLabelsDraft(e.target.value)}
                      className="mt-1 h-8 w-full rounded bg-muted/30 px-2 text-xs outline-none focus:ring-1 focus:ring-accent"
                      placeholder="bug, enhancement"
                    />
                  </label>
                  <label className="text-[11px] text-muted-fg">
                    Reviewers (comma-separated)
                    <input
                      value={reviewersDraft}
                      onChange={(e) => setReviewersDraft(e.target.value)}
                      className="mt-1 h-8 w-full rounded bg-muted/30 px-2 text-xs outline-none focus:ring-1 focus:ring-accent"
                      placeholder="octocat, teammate"
                    />
                  </label>
                </div>
                <label className="inline-flex items-center gap-2 text-[11px] text-muted-fg">
                  <input
                    type="checkbox"
                    checked={createDraft.draft}
                    onChange={(e) => setCreateDraft((p) => ({ ...p, draft: e.target.checked }))}
                  />
                  Create as draft
                </label>
                <div className="flex items-center justify-between gap-2">
                  <Button size="sm" variant="outline" className="h-7" onClick={() => void draftFromPack()}>
                    Draft From Pack
                  </Button>
                  <Button size="sm" variant="primary" className="h-7" disabled={loading || !createDraft.title.trim()} onClick={() => void createPr()}>
                    {loading ? "Working…" : "Create PR"}
                  </Button>
                </div>
              </div>
            </div>

            <div className="rounded-xl shadow-card bg-card/50 p-3">
              <div className="mb-2 text-xs font-semibold text-fg">Link Existing PR</div>
              <div className="flex gap-2">
                <input
                  value={linkValue}
                  onChange={(e) => setLinkValue(e.target.value)}
                  placeholder="PR URL or number (e.g. 123)"
                  className="h-8 flex-1 rounded bg-muted/30 px-2 text-xs outline-none focus:ring-1 focus:ring-accent"
                />
                <Button size="sm" variant="outline" className="h-8" disabled={loading || !linkValue.trim()} onClick={() => void linkPr()}>
                  Link
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const state = stateChip(pr.state);
  const checksState = checksChip(pr.checksStatus);
  const reviewState = reviewsChip(pr.reviewStatus);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-fg truncate">{pr.title || `PR #${pr.githubPrNumber}`}</span>
            <Chip className={cn("text-[10px] px-1.5", state.className)}>{state.label}</Chip>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Chip className={cn("text-[10px] px-1.5", checksState.className)}>{checksState.label}</Chip>
            <Chip className={cn("text-[10px] px-1.5", reviewState.className)}>{reviewState.label}</Chip>
            <span className="text-[10px] text-muted-fg">#{pr.githubPrNumber}</span>
            <span className="text-[10px] text-muted-fg">base: {pr.baseBranch}</span>
            <span className="text-[10px] text-muted-fg">head: {pr.headBranch}</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-7" onClick={() => void refresh()} disabled={loading}>
              Refresh
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => void pushChanges()} disabled={loading}>
              Push changes
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => void window.ade.prs.openInGitHub(pr.id)}>
              Open in GitHub
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => navigate("/prs")}>
              Open PRs Tab
            </Button>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" className="h-7" onClick={() => void updateDescription()} disabled={loading}>
              Update Description
            </Button>
            <select
              value={mergeMethod}
              onChange={(e) => setMergeMethod(e.target.value as MergeMethod)}
              className="h-7 rounded bg-muted/30 px-2 text-[11px]"
              title="Merge method"
            >
              <option value="squash">squash</option>
              <option value="merge">merge</option>
              <option value="rebase">rebase</option>
            </select>
            <Button size="sm" variant="primary" className="h-7" onClick={() => void mergePr()} disabled={loading || pr.state !== "open"}>
              Merge
            </Button>
          </div>
        </div>
      </div>

      {error ? <div className="mt-2 rounded bg-red-950/20 p-2 text-xs text-red-300">{error}</div> : null}
      {mergeResult ? (
        <div className={cn("mt-2 rounded p-2 text-xs", mergeResult.success ? "bg-emerald-900/20 text-emerald-100" : "bg-red-900/20 text-red-100")}>
          {mergeResult.success ? `Merged PR #${mergeResult.prNumber}` : `Merge failed: ${mergeResult.error ?? "unknown error"}`}
        </div>
      ) : null}

      {status ? (
        <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
          <div className="rounded-xl shadow-card bg-card/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-fg">Mergeable</div>
            <div className="font-semibold text-fg">{status.isMergeable ? "yes" : "no"}</div>
          </div>
          <div className="rounded-xl shadow-card bg-card/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-fg">Conflicts</div>
            <div className="font-semibold text-fg">{status.mergeConflicts ? "yes" : "no"}</div>
          </div>
          <div className="rounded-xl shadow-card bg-card/50 p-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-fg">Behind Base</div>
            <div className="font-semibold text-fg">{status.behindBaseBy}</div>
          </div>
        </div>
      ) : null}

      <div className="mt-2 grid flex-1 min-h-0 grid-cols-1 gap-2 overflow-auto">
        <div className="rounded-xl shadow-card bg-card/30">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-fg">Checks</div>
          <div className="divide-y divide-border/10">
            {checks.map((check) => (
              <div key={check.name} className="px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-fg">{check.name}</div>
                  <div className="flex items-center gap-2">
                    <div className="text-[10px] text-muted-fg">{check.conclusion ?? check.status}</div>
                    {check.detailsUrl ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[10px]"
                        onClick={() => void window.ade.app.openExternal(check.detailsUrl!)}
                      >
                        Open
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
            {!checks.length ? <div className="px-2 py-2 text-xs text-muted-fg">No checks found.</div> : null}
          </div>
        </div>
        <div className="rounded-xl shadow-card bg-card/30">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-fg">Reviews</div>
          <div className="divide-y divide-border/10">
            {reviews.map((review, idx) => (
              <div key={`${review.reviewer}:${idx}`} className="px-2 py-1.5 text-[11px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate text-fg">{review.reviewer}</div>
                  <div className="text-[10px] text-muted-fg">{review.state}</div>
                </div>
                {review.body ? <div className="mt-1 line-clamp-2 text-[10px] text-muted-fg">{review.body}</div> : null}
              </div>
            ))}
            {!reviews.length ? <div className="px-2 py-2 text-xs text-muted-fg">No reviews found.</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
