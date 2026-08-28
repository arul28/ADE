import { useState, useEffect, useCallback } from "react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  LABEL_STYLE,
  outlineButton,
  primaryButton,
  cardStyle,
} from "../lanes/laneDesignTokens";
import { SettingsDisclosure, SettingsToggle } from "./primitives";
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

/** Paths and commands stay monospaced — everything else is sans. */
const monoInputStyle: React.CSSProperties = { ...inputStyle, fontFamily: MONO_FONT, fontSize: 11 };

const textareaStyle: React.CSSProperties = {
  ...monoInputStyle,
  height: "auto",
  minHeight: 64,
  padding: "8px 12px",
  resize: "vertical" as const,
  lineHeight: 1.5,
};

const fieldLabelStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
};

const hintStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily: SANS_FONT,
  color: COLORS.textDim,
  lineHeight: 1.5,
  marginTop: 2,
};

const subLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  fontFamily: SANS_FONT,
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
  fontFamily: SANS_FONT,
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
  background: "color-mix(in srgb, var(--color-accent) 8%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-accent) 15%, transparent)",
  padding: "2px 8px",
  borderRadius: 12,
};

const codeStyle: React.CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 10,
  color: COLORS.accent,
  background: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
  padding: "1px 4px",
  borderRadius: 3,
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count > 1 ? "s" : ""}`;
}

function parseLines(text: string): string[] {
  return text.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Drops members that are `undefined` so a saved template carries no empty keys.
 * The `as T` cast holds because every caller passes an object literal whose
 * `undefined`-valued members are optional in the target type, so dropping them
 * still produces a valid `T`.
 */
function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/**
 * A setup script only does something when it has at least one command or a
 * script path on some platform. A config carrying nothing but
 * `injectPrimaryPath` runs no script, so it must not be shown as one.
 */
function hasRunnableSetupScript(script: LaneSetupScriptConfig | undefined | null): boolean {
  if (!script) return false;
  return (
    (script.commands?.length ?? 0) > 0 ||
    (script.unixCommands?.length ?? 0) > 0 ||
    (script.windowsCommands?.length ?? 0) > 0 ||
    !!script.scriptPath?.trim() ||
    !!script.unixScriptPath?.trim() ||
    !!script.windowsScriptPath?.trim()
  );
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

/**
 * Matches `lanes-git.lane-templates` in `settingsManifest.ts`. Every state of
 * this section renders it, so a Cmd-K result or `?tab=lanes-git#lane-templates`
 * deeplink lands here whether templates are still loading or one is open in the
 * editor. `data-settings-anchor` mirrors the id, the way `SettingsCard` and
 * `SettingsSectionShell` do it, so settings search can filter this section too.
 */
const ANCHOR = "lane-templates";

