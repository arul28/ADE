import { useState, useEffect, useCallback } from "react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  outlineButton,
  primaryButton,
  dangerButton,
  cardStyle,
  recessedStyle,
} from "../lanes/laneDesignTokens";
import type {
  LaneTemplate,
  LaneCopyPathConfig,
  LaneEnvFileConfig,
  LaneDependencyInstallConfig,
  LaneMountPointConfig,
} from "../../../shared/types";

function generateId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function emptyTemplate(): LaneTemplate {
  return { id: generateId(), name: "" };
}

// ---------------------------------------------------------------------------
// Shared inline styles
// ---------------------------------------------------------------------------

const inputStyle: React.CSSProperties = {
  height: 32,
  width: "100%",
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  padding: "0 10px",
  fontSize: 12,
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  borderRadius: 6,
  outline: "none",
};

const monoInputStyle: React.CSSProperties = { ...inputStyle, fontFamily: MONO_FONT, fontSize: 11 };

const miniLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  fontFamily: SANS_FONT,
  textTransform: "uppercase" as const,
  letterSpacing: "0.5px",
  color: COLORS.textMuted,
  marginBottom: 4,
};

const removeBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: COLORS.textDim,
  cursor: "pointer",
  fontSize: 14,
  padding: "0 4px",
  lineHeight: 1,
};

// ---------------------------------------------------------------------------
// Main section
// ---------------------------------------------------------------------------

