import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { GroupedMissionArtifacts, UnifiedMissionArtifact } from "./missionControlViewModel";
import type { ComputerUseOwnerSnapshot, EpisodicMemory, MemoryEntryDto, MissionCloseoutRequirement } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { MissionComputerUsePanel } from "./MissionComputerUsePanel";

type ArtifactGroupMode = "phase" | "step" | "type";

function isExternalUri(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isMemoryCategory(
  value: unknown,
): value is MemoryEntryDto["category"] {
  return typeof value === "string"
    && ["fact", "preference", "pattern", "decision", "gotcha", "convention", "episode", "procedure", "digest", "handoff"].includes(value);
}

function isMemoryScope(
  value: unknown,
): value is MemoryEntryDto["scope"] {
  return value === "project" || value === "agent" || value === "mission";
}

function isMemoryStatus(
  value: unknown,
): value is MemoryEntryDto["status"] {
  return value === "candidate" || value === "promoted" || value === "archived";
}

function isMemoryImportance(
  value: unknown,
): value is MemoryEntryDto["importance"] {
  return value === "low" || value === "medium" || value === "high";
}

function toMemoryEntryDto(value: unknown): MemoryEntryDto | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  const content = typeof row.content === "string" ? row.content : "";
  if (!id || !content || !isMemoryScope(row.scope) || !isMemoryCategory(row.category) || !isMemoryStatus(row.status) || !isMemoryImportance(row.importance)) {
    return null;
  }
  return {
    id,
    scope: row.scope,
    scopeOwnerId: typeof row.scopeOwnerId === "string" ? row.scopeOwnerId : null,
    tier: Number(row.tier ?? 0) || 0,
    pinned: row.pinned === true || row.pinned === 1,
    category: row.category,
    content,
    importance: row.importance,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : "",
    lastAccessedAt: typeof row.lastAccessedAt === "string" ? row.lastAccessedAt : "",
    accessCount: Number(row.accessCount ?? 0) || 0,
    observationCount: Number(row.observationCount ?? 0) || 0,
    status: row.status,
    confidence: Number(row.confidence ?? 0) || 0,
    embedded: row.embedded === true || row.embedded === 1,
    sourceRunId: typeof row.sourceRunId === "string" ? row.sourceRunId : null,
    sourceType: typeof row.sourceType === "string" ? row.sourceType : null,
    sourceId: typeof row.sourceId === "string" ? row.sourceId : null,
    fileScopePattern: typeof row.fileScopePattern === "string"
      ? row.fileScopePattern
      : (typeof row.file_scope_pattern === "string" ? row.file_scope_pattern : null),
  };
}

function parseEpisode(content: string): EpisodicMemory | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const taskDescription = typeof parsed.taskDescription === "string" ? parsed.taskDescription.trim() : "";
    const approachTaken = typeof parsed.approachTaken === "string" ? parsed.approachTaken.trim() : "";
    const outcome = typeof parsed.outcome === "string" ? parsed.outcome : "";
    if (!taskDescription || !approachTaken || !["success", "partial", "failure"].includes(outcome)) return null;
    return {
      id: typeof parsed.id === "string" && parsed.id.trim().length > 0 ? parsed.id : "episode",
      ...(typeof parsed.sessionId === "string" && parsed.sessionId.trim().length > 0 ? { sessionId: parsed.sessionId } : {}),
      ...(typeof parsed.missionId === "string" && parsed.missionId.trim().length > 0 ? { missionId: parsed.missionId } : {}),
      taskDescription,
      approachTaken,
      outcome: outcome as EpisodicMemory["outcome"],
      toolsUsed: Array.isArray(parsed.toolsUsed) ? parsed.toolsUsed.map((entry) => String(entry ?? "")).filter(Boolean) : [],
      patternsDiscovered: Array.isArray(parsed.patternsDiscovered) ? parsed.patternsDiscovered.map((entry) => String(entry ?? "")).filter(Boolean) : [],
      gotchas: Array.isArray(parsed.gotchas) ? parsed.gotchas.map((entry) => String(entry ?? "")).filter(Boolean) : [],
      decisionsMade: Array.isArray(parsed.decisionsMade) ? parsed.decisionsMade.map((entry) => String(entry ?? "")).filter(Boolean) : [],
      duration: Number(parsed.duration ?? 0) || 0,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unknown";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function badgeColorForMemory(entry: MemoryEntryDto): string {
  if (entry.status === "candidate") return COLORS.warning;
  if (entry.status === "archived") return COLORS.textDim;
  if (entry.category === "gotcha") return COLORS.danger;
  if (entry.category === "handoff") return COLORS.info;
  if (entry.category === "decision") return COLORS.accent;
  return COLORS.success;
}

