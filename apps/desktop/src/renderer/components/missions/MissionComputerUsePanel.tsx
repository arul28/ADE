import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ComputerUseArtifactOwnerKind, ComputerUseArtifactView, ComputerUseOwnerSnapshot } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import {
  buildComputerUseRoutePresets,
  describeComputerUseLinks,
  formatComputerUseKind,
  formatComputerUseMode,
  summarizeComputerUseProof,
} from "../../lib/computerUse";

function isExternalUri(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function openArtifactUri(uri: string | null) {
  if (!uri) return;
  if (isExternalUri(uri)) {
    void window.ade.app.openExternal(uri);
    return;
  }
  void window.ade.app.revealPath(uri);
}

export function MissionComputerUsePanel({
  missionId,
  laneId,
  initialSnapshot,
}: {
  missionId: string;
  laneId?: string | null;
  initialSnapshot?: ComputerUseOwnerSnapshot | null;
}) {
  const [snapshot, setSnapshot] = useState<ComputerUseOwnerSnapshot | null>(initialSnapshot ?? null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(initialSnapshot?.artifacts[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routeKind, setRouteKind] = useState<ComputerUseArtifactOwnerKind>("mission");
  const [routeTargetId, setRouteTargetId] = useState("");

  const refresh = useCallback(async () => {
    const next = await window.ade.computerUse.getOwnerSnapshot({
      owner: { kind: "mission", id: missionId },
    });
    setSnapshot(next);
    setSelectedArtifactId((current) => current && next.artifacts.some((artifact) => artifact.id === current)
      ? current
      : next.artifacts[0]?.id ?? null);
  }, [missionId]);

  useEffect(() => {
    setSnapshot(initialSnapshot ?? null);
    setSelectedArtifactId(initialSnapshot?.artifacts[0]?.id ?? null);
  }, [initialSnapshot]);

  useEffect(() => {
    if (initialSnapshot) return;
    void refresh().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [initialSnapshot, refresh]);

  const selectedArtifact = useMemo(
    () => snapshot?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? snapshot?.artifacts[0] ?? null,
    [selectedArtifactId, snapshot],
  );

  const routePresets = useMemo(
    () => buildComputerUseRoutePresets({ missionId, laneId }),
    [laneId, missionId],
  );

  const updateReview = useCallback(async (artifactId: string, reviewState: ComputerUseArtifactView["reviewState"], workflowState?: ComputerUseArtifactView["workflowState"]) => {
    setBusy(true);
    setError(null);
    try {
      await window.ade.computerUse.updateArtifactReview({
        artifactId,
        reviewState,
        ...(workflowState ? { workflowState } : {}),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const routeArtifact = useCallback(async (artifactId: string, ownerKind: ComputerUseArtifactOwnerKind, ownerId: string) => {
    if (!ownerId.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.ade.computerUse.routeArtifact({
        artifactId,
        owner: { kind: ownerKind, id: ownerId.trim() },
      });
      setRouteTargetId("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (!snapshot) return null;

  return (
    <div className="space-y-3 rounded-sm p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            Computer-Use Proof Review
          </div>
          <div className="mt-1 text-[12px]" style={{ color: COLORS.textPrimary }}>
            {snapshot.summary}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="px-2 py-1 text-[9px] uppercase tracking-[1px]" style={{ color: snapshot.usingLocalFallback ? COLORS.warning : COLORS.success, border: `1px solid ${(snapshot.usingLocalFallback ? COLORS.warning : COLORS.success)}35`, fontFamily: MONO_FONT }}>
            {snapshot.usingLocalFallback ? "fallback" : "external"}
          </span>
          <button type="button" style={outlineButton({ height: 26, padding: "0 8px", fontSize: 9 })} onClick={() => void refresh()} disabled={busy}>
            REFRESH
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
        <span>Policy: {formatComputerUseMode(snapshot.policy)}</span>
        <span>{summarizeComputerUseProof(snapshot)}</span>
        <span>Backend: {snapshot.activeBackend?.name ?? "not selected"}</span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div className="space-y-2">
          {snapshot.artifacts.length === 0 ? (
            <div className="text-[10px]" style={{ color: COLORS.textDim, fontFamily: MONO_FONT }}>
              No computer-use artifacts are linked to this mission yet.
            </div>
          ) : snapshot.artifacts.map((artifact) => {
            const selected = artifact.id === selectedArtifact?.id;
            return (
              <button
                key={artifact.id}
                type="button"
                onClick={() => setSelectedArtifactId(artifact.id)}
                className="w-full text-left"
                style={{
                  border: `1px solid ${selected ? COLORS.accent : COLORS.border}`,
                  background: selected ? `${COLORS.accent}10` : COLORS.recessedBg,
                  padding: 10,
                }}
              >
                <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  {artifact.backendName}
                </div>
                <div className="mt-1 text-[12px]" style={{ color: COLORS.textPrimary }}>
                  {artifact.title}
                </div>
                <div className="mt-1 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  {formatComputerUseKind(artifact.kind)} • {artifact.reviewState} • {artifact.workflowState}
                </div>
              </button>
            );
          })}
        </div>

        <div className="space-y-3">
          {selectedArtifact ? (
            <>
              <div className="rounded-sm p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      {selectedArtifact.backendName}
                    </div>
                    <div className="mt-1 text-[14px]" style={{ color: COLORS.textPrimary }}>
                      {selectedArtifact.title}
                    </div>
                    {selectedArtifact.description ? (
                      <div className="mt-2 text-[11px]" style={{ color: COLORS.textSecondary }}>
                        {selectedArtifact.description}
                      </div>
                    ) : null}
                  </div>
                  {selectedArtifact.uri ? (
                    <button type="button" style={outlineButton({ height: 28, padding: "0 10px", fontSize: 9 })} onClick={() => openArtifactUri(selectedArtifact.uri)}>
                      {isExternalUri(selectedArtifact.uri) ? "OPEN" : "REVEAL"}
                    </button>
                  ) : null}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  <span>{formatComputerUseKind(selectedArtifact.kind)}</span>
                  <span>{selectedArtifact.reviewState}</span>
                  <span>{selectedArtifact.workflowState}</span>
                  <span>{describeComputerUseLinks(selectedArtifact.links)}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="button" style={outlineButton({ height: 26, padding: "0 8px", fontSize: 9 })} onClick={() => void updateReview(selectedArtifact.id, "accepted", "promoted")} disabled={busy}>
                  ACCEPT
                </button>
                <button type="button" style={outlineButton({ height: 26, padding: "0 8px", fontSize: 9 })} onClick={() => void updateReview(selectedArtifact.id, "needs_more")} disabled={busy}>
                  NEED MORE
                </button>
                <button type="button" style={outlineButton({ height: 26, padding: "0 8px", fontSize: 9 })} onClick={() => void updateReview(selectedArtifact.id, "dismissed", "dismissed")} disabled={busy}>
                  DISMISS
                </button>
                <button type="button" style={outlineButton({ height: 26, padding: "0 8px", fontSize: 9 })} onClick={() => void updateReview(selectedArtifact.id, "accepted", "published")} disabled={busy}>
                  PUBLISH
                </button>
              </div>

              <div className="space-y-2 rounded-sm p-3" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  Route Artifact
                </div>
                <div className="flex flex-wrap gap-2">
                  {routePresets.map((preset) => (
                    <button
                      key={`${preset.owner.kind}:${preset.owner.id}`}
                      type="button"
                      style={outlineButton({ height: 26, padding: "0 8px", fontSize: 9 })}
                      onClick={() => void routeArtifact(selectedArtifact.id, preset.owner.kind, preset.owner.id)}
                      disabled={busy}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="grid gap-2 md:grid-cols-[160px_minmax(0,1fr)_auto]">
                  <select
                    value={routeKind}
                    onChange={(e) => setRouteKind(e.target.value as ComputerUseArtifactOwnerKind)}
                    className="h-8 px-2 text-[11px] outline-none"
                  style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary, fontFamily: MONO_FONT }}
                >
                  <option value="mission">mission</option>
                  <option value="lane">lane</option>
                  <option value="github_pr">GitHub PR</option>
                  <option value="linear_issue">linear issue</option>
                  <option value="automation_run">automation run</option>
                </select>
                  <input
                    value={routeTargetId}
                    onChange={(e) => setRouteTargetId(e.target.value)}
                    placeholder="Target ID"
                    className="h-8 px-2 text-[11px] outline-none"
                    style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, color: COLORS.textPrimary, fontFamily: MONO_FONT }}
                  />
                  <button type="button" style={outlineButton({ height: 32, padding: "0 10px", fontSize: 9 })} onClick={() => void routeArtifact(selectedArtifact.id, routeKind, routeTargetId)} disabled={busy || !routeTargetId.trim()}>
                    ATTACH
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="text-[10px]" style={{ color: COLORS.warning, fontFamily: MONO_FONT }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
