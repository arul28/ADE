import React, { useMemo, useState } from "react";
import type { OrchestratorPromptInspector } from "../../../shared/types";
import { COLORS, MONO_FONT, outlineButton } from "../lanes/laneDesignTokens";

export function PromptInspectorCard({
  inspector,
  loading,
  error,
  title,
}: {
  inspector: OrchestratorPromptInspector | null;
  loading?: boolean;
  error?: string | null;
  title?: string;
}) {
  const [expandedLayerIds, setExpandedLayerIds] = useState<Set<string>>(new Set());
  const [showFullPrompt, setShowFullPrompt] = useState(false);

  const layers = inspector?.layers ?? [];
  const notes = inspector?.notes ?? [];
  const toggleLayer = (layerId: string) => {
    setExpandedLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(layerId)) next.delete(layerId);
      else next.add(layerId);
      return next;
    });
  };

  const summary = useMemo(() => {
    if (!inspector) return null;
    return `${inspector.layers.length} layers${inspector.phaseName ? ` • ${inspector.phaseName}` : ""}`;
  }, [inspector]);

  return (
    <div className="space-y-3 p-3" style={{ background: COLORS.cardBg, border: `1px solid ${COLORS.border}` }}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
            {title ?? inspector?.title ?? "Effective prompt"}
          </div>
          {summary ? (
            <div className="mt-1 text-[11px]" style={{ color: COLORS.textSecondary }}>
              {summary}{inspector?.target ? ` • ${inspector.target}` : ""}
            </div>
          ) : null}
        </div>
        {inspector?.fullPrompt ? (
          <button
            type="button"
            style={outlineButton({ height: 22, padding: "0 8px", fontSize: 9 })}
            onClick={() => setShowFullPrompt((prev) => !prev)}
          >
            {showFullPrompt ? "HIDE COMPOSED" : "SHOW COMPOSED"}
          </button>
        ) : null}
      </div>

      {loading ? (
        <div className="text-[11px]" style={{ color: COLORS.textMuted }}>
          Loading prompt composition...
        </div>
      ) : error ? (
        <div className="text-[11px]" style={{ color: COLORS.danger }}>
          {error}
        </div>
      ) : inspector ? (
        <>
          {notes.length > 0 ? (
            <div className="space-y-1 rounded-sm px-3 py-2" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
              {notes.map((note) => (
                <div key={note} className="text-[11px]" style={{ color: COLORS.textSecondary }}>
                  {"\u2022"} {note}
                </div>
              ))}
            </div>
          ) : null}

          <div className="space-y-2">
            {layers.map((layer) => {
              const expanded = expandedLayerIds.has(layer.id);
              const preview = layer.text.length > 280 ? `${layer.text.slice(0, 280).trimEnd()}...` : layer.text;
              return (
                <div key={layer.id} className="rounded-sm" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
                  <div className="flex items-center justify-between gap-3 px-3 py-2">
                    <div>
                      <div className="text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                        {layer.label}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px]" style={{ color: COLORS.textMuted, fontFamily: MONO_FONT }}>
                        <span>{layer.source.replace(/_/g, " ")}</span>
                        <span>{layer.sourceKind.replace(/_/g, " ")}</span>
                        <span>{layer.editable ? "editable" : "read-only"}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      style={outlineButton({ height: 22, padding: "0 8px", fontSize: 9 })}
                      onClick={() => toggleLayer(layer.id)}
                    >
                      {expanded ? "HIDE" : "SHOW"}
                    </button>
                  </div>
                  <div className="px-3 pb-3">
                    {layer.description ? (
                      <div className="mb-2 text-[11px]" style={{ color: COLORS.textSecondary }}>
                        {layer.description}
                      </div>
                    ) : null}
                    <pre
                      className="whitespace-pre-wrap break-words rounded-sm p-3 text-[11px]"
                      style={{ background: COLORS.cardBg, color: COLORS.textSecondary, fontFamily: MONO_FONT }}
                    >
                      {expanded ? layer.text : preview}
                    </pre>
                  </div>
                </div>
              );
            })}
          </div>
          {showFullPrompt && inspector.fullPrompt ? (
            <div className="rounded-sm" style={{ background: COLORS.recessedBg, border: `1px solid ${COLORS.border}` }}>
              <div className="px-3 py-2 text-[10px] font-bold uppercase tracking-[1px]" style={{ color: COLORS.textPrimary, fontFamily: MONO_FONT }}>
                Composed prompt
              </div>
              <pre
                className="px-3 pb-3 whitespace-pre-wrap break-words text-[11px]"
                style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT }}
              >
                {inspector.fullPrompt}
              </pre>
            </div>
          ) : null}
        </>
      ) : (
        <div className="text-[11px]" style={{ color: COLORS.textMuted }}>
          Prompt composition is not available yet for this selection.
        </div>
      )}
    </div>
  );
}
