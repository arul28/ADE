import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { MissionLogChannel, MissionLogEntry } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";
import { useMissionPolling } from "./useMissionPolling";

type MissionLogsTabProps = {
  missionId: string;
  runId: string | null;
  focusInterventionId?: string | null;
  onFocusHandled?: () => void;
};

const CHANNELS: MissionLogChannel[] = [
  "timeline",
  "runtime",
  "chat",
  "outputs",
  "reflections",
  "retrospectives",
  "interventions",
];

const CHANNEL_LABELS: Record<MissionLogChannel, string> = {
  timeline: "Timeline",
  runtime: "Runtime",
  chat: "Chat",
  outputs: "Outputs",
  reflections: "Reflections",
  retrospectives: "Retrospectives",
  interventions: "Interventions",
};

const LEVEL_COLORS: Record<MissionLogEntry["level"], string> = {
  info: COLORS.textMuted,
  warning: COLORS.warning,
  error: COLORS.danger,
};

function formatWhen(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toLocaleString();
}

function mergeEntries(existing: MissionLogEntry[], incoming: MissionLogEntry[]): MissionLogEntry[] {
  const byId = new Map<string, MissionLogEntry>();
  for (const entry of [...existing, ...incoming]) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export const MissionLogsTab = React.memo(function MissionLogsTab({
  missionId,
  runId,
  focusInterventionId,
  onFocusHandled,
}: MissionLogsTabProps) {
  const [selectedChannels, setSelectedChannels] = useState<MissionLogChannel[]>(CHANNELS);
  const [entries, setEntries] = useState<MissionLogEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const channelKey = useMemo(() => selectedChannels.join(","), [selectedChannels]);

  const loadLogs = useCallback(async (cursor?: string | null) => {
    if (!missionId) return;
    const pageLimit = 200;
    if (!cursor) {
      setLoading(true);
      setError(null);
    } else {
      setLoadingMore(true);
    }
    try {
      const result = await window.ade.orchestrator.getMissionLogs({
        missionId,
        runId,
        channels: selectedChannels,
        cursor: cursor ?? null,
        limit: pageLimit,
      });
      setTotal(result.total);
      setNextCursor(result.nextCursor);
      setEntries((prev) => (cursor ? mergeEntries(prev, result.entries) : result.entries));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!cursor) setLoading(false);
      setLoadingMore(false);
    }
  }, [missionId, runId, selectedChannels]);

  useEffect(() => {
    void loadLogs(null);
  }, [loadLogs, channelKey, missionId, runId]);

  useMissionPolling(
    () => {
      void loadLogs(null);
    },
    3_000,
    Boolean(missionId),
  );

  useEffect(() => {
    if (!focusInterventionId) return;
    setSelectedChannels(["interventions"]);
    onFocusHandled?.();
  }, [focusInterventionId, onFocusHandled]);

  const toggleChannel = (channel: MissionLogChannel) => {
    setSelectedChannels((prev) => {
      const next = prev.includes(channel)
        ? prev.filter((entry) => entry !== channel)
        : [...prev, channel];
      return next.length > 0 ? next : [channel];
    });
  };

  const handleExport = async () => {
    try {
      const result = await window.ade.orchestrator.exportMissionLogs({
        missionId,
        runId,
        includeArtifacts: true,
      });
      setExportNotice(`Exported ${result.manifest.entryCount} entries to ${result.bundlePath}`);
    } catch (err) {
      setExportNotice(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {CHANNELS.map((channel) => {
          const active = selectedChannels.includes(channel);
          return (
            <button
              key={channel}
              type="button"
              onClick={() => toggleChannel(channel)}
              className="px-2 py-1 text-[10px] font-bold uppercase tracking-[1px]"
              style={active
                ? { background: `${COLORS.accent}18`, border: `1px solid ${COLORS.accent}35`, color: COLORS.accent, fontFamily: MONO_FONT }
                : { background: COLORS.recessedBg, border: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontFamily: MONO_FONT }
              }
            >
              {CHANNEL_LABELS[channel]}
            </button>
          );
        })}
        <button
          type="button"
          style={outlineButton()}
          onClick={() => void loadLogs(null)}
          disabled={loading}
        >
          Refresh
        </button>
        <button
          type="button"
          style={outlineButton()}
          onClick={() => void handleExport()}
          disabled={loading}
        >
          Export Bundle
        </button>
        <span className="ml-auto text-[10px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
          {entries.length}/{total} entries
        </span>
      </div>

      {exportNotice ? (
        <div className="px-2 py-1 text-[10px]" style={{ background: `${COLORS.accent}10`, border: `1px solid ${COLORS.accent}25`, color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
          {exportNotice}
        </div>
      ) : null}

      {error ? (
        <div className="px-2 py-1 text-[10px]" style={{ background: `${COLORS.danger}14`, border: `1px solid ${COLORS.danger}30`, color: COLORS.danger, fontFamily: MONO_FONT }}>
          {error}
        </div>
      ) : null}

      <div style={{ border: `1px solid ${COLORS.border}`, background: COLORS.cardBg }}>
        {loading && entries.length === 0 ? (
          <div className="px-3 py-6 text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            Loading logs...
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-6 text-xs" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            No log entries yet for the selected channels.
          </div>
        ) : (
          <div className="max-h-[520px] overflow-y-auto">
            {entries.map((entry) => {
              const focused = focusInterventionId && entry.interventionId === focusInterventionId;
              return (
                <div
                  key={entry.id}
                  className="px-3 py-2"
                  style={{
                    borderBottom: `1px solid ${COLORS.border}`,
                    background: focused ? `${COLORS.warning}10` : "transparent",
                  }}
                >
                  <div className="flex items-center gap-2 text-[10px]" style={{ fontFamily: MONO_FONT }}>
                    <span style={{ color: COLORS.textMuted }}>{formatWhen(entry.at)}</span>
                    <span
                      className="px-1 py-0.5 uppercase tracking-[1px]"
                      style={{ background: `${COLORS.accent}15`, border: `1px solid ${COLORS.accent}25`, color: COLORS.accent }}
                    >
                      {CHANNEL_LABELS[entry.channel]}
                    </span>
                    <span style={{ color: LEVEL_COLORS[entry.level] }}>{entry.level.toUpperCase()}</span>
                    {entry.stepKey ? <span style={{ color: COLORS.textDim }}>step:{entry.stepKey}</span> : null}
                    {entry.interventionId ? <span style={{ color: COLORS.warning }}>iv:{entry.interventionId.slice(0, 8)}</span> : null}
                  </div>
                  <div className="mt-1 text-[11px] font-semibold" style={{ color: COLORS.textPrimary }}>
                    {entry.title}
                  </div>
                  <div className="mt-0.5 text-[11px]" style={{ color: COLORS.textSecondary, whiteSpace: "pre-wrap" }}>
                    {entry.message}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {nextCursor ? (
        <div className="flex justify-center">
          <button
            type="button"
            style={outlineButton()}
            onClick={() => void loadLogs(nextCursor)}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading..." : "Load More"}
          </button>
        </div>
      ) : null}
    </div>
  );
});
