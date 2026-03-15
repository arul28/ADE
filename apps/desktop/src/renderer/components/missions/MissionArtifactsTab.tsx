import React, { useMemo, useState } from "react";
import type { GroupedMissionArtifacts, UnifiedMissionArtifact } from "./missionControlViewModel";
import type { ComputerUseOwnerSnapshot, MissionCloseoutRequirement } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { MissionComputerUsePanel } from "./MissionComputerUsePanel";

type ArtifactGroupMode = "phase" | "step" | "type";

function isExternalUri(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function sectionHeading(label: string) {
  return (
    <div className="text-[9px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
      {label}
    </div>
  );
}

function describeCloseoutRequirement(requirement: MissionCloseoutRequirement): string {
  const purposes: Partial<Record<MissionCloseoutRequirement["key"], string>> = {
    validation_verdict: "Shows whether ADE finished validation with an explicit pass or fail call.",
    changed_files_summary: "Summarizes which files changed so the closeout explains the implementation scope.",
    final_outcome_summary: "Captures the end result in plain English for the operator.",
    review_summary: "Summarizes the review findings, follow-ups, or residual risk.",
    screenshot: "Captures a visual proof artifact for UI-facing work.",
    browser_verification: "Records browser-based proof that the user flow was actually exercised.",
    browser_trace: "Keeps a browser trace for debugging or audit follow-up.",
    test_report: "Shows what ADE ran to validate the work and what happened.",
    pr_url: "Links the mission to the pull request created during closeout.",
    proposal_url: "Links the mission to the proposal or review thread created during finalization.",
  };
  return requirement.detail?.trim() || purposes[requirement.key] || "Required to explain or verify the mission before closeout.";
}

function friendlyRequirementStatus(requirement: MissionCloseoutRequirement): {
  label: "Captured" | "Missing" | "Not required";
  color: string;
} {
  if (!requirement.required || requirement.status === "waived") {
    return { label: "Not required", color: COLORS.textMuted };
  }
  if (requirement.status === "present") {
    return { label: "Captured", color: COLORS.success };
  }
  return { label: "Missing", color: COLORS.warning };
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
  missionId = null,
  runId = null,
  laneId = null,
  computerUseSnapshot = null,
}: {
  groupedArtifacts: GroupedMissionArtifacts;
  closeoutRequirements?: MissionCloseoutRequirement[];
  missionId?: string | null;
  runId?: string | null;
  laneId?: string | null;
  computerUseSnapshot?: ComputerUseOwnerSnapshot | null;
}) {
  const [groupMode, setGroupMode] = useState<ArtifactGroupMode>("phase");
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [showOptionalRequirements, setShowOptionalRequirements] = useState(false);

  const groups = useMemo(() => {
    if (groupMode === "step") return groupedArtifacts.byStep;
    if (groupMode === "type") return groupedArtifacts.byType;
    return groupedArtifacts.byPhase;
  }, [groupMode, groupedArtifacts.byPhase, groupedArtifacts.byStep, groupedArtifacts.byType]);

  const selectedArtifact = groupedArtifacts.all.find((artifact) => artifact.id === selectedArtifactId)
    ?? groupedArtifacts.all[0]
    ?? null;
  const visibleRequirements = useMemo(
    () => closeoutRequirements.filter((requirement) => {
      if (showOptionalRequirements) return true;
      return requirement.required && requirement.status !== "waived";
    }),
    [closeoutRequirements, showOptionalRequirements],
  );
  const hiddenRequirementCount = Math.max(0, closeoutRequirements.length - visibleRequirements.length);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {missionId && computerUseSnapshot ? (
        <MissionComputerUsePanel missionId={missionId} laneId={laneId} initialSnapshot={computerUseSnapshot} />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
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
              <div className="flex items-center justify-between gap-3">
                <div className="text-[9px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  Closeout status
                </div>
                {hiddenRequirementCount > 0 ? (
                  <button
                    type="button"
                    style={outlineButton({ height: 24, padding: "0 8px", fontSize: 9 })}
                    onClick={() => setShowOptionalRequirements((current) => !current)}
                  >
                    {showOptionalRequirements ? "HIDE OPTIONAL" : `SHOW ${hiddenRequirementCount} OPTIONAL`}
                  </button>
                ) : null}
              </div>
              <div className="mt-1 text-[11px]" style={{ color: COLORS.textSecondary }}>
                These checks explain what evidence ADE still needs before closeout is complete.
              </div>
              <div className="mt-2 space-y-2">
                {visibleRequirements.length === 0 ? (
                  <div className="rounded-sm p-2 text-[10px]" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textSecondary }}>
                    Only optional or waived closeout checks remain. Use the toggle above if you want to inspect them.
                  </div>
                ) : visibleRequirements.map((requirement) => {
                  const status = friendlyRequirementStatus(requirement);
                  return (
                  <div key={requirement.key} className="rounded-sm p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-[10px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                        {requirement.label}
                      </div>
                      <div className="text-[9px] uppercase" style={{ color: status.color, fontFamily: MONO_FONT }}>
                        {status.label}
                      </div>
                    </div>
                    <div className="mt-1 text-[10px]" style={{ color: COLORS.textSecondary }}>
                      {describeCloseoutRequirement(requirement)}
                    </div>
                  </div>
                );})}
              </div>
            </div>
          ) : null}

          <div className="space-y-3 overflow-auto">
            {groupedArtifacts.all.length === 0 ? (
              <div className="rounded-sm p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
                {sectionHeading("Artifacts")}
                <div className="mt-2 text-[11px]" style={{ color: COLORS.textSecondary }}>
                  No artifacts have been attached yet. Expected evidence slots will appear here as the mission produces outputs.
                </div>
              </div>
            ) : (
              groups.map((group) => (
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
              ))
            )}
          </div>
        </div>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {groupedArtifacts.all.length > 0 ? (
          <ArtifactPreview artifact={selectedArtifact} />
        ) : (
          <div className="p-4 text-[11px]" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted }}>
            Artifact previews will appear here once the mission records files, URIs, or extracted evidence.
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
