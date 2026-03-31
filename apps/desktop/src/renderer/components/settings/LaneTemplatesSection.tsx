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
  LaneSetupScriptConfig,
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
  height: 36,
  width: "100%",
  background: COLORS.recessedBg,
  border: `1px solid ${COLORS.outlineBorder}`,
  padding: "0 12px",
  fontSize: 12,
  color: COLORS.textPrimary,
  fontFamily: SANS_FONT,
  borderRadius: 8,
  outline: "none",
  transition: "border-color 150ms ease",
};

const monoInputStyle: React.CSSProperties = { ...inputStyle, fontFamily: MONO_FONT, fontSize: 11 };

const textareaStyle: React.CSSProperties = {
  ...monoInputStyle,
  height: "auto",
  minHeight: 64,
  padding: "8px 12px",
  resize: "vertical" as const,
  lineHeight: 1.5,
};

const miniLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  fontFamily: SANS_FONT,
  textTransform: "uppercase" as const,
  letterSpacing: "0.5px",
  color: COLORS.textMuted,
  marginBottom: 6,
};

const removeBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  color: COLORS.textDim,
  cursor: "pointer",
  fontSize: 16,
  padding: "0 4px",
  lineHeight: 1,
  transition: "color 150ms ease",
};

const pillBadge = (color: string): React.CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 9,
  fontWeight: 700,
  fontFamily: MONO_FONT,
  color,
  textTransform: "uppercase" as const,
  letterSpacing: "0.5px",
  background: `${color}15`,
  padding: "2px 8px",
  borderRadius: 4,
});

const featureChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 10,
  fontWeight: 500,
  fontFamily: SANS_FONT,
  color: COLORS.textMuted,
  background: `${COLORS.accent}08`,
  border: `1px solid ${COLORS.accent}15`,
  padding: "2px 8px",
  borderRadius: 12,
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count > 1 ? "s" : ""}`;
}

function parseLines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function updateAt<T>(items: T[], index: number, patch: Partial<T>): T[] {
  return items.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

function removeAt<T>(items: T[], index: number): T[] {
  return items.filter((_, i) => i !== index);
}

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
    } catch (err: unknown) {
      alert(`Failed to save template: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (templateId: string) => {
    try {
      await window.ade.lanes.deleteTemplate({ templateId });
      await refresh();
    } catch (err: unknown) {
      alert(`Failed to delete template: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [refresh]);

  if (loading) {
    return <div style={{ fontSize: 12, color: COLORS.textMuted, padding: 16 }}>Loading templates...</div>;
  }

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
        <div>
          <div style={{ ...LABEL_STYLE, fontSize: 11, margin: 0 }}>LANE TEMPLATES</div>
          <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 4 }}>
            Reusable recipes that automate lane setup.
          </div>
        </div>
        <button
          style={outlineButton({ height: 28, fontSize: 11 })}
          onClick={() => setEditing(emptyTemplate())}
        >
          + New template
        </button>
      </div>

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
// Template card
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

  const features: string[] = [];
  if (template.copyPaths?.length) features.push(pluralize(template.copyPaths.length, "copy path"));
  if (template.envFiles?.length) features.push(pluralize(template.envFiles.length, "env file"));
  if (template.dependencies?.length) features.push(pluralize(template.dependencies.length, "dep"));
  if (template.mountPoints?.length) features.push(pluralize(template.mountPoints.length, "mount"));
  if (template.docker?.composePath) features.push("docker");
  if (template.portRange) features.push("ports");
  if (template.envVars && Object.keys(template.envVars).length > 0) features.push("env vars");
  if (template.setupScript) features.push("setup script");

  return (
    <div style={{
      ...cardStyle({ padding: "12px 16px", borderRadius: 12 }),
      ...(isDefault ? { borderColor: `${COLORS.info}40` } : {}),
      transition: "border-color 150ms ease",
    }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>{template.name || "Untitled"}</span>
            {isDefault && <span style={pillBadge(COLORS.info)}>DEFAULT</span>}
          </div>
          {template.description && (
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {template.description}
            </div>
          )}
          {features.length > 0 && (
            <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
              {features.map((f) => <span key={f} style={featureChip}>{f}</span>)}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0, marginLeft: 12 }}>
          <button
            style={outlineButton({ height: 26, fontSize: 10, padding: "0 10px", borderRadius: 6 })}
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
          >
            Edit
          </button>
          <button
            style={outlineButton({ height: 26, fontSize: 10, padding: "0 10px", borderRadius: 6, color: COLORS.danger, borderColor: `${COLORS.danger}30` })}
            onClick={(e) => { e.stopPropagation(); if (confirm(`Delete template "${template.name}"?`)) onDelete(); }}
          >
            Delete
          </button>
          <span style={{ fontSize: 10, color: COLORS.textDim, marginLeft: 4, width: 16, textAlign: "center", transition: "transform 150ms ease", transform: expanded ? "rotate(180deg)" : "rotate(0)" }}>
            {"\u25BE"}
          </span>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.borderMuted}`, fontSize: 11, color: COLORS.textSecondary, fontFamily: MONO_FONT, display: "flex", flexDirection: "column", gap: 6 }}>
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
          {template.setupScript && (
            <SetupScriptPreview script={template.setupScript} />
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

function SetupScriptPreview({ script }: { script: LaneSetupScriptConfig }) {
  const lines: string[] = [];
  if (script.commands?.length) lines.push(script.commands.join("; "));
  if (script.unixCommands?.length) lines.push(`unix: ${script.unixCommands.join("; ")}`);
  if (script.windowsCommands?.length) lines.push(`win: ${script.windowsCommands.join("; ")}`);
  if (script.scriptPath) lines.push(`script: ${script.scriptPath}`);
  if (script.unixScriptPath) lines.push(`unix script: ${script.unixScriptPath}`);
  if (script.windowsScriptPath) lines.push(`win script: ${script.windowsScriptPath}`);
  return (
    <div>
      <span style={{ color: COLORS.textDim, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.3px" }}>Setup script: </span>
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <span style={{ color: COLORS.textDim }}> | </span>}
          <span style={{ color: COLORS.accent }}>{line}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template editor
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

  // Setup script state — simple by default, platform overrides shown on demand
  const [setupCommands, setSetupCommands] = useState(initial.setupScript?.commands?.join("\n") ?? "");
  const [setupUnixCommands, setSetupUnixCommands] = useState(initial.setupScript?.unixCommands?.join("\n") ?? "");
  const [setupWindowsCommands, setSetupWindowsCommands] = useState(initial.setupScript?.windowsCommands?.join("\n") ?? "");
  const [setupScriptPath, setSetupScriptPath] = useState(initial.setupScript?.scriptPath ?? "");
  const [setupUnixScriptPath, setSetupUnixScriptPath] = useState(initial.setupScript?.unixScriptPath ?? "");
  const [setupWindowsScriptPath, setSetupWindowsScriptPath] = useState(initial.setupScript?.windowsScriptPath ?? "");
  const [setupInjectPrimaryPath, setSetupInjectPrimaryPath] = useState(initial.setupScript?.injectPrimaryPath ?? false);

  // Show platform overrides only if they have content or the user expands them
  const hasPlatformOverrides =
    (initial.setupScript?.unixCommands?.length ?? 0) > 0 ||
    (initial.setupScript?.windowsCommands?.length ?? 0) > 0 ||
    !!initial.setupScript?.unixScriptPath ||
    !!initial.setupScript?.windowsScriptPath;
  const [showPlatformOverrides, setShowPlatformOverrides] = useState(hasPlatformOverrides);

  // Collapsible section state — only expand sections that already have content
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    copyPaths: (initial.copyPaths ?? []).length > 0,
    envFiles: (initial.envFiles ?? []).length > 0,
    dependencies: (initial.dependencies ?? []).length > 0,
    mountPoints: (initial.mountPoints ?? []).length > 0,
    docker: !!initial.docker?.composePath,
    ports: !!initial.portRange,
    envVars: Object.keys(initial.envVars ?? {}).length > 0,
    setupScript: !!initial.setupScript,
  });

  const toggleSection = (key: string) =>
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));

  const isNew = !initial.name;

  function handleSubmit() {
    if (!name.trim()) return;

    const setupCmds = parseLines(setupCommands);
    const setupUnixCmds = parseLines(setupUnixCommands);
    const setupWinCmds = parseLines(setupWindowsCommands);
    const hasSetupScript =
      setupCmds.length > 0 ||
      setupUnixCmds.length > 0 ||
      setupWinCmds.length > 0 ||
      setupScriptPath.trim() ||
      setupUnixScriptPath.trim() ||
      setupWindowsScriptPath.trim();

    const setupScript: LaneSetupScriptConfig | undefined = hasSetupScript
      ? compact({
          commands: setupCmds.length > 0 ? setupCmds : undefined,
          unixCommands: setupUnixCmds.length > 0 ? setupUnixCmds : undefined,
          windowsCommands: setupWinCmds.length > 0 ? setupWinCmds : undefined,
          scriptPath: setupScriptPath.trim() || undefined,
          unixScriptPath: setupUnixScriptPath.trim() || undefined,
          windowsScriptPath: setupWindowsScriptPath.trim() || undefined,
          injectPrimaryPath: setupInjectPrimaryPath || undefined,
        })
      : undefined;

    const filteredEnvVars = envVars.filter((v) => v.key.trim());
    const dockerServicesList = dockerServices.split(",").map((s) => s.trim()).filter(Boolean);

    const t: LaneTemplate = compact({
      id: initial.id,
      name: name.trim(),
      description: description.trim() || undefined,
      copyPaths: copyPaths.length > 0 ? copyPaths : undefined,
      envFiles: envFiles.length > 0 ? envFiles : undefined,
      docker: dockerCompose.trim()
        ? compact({
            composePath: dockerCompose.trim(),
            services: dockerServicesList.length > 0 ? dockerServicesList : undefined,
          })
        : undefined,
      dependencies: dependencies.length > 0 ? dependencies : undefined,
      mountPoints: mountPoints.length > 0 ? mountPoints : undefined,
      portRange: portStart && portEnd ? { start: Number(portStart), end: Number(portEnd) } : undefined,
      envVars: filteredEnvVars.length > 0
        ? Object.fromEntries(filteredEnvVars.map((v) => [v.key.trim(), v.value]))
        : undefined,
      setupScript,
    });
    onSave(t);
  }

  return (
    <div>
      {/* Header with save/cancel */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 20,
        paddingBottom: 16,
        borderBottom: `1px solid ${COLORS.borderMuted}`,
      }}>
        <div>
          <div style={{ ...LABEL_STYLE, fontSize: 11, margin: 0 }}>{isNew ? "NEW TEMPLATE" : "EDIT TEMPLATE"}</div>
          <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 4 }}>
            {isNew ? "Define what happens when a lane is created with this template." : `Editing "${initial.name}"`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={outlineButton({ height: 30, fontSize: 11 })} onClick={onCancel}>Cancel</button>
          <button
            style={primaryButton({ height: 30, fontSize: 11, opacity: name.trim() ? 1 : 0.4 })}
            disabled={!name.trim()}
            onClick={handleSubmit}
          >
            {isNew ? "Create template" : "Save changes"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Name & Description — always visible, not collapsible */}
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={miniLabel}>Template name</div>
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Default Setup"
              autoFocus
            />
          </div>
          <div style={{ flex: 2 }}>
            <div style={miniLabel}>Description (optional)</div>
            <input
              style={inputStyle}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this template sets up..."
            />
          </div>
        </div>

        {/* Collapsible config sections */}
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>

          {/* Setup Script */}
          <CollapsibleSection
            title="Setup script"
            subtitle="Shell commands to run after lane creation"
            expanded={!!expandedSections.setupScript}
            onToggle={() => toggleSection("setupScript")}
            count={setupCommands.split("\n").filter((s) => s.trim()).length || undefined}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={miniLabel}>Commands</div>
                <textarea
                  style={textareaStyle}
                  value={setupCommands}
                  onChange={(e) => setSetupCommands(e.target.value)}
                  placeholder={"npm install\ncp $PRIMARY_WORKTREE_PATH/.env .env"}
                  rows={3}
                />
                <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 4 }}>
                  One command per line, executed in order. Use <code style={{ fontFamily: MONO_FONT, color: COLORS.accent, fontSize: 10, background: `${COLORS.accent}12`, padding: "1px 4px", borderRadius: 3 }}>$PRIMARY_WORKTREE_PATH</code> to reference the main lane's root.
                </div>
              </div>

              {/* Script file path — simple single input */}
              <div>
                <div style={miniLabel}>Or run a script file</div>
                <input
                  style={monoInputStyle}
                  value={setupScriptPath}
                  onChange={(e) => setSetupScriptPath(e.target.value)}
                  placeholder="scripts/setup-lane.sh (relative to project root)"
                />
                <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 4 }}>
                  Runs instead of the commands above when set. Leave empty to use inline commands.
                </div>
              </div>

              {/* Platform overrides — hidden by default */}
              {!showPlatformOverrides ? (
                <button
                  type="button"
                  style={{
                    ...outlineButton({ height: 28, fontSize: 10 }),
                    alignSelf: "flex-start",
                  }}
                  onClick={() => setShowPlatformOverrides(true)}
                >
                  + Add platform-specific overrides
                </button>
              ) : (
                <div style={recessedStyle({ padding: 12, borderRadius: 8 })}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <div style={{ ...miniLabel, marginBottom: 0 }}>Platform overrides</div>
                    <div style={{ fontSize: 10, color: COLORS.textDim }}>These take precedence over the generic commands above</div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <div>
                      <div style={{ ...miniLabel, fontSize: 9 }}>macOS / Linux commands</div>
                      <textarea
                        style={{ ...textareaStyle, minHeight: 48 }}
                        value={setupUnixCommands}
                        onChange={(e) => setSetupUnixCommands(e.target.value)}
                        placeholder={"chmod +x scripts/setup.sh\n./scripts/setup.sh"}
                        rows={2}
                      />
                      <div style={{ marginTop: 6 }}>
                        <div style={{ ...miniLabel, fontSize: 9 }}>Unix script file</div>
                        <input
                          style={monoInputStyle}
                          value={setupUnixScriptPath}
                          onChange={(e) => setSetupUnixScriptPath(e.target.value)}
                          placeholder="scripts/setup-lane-unix.sh"
                        />
                      </div>
                    </div>
                    <div>
                      <div style={{ ...miniLabel, fontSize: 9 }}>Windows commands</div>
                      <textarea
                        style={{ ...textareaStyle, minHeight: 48 }}
                        value={setupWindowsCommands}
                        onChange={(e) => setSetupWindowsCommands(e.target.value)}
                        placeholder="powershell -File scripts\setup.ps1"
                        rows={2}
                      />
                      <div style={{ marginTop: 6 }}>
                        <div style={{ ...miniLabel, fontSize: 9 }}>Windows script file</div>
                        <input
                          style={monoInputStyle}
                          value={setupWindowsScriptPath}
                          onChange={(e) => setSetupWindowsScriptPath(e.target.value)}
                          placeholder="scripts\setup-lane.ps1"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Inject primary path toggle */}
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 12px",
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.borderMuted}`,
                borderRadius: 8,
              }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 500, color: COLORS.textPrimary }}>Expose primary lane path</div>
                  <div style={{ fontSize: 10, color: COLORS.textDim, marginTop: 2 }}>
                    Sets <code style={{ fontFamily: MONO_FONT, fontSize: 10 }}>$PRIMARY_WORKTREE_PATH</code> so scripts can copy files from the main lane.
                  </div>
                </div>
                <ToggleSwitch checked={setupInjectPrimaryPath} onChange={setSetupInjectPrimaryPath} />
              </div>
            </div>
          </CollapsibleSection>

          {/* Copy Paths */}
          <CollapsibleSection
            title="Copy paths"
            subtitle="Copy files from project root into the lane"
            expanded={!!expandedSections.copyPaths}
            onToggle={() => toggleSection("copyPaths")}
            count={copyPaths.length || undefined}
          >
            {copyPaths.map((cp, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input
                  style={{ ...monoInputStyle, flex: 1 }}
                  value={cp.source}
                  onChange={(e) => setCopyPaths(updateAt(copyPaths, i, { source: e.target.value }))}
                  placeholder="source (e.g. .claude)"
                />
                <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"\u2192"}</span>
                <input
                  style={{ ...monoInputStyle, flex: 1 }}
                  value={cp.dest ?? ""}
                  onChange={(e) => setCopyPaths(updateAt(copyPaths, i, { dest: e.target.value || undefined }))}
                  placeholder="dest (same as source if empty)"
                />
                <button style={removeBtn} onClick={() => setCopyPaths(removeAt(copyPaths, i))}>{"\u00D7"}</button>
              </div>
            ))}
            <button
              style={outlineButton({ height: 28, fontSize: 10 })}
              onClick={() => setCopyPaths([...copyPaths, { source: "" }])}
            >
              + Add path
            </button>
          </CollapsibleSection>

          {/* Env Files */}
          <CollapsibleSection
            title="Environment files"
            subtitle="Template .env files with variable substitution"
            expanded={!!expandedSections.envFiles}
            onToggle={() => toggleSection("envFiles")}
            count={envFiles.length || undefined}
          >
            {envFiles.map((ef, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input
                  style={{ ...monoInputStyle, flex: 1 }}
                  value={ef.source}
                  onChange={(e) => setEnvFiles(updateAt(envFiles, i, { source: e.target.value }))}
                  placeholder=".env.template"
                />
                <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"\u2192"}</span>
                <input
                  style={{ ...monoInputStyle, flex: 1 }}
                  value={ef.dest}
                  onChange={(e) => setEnvFiles(updateAt(envFiles, i, { dest: e.target.value }))}
                  placeholder=".env"
                />
                <button style={removeBtn} onClick={() => setEnvFiles(removeAt(envFiles, i))}>{"\u00D7"}</button>
              </div>
            ))}
            <button
              style={outlineButton({ height: 28, fontSize: 10 })}
              onClick={() => setEnvFiles([...envFiles, { source: "", dest: "" }])}
            >
              + Add env file
            </button>
          </CollapsibleSection>

          {/* Dependencies */}
          <CollapsibleSection
            title="Install dependencies"
            subtitle="Commands to run during setup (e.g. npm install)"
            expanded={!!expandedSections.dependencies}
            onToggle={() => toggleSection("dependencies")}
            count={dependencies.length || undefined}
          >
            {dependencies.map((dep, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input
                  style={{ ...monoInputStyle, flex: 2 }}
                  value={dep.command.join(" ")}
                  onChange={(e) => setDependencies(updateAt(dependencies, i, { command: e.target.value.split(/\s+/).filter(Boolean) }))}
                  placeholder="npm install"
                />
                <input
                  style={{ ...monoInputStyle, flex: 1 }}
                  value={dep.cwd ?? ""}
                  onChange={(e) => setDependencies(updateAt(dependencies, i, { cwd: e.target.value || undefined }))}
                  placeholder="working dir (optional)"
                />
                <button style={removeBtn} onClick={() => setDependencies(removeAt(dependencies, i))}>{"\u00D7"}</button>
              </div>
            ))}
            <button
              style={outlineButton({ height: 28, fontSize: 10 })}
              onClick={() => setDependencies([...dependencies, { command: [] }])}
            >
              + Add command
            </button>
          </CollapsibleSection>

          {/* Mount Points */}
          <CollapsibleSection
            title="Mount points"
            subtitle="Copy files from .ade/ into the lane"
            expanded={!!expandedSections.mountPoints}
            onToggle={() => toggleSection("mountPoints")}
            count={mountPoints.length || undefined}
          >
            {mountPoints.map((mp, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input
                  style={{ ...monoInputStyle, flex: 1 }}
                  value={mp.source}
                  onChange={(e) => setMountPoints(updateAt(mountPoints, i, { source: e.target.value }))}
                  placeholder="source (relative to .ade/)"
                />
                <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"\u2192"}</span>
                <input
                  style={{ ...monoInputStyle, flex: 1 }}
                  value={mp.dest}
                  onChange={(e) => setMountPoints(updateAt(mountPoints, i, { dest: e.target.value }))}
                  placeholder="dest (relative to worktree)"
                />
                <button style={removeBtn} onClick={() => setMountPoints(removeAt(mountPoints, i))}>{"\u00D7"}</button>
              </div>
            ))}
            <button
              style={outlineButton({ height: 28, fontSize: 10 })}
              onClick={() => setMountPoints([...mountPoints, { source: "", dest: "" }])}
            >
              + Add mount point
            </button>
          </CollapsibleSection>

          {/* Docker */}
          <CollapsibleSection
            title="Docker"
            subtitle="Compose services to start per lane"
            expanded={!!expandedSections.docker}
            onToggle={() => toggleSection("docker")}
          >
            <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
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
          </CollapsibleSection>

          {/* Port Range */}
          <CollapsibleSection
            title="Port range"
            subtitle="Reserved port range for the lane"
            expanded={!!expandedSections.ports}
            onToggle={() => toggleSection("ports")}
            badge={portStart && portEnd ? `${portStart}\u2013${portEnd}` : undefined}
          >
            <div style={{ display: "flex", gap: 12 }}>
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
          </CollapsibleSection>

          {/* Env Vars */}
          <CollapsibleSection
            title="Environment variables"
            subtitle="Extra env vars set in the lane"
            expanded={!!expandedSections.envVars}
            onToggle={() => toggleSection("envVars")}
            count={envVars.filter((v) => v.key.trim()).length || undefined}
          >
            {envVars.map((v, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <input
                  style={{ ...monoInputStyle, flex: 1 }}
                  value={v.key}
                  onChange={(e) => setEnvVars(updateAt(envVars, i, { key: e.target.value }))}
                  placeholder="KEY"
                />
                <span style={{ color: COLORS.textDim, fontSize: 11 }}>=</span>
                <input
                  style={{ ...monoInputStyle, flex: 2 }}
                  value={v.value}
                  onChange={(e) => setEnvVars(updateAt(envVars, i, { value: e.target.value }))}
                  placeholder="value"
                />
                <button style={removeBtn} onClick={() => setEnvVars(removeAt(envVars, i))}>{"\u00D7"}</button>
              </div>
            ))}
            <button
              style={outlineButton({ height: 28, fontSize: 10 })}
              onClick={() => setEnvVars([...envVars, { key: "", value: "" }])}
            >
              + Add variable
            </button>
          </CollapsibleSection>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible section
// ---------------------------------------------------------------------------

function CollapsibleSection({
  title,
  subtitle,
  expanded,
  onToggle,
  children,
  count,
  badge,
}: {
  title: string;
  subtitle: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  count?: number;
  badge?: string;
}) {
  return (
    <div style={{
      ...recessedStyle({ padding: 0, borderRadius: 10 }),
      overflow: "hidden",
      transition: "border-color 150ms ease",
    }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "12px 14px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{
          fontSize: 10,
          color: COLORS.textDim,
          width: 16,
          textAlign: "center",
          transition: "transform 150ms ease",
          transform: expanded ? "rotate(90deg)" : "rotate(0)",
        }}>
          {"\u25B6"}
        </span>
        <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.textPrimary }}>{title}</span>
        <span style={{ fontSize: 10, color: COLORS.textDim }}>{subtitle}</span>
        <div style={{ flex: 1 }} />
        {count !== undefined && (
          <span style={pillBadge(COLORS.accent)}>{count}</span>
        )}
        {badge && (
          <span style={pillBadge(COLORS.info)}>{badge}</span>
        )}
      </button>
      {expanded && (
        <div style={{ padding: "0 14px 14px 14px" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle switch
// ---------------------------------------------------------------------------

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: 40,
        height: 22,
        border: "none",
        padding: 0,
        borderRadius: 11,
        background: checked ? COLORS.accent : COLORS.border,
        cursor: "pointer",
        flexShrink: 0,
        transition: "background 150ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 20 : 2,
          width: 18,
          height: 18,
          background: checked ? COLORS.pageBg : COLORS.textMuted,
          borderRadius: 9,
          transition: "left 150ms ease",
        }}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

const FEATURES = [
  {
    title: "Copy folders & files",
    description: "Copy .claude, .vscode, or config files into every new lane.",
    example: ".claude/ \u2192 .claude/",
  },
  {
    title: "Environment files",
    description: "Template .env files with lane-specific variables.",
    example: ".env.template \u2192 .env",
  },
  {
    title: "Install dependencies",
    description: "Run npm install, pip install, etc. on lane creation.",
    example: "npm install",
  },
  {
    title: "Docker services",
    description: "Start isolated Docker Compose services per lane.",
    example: "docker-compose.yml",
  },
  {
    title: "Port ranges & env vars",
    description: "Assign unique ports and inject env vars per lane.",
    example: "PORT=3100\u20133199",
  },
  {
    title: "Setup scripts",
    description: "Run custom commands after creation, with platform overrides.",
    example: "scripts/setup-lane.sh",
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
          Set a default template so every lane starts ready to go.
        </div>
        <button
          style={primaryButton({ height: 34, fontSize: 12, marginTop: 16 })}
          onClick={onCreateTemplate}
        >
          Create your first template
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
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
