import React, { useState, useEffect, useCallback } from "react";
import { COLORS, MONO_FONT, LABEL_STYLE } from "../lanes/laneDesignTokens";
import type { LaneTemplate } from "../../../shared/types";

export function LaneTemplatesSection() {
  const [templates, setTemplates] = useState<LaneTemplate[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [tpls, defId] = await Promise.all([
        window.ade.lanes.listTemplates(),
        window.ade.lanes.getDefaultTemplate(),
      ]);
      setTemplates(tpls);
      setDefaultId(defId);
    } catch {
      setTemplates([]);
      setDefaultId(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSetDefault = useCallback(async (templateId: string) => {
    const newId = templateId || null;
    try {
      await window.ade.lanes.setDefaultTemplate({ templateId: newId });
      setDefaultId(newId);
    } catch {
      await refresh();
    }
  }, [refresh]);

  if (loading) {
    return <div style={{ fontSize: 12, color: COLORS.textMuted, padding: 16 }}>Loading templates...</div>;
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ ...LABEL_STYLE, fontSize: 11, marginBottom: 12 }}>LANE TEMPLATES</div>

      {/* Default template selector */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, fontFamily: MONO_FONT, textTransform: "uppercase", letterSpacing: "1px", color: COLORS.textMuted, marginBottom: 4 }}>
          Default template for new lanes
        </div>
        <select
          value={defaultId ?? ""}
          onChange={(e) => handleSetDefault(e.target.value)}
          style={{
            height: 28,
            width: "100%",
            maxWidth: 400,
            background: COLORS.recessedBg,
            border: `1px solid ${COLORS.outlineBorder}`,
            padding: "0 8px",
            fontSize: 11,
            color: COLORS.textPrimary,
            fontFamily: MONO_FONT,
            borderRadius: 0,
            outline: "none",
          }}
        >
          <option value="">None</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>

      {/* Template list */}
      {templates.length === 0 ? (
        <div style={{ fontSize: 12, color: COLORS.textMuted }}>
          No templates defined. Add templates to <code style={{ fontFamily: MONO_FONT }}>.ade/local.yaml</code> or <code style={{ fontFamily: MONO_FONT }}>.ade/ade.yaml</code> under the <code style={{ fontFamily: MONO_FONT }}>laneTemplates</code> key.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {templates.map((t) => (
            <TemplateCard key={t.id} template={t} isDefault={t.id === defaultId} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template, isDefault }: { template: LaneTemplate; isDefault: boolean }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        background: COLORS.cardBg,
        border: `1px solid ${isDefault ? COLORS.info : COLORS.outlineBorder}`,
        padding: "8px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setExpanded(!expanded)}>
        <div>
          <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.textPrimary }}>{template.name}</span>
          {isDefault && (
            <span style={{ marginLeft: 8, fontSize: 9, fontWeight: 700, fontFamily: MONO_FONT, color: COLORS.info, textTransform: "uppercase", letterSpacing: "0.5px" }}>DEFAULT</span>
          )}
          {template.description && (
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2 }}>{template.description}</div>
          )}
        </div>
        <span style={{ fontSize: 10, color: COLORS.textMuted }}>{expanded ? "collapse" : "expand"}</span>
      </div>
      {expanded && (
        <div style={{ marginTop: 8, fontSize: 11, color: COLORS.textSecondary, fontFamily: MONO_FONT }}>
          {template.envFiles && template.envFiles.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: COLORS.textMuted }}>Env files:</span>{" "}
              {template.envFiles.map((f) => `${f.source} -> ${f.dest}`).join(", ")}
            </div>
          )}
          {template.docker?.composePath && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: COLORS.textMuted }}>Docker:</span>{" "}
              {template.docker.composePath}
              {template.docker.services?.length ? ` (${template.docker.services.join(", ")})` : ""}
            </div>
          )}
          {template.dependencies && template.dependencies.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: COLORS.textMuted }}>Dependencies:</span>{" "}
              {template.dependencies.map((d) => d.command.join(" ")).join("; ")}
            </div>
          )}
          {template.mountPoints && template.mountPoints.length > 0 && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: COLORS.textMuted }}>Mount points:</span>{" "}
              {template.mountPoints.map((m) => `${m.source} -> ${m.dest}`).join(", ")}
            </div>
          )}
          {template.portRange && (
            <div style={{ marginBottom: 4 }}>
              <span style={{ color: COLORS.textMuted }}>Port range:</span>{" "}
              {template.portRange.start}-{template.portRange.end}
            </div>
          )}
          {template.envVars && Object.keys(template.envVars).length > 0 && (
            <div>
              <span style={{ color: COLORS.textMuted }}>Env vars:</span>{" "}
              {Object.entries(template.envVars).map(([k, v]) => `${k}=${v}`).join(", ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