function sectionHeading(label: string) {
  return (
    <div className="text-[9px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
      {label}
    </div>
  );
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
  const [missionMemories, setMissionMemories] = useState<MemoryEntryDto[]>([]);
  const [missionEpisode, setMissionEpisode] = useState<MemoryEntryDto | null>(null);
  const [missionMemoryLoading, setMissionMemoryLoading] = useState(false);
  const [missionMemoryError, setMissionMemoryError] = useState<string | null>(null);
  const [memoryActionBusyId, setMemoryActionBusyId] = useState<string | null>(null);

  const loadMissionMemory = useCallback(async () => {
    if (!missionId || !window.ade.memory?.listMissionEntries) {
      setMissionMemories([]);
      setMissionEpisode(null);
      setMissionMemoryError(null);
      return;
    }
    setMissionMemoryLoading(true);
    try {
      const [entries, episodeMatchesRaw] = await Promise.all([
        window.ade.memory.listMissionEntries({ missionId, runId, status: "all" }),
        window.ade.memory.search({ query: missionId, limit: 25, mode: "lexical", status: "all" }),
      ]);
      const episodeMatches = Array.isArray(episodeMatchesRaw)
        ? episodeMatchesRaw.map((entry) => toMemoryEntryDto(entry)).filter((entry): entry is MemoryEntryDto => entry !== null)
        : [];
      const episodeEntry = episodeMatches.find((entry) =>
        entry.category === "episode"
        && entry.scope === "project"
        && (entry.sourceId === runId || entry.content.includes(`"missionId":"${missionId}"`) || entry.content.includes(`"missionId": "${missionId}"`)),
      ) ?? null;
      setMissionMemories(entries);
      setMissionEpisode(episodeEntry);
      setMissionMemoryError(null);
    } catch (error) {
      setMissionMemoryError(error instanceof Error ? error.message : String(error));
    } finally {
      setMissionMemoryLoading(false);
    }
  }, [missionId, runId]);

  useEffect(() => {
    void loadMissionMemory();
  }, [loadMissionMemory]);

  const groups = useMemo(() => {
    if (groupMode === "step") return groupedArtifacts.byStep;
    if (groupMode === "type") return groupedArtifacts.byType;
    return groupedArtifacts.byPhase;
  }, [groupMode, groupedArtifacts.byPhase, groupedArtifacts.byStep, groupedArtifacts.byType]);

  const memoryGroups = useMemo(() => {
    const orderedCategories: Array<{ key: MemoryEntryDto["category"] | "other"; label: string }> = [
      { key: "decision", label: "Decisions" },
      { key: "fact", label: "Facts" },
      { key: "handoff", label: "Handoffs" },
      { key: "gotcha", label: "Gotchas" },
      { key: "other", label: "Other mission memory" },
    ];
    return orderedCategories.map((group) => ({
      ...group,
      items: missionMemories.filter((entry) => {
        if (group.key === "other") {
          return !["decision", "fact", "handoff", "gotcha"].includes(entry.category);
        }
        return entry.category === group.key;
      }),
    })).filter((group) => group.items.length > 0);
  }, [missionMemories]);

  const parsedEpisode = useMemo(() => (missionEpisode ? parseEpisode(missionEpisode.content) : null), [missionEpisode]);

  const selectedArtifact = groupedArtifacts.all.find((artifact) => artifact.id === selectedArtifactId)
    ?? groupedArtifacts.all[0]
    ?? null;

  const handlePromoteMemory = async (memoryId: string) => {
    if (!missionId || !window.ade.memory) return;
    setMemoryActionBusyId(memoryId);
    try {
      await window.ade.memory.promoteMissionEntry({ id: memoryId, missionId });
      await loadMissionMemory();
    } finally {
      setMemoryActionBusyId(null);
    }
  };

  const handleArchiveMemory = async (memoryId: string) => {
    if (!window.ade.memory) return;
    setMemoryActionBusyId(memoryId);
    try {
      await window.ade.memory.archive({ id: memoryId });
      await loadMissionMemory();
    } finally {
      setMemoryActionBusyId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {missionId && computerUseSnapshot ? (
        <MissionComputerUsePanel missionId={missionId} laneId={laneId} initialSnapshot={computerUseSnapshot} />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row">
      <div className="min-h-0 min-w-0 lg:w-[380px] lg:max-w-[40%] lg:shrink-0">
        <div className="space-y-3">
          <div className="rounded-sm p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            {sectionHeading("Mission memory")}
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="text-[10px]" style={{ color: COLORS.textSecondary }}>
                Decisions, facts, handoffs, and gotchas captured during this mission.
              </div>
              <button
                type="button"
                style={outlineButton({ height: 24, padding: "0 8px", fontSize: 9 })}
                onClick={() => void loadMissionMemory()}
                disabled={missionMemoryLoading}
              >
                {missionMemoryLoading ? "REFRESHING" : "REFRESH"}
              </button>
            </div>
            {missionMemoryError ? (
              <div className="mt-2 text-[10px]" style={{ color: COLORS.warning, fontFamily: MONO_FONT }}>
                {missionMemoryError}
              </div>
            ) : null}
            {missionMemoryLoading && missionMemories.length === 0 ? (
              <div className="mt-2 text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                Loading mission memory...
              </div>
            ) : null}
            {!missionMemoryLoading && memoryGroups.length === 0 ? (
              <div className="mt-2 text-[10px]" style={{ color: COLORS.textMuted }}>
                No mission-scoped memory has been recorded yet.
              </div>
            ) : null}
            <div className="mt-3 space-y-3">
              {memoryGroups.map((group) => (
                <div key={group.key} className="space-y-2">
                  <div className="text-[9px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                    {group.label}
                  </div>
                  {group.items.map((entry) => (
                    <div key={entry.id} className="rounded-sm p-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[10px] uppercase tracking-[1px]" style={{ color: badgeColorForMemory(entry), fontFamily: MONO_FONT }}>
                            {entry.status} · {Math.round(entry.confidence * 100)}%
                          </div>
                          <div className="mt-1 whitespace-pre-wrap text-[11px]" style={{ color: COLORS.textPrimary }}>
                            {entry.content}
                          </div>
                          <div className="mt-1 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                            {formatTimestamp(entry.createdAt)} · tier {entry.tier}
                          </div>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {entry.status === "candidate" ? (
                            <button
                              type="button"
                              style={outlineButton({ height: 24, padding: "0 8px", fontSize: 9 })}
                              onClick={() => void handlePromoteMemory(entry.id)}
                              disabled={memoryActionBusyId === entry.id}
                            >
                              PROMOTE
                            </button>
                          ) : null}
                          <button
                            type="button"
                            style={outlineButton({ height: 24, padding: "0 8px", fontSize: 9 })}
                            onClick={() => void handleArchiveMemory(entry.id)}
                            disabled={memoryActionBusyId === entry.id}
                          >
                            ARCHIVE
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-sm p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
            {sectionHeading("Mission episode")}
            {parsedEpisode ? (
              <div className="mt-2 space-y-2">
                <div className="text-[11px] font-medium" style={{ color: COLORS.textPrimary }}>
                  {parsedEpisode.taskDescription}
                </div>
                <div className="text-[9px] uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                  {parsedEpisode.outcome} · {Math.round(parsedEpisode.duration)}s · {formatTimestamp(parsedEpisode.createdAt || missionEpisode?.createdAt)}
                </div>
                <div className="whitespace-pre-wrap text-[11px]" style={{ color: COLORS.textSecondary }}>
                  {parsedEpisode.approachTaken}
                </div>
                {parsedEpisode.decisionsMade.length > 0 ? (
                  <div className="space-y-1">
                    <div className="text-[9px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      Decisions
                    </div>
                    {parsedEpisode.decisionsMade.map((entry) => (
                      <div key={entry} className="text-[10px]" style={{ color: COLORS.textSecondary }}>
                        {entry}
                      </div>
                    ))}
                  </div>
                ) : null}
                {parsedEpisode.gotchas.length > 0 ? (
                  <div className="space-y-1">
                    <div className="text-[9px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                      Gotchas
                    </div>
                    {parsedEpisode.gotchas.map((entry) => (
                      <div key={entry} className="text-[10px]" style={{ color: COLORS.textSecondary }}>
                        {entry}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="mt-2 text-[10px]" style={{ color: COLORS.textMuted }}>
                No generated episode has been stored for this mission yet.
              </div>
            )}
          </div>

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