export function LaneTemplatesSection() {
  const [templates, setTemplates] = useState<LaneTemplate[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<LaneTemplate | null>(null);

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

  const handleSave = useCallback(async (template: LaneTemplate) => {
    try {
      await window.ade.lanes.saveTemplate({ template });
      setEditing(null);
      await refresh();
    } catch (err: any) {
      alert(`Failed to save template: ${err?.message ?? err}`);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (templateId: string) => {
    try {
      await window.ade.lanes.deleteTemplate({ templateId });
      await refresh();
    } catch (err: any) {
      alert(`Failed to delete template: ${err?.message ?? err}`);
    }
  }, [refresh]);

  if (loading) {
    return <div style={{ fontSize: 12, color: COLORS.textMuted, padding: 16 }}>Loading templates...</div>;
  }

  // If editing, show the editor
  if (editing) {
    return (
      <div style={{ padding: 16 }}>
        <TemplateEditor
          template={editing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      </div>
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ ...LABEL_STYLE, fontSize: 11, margin: 0 }}>LANE TEMPLATES</div>
        <button
          style={outlineButton({ height: 28, fontSize: 11 })}
          onClick={() => setEditing(emptyTemplate())}
        >
          + New template
        </button>
      </div>

      {/* Default template selector */}
      {templates.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={miniLabel}>Default template for new lanes</div>
          <select
            value={defaultId ?? ""}
            onChange={(e) => handleSetDefault(e.target.value)}
            style={{ ...inputStyle, maxWidth: 400 }}
          >
            <option value="">None</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Template list */}
      {templates.length === 0 ? (
        <EmptyState onCreateTemplate={() => setEditing(emptyTemplate())} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {templates.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              isDefault={t.id === defaultId}
              onEdit={() => setEditing({ ...t })}
              onDelete={() => handleDelete(t.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template card (read-only view in list)
// ---------------------------------------------------------------------------

function TemplateCard({
  template,
  isDefault,
  onEdit,
  onDelete,
}: {
  template: LaneTemplate;
  isDefault: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const featureCount = [
    template.copyPaths?.length ?? 0,
    template.envFiles?.length ?? 0,
    template.dependencies?.length ?? 0,
    template.mountPoints?.length ?? 0,
    template.docker?.composePath ? 1 : 0,
    template.portRange ? 1 : 0,
    Object.keys(template.envVars ?? {}).length > 0 ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  return (
    <div style={{ ...cardStyle({ padding: "10px 14px", borderRadius: 10 }), ...(isDefault ? { borderColor: `${COLORS.info}40` } : {}) }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{template.name || "Untitled"}</span>
            {isDefault && (
              <span style={{
                fontSize: 9,
                fontWeight: 700,
                fontFamily: MONO_FONT,
                color: COLORS.info,
                textTransform: "uppercase",
                letterSpacing: "0.5px",
                background: `${COLORS.info}15`,
                padding: "2px 6px",
                borderRadius: 4,
              }}>
                DEFAULT
              </span>
            )}
            <span style={{ fontSize: 10, color: COLORS.textDim }}>
              {featureCount} config{featureCount !== 1 ? "s" : ""}
            </span>
          </div>
          {template.description && (
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{template.description}</div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
          <button
            style={outlineButton({ height: 24, fontSize: 10, padding: "0 8px", borderRadius: 5 })}
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
          >
            Edit
          </button>
          <button
            style={{ ...outlineButton({ height: 24, fontSize: 10, padding: "0 8px", borderRadius: 5, color: COLORS.danger, borderColor: `${COLORS.danger}30` }) }}
            onClick={(e) => { e.stopPropagation(); if (confirm(`Delete template "${template.name}"?`)) onDelete(); }}
          >
            Delete
          </button>
          <span style={{ fontSize: 10, color: COLORS.textDim, marginLeft: 4, width: 12, textAlign: "center" }}>
            {expanded ? "\u25B4" : "\u25BE"}
          </span>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 10, fontSize: 11, color: COLORS.textSecondary, fontFamily: MONO_FONT, display: "flex", flexDirection: "column", gap: 4 }}>
          {template.copyPaths && template.copyPaths.length > 0 && (
            <ConfigRow label="Copy paths" items={template.copyPaths.map((p) => p.dest ? `${p.source} \u2192 ${p.dest}` : p.source)} />
          )}
          {template.envFiles && template.envFiles.length > 0 && (
            <ConfigRow label="Env files" items={template.envFiles.map((f) => `${f.source} \u2192 ${f.dest}`)} />
          )}
          {template.docker?.composePath && (
            <ConfigRow label="Docker" items={[template.docker.composePath + (template.docker.services?.length ? ` (${template.docker.services.join(", ")})` : "")]} />
          )}
          {template.dependencies && template.dependencies.length > 0 && (
            <ConfigRow label="Dependencies" items={template.dependencies.map((d) => d.command.join(" "))} />
          )}
          {template.mountPoints && template.mountPoints.length > 0 && (
            <ConfigRow label="Mount points" items={template.mountPoints.map((m) => `${m.source} \u2192 ${m.dest}`)} />
          )}
          {template.portRange && (
            <ConfigRow label="Port range" items={[`${template.portRange.start}\u2013${template.portRange.end}`]} />
          )}
          {template.envVars && Object.keys(template.envVars).length > 0 && (
            <ConfigRow label="Env vars" items={Object.entries(template.envVars).map(([k, v]) => `${k}=${v}`)} />
          )}
        </div>
      )}
    </div>
  );
}

function ConfigRow({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <span style={{ color: COLORS.textDim, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.3px" }}>{label}: </span>
      {items.map((item, i) => (
        <span key={i}>
          {i > 0 && <span style={{ color: COLORS.textDim }}>, </span>}
          <span style={{ color: COLORS.textSecondary }}>{item}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template editor (create / edit)
// ---------------------------------------------------------------------------

function TemplateEditor({
  template: initial,
  onSave,
  onCancel,
}: {
  template: LaneTemplate;
  onSave: (t: LaneTemplate) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? "");
  const [copyPaths, setCopyPaths] = useState<LaneCopyPathConfig[]>(initial.copyPaths ?? []);
  const [envFiles, setEnvFiles] = useState<LaneEnvFileConfig[]>(initial.envFiles ?? []);
  const [dependencies, setDependencies] = useState<LaneDependencyInstallConfig[]>(initial.dependencies ?? []);
  const [mountPoints, setMountPoints] = useState<LaneMountPointConfig[]>(initial.mountPoints ?? []);
  const [portStart, setPortStart] = useState(initial.portRange?.start?.toString() ?? "");
  const [portEnd, setPortEnd] = useState(initial.portRange?.end?.toString() ?? "");
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    Object.entries(initial.envVars ?? {}).map(([key, value]) => ({ key, value }))
  );
  const [dockerCompose, setDockerCompose] = useState(initial.docker?.composePath ?? "");
  const [dockerServices, setDockerServices] = useState(initial.docker?.services?.join(", ") ?? "");

  const isNew = !initial.name;

  function handleSubmit() {
    if (!name.trim()) return;
    const t: LaneTemplate = {
      id: initial.id,
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(copyPaths.length > 0 ? { copyPaths } : {}),
      ...(envFiles.length > 0 ? { envFiles } : {}),
      ...(dockerCompose.trim() ? {
        docker: {
          composePath: dockerCompose.trim(),
          ...(dockerServices.trim() ? { services: dockerServices.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
        },
      } : {}),
      ...(dependencies.length > 0 ? { dependencies } : {}),
      ...(mountPoints.length > 0 ? { mountPoints } : {}),
      ...(portStart && portEnd ? { portRange: { start: Number(portStart), end: Number(portEnd) } } : {}),
      ...(envVars.filter((v) => v.key.trim()).length > 0
        ? { envVars: Object.fromEntries(envVars.filter((v) => v.key.trim()).map((v) => [v.key.trim(), v.value])) }
        : {}),
    };
    onSave(t);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ ...LABEL_STYLE, fontSize: 11, margin: 0 }}>{isNew ? "NEW TEMPLATE" : "EDIT TEMPLATE"}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={outlineButton({ height: 28, fontSize: 11 })} onClick={onCancel}>Cancel</button>
          <button
            style={primaryButton({ height: 28, fontSize: 11, opacity: name.trim() ? 1 : 0.4 })}
            disabled={!name.trim()}
            onClick={handleSubmit}
          >
            {isNew ? "Create" : "Save"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Name & Description */}
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={miniLabel}>Name</div>
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Default Setup"
              autoFocus
            />
          </div>
          <div style={{ flex: 2 }}>
            <div style={miniLabel}>Description</div>
            <input
              style={inputStyle}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
            />
          </div>
        </div>

        {/* Copy Paths */}
        <SectionBlock title="Copy paths" description="Files and directories copied from the project root into each new lane.">
          {copyPaths.map((cp, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={cp.source}
                onChange={(e) => {
                  const next = [...copyPaths];
                  next[i] = { ...cp, source: e.target.value };
                  setCopyPaths(next);
                }}
                placeholder="source (e.g. .claude)"
              />
              <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"\u2192"}</span>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={cp.dest ?? ""}
                onChange={(e) => {
                  const next = [...copyPaths];
                  next[i] = { ...cp, dest: e.target.value || undefined };
                  setCopyPaths(next);
                }}
                placeholder="dest (same as source if empty)"
              />
              <button style={removeBtn} onClick={() => setCopyPaths(copyPaths.filter((_, j) => j !== i))}>{"\u00D7"}</button>
            </div>
          ))}
          <button
            style={outlineButton({ height: 26, fontSize: 10 })}
            onClick={() => setCopyPaths([...copyPaths, { source: "" }])}
          >
            + Add path
          </button>
        </SectionBlock>

        {/* Env Files */}
        <SectionBlock title="Environment files" description="Template files copied with variable substitution (e.g. .env.template to .env).">
          {envFiles.map((ef, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={ef.source}
                onChange={(e) => {
                  const next = [...envFiles];
                  next[i] = { ...ef, source: e.target.value };
                  setEnvFiles(next);
                }}
                placeholder=".env.template"
              />
              <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"\u2192"}</span>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={ef.dest}
                onChange={(e) => {
                  const next = [...envFiles];
                  next[i] = { ...ef, dest: e.target.value };
                  setEnvFiles(next);
                }}
                placeholder=".env"
              />
              <button style={removeBtn} onClick={() => setEnvFiles(envFiles.filter((_, j) => j !== i))}>{"\u00D7"}</button>
            </div>
          ))}
          <button
            style={outlineButton({ height: 26, fontSize: 10 })}
            onClick={() => setEnvFiles([...envFiles, { source: "", dest: "" }])}
          >
            + Add env file
          </button>
        </SectionBlock>

        {/* Dependencies */}
        <SectionBlock title="Dependencies" description="Install commands run during lane setup (e.g. npm install).">
          {dependencies.map((dep, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <input
                style={{ ...monoInputStyle, flex: 2 }}
                value={dep.command.join(" ")}
                onChange={(e) => {
                  const next = [...dependencies];
                  next[i] = { ...dep, command: e.target.value.split(/\s+/).filter(Boolean) };
                  setDependencies(next);
                }}
                placeholder="npm install"
              />
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={dep.cwd ?? ""}
                onChange={(e) => {
                  const next = [...dependencies];
                  next[i] = { ...dep, cwd: e.target.value || undefined };
                  setDependencies(next);
                }}
                placeholder="cwd (optional)"
              />
              <button style={removeBtn} onClick={() => setDependencies(dependencies.filter((_, j) => j !== i))}>{"\u00D7"}</button>
            </div>
          ))}
          <button
            style={outlineButton({ height: 26, fontSize: 10 })}
            onClick={() => setDependencies([...dependencies, { command: [] }])}
          >
            + Add command
          </button>
        </SectionBlock>

        {/* Mount Points */}
        <SectionBlock title="Mount points" description="Individual files from .ade/ copied into the lane.">
          {mountPoints.map((mp, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={mp.source}
                onChange={(e) => {
                  const next = [...mountPoints];
                  next[i] = { ...mp, source: e.target.value };
                  setMountPoints(next);
                }}
                placeholder="source (relative to .ade/)"
              />
              <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"\u2192"}</span>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={mp.dest}
                onChange={(e) => {
                  const next = [...mountPoints];
                  next[i] = { ...mp, dest: e.target.value };
                  setMountPoints(next);
                }}
                placeholder="dest (relative to worktree)"
              />
              <button style={removeBtn} onClick={() => setMountPoints(mountPoints.filter((_, j) => j !== i))}>{"\u00D7"}</button>
            </div>
          ))}
          <button
            style={outlineButton({ height: 26, fontSize: 10 })}
            onClick={() => setMountPoints([...mountPoints, { source: "", dest: "" }])}
          >
            + Add mount point
          </button>
        </SectionBlock>

        {/* Docker */}
        <SectionBlock title="Docker" description="Docker Compose services to start with each lane.">
          <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <div style={{ flex: 2 }}>
              <div style={{ ...miniLabel, fontSize: 9 }}>Compose file</div>
              <input
                style={monoInputStyle}
                value={dockerCompose}
                onChange={(e) => setDockerCompose(e.target.value)}
                placeholder="docker-compose.yml"
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ ...miniLabel, fontSize: 9 }}>Services (comma-separated)</div>
              <input
                style={monoInputStyle}
                value={dockerServices}
                onChange={(e) => setDockerServices(e.target.value)}
                placeholder="all"
              />
            </div>
          </div>
        </SectionBlock>

        {/* Port Range */}
        <SectionBlock title="Port range" description="Allocated port range for the lane.">
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>
              <div style={{ ...miniLabel, fontSize: 9 }}>Start</div>
              <input
                style={monoInputStyle}
                type="number"
                value={portStart}
                onChange={(e) => setPortStart(e.target.value)}
                placeholder="3000"
              />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ ...miniLabel, fontSize: 9 }}>End</div>
              <input
                style={monoInputStyle}
                type="number"
                value={portEnd}
                onChange={(e) => setPortEnd(e.target.value)}
                placeholder="3099"
              />
            </div>
          </div>
        </SectionBlock>

        {/* Env Vars */}
        <SectionBlock title="Environment variables" description="Extra env vars injected into the lane.">
          {envVars.map((v, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={v.key}
                onChange={(e) => {
                  const next = [...envVars];
                  next[i] = { ...v, key: e.target.value };
                  setEnvVars(next);
                }}
                placeholder="KEY"
              />
              <span style={{ color: COLORS.textDim, fontSize: 11 }}>=</span>
              <input
                style={{ ...monoInputStyle, flex: 2 }}
                value={v.value}
                onChange={(e) => {
                  const next = [...envVars];
                  next[i] = { ...v, value: e.target.value };
                  setEnvVars(next);
                }}
                placeholder="value"
              />
              <button style={removeBtn} onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}>{"\u00D7"}</button>
            </div>
          ))}
          <button
            style={outlineButton({ height: 26, fontSize: 10 })}
            onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}
          >
            + Add variable
          </button>
        </SectionBlock>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section block wrapper
// ---------------------------------------------------------------------------

function SectionBlock({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div style={recessedStyle({ padding: 14, borderRadius: 8 })}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>{title}</span>
        <span style={{ fontSize: 10, color: COLORS.textDim }}>{description}</span>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state with feature overview
// ---------------------------------------------------------------------------

const FEATURES = [
  {
    title: "Copy folders & files",
    description: "Copy directories like .claude, .vscode, or config files into every new lane automatically.",
    example: ".claude/ \u2192 .claude/",
  },
  {
    title: "Environment files",
    description: "Template .env files with lane-specific variables like port numbers and hostnames.",
    example: ".env.template \u2192 .env",
  },
  {
    title: "Install dependencies",
    description: "Run setup commands like npm install or pip install when a lane is created.",
    example: "npm install",
  },
  {
    title: "Docker services",
    description: "Spin up isolated Docker Compose services per lane with automatic cleanup.",
    example: "docker-compose.yml",
  },
  {
    title: "Port ranges & env vars",
    description: "Assign unique port ranges and inject environment variables per lane.",
    example: "PORT=3100\u20133199",
  },
];

function EmptyState({ onCreateTemplate }: { onCreateTemplate: () => void }) {
  return (
    <div>
      <div style={{ ...cardStyle({ borderRadius: 12, padding: 24 }), textAlign: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>
          Lane templates automate your lane setup
        </div>
        <div style={{ fontSize: 12, color: COLORS.textMuted, maxWidth: 440, margin: "0 auto", lineHeight: 1.5 }}>
          Define what gets copied, installed, and configured every time you create a new lane.
          Set a default template so every lane starts with the right files and tooling.
        </div>
        <button
          style={primaryButton({ height: 34, fontSize: 12, marginTop: 16 })}
          onClick={onCreateTemplate}
        >
          Create your first template
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {FEATURES.map((f) => (
          <div
            key={f.title}
            style={{
              ...recessedStyle({ padding: "12px 14px", borderRadius: 8 }),
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>{f.title}</div>
            <div style={{ fontSize: 10, color: COLORS.textMuted, lineHeight: 1.4 }}>{f.description}</div>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, marginTop: 2 }}>{f.example}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
