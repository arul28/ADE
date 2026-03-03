import React from "react";
import type { LaneSummary, MergeMethod } from "../../../../shared/types";
import { Button } from "../../ui/Button";
import type { PrDialogState } from "../graphTypes";

export function PrDialog({
  prDialog,
  setPrDialog,
  laneById,
  refreshPrs,
  refreshLanes,
  refreshRiskBatch,
  openPrDialogForLane,
  setMergeInProgressByLaneId,
  setMergeDisappearingAtByLaneId
}: {
  prDialog: PrDialogState;
  setPrDialog: React.Dispatch<React.SetStateAction<PrDialogState | null>>;
  laneById: Map<string, LaneSummary>;
  refreshPrs: () => Promise<void>;
  refreshLanes: () => Promise<void>;
  refreshRiskBatch: () => Promise<void>;
  openPrDialogForLane: (laneId: string, baseLaneId: string) => void;
  setMergeInProgressByLaneId: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setMergeDisappearingAtByLaneId: React.Dispatch<React.SetStateAction<Record<string, number>>>;
}) {
  return (
    <div className="fixed inset-0 z-[96] flex items-center justify-center bg-black/45 p-4">
      <div className="w-[min(980px,100%)] rounded-lg border border-border/10 bg-card backdrop-blur-sm p-4 shadow-float">
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-fg">
            {prDialog.existingPr ? `PR #${prDialog.existingPr.githubPrNumber}` : "Create Pull Request"}
          </div>
          <button type="button" className="text-muted-fg hover:text-fg" onClick={() => setPrDialog(null)}>
            ×
          </button>
        </div>
        <div className="mb-3 text-xs text-muted-fg">
          {laneById.get(prDialog.laneId)?.name ?? prDialog.laneId} → {laneById.get(prDialog.baseLaneId)?.name ?? prDialog.baseLaneId} (base:{" "}
          <span className="text-fg">{prDialog.baseBranch}</span>)
        </div>

        {prDialog.error ? (
          <div className="mb-3 rounded bg-red-900/30 p-2 text-xs text-red-200">
            {prDialog.error}
          </div>
        ) : null}

        {!prDialog.existingPr ? (
          <div className="space-y-3">
            {prDialog.loadingDraft ? (
              <div className="rounded-lg border border-border/10 bg-card/60 p-2 text-xs text-muted-fg">
                <div className="mb-1 inline-flex h-3 w-3 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />
                Drafting description from pack…
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <input
                className="h-9 rounded border border-border/15 bg-surface-recessed px-3 text-sm md:col-span-2"
                placeholder="PR title"
                value={prDialog.title}
                onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
              />
              <label className="inline-flex h-9 items-center gap-2 rounded border border-border/15 bg-surface-recessed px-3 text-xs text-muted-fg">
                <input
                  type="checkbox"
                  checked={prDialog.draft}
                  onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, draft: e.target.checked } : prev))}
                />
                Draft PR
              </label>
            </div>

            <textarea
              className="min-h-[240px] w-full rounded border border-border/15 bg-surface-recessed px-3 py-2 text-xs"
              value={prDialog.body}
              onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, body: e.target.value } : prev))}
              placeholder="PR description (markdown)"
            />

            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setPrDialog(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={prDialog.creating || prDialog.loadingDraft}
                onClick={() => {
                  const laneId = prDialog.laneId;
                  setPrDialog((prev) => (prev ? { ...prev, loadingDraft: true, error: null } : prev));
                  window.ade.prs
                    .draftDescription(laneId)
                    .then((draft) => {
                      setPrDialog((prev) =>
                        prev && prev.laneId === laneId ? { ...prev, title: draft.title, body: draft.body, loadingDraft: false } : prev
                      );
                    })
                    .catch((error) => {
                      const message = error instanceof Error ? error.message : String(error);
                      setPrDialog((prev) => (prev && prev.laneId === laneId ? { ...prev, loadingDraft: false, error: message } : prev));
                    });
                }}
              >
                Refresh Draft
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={prDialog.creating || !prDialog.title.trim() || !prDialog.body.trim()}
                onClick={() => {
                  const laneId = prDialog.laneId;
                  setPrDialog((prev) => (prev ? { ...prev, creating: true, error: null } : prev));
                  window.ade.prs
                    .createFromLane({
                      laneId,
                      title: prDialog.title,
                      body: prDialog.body,
                      draft: prDialog.draft,
                      baseBranch: prDialog.baseBranch
                    })
                    .then((created) => {
                      void refreshPrs().catch(() => {});
                      setPrDialog((prev) =>
                        prev && prev.laneId === laneId
                          ? { ...prev, creating: false, existingPr: created, loadingDetails: true }
                          : prev
                      );
                      void Promise.all([
                        window.ade.prs.getStatus(created.id),
                        window.ade.prs.getChecks(created.id),
                        window.ade.prs.getReviews(created.id)
                      ])
                        .then(([status, checks, reviews]) => {
                          setPrDialog((prev) =>
                            prev && prev.laneId === laneId
                              ? { ...prev, loadingDetails: false, status, checks, reviews }
                              : prev
                          );
                        })
                        .catch(() => {});
                    })
                    .catch((error) => {
                      const message = error instanceof Error ? error.message : String(error);
                      setPrDialog((prev) => (prev && prev.laneId === laneId ? { ...prev, creating: false, error: message } : prev));
                    });
                }}
              >
                {prDialog.creating ? "Creating…" : "Create PR"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg border border-border/10 bg-card/60 p-2 text-xs">
              <div className="font-semibold text-fg">{prDialog.existingPr.title}</div>
              <div className="mt-1 text-muted-fg">
                state: {prDialog.existingPr.state} · checks: {prDialog.existingPr.checksStatus} · reviews: {prDialog.existingPr.reviewStatus}
                {prDialog.existingPr.lastSyncedAt ? ` · synced ${prDialog.existingPr.lastSyncedAt}` : ""}
              </div>
            </div>

            {prDialog.loadingDetails ? (
              <div className="rounded-lg border border-border/10 bg-card/60 p-2 text-xs text-muted-fg">Loading PR status…</div>
            ) : prDialog.status ? (
              <div className="rounded-lg border border-border/10 bg-card/60 p-2 text-xs text-muted-fg">
                <div>
                  mergeable: <span className="text-fg">{prDialog.status.isMergeable ? "yes" : "no"}</span> · conflicts:{" "}
                  <span className="text-fg">{prDialog.status.mergeConflicts ? "yes" : "no"}</span> · behind base:{" "}
                  <span className="text-fg">{prDialog.status.behindBaseBy}</span>
                </div>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div className="rounded-lg border border-border/10 bg-card/60 p-2 text-xs">
                <div className="mb-1 font-semibold text-fg">Checks</div>
                {prDialog.checks.length === 0 ? (
                  <div className="text-muted-fg">No checks.</div>
                ) : (
                  prDialog.checks.slice(0, 12).map((check) => (
                    <div key={check.name} className="flex items-center justify-between gap-2">
                      <span className="truncate">{check.name}</span>
                      <span className="text-muted-fg">{check.conclusion ?? check.status}</span>
                    </div>
                  ))
                )}
              </div>
              <div className="rounded-lg border border-border/10 bg-card/60 p-2 text-xs">
                <div className="mb-1 font-semibold text-fg">Reviews</div>
                {prDialog.reviews.length === 0 ? (
                  <div className="text-muted-fg">No reviews.</div>
                ) : (
                  prDialog.reviews.slice(0, 12).map((review, idx) => (
                    <div key={`${review.reviewer}:${idx}`} className="flex items-center justify-between gap-2">
                      <span className="truncate">{review.reviewer}</span>
                      <span className="text-muted-fg">{review.state}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <select
                  value={prDialog.mergeMethod}
                  onChange={(e) => setPrDialog((prev) => (prev ? { ...prev, mergeMethod: e.target.value as MergeMethod } : prev))}
                  className="h-8 rounded border border-border/15 bg-surface-recessed px-2 text-xs"
                >
                  <option value="merge">merge</option>
                  <option value="squash">squash</option>
                  <option value="rebase">rebase</option>
                </select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const prId = prDialog.existingPr?.id;
                    if (!prId) return;
                    void window.ade.prs.openInGitHub(prId).catch(() => {});
                  }}
                >
                  Open in GitHub
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={prDialog.loadingDetails}
                  onClick={() => openPrDialogForLane(prDialog.laneId, prDialog.baseLaneId)}
                >
                  Refresh
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setPrDialog(null)}>
                  Close
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={prDialog.merging || !prDialog.existingPr}
                  onClick={() => {
                    const pr = prDialog.existingPr;
                    if (!pr) return;
                    const laneId = prDialog.laneId;
                    setPrDialog((prev) => (prev ? { ...prev, merging: true, error: null } : prev));
                    setMergeInProgressByLaneId((prev) => ({ ...prev, [laneId]: true }));
                    window.ade.prs
                      .land({ prId: pr.id, method: prDialog.mergeMethod })
                      .then((result) => {
                        void refreshPrs().catch(() => {});
                        if (!result.success) {
                          throw new Error(result.error || "Merge failed");
                        }
                        setMergeDisappearingAtByLaneId((prev) => ({ ...prev, [laneId]: Date.now() }));
                        window.setTimeout(() => {
                          void refreshLanes().catch(() => {});
                          void refreshRiskBatch().catch(() => {});
                        }, 650);
                        setPrDialog(null);
                      })
                      .catch((error) => {
                        const message = error instanceof Error ? error.message : String(error);
                        setMergeInProgressByLaneId((prev) => ({ ...prev, [laneId]: false }));
                        setPrDialog((prev) => (prev ? { ...prev, merging: false, error: message } : prev));
                      });
                  }}
                >
                  {prDialog.merging ? "Merging…" : "Merge PR"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
