import React, { useMemo, useState } from "react";
import type { GroupedMissionArtifacts, UnifiedMissionArtifact } from "./missionControlViewModel";
import type { MissionCloseoutRequirement } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";

type ArtifactGroupMode = "phase" | "step" | "type";

function isExternalUri(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function ArtifactPreview({ artifact }: { artifact: UnifiedMissionArtifact | null }) {
  if (!artifact) {
    return (
      <div className="p-4 text-[11px]" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
        Select an artifact to inspect its evidence, linked URI, or extracted text content.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="p-4" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
              {artifact.source}
            </div>
            <div className="mt-2 text-[14px] font-semibold" style={{ color: COLORS.textPrimary }}>
              {artifact.title}
            </div>
            {artifact.description ? (
              <div className="mt-2 text-[11px]" style={{ color: COLORS.textSecondary }}>
                {artifact.description}
              </div>
            ) : null}
          </div>
          {artifact.uri ? (
            <button
              type="button"
              style={outlineButton({ height: 28, padding: "0 10px", fontSize: 9 })}
              onClick={() => {
                if (isExternalUri(artifact.uri!)) void window.ade.app.openExternal(artifact.uri!);
                else void window.ade.app.revealPath(artifact.uri!);
              }}
            >
              {isExternalUri(artifact.uri) ? "OPEN URI" : "REVEAL"}
            </button>
          ) : null}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          <span>{artifact.artifactType}</span>
          {artifact.phaseName ? <span>{artifact.phaseName}</span> : null}
          {artifact.stepTitle ? <span>{artifact.stepTitle}</span> : null}
          {artifact.declared ? <span>declared</span> : <span>discovered</span>}
          {artifact.missingExpectedEvidence ? <span style={{ color: COLORS.warning }}>missing</span> : null}
        </div>
      </div>

      {artifact.textContent ? (
        <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words p-4 text-[11px]" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
          {artifact.textContent}
        </pre>
      ) : (
        <div className="p-4 text-[11px]" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
          This artifact is URI-backed only. Use the action button above to open it.
        </div>
      )}
    </div>
  );
}

export function MissionArtifactsTab({
  groupedArtifacts,
  closeoutRequirements = [],
}: {
  groupedArtifacts: GroupedMissionArtifacts;
  closeoutRequirements?: MissionCloseoutRequirement[];
}) {
  const [groupMode, setGroupMode] = useState<ArtifactGroupMode>("phase");
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);

  const groups = useMemo(() => {
    if (groupMode === "step") return groupedArtifacts.byStep;
    if (groupMode === "type") return groupedArtifacts.byType;
    return groupedArtifacts.byPhase;
  }, [groupMode, groupedArtifacts.byPhase, groupedArtifacts.byStep, groupedArtifacts.byType]);

  const selectedArtifact = groupedArtifacts.all.find((artifact) => artifact.id === selectedArtifactId)
    ?? groupedArtifacts.all[0]
    ?? null;

  if (groupedArtifacts.all.length === 0) {
    return (
      <div className="p-6" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
        <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          Artifacts
        </div>
        <div className="mt-3 text-[12px]" style={{ color: COLORS.textSecondary }}>
          No artifacts have been attached yet. Expected evidence slots will appear here as the mission produces outputs.
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 lg:flex-row">
      <div className="min-h-0 min-w-0 lg:w-[380px] lg:max-w-[40%] lg:shrink-0">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            {(["phase", "step", "type"] as ArtifactGroupMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                style={outlineButton({
                  height: 24,
                  padding: "0 8px",
                  fontSize: 9,
                  background: groupMode === mode ? `${COLORS.accent}14` : COLORS.cardBg,
                  color: groupMode === mode ? COLORS.accent : COLORS.textMuted,
                  border: `1px solid ${groupMode === mode ? `${COLORS.accent}35` : COLORS.border}`,
                })}
                onClick={() => setGroupMode(mode)}
              >
                {mode.toUpperCase()}
              </button>
            ))}
          </div>

          {groupedArtifacts.expectedEvidence.length > 0 ? (
            <div className="rounded-sm p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
              <div className="text-[9px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Expected evidence
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {groupedArtifacts.expectedEvidence.map((entry) => (
                  <span
                    key={entry}
                    className="px-1.5 py-0.5 text-[9px] uppercase tracking-[1px]"
                    style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary, fontFamily: MONO_FONT }}
                  >
                    {entry.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {closeoutRequirements.length > 0 ? (
            <div className="rounded-sm p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
              <div className="text-[9px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Closeout contract
              </div>
              <div className="mt-2 space-y-2">
                {closeoutRequirements.map((requirement) => (
                  <div key={requirement.key} className="rounded-sm p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                        {requirement.label}
                      </div>
                      <div className="text-[9px] uppercase" style={{ color: requirement.status === "present" || requirement.status === "waived" ? COLORS.success : COLORS.warning, fontFamily: MONO_FONT }}>
                        {requirement.status.replace(/_/g, " ")}
                      </div>
                    </div>
                    {requirement.detail ? (
                      <div className="mt-1 text-[10px]" style={{ color: COLORS.textSecondary }}>
                        {requirement.detail}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-3 overflow-auto">
            {groups.map((group) => (
              <section key={group.key} className="rounded-sm p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                    {group.label}
                  </div>
                  <div className="text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    {group.items.length}
                  </div>
                </div>
                <div className="mt-2 space-y-2">
                  {group.items.map((artifact) => {
                    const selected = selectedArtifact?.id === artifact.id;
                    return (
                      <button
                        key={artifact.id}
                        type="button"
                        className="w-full rounded-sm px-3 py-2 text-left"
                        style={{
                          background: selected ? `${COLORS.accent}12` : COLORS.recessedBg,
                          border: `1px solid ${selected ? `${COLORS.accent}35` : COLORS.border}`,
                        }}
                        onClick={() => setSelectedArtifactId(artifact.id)}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 text-[11px] font-medium" style={{ color: COLORS.textPrimary }}>
                            {artifact.title}
                          </div>
                          {artifact.missingExpectedEvidence ? (
                            <span className="text-[9px]" style={{ color: COLORS.warning, fontFamily: MONO_FONT }}>
                              missing
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                          <span>{artifact.artifactType}</span>
                          {artifact.stepTitle ? <span>{artifact.stepTitle}</span> : null}
                          {artifact.uri ? <span>uri</span> : null}
                          {artifact.textContent ? <span>preview</span> : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <ArtifactPreview artifact={selectedArtifact} />
      </div>
    </div>
  );
}