const sectionStyle: React.CSSProperties = { scrollMarginTop: 16, padding: 16 };

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
    return (
      <section id={ANCHOR} data-settings-anchor={ANCHOR} style={sectionStyle}>
        <div style={{ fontSize: 12, color: COLORS.textMuted }}>Loading templates...</div>
      </section>
    );
  }

  if (editing) {
    return (
      <section id={ANCHOR} data-settings-anchor={ANCHOR} style={sectionStyle}>
        <TemplateEditor
          template={editing}
          onSave={handleSave}
          onCancel={() => setEditing(null)}
        />
      </section>
    );
  }

  return (
    <section id={ANCHOR} data-settings-anchor={ANCHOR} style={sectionStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ ...LABEL_STYLE, fontSize: 11, margin: 0 }}>LANE TEMPLATES</div>
          <div style={{ fontSize: 11, color: COLORS.textDim, marginTop: 4 }}>
            Set up every new lane the same way: copy files in, install packages, run a script.
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
          <div style={subLabelStyle}>Use for new lanes</div>
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
          <div style={hintStyle}>
            Picked for you when you create a lane. You can still choose a different one there.
          </div>
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
    </section>
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
  if (template.copyPaths?.length) features.push(pluralize(template.copyPaths.length, "file"));
  if (template.envFiles?.length) features.push(pluralize(template.envFiles.length, "env file"));
  if (template.dependencies?.length) features.push(pluralize(template.dependencies.length, "install"));
  if (hasRunnableSetupScript(template.setupScript)) features.push("setup script");
  if (template.mountPoints?.length) features.push(pluralize(template.mountPoints.length, "mount"));
  if (template.docker?.composePath) features.push("docker");
  if (template.envVars && Object.keys(template.envVars).length > 0) features.push("env vars");

  return (
    <div style={{
      ...cardStyle({ padding: "12px 16px", borderRadius: 12 }),
      ...(isDefault ? { borderColor: "color-mix(in srgb, var(--color-info) 40%, transparent)" } : {}),
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
            style={outlineButton({ height: 26, fontSize: 10, padding: "0 10px", borderRadius: 6, color: COLORS.danger, borderColor: "color-mix(in srgb, var(--color-error) 30%, transparent)" })}
            onClick={(e) => { e.stopPropagation(); if (confirm(`Delete template "${template.name}"?`)) onDelete(); }}
          >
            Delete
          </button>
          <span style={{ fontSize: 10, color: COLORS.textDim, marginLeft: 4, width: 16, textAlign: "center", transition: "transform 150ms ease", transform: expanded ? "rotate(180deg)" : "rotate(0)" }}>
            {"▾"}
          </span>
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.borderMuted}`, fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textSecondary, display: "flex", flexDirection: "column", gap: 6 }}>
          {template.copyPaths && template.copyPaths.length > 0 && (
            <ConfigRow label="Files to copy" items={template.copyPaths.map((p) => p.dest ? `${p.source} → ${p.dest}` : p.source)} />
          )}
          {template.envFiles && template.envFiles.length > 0 && (
            <ConfigRow label="Env files" items={template.envFiles.map((f) => `${f.source} → ${f.dest}`)} />
          )}
          {template.dependencies && template.dependencies.length > 0 && (
            <ConfigRow label="Install" items={template.dependencies.map((d) => d.command.join(" "))} />
          )}
          {hasRunnableSetupScript(template.setupScript) && template.setupScript && (
            <SetupScriptPreview script={template.setupScript} />
          )}
          {template.mountPoints && template.mountPoints.length > 0 && (
            <ConfigRow label="Mounts" items={template.mountPoints.map((m) => `${m.source} → ${m.dest}`)} />
          )}
          {template.docker?.composePath && (
            <ConfigRow label="Docker" items={[template.docker.composePath + (template.docker.services?.length ? ` (${template.docker.services.join(", ")})` : "")]} />
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
      <span style={{ color: COLORS.textDim, fontSize: 11 }}>{label}: </span>
      {items.map((item, i) => (
        <span key={i}>
          {i > 0 && <span style={{ color: COLORS.textDim }}>, </span>}
          <span style={{ color: COLORS.textSecondary, fontFamily: MONO_FONT, fontSize: 10 }}>{item}</span>
        </span>
      ))}
    </div>
  );
}

function SetupScriptPreview({ script }: { script: LaneSetupScriptConfig }) {
  const lines: string[] = [];
  if (script.commands?.length) lines.push(script.commands.join("; "));
  if (script.unixCommands?.length) lines.push(`macOS/Linux: ${script.unixCommands.join("; ")}`);
  if (script.windowsCommands?.length) lines.push(`Windows: ${script.windowsCommands.join("; ")}`);
  if (script.scriptPath) lines.push(script.scriptPath);
  if (script.unixScriptPath) lines.push(`macOS/Linux: ${script.unixScriptPath}`);
  if (script.windowsScriptPath) lines.push(`Windows: ${script.windowsScriptPath}`);
  return (
    <div>
      <span style={{ color: COLORS.textDim, fontSize: 11 }}>Setup script: </span>
      {lines.map((line, i) => (
        <span key={i}>
          {i > 0 && <span style={{ color: COLORS.textDim }}> | </span>}
          <span style={{ color: COLORS.accent, fontFamily: MONO_FONT, fontSize: 10 }}>{line}</span>
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
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>(
    Object.entries(initial.envVars ?? {}).map(([key, value]) => ({ key, value }))
  );
  /**
   * A lane's ports come from its own allocation, never from the template: a
   * port lease is taken at lane create, before `applyTemplate` runs, and
   * `applyLeaseToOverrides` fills `overrides.portRange` first — so
   * `template.portRange` was only ever used by a lane with no lease at all.
   * The field is gone from the editor rather than showing a control that does
   * nothing, but any stored value round-trips untouched through save.
   */
  const preservedPortRange = initial.portRange;

  const [dockerCompose, setDockerCompose] = useState(initial.docker?.composePath ?? "");
  const [dockerServices, setDockerServices] = useState(initial.docker?.services?.join(", ") ?? "");

  // Setup script state — one set of commands by default, per-platform variants on demand
  const [setupCommands, setSetupCommands] = useState(initial.setupScript?.commands?.join("\n") ?? "");
  const [setupUnixCommands, setSetupUnixCommands] = useState(initial.setupScript?.unixCommands?.join("\n") ?? "");
  const [setupWindowsCommands, setSetupWindowsCommands] = useState(initial.setupScript?.windowsCommands?.join("\n") ?? "");
  const [setupScriptPath, setSetupScriptPath] = useState(initial.setupScript?.scriptPath ?? "");
  const [setupUnixScriptPath, setSetupUnixScriptPath] = useState(initial.setupScript?.unixScriptPath ?? "");
  const [setupWindowsScriptPath, setSetupWindowsScriptPath] = useState(initial.setupScript?.windowsScriptPath ?? "");
  const [setupInjectPrimaryPath, setSetupInjectPrimaryPath] = useState(initial.setupScript?.injectPrimaryPath ?? false);

  // Per-platform variants and the advanced block start open only when they
  // already hold something, so an existing template never hides its own config.
  const hasPlatformVariants =
    (initial.setupScript?.unixCommands?.length ?? 0) > 0 ||
    (initial.setupScript?.windowsCommands?.length ?? 0) > 0 ||
    !!initial.setupScript?.unixScriptPath ||
    !!initial.setupScript?.windowsScriptPath;

  const hasAdvanced =
    !!initial.docker?.composePath ||
    (initial.mountPoints ?? []).length > 0 ||
    Object.keys(initial.envVars ?? {}).length > 0;

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
      portRange: preservedPortRange,
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
            {isNew ? "Everything here runs when a lane is created with this template." : `Editing "${initial.name}"`}
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

      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Name & description */}
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={subLabelStyle}>Name</div>
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Web app"
              autoFocus
            />
          </div>
          <div style={{ flex: 2 }}>
            <div style={subLabelStyle}>Description (optional)</div>
            <input
              style={inputStyle}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this template sets up..."
            />
          </div>
        </div>

        {/* Files to copy */}
        <Field
          label="Files to copy into new lanes"
          hint="Copied from your project folder into the new lane when it's created, exactly as they are."
        >
          {copyPaths.map((cp, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={cp.source}
                onChange={(e) => setCopyPaths(updateAt(copyPaths, i, { source: e.target.value }))}
                placeholder=".claude"
              />
              <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"→"}</span>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={cp.dest ?? ""}
                onChange={(e) => setCopyPaths(updateAt(copyPaths, i, { dest: e.target.value || undefined }))}
                placeholder="same path if left empty"
              />
              <button style={removeBtn} onClick={() => setCopyPaths(removeAt(copyPaths, i))}>{"×"}</button>
            </div>
          ))}
          <button
            style={outlineButton({ height: 28, fontSize: 10 })}
            onClick={() => setCopyPaths([...copyPaths, { source: "" }])}
          >
            + Add file or folder
          </button>
        </Field>

        {/* Env files */}
        <Field
          label="Env files to fill in"
          hint={
            <>
              Copied the same way, but placeholders like <code style={codeStyle}>{"{{LANE_NAME}}"}</code> and{" "}
              <code style={codeStyle}>{"{{PORT}}"}</code> are replaced with this lane's values.
            </>
          }
        >
          {envFiles.map((ef, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={ef.source}
                onChange={(e) => setEnvFiles(updateAt(envFiles, i, { source: e.target.value }))}
                placeholder=".env.template"
              />
              <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"→"}</span>
              <input
                style={{ ...monoInputStyle, flex: 1 }}
                value={ef.dest}
                onChange={(e) => setEnvFiles(updateAt(envFiles, i, { dest: e.target.value }))}
                placeholder=".env"
              />
              <button style={removeBtn} onClick={() => setEnvFiles(removeAt(envFiles, i))}>{"×"}</button>
            </div>
          ))}
          <button
            style={outlineButton({ height: 28, fontSize: 10 })}
            onClick={() => setEnvFiles([...envFiles, { source: "", dest: "" }])}
          >
            + Add env file
          </button>
        </Field>

        {/* Install */}
        <Field
          label="Install command"
          hint="Runs in the new lane while it's being set up. Package managers only — npm, pnpm, yarn, pip, bundle, cargo, go, bun and friends. One plain command each; pipes and && won't work."
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
                placeholder="folder (optional)"
              />
              <button style={removeBtn} onClick={() => setDependencies(removeAt(dependencies, i))}>{"×"}</button>
            </div>
          ))}
          <button
            style={outlineButton({ height: 28, fontSize: 10 })}
            onClick={() => setDependencies([...dependencies, { command: [] }])}
          >
            + Add command
          </button>
        </Field>

        <SetupScriptFields
          commands={setupCommands}
          onCommands={setSetupCommands}
          scriptPath={setupScriptPath}
          onScriptPath={setSetupScriptPath}
          injectPrimaryPath={setupInjectPrimaryPath}
          onInjectPrimaryPath={setSetupInjectPrimaryPath}
          unixCommands={setupUnixCommands}
          onUnixCommands={setSetupUnixCommands}
          unixScriptPath={setupUnixScriptPath}
          onUnixScriptPath={setSetupUnixScriptPath}
          windowsCommands={setupWindowsCommands}
          onWindowsCommands={setSetupWindowsCommands}
          windowsScriptPath={setupWindowsScriptPath}
          onWindowsScriptPath={setSetupWindowsScriptPath}
          platformVariantsOpen={hasPlatformVariants}
        />

        <AdvancedFields
          defaultOpen={hasAdvanced}
          dockerCompose={dockerCompose}
          onDockerCompose={setDockerCompose}
          dockerServices={dockerServices}
          onDockerServices={setDockerServices}
          mountPoints={mountPoints}
          onMountPoints={setMountPoints}
          envVars={envVars}
          onEnvVars={setEnvVars}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor blocks
// ---------------------------------------------------------------------------

/** The setup-script half of the editor: commands, script file, platform variants. */
function SetupScriptFields({
  commands,
  onCommands,
  scriptPath,
  onScriptPath,
  injectPrimaryPath,
  onInjectPrimaryPath,
  unixCommands,
  onUnixCommands,
  unixScriptPath,
  onUnixScriptPath,
  windowsCommands,
  onWindowsCommands,
  windowsScriptPath,
  onWindowsScriptPath,
  platformVariantsOpen,
}: {
  commands: string;
  onCommands: (value: string) => void;
  scriptPath: string;
  onScriptPath: (value: string) => void;
  injectPrimaryPath: boolean;
  onInjectPrimaryPath: (value: boolean) => void;
  unixCommands: string;
  onUnixCommands: (value: string) => void;
  unixScriptPath: string;
  onUnixScriptPath: (value: string) => void;
  windowsCommands: string;
  onWindowsCommands: (value: string) => void;
  windowsScriptPath: string;
  onWindowsScriptPath: (value: string) => void;
  platformVariantsOpen: boolean;
}) {
  return (
    <Field
      label="Setup script"
      hint="Runs last, in the new lane's folder, once everything above is done. If a command fails, setup stops there."
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <textarea
            style={textareaStyle}
            value={commands}
            onChange={(e) => onCommands(e.target.value)}
            placeholder={"npm run bootstrap\ncp $PRIMARY_WORKTREE_PATH/.env .env"}
            rows={3}
          />
          <div style={hintStyle}>
            One command per line, run in order. (On Windows they run in cmd, where a variable
            is written <code style={codeStyle}>%PRIMARY_WORKTREE_PATH%</code>.)
          </div>
        </div>

        <div>
          <div style={subLabelStyle}>Or run a script file</div>
          <input
            style={monoInputStyle}
            value={scriptPath}
            onChange={(e) => onScriptPath(e.target.value)}
            placeholder="scripts/setup-lane.sh"
          />
          <div style={hintStyle}>
            Runs after the commands above. Path is relative to your project folder. The file has to
            exist, and on macOS and Linux it has to be executable (<code style={codeStyle}>chmod +x</code>),
            or setup fails.
          </div>
        </div>

        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          padding: "10px 12px",
          background: COLORS.recessedBg,
          border: `1px solid ${COLORS.borderMuted}`,
          borderRadius: 8,
        }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 500, color: COLORS.textPrimary }}>Pass the main folder path</div>
            <div style={hintStyle}>
              Sets <code style={codeStyle}>$PRIMARY_WORKTREE_PATH</code> so the script can copy files out of your main checkout.
            </div>
          </div>
          <SettingsToggle
            checked={injectPrimaryPath}
            onChange={onInjectPrimaryPath}
            label="Pass the main folder path"
          />
        </div>

        {/* Per-platform variants — the script that runs depends on the OS */}
        <SettingsDisclosure summary="Different commands on Windows" defaultOpen={platformVariantsOpen}>
          <div style={{ ...hintStyle, marginTop: 0 }}>
            When set, these run instead of the commands above on that platform.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={subLabelStyle}>macOS and Linux</div>
              <textarea
                style={{ ...textareaStyle, minHeight: 48 }}
                value={unixCommands}
                onChange={(e) => onUnixCommands(e.target.value)}
                placeholder={"chmod +x scripts/setup.sh\n./scripts/setup.sh"}
                rows={2}
              />
              <div style={{ marginTop: 8 }}>
                <div style={subLabelStyle}>Script file</div>
                <input
                  style={monoInputStyle}
                  value={unixScriptPath}
                  onChange={(e) => onUnixScriptPath(e.target.value)}
                  placeholder="scripts/setup-lane.sh"
                />
              </div>
            </div>
            <div>
              <div style={subLabelStyle}>Windows</div>
              <textarea
                style={{ ...textareaStyle, minHeight: 48 }}
                value={windowsCommands}
                onChange={(e) => onWindowsCommands(e.target.value)}
                placeholder="powershell -File scripts\setup.ps1"
                rows={2}
              />
              <div style={{ marginTop: 8 }}>
                <div style={subLabelStyle}>Script file</div>
                <input
                  style={monoInputStyle}
                  value={windowsScriptPath}
                  onChange={(e) => onWindowsScriptPath(e.target.value)}
                  placeholder="scripts\setup-lane.ps1"
                />
              </div>
            </div>
          </div>
        </SettingsDisclosure>
      </div>
    </Field>
  );
}

/** Rarely-needed editor fields: docker, .ade files, extra variables. */
function AdvancedFields({
  defaultOpen,
  dockerCompose,
  onDockerCompose,
  dockerServices,
  onDockerServices,
  mountPoints,
  onMountPoints,
  envVars,
  onEnvVars,
}: {
  defaultOpen: boolean;
  dockerCompose: string;
  onDockerCompose: (value: string) => void;
  dockerServices: string;
  onDockerServices: (value: string) => void;
  mountPoints: LaneMountPointConfig[];
  onMountPoints: (value: LaneMountPointConfig[]) => void;
  envVars: Array<{ key: string; value: string }>;
  onEnvVars: (value: Array<{ key: string; value: string }>) => void;
}) {
  return (
    <SettingsDisclosure summary="Advanced" defaultOpen={defaultOpen}>
      <Field
        label="Docker services"
        hint="Started with Docker Compose when the lane is created, under a name of their own, and stopped when the lane is deleted."
      >
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 2 }}>
            <div style={subLabelStyle}>Compose file</div>
            <input
              style={monoInputStyle}
              value={dockerCompose}
              onChange={(e) => onDockerCompose(e.target.value)}
              placeholder="docker-compose.yml"
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={subLabelStyle}>Services</div>
            <input
              style={monoInputStyle}
              value={dockerServices}
              onChange={(e) => onDockerServices(e.target.value)}
              placeholder="all services if empty"
            />
          </div>
        </div>
      </Field>

      <Field
        label="Files from the .ade folder"
        hint="Copied out of this project's .ade folder into the new lane when it's created. Mostly for agent profiles."
      >
        {mountPoints.map((mp, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              style={{ ...monoInputStyle, flex: 1 }}
              value={mp.source}
              onChange={(e) => onMountPoints(updateAt(mountPoints, i, { source: e.target.value }))}
              placeholder="agent-profiles/default.json"
            />
            <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"→"}</span>
            <input
              style={{ ...monoInputStyle, flex: 1 }}
              value={mp.dest}
              onChange={(e) => onMountPoints(updateAt(mountPoints, i, { dest: e.target.value }))}
              placeholder=".ade/profile.json"
            />
            <button style={removeBtn} onClick={() => onMountPoints(removeAt(mountPoints, i))}>{"×"}</button>
          </div>
        ))}
        <button
          style={outlineButton({ height: 28, fontSize: 10 })}
          onClick={() => onMountPoints([...mountPoints, { source: "", dest: "" }])}
        >
          + Add file
        </button>
      </Field>

      <Field
        label="Extra variables"
        hint={
          <>
            More <code style={codeStyle}>{"{{VALUES}}"}</code> for the env files above, and environment variables for the setup
            script. They aren't set in lane terminals.
          </>
        }
      >
        {envVars.map((v, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input
              style={{ ...monoInputStyle, flex: 1 }}
              value={v.key}
              onChange={(e) => onEnvVars(updateAt(envVars, i, { key: e.target.value }))}
              placeholder="KEY"
            />
            <span style={{ color: COLORS.textDim, fontSize: 11 }}>=</span>
            <input
              style={{ ...monoInputStyle, flex: 2 }}
              value={v.value}
              onChange={(e) => onEnvVars(updateAt(envVars, i, { value: e.target.value }))}
              placeholder="value"
            />
            <button style={removeBtn} onClick={() => onEnvVars(removeAt(envVars, i))}>{"×"}</button>
          </div>
        ))}
        <button
          style={outlineButton({ height: 28, fontSize: 10 })}
          onClick={() => onEnvVars([...envVars, { key: "", value: "" }])}
        >
          + Add variable
        </button>
      </Field>
    </SettingsDisclosure>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

/** One setting: plain label, one line of help, then the controls. */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={fieldLabelStyle}>{label}</div>
      {hint ? <div style={hintStyle}>{hint}</div> : null}
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onCreateTemplate }: { onCreateTemplate: () => void }) {
  return (
    <div style={{ ...cardStyle({ borderRadius: 12, padding: 24 }), textAlign: "center" }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 6 }}>
        No templates yet
      </div>
      <div style={{ fontSize: 12, color: COLORS.textMuted, maxWidth: 420, margin: "0 auto", lineHeight: 1.5 }}>
        A template says what happens when a lane is created: which files get copied in,
        what gets installed, and what script runs.
      </div>
      <button
        style={primaryButton({ height: 34, fontSize: 12, marginTop: 16 })}
        onClick={onCreateTemplate}
      >
        Create your first template
      </button>
    </div>
  );
}
