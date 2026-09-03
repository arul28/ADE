/**
 * Two lanes' conflict, and the AI resolution flow over it.
 *
 * Ported from `components/graph/graphDialogs/ConflictPanel.tsx`. The layout, the
 * disclosure blocks and the apply-mode ladder are unchanged. What changed is the
 * calls: four `window.ade.conflicts.*` became four page actions, and each one now
 * answers `{ok, message}` instead of rejecting — so the error path reads a
 * result rather than catching a promise. See `host/actions.ts`.
 */

import React from "react";
import { Button } from "@ade-dev/ui";

import type { LaneSummary } from "../../lib/types";
import { edgePairKey } from "../../lib/graphHelpers";
import type { ConflictPanelState } from "../../lib/graphTypes";
import * as actions from "../../host/actions";

export function ConflictPanel({
  conflictPanel,
  setConflictPanel,
  laneById,
  overlapFilesByPair,
  refreshRiskBatch,
  refreshLanes,
}: {
  conflictPanel: ConflictPanelState;
  setConflictPanel: React.Dispatch<React.SetStateAction<ConflictPanelState | null>>;
  laneById: Map<string, LaneSummary>;
  overlapFilesByPair: Map<string, string[]>;
  refreshRiskBatch: () => Promise<void>;
  refreshLanes: () => Promise<void>;
}) {
  return (
    <div
      data-ade-graph-panel="conflict"
      className="absolute right-3 top-[66px] z-[89] w-[420px] rounded border border-border/10 bg-card/95 backdrop-blur-sm p-3 text-xs shadow-float"
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="font-semibold text-fg">Conflict Resolution</div>
        <button type="button" className="text-muted-fg hover:text-fg" onClick={() => setConflictPanel(null)}>
          ×
        </button>
      </div>
      <div className="mb-2 text-muted-fg">
        {laneById.get(conflictPanel.laneAId)?.name ?? conflictPanel.laneAId} ↔{" "}
        {laneById.get(conflictPanel.laneBId)?.name ?? conflictPanel.laneBId}
      </div>

      {conflictPanel.error ? (
        <div className="mb-2 rounded bg-red-900/30 p-2 text-xs text-red-200">{conflictPanel.error}</div>
      ) : null}

      {conflictPanel.loading ? (
        <div className="mb-2 rounded-lg border border-border/10 bg-card/60 p-2 text-muted-fg">
          <div className="mb-1 inline-flex h-3 w-3 animate-spin rounded-full border-2 border-muted-fg border-t-transparent" />
          <div>Running merge simulation…</div>
        </div>
      ) : conflictPanel.result ? (
        <div className="mb-2 rounded-lg border border-border/10 bg-card/60 p-2 text-muted-fg">
          <div>
            outcome: <span className="font-semibold text-fg">{conflictPanel.result.outcome}</span>
          </div>
          <div>
            conflicts: <span className="text-fg">{conflictPanel.result.conflictingFiles.length}</span> · files changed:{" "}
            <span className="text-fg">{conflictPanel.result.diffStat.filesChanged}</span>
          </div>
        </div>
      ) : null}

      <div className="mb-2">
        <div className="mb-1 text-[11px] font-semibold text-fg">Overlapping Files</div>
        <div className="max-h-[120px] overflow-auto rounded-lg border border-border/10 bg-card/60 p-2 text-[11px]">
          {(() => {
            const key = edgePairKey(conflictPanel.laneAId, conflictPanel.laneBId);
            const files = overlapFilesByPair.get(key) ?? [];
            if (files.length === 0) return <div className="text-muted-fg">No overlap file list.</div>;
            return files.slice(0, 30).map((file) => (
              <div key={file} className="truncate" title={file}>
                {file}
              </div>
            ));
          })()}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-fg">Apply to:</span>
          <select
            aria-label="Apply to lane"
            className="h-7 rounded border border-border/15 bg-white/[0.02] px-2 text-[11px]"
            value={conflictPanel.applyLaneId}
            onChange={(e) =>
              setConflictPanel((prev) =>
                prev ? { ...prev, applyLaneId: e.target.value, preview: null, proposal: null, error: null } : prev,
              )}
          >
            <option value={conflictPanel.laneAId}>
              {laneById.get(conflictPanel.laneAId)?.name ?? conflictPanel.laneAId}
            </option>
            <option value={conflictPanel.laneBId}>
              {laneById.get(conflictPanel.laneBId)?.name ?? conflictPanel.laneBId}
            </option>
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            className="h-7 px-2 text-[11px]"
            disabled={conflictPanel.preparing || conflictPanel.proposing}
            onClick={() => {
              const panel = conflictPanel;
              const laneId = panel.applyLaneId;
              const peerLaneId = laneId === panel.laneAId ? panel.laneBId : panel.laneAId;

              if (!panel.preview) {
                setConflictPanel((prev) =>
                  prev ? { ...prev, preparing: true, error: null, preview: null, proposal: null } : prev,
                );
                void actions.prepareProposal(laneId, peerLaneId).then((result) => {
                  setConflictPanel((prev) =>
                    prev
                      ? {
                        ...prev,
                        preparing: false,
                        ...(result.ok && result.preview
                          ? { preview: result.preview }
                          : { error: result.message ?? "Could not prepare the conflict context." }),
                      }
                      : prev,
                  );
                });
                return;
              }

              setConflictPanel((prev) => (prev ? { ...prev, proposing: true, error: null } : prev));
              void actions
                .requestProposal({ laneId, peerLaneId, contextDigest: panel.preview.contextDigest })
                .then((result) => {
                  setConflictPanel((prev) =>
                    prev
                      ? {
                        ...prev,
                        proposing: false,
                        ...(result.ok && result.proposal
                          ? { proposal: result.proposal }
                          : { error: result.message ?? "Could not resolve this conflict." }),
                      }
                      : prev,
                  );
                });
            }}
          >
            {conflictPanel.preparing
              ? "Preparing…"
              : conflictPanel.proposing
                ? "Resolving…"
                : conflictPanel.preview
                  ? "Send to AI"
                  : "Prepare AI"}
          </Button>
        </div>
      </div>

      {conflictPanel.preview ? (
        <div className="mb-2 rounded-lg border border-border/10 bg-card/60 p-2 text-[11px] text-muted-fg">
          <div className="mb-1 font-semibold text-fg">AI preview</div>
          <div>
            files: <span className="text-fg">{conflictPanel.preview.stats.fileCount}</span> · approx chars:{" "}
            <span className="text-fg">{conflictPanel.preview.stats.approxChars.toLocaleString()}</span> · lane export:{" "}
            <span className="text-fg">{conflictPanel.preview.stats.laneExportChars.toLocaleString()}</span> · peer
            export: <span className="text-fg">{conflictPanel.preview.stats.peerLaneExportChars.toLocaleString()}</span>
            {" "}· conflict export:{" "}
            <span className="text-fg">{conflictPanel.preview.stats.conflictExportChars.toLocaleString()}</span>
          </div>
          {conflictPanel.preview.warnings.length ? (
            <div className="mt-1 text-amber-200/90">{conflictPanel.preview.warnings.slice(0, 2).join(" ")}</div>
          ) : null}
          {conflictPanel.preview.laneExportLite
            || conflictPanel.preview.peerLaneExportLite
            || conflictPanel.preview.conflictExportStandard
            ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-muted-fg">exports sent to AI</summary>
                {conflictPanel.preview.laneExportLite ? (
                  <div className="mt-2">
                    <div className="text-[11px] font-semibold text-fg">lane export (lite)</div>
                    <pre className="mt-1 max-h-40 overflow-auto rounded border border-border/10 bg-card/60 p-2 text-[10px] text-fg whitespace-pre-wrap">
                      {conflictPanel.preview.laneExportLite}
                    </pre>
                  </div>
                ) : null}
                {conflictPanel.preview.peerLaneExportLite ? (
                  <div className="mt-2">
                    <div className="text-[11px] font-semibold text-fg">peer lane export (lite)</div>
                    <pre className="mt-1 max-h-40 overflow-auto rounded border border-border/10 bg-card/60 p-2 text-[10px] text-fg whitespace-pre-wrap">
                      {conflictPanel.preview.peerLaneExportLite}
                    </pre>
                  </div>
                ) : null}
                {conflictPanel.preview.conflictExportStandard ? (
                  <div className="mt-2">
                    <div className="text-[11px] font-semibold text-fg">conflict export (standard)</div>
                    <pre className="mt-1 max-h-40 overflow-auto rounded border border-border/10 bg-card/60 p-2 text-[10px] text-fg whitespace-pre-wrap">
                      {conflictPanel.preview.conflictExportStandard}
                    </pre>
                  </div>
                ) : null}
              </details>
            )
            : null}
          {conflictPanel.preview.files.length ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-muted-fg">included files</summary>
              <div className="mt-1 space-y-2">
                {conflictPanel.preview.files.slice(0, 6).map((f) => (
                  <details key={f.path} className="rounded border border-border/10 bg-card/60 p-2">
                    <summary className="cursor-pointer text-[11px] text-fg">{f.path}</summary>
                    {f.markerPreview ? (
                      <pre className="mt-2 max-h-28 overflow-auto rounded border border-border/10 bg-card/60 p-2 text-[10px] text-fg whitespace-pre-wrap">
                        {f.markerPreview}
                      </pre>
                    ) : null}
                    {f.laneDiff ? (
                      <pre className="mt-2 max-h-28 overflow-auto rounded border border-border/10 bg-card/60 p-2 text-[10px] text-fg whitespace-pre-wrap">
                        {f.laneDiff}
                      </pre>
                    ) : null}
                    {f.peerDiff ? (
                      <pre className="mt-2 max-h-28 overflow-auto rounded border border-border/10 bg-card/60 p-2 text-[10px] text-fg whitespace-pre-wrap">
                        {f.peerDiff}
                      </pre>
                    ) : null}
                  </details>
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ) : null}

      {conflictPanel.proposal ? (
        <div className="space-y-2">
          <div className="rounded-lg border border-border/10 bg-card/60 p-2 text-[11px] text-muted-fg">
            <div className="mb-1 font-semibold text-fg">Proposal</div>
            <div>
              status: <span className="text-fg">{conflictPanel.proposal.status}</span>
            </div>
            {conflictPanel.proposal.confidence != null ? (
              <div>
                confidence: <span className="text-fg">{Math.round(conflictPanel.proposal.confidence * 100)}%</span>
              </div>
            ) : null}
            {conflictPanel.proposal.explanation ? (
              <div className="mt-1 whitespace-pre-wrap">{conflictPanel.proposal.explanation}</div>
            ) : null}
          </div>

          <div className="rounded-lg border border-border/10 bg-card/60 p-2">
            <div className="mb-1 text-[11px] font-semibold text-fg">Apply Mode</div>
            <div className="flex flex-wrap gap-2 text-[11px] text-muted-fg">
              {(["unstaged", "staged", "commit"] as const).map((mode) => (
                <label key={mode} className="inline-flex items-center gap-1">
                  <input
                    type="radio"
                    checked={conflictPanel.applyMode === mode}
                    onChange={() => setConflictPanel((prev) => (prev ? { ...prev, applyMode: mode } : prev))}
                  />
                  {mode}
                </label>
              ))}
            </div>
            {conflictPanel.applyMode === "commit" ? (
              <input
                aria-label="Commit message"
                className="mt-2 h-8 w-full rounded border border-border/15 bg-white/[0.02] px-2 text-[11px]"
                placeholder="Commit message"
                value={conflictPanel.commitMessage}
                onChange={(e) => setConflictPanel((prev) => (prev ? { ...prev, commitMessage: e.target.value } : prev))}
              />
            ) : null}
            <div className="mt-2 flex justify-end gap-2">
              {conflictPanel.proposal.status === "applied" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    const panel = conflictPanel;
                    setConflictPanel((prev) => (prev ? { ...prev, applying: true, error: null } : prev));
                    void actions.undoProposal(panel.applyLaneId, panel.proposal!.id).then((result) => {
                      setConflictPanel((prev) =>
                        prev
                          ? {
                            ...prev,
                            applying: false,
                            ...(result.ok && result.proposal
                              ? { proposal: result.proposal }
                              : { error: result.message ?? "Could not undo this proposal." }),
                          }
                          : prev,
                      );
                      if (result.ok) void refreshRiskBatch().catch(() => {});
                    });
                  }}
                >
                  Undo
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="primary"
                className="h-7 px-2 text-[11px]"
                disabled={conflictPanel.applying}
                onClick={() => {
                  const panel = conflictPanel;
                  if (panel.applyMode === "commit" && !panel.commitMessage.trim()) {
                    setConflictPanel((prev) =>
                      prev ? { ...prev, error: "Commit message is required for commit mode." } : prev,
                    );
                    return;
                  }
                  setConflictPanel((prev) => (prev ? { ...prev, applying: true, error: null } : prev));
                  void actions
                    .applyProposal({
                      laneId: panel.applyLaneId,
                      proposalId: panel.proposal!.id,
                      applyMode: panel.applyMode,
                      ...(panel.applyMode === "commit" ? { commitMessage: panel.commitMessage } : {}),
                    })
                    .then((result) => {
                      setConflictPanel((prev) =>
                        prev
                          ? {
                            ...prev,
                            applying: false,
                            ...(result.ok && result.proposal
                              ? { proposal: result.proposal }
                              : { error: result.message ?? "Could not apply this proposal." }),
                          }
                          : prev,
                      );
                      if (result.ok) {
                        void refreshRiskBatch().catch(() => {});
                        void refreshLanes().catch(() => {});
                      }
                    });
                }}
              >
                {conflictPanel.applying ? "Applying…" : "Apply"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
