import { useState, useEffect, useCallback } from "react";
import { CaretDown, ChatCircleText, Plus, Stack } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
} from "../lanes/laneDesignTokens";
import {
  ModernRow,
  ModernRows,
  ModernSection,
  SettingsDisclosure,
  SettingsSelect,
  SettingsTextField,
  SettingsToggle,
} from "./primitives";
import "./machineSettings.css";
import { laneSetupScriptHasWork, laneSetupScriptIsConfigured } from "../../../shared/types";
import {
  LANE_SETUP_PLATFORM_FIELDS,
  macosOnlyToolOnLinux,
  type LaneSetupCommandsKey,
  type LaneSetupPlatformKey,
  type LaneSetupScriptPathKey,
} from "../../../shared/laneSetupPlatform";
import { confirmDialog } from "../ui/dialog/confirm";
import { showToast } from "../app/toast/toastStore";
import type {
  LaneTemplate,
  LaneCopyPathConfig,
  LaneEnvFileConfig,
  LaneDependencyInstallConfig,
  LaneMountPointConfig,
  LaneSetupScriptConfig,
} from "../../../shared/types";
import { useSettingsMachineScope } from "./SettingsMachineScope";
import { AccountSettingNotices } from "./AccountSettingNotices";
import { useLaneTemplateSetupChat } from "../lanes/useLaneTemplateSetupChat";
import { getNewLaneDefaultsCached } from "../../lib/newLaneDefaultsCache";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { requirePin } from "../../state/repositoryScope";

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

const codeStyle: React.CSSProperties = {
  fontFamily: MONO_FONT,
  fontSize: 10.5,
  color: COLORS.textPrimary,
  background: "color-mix(in srgb, var(--color-fg) 7%, transparent)",
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
 * The setup-script half of the editor, as one form-state object. Kept flat and
 * string-shaped (not `LaneSetupScriptConfig`) because these are raw textarea
 * and input values — parsing into commands only happens on save.
 */
type SetupScriptForm = Record<LaneSetupCommandsKey | LaneSetupScriptPathKey, string> & {
  injectPrimaryPath: boolean;
  /**
   * Per-OS lists the person set to "Run no commands": saved as an explicit
   * `[]`, so the shared commands do not run on that OS. Off, an empty field
   * inherits them.
   */
  noCommands: Partial<Record<LaneSetupCommandsKey, boolean>>;
};

function setupScriptFormFrom(script: LaneSetupScriptConfig | undefined): SetupScriptForm {
  const form = { injectPrimaryPath: script?.injectPrimaryPath ?? false, noCommands: {} } as SetupScriptForm;
  for (const field of LANE_SETUP_PLATFORM_FIELDS) {
    form[field.commandsKey] = script?.[field.commandsKey]?.join("\n") ?? "";
    form[field.scriptKey] = script?.[field.scriptKey] ?? "";
    if (field.key !== "shared" && script?.[field.commandsKey]?.length === 0) form.noCommands[field.commandsKey] = true;
  }
  return form;
}

/**
 * Turns the editor's raw text back into a config, or `undefined` when it holds
 * nothing to keep: the same predicate config parsing uses
 * (`laneSetupScriptIsConfigured`), so a saved template loads back as saved.
 */
function setupScriptFromForm(form: SetupScriptForm): LaneSetupScriptConfig | undefined {
  // Every commands list first, then every script path: the stored key order.
  const script: LaneSetupScriptConfig = {};
  for (const field of LANE_SETUP_PLATFORM_FIELDS) {
    if (form.noCommands[field.commandsKey]) {
      script[field.commandsKey] = [];
      continue;
    }
    const commands = parseLines(form[field.commandsKey]);
    if (commands.length > 0) script[field.commandsKey] = commands;
  }
  for (const field of LANE_SETUP_PLATFORM_FIELDS) {
    const scriptPath = form[field.scriptKey].trim();
    if (scriptPath) script[field.scriptKey] = scriptPath;
  }
  if (form.injectPrimaryPath) script.injectPrimaryPath = true;
  return laneSetupScriptIsConfigured(script) ? script : undefined;
}

/**
 * The advanced half of the editor, as one form-state object — same shape as
 * `SetupScriptForm` so both editor blocks take `{ value, onChange(patch) }`
 * instead of one growing a fistful of value/setter pairs.
 */
type AdvancedForm = {
  dockerCompose: string;
  dockerServices: string;
  mountPoints: LaneMountPointConfig[];
  envVars: Array<{ key: string; value: string }>;
};

function advancedFormFrom(template: LaneTemplate): AdvancedForm {
  return {
    dockerCompose: template.docker?.composePath ?? "",
    dockerServices: template.docker?.services?.join(", ") ?? "",
    mountPoints: template.mountPoints ?? [],
    envVars: Object.entries(template.envVars ?? {}).map(([key, value]) => ({ key, value })),
  };
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
 * editor. `ModernSection` sets the id and its `data-settings-anchor` mirror, so
 * settings search can filter this step too.
 */
const ANCHOR = "lane-templates";
const GROUP = "New lanes";

const TITLE = "Template";
const DESCRIPTION = "Set up new lanes the same way: copy files in, install packages, run a script.";

/** The repository recipes that follow the account (`projectConfigAccountKeys.ts`). */
const RECIPE_ACCOUNT_KEYS = ["lanes.envInit", "tests.suite."] as const;

export function LaneTemplatesSection() {
  // A project's templates follow the account (per repository); they are read
  // and written through the machine the Settings page shows, which also adds
  // any templates committed in the repository's shared config.
  const { pin, machineName } = useSettingsMachineScope();
  const { start: startTemplateChat, busy: templateChatBusy } = useLaneTemplateSetupChat({ pin, machineName, origin: "settings" });
  const [templates, setTemplates] = useState<LaneTemplate[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<LaneTemplate | null>(null);
  const projectRoot = useAppStore(selectActiveProjectRoot);
  // The default template is part of the new-lane defaults every surface
  // shares; re-read them after a change here so none keeps a stale copy.
  const refreshNewLaneDefaults = useCallback(() => {
    void getNewLaneDefaultsCached({ projectRoot, pin, force: true });
  }, [pin, projectRoot]);

  const refresh = useCallback(async () => {
    try {
      const [tpls, defId] = await Promise.all([
        window.ade.lanes.listTemplates(requirePin(pin)),
        window.ade.lanes.getDefaultTemplate(requirePin(pin)),
      ]);
      setTemplates(tpls);
      setDefaultId(defId);
    } catch {
      setTemplates([]);
      setDefaultId(null);
    } finally {
      setLoading(false);
    }
  }, [pin]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleSetDefault = useCallback(async (templateId: string) => {
    const newId = templateId || null;
    try {
      await window.ade.lanes.setDefaultTemplate({ templateId: newId }, requirePin(pin));
      setDefaultId(newId);
    } catch {
      await refresh();
    }
    refreshNewLaneDefaults();
  }, [pin, refresh, refreshNewLaneDefaults]);

  const handleSave = useCallback(async (template: LaneTemplate) => {
    try {
      await window.ade.lanes.saveTemplate({ template }, requirePin(pin));
      setEditing(null);
      await refresh();
      refreshNewLaneDefaults();
    } catch (err: unknown) {
      showToast({ title: "Failed to save template", message: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }, [pin, refresh, refreshNewLaneDefaults]);

  const handleDelete = useCallback(async (templateId: string) => {
    try {
      await window.ade.lanes.deleteTemplate({ templateId }, requirePin(pin));
      await refresh();
      refreshNewLaneDefaults();
    } catch (err: unknown) {
      showToast({ title: "Failed to delete template", message: err instanceof Error ? err.message : String(err), tone: "error" });
    }
  }, [pin, refresh, refreshNewLaneDefaults]);

  const newTemplateButton = (
    <button type="button" className="ade-modern-btn" onClick={() => setEditing(emptyTemplate())}>
      <Plus size={12} weight="bold" />
      New template
    </button>
  );

  // A new chat in this machine's main checkout, with a prompt that asks an
  // agent to read the repo and write the template. Nothing is sent.
  const agentSetupButton = (
    <button
      type="button"
      className="ade-modern-btn"
      disabled={templateChatBusy}
      title={`Opens a new chat in the main checkout on ${machineName} with a setup prompt. You pick the model and press Send.`}
      onClick={() => void startTemplateChat()}
    >
      <ChatCircleText size={12} weight="bold" />
      {templateChatBusy ? "Opening chat…" : "Set up with an agent"}
    </button>
  );

  if (loading) {
    return (
      <ModernSection size="step" group={GROUP} anchor={ANCHOR} title={TITLE} hint={DESCRIPTION}>
        <p className="ade-modern-muted">Loading templates...</p>
      </ModernSection>
    );
  }

  if (editing) {
    return (
      <ModernSection size="step" group={GROUP} anchor={ANCHOR} title={TITLE} hint={DESCRIPTION}>
        <div className="ade-lt-editor">
          <TemplateEditor
            template={editing}
            onSave={handleSave}
            onCancel={() => setEditing(null)}
          />
        </div>
      </ModernSection>
    );
  }

  return (
    <ModernSection
      size="step"
      group={GROUP}
      anchor={ANCHOR}
      title={TITLE}
      hint={DESCRIPTION}
      actions={templates.length > 0 ? <>{agentSetupButton}{newTemplateButton}</> : undefined}
    >
      {/* The project's lane setup and test suites follow the account too;
          one that stays on this computer says why here. */}
      <AccountSettingNotices pin={pin} keys={RECIPE_ACCOUNT_KEYS} />
      {templates.length === 0 ? (
        <div className="ade-lt-empty">
          <Stack size={22} weight="light" />
          <div className="ade-ap-rowtitle">No templates yet</div>
          <p className="ade-modern-muted" style={{ maxWidth: 440, textAlign: "center" }}>
            A template says what happens when a lane is created: which files get copied in, what gets installed, and what script runs. New lanes start without packages, so an agent can read this repo and write one for you.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <button
              type="button"
              className="ade-modern-btn"
              data-tone="primary"
              disabled={templateChatBusy}
              title={`Opens a new chat in the main checkout on ${machineName} with a setup prompt. You pick the model and press Send.`}
              onClick={() => void startTemplateChat()}
            >
              <ChatCircleText size={12} weight="bold" />
              {templateChatBusy ? "Opening chat…" : "Set up with an agent"}
            </button>
            <button type="button" className="ade-modern-btn" onClick={() => setEditing(emptyTemplate())}>
              Create one yourself
            </button>
          </div>
        </div>
      ) : (
        <>
          <ModernRows>
            <ModernRow
              title="New lanes use"
              hint="Auto-create lane too. You can pick another when you make a lane."
              control={(
                <SettingsSelect
                  value={defaultId ?? ""}
                  onChange={handleSetDefault}
                  ariaLabel="Default lane template"
                  options={[
                    { value: "", label: "None" },
                    ...templates.map((template) => ({ value: template.id, label: template.name })),
                  ]}
                  style={{ minWidth: 200 }}
                />
              )}
            />
          </ModernRows>
          <div className="ade-modern-rows" role="table" aria-label="Lane templates">
            {templates.map((t) => (
              <TemplateRow
                key={t.id}
                template={t}
                isDefault={t.id === defaultId}
                onEdit={() => setEditing({ ...t })}
                onDelete={() => handleDelete(t.id)}
              />
            ))}
          </div>
        </>
      )}
    </ModernSection>
  );
}

// ---------------------------------------------------------------------------
// Template row
// ---------------------------------------------------------------------------

/**
 * One template in the manager table, plus its expanded configuration preview.
 *
 * The preview is a sibling of the row rather than a child because the row is a
 * grid of the table's columns — a full-width detail block inside it would be
 * squeezed into the first column.
 */
function TemplateRow({
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
  if (laneSetupScriptHasWork(template.setupScript)) features.push("Setup script");
  if (template.mountPoints?.length) features.push(pluralize(template.mountPoints.length, "mount"));
  if (template.docker?.composePath) features.push("Docker");
  if (template.envVars && Object.keys(template.envVars).length > 0) features.push("Env vars");

  const name = template.name || "Untitled";

  return (
    <div className="ade-lt-item">
      <div role="row" className="ade-lt-row">
        <div style={{ minWidth: 0, flex: "1 1 200px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span className="ade-ap-rowtitle" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
            {isDefault ? <span className="kit-tag">Default</span> : null}
          </div>
          {template.description ? (
            <div className="ade-ap-rowhint" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {template.description}
            </div>
          ) : null}
        </div>
        <div className="ade-lt-features">
          {features.length > 0 ? (
            features.map((f) => <span key={f} className="kit-tag">{f}</span>)
          ) : (
            <span className="ade-modern-muted">Nothing yet</span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
          <button type="button" className="ade-modern-btn" data-size="sm" onClick={onEdit}>
            Edit
          </button>
          <button
            type="button"
            className="ade-modern-btn"
            data-size="sm"
            data-variant="ghost"
            onClick={() => {
              void confirmDialog({ title: `Delete template "${template.name}"?`, confirmLabel: "Delete", destructive: true })
                .then((ok) => { if (ok) onDelete(); });
            }}
          >
            Delete
          </button>
          <button
            type="button"
            className="ade-modern-btn"
            data-size="sm"
            data-variant="ghost"
            aria-expanded={expanded}
            aria-label={expanded ? `Hide ${name} details` : `Show ${name} details`}
            onClick={() => setExpanded(!expanded)}
            style={{ width: 24, padding: 0 }}
          >
            <CaretDown size={12} style={{ transition: "transform 150ms ease", transform: expanded ? "rotate(180deg)" : "rotate(0)" }} />
          </button>
        </div>
      </div>
      {expanded && (
        <dl className="ade-lt-details ade-modern-facts">
          {template.copyPaths && template.copyPaths.length > 0 && (
            <ConfigRow label="Files to copy" items={template.copyPaths.map((p) => p.dest ? `${p.source} → ${p.dest}` : p.source)} />
          )}
          {template.envFiles && template.envFiles.length > 0 && (
            <ConfigRow label="Env files" items={template.envFiles.map((f) => `${f.source} → ${f.dest}`)} />
          )}
          {template.dependencies && template.dependencies.length > 0 && (
            <ConfigRow label="Install" items={template.dependencies.map((d) => d.command.join(" "))} />
          )}
          {laneSetupScriptHasWork(template.setupScript) && template.setupScript && (
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
        </dl>
      )}
    </div>
  );
}

function ConfigRow({ label, items }: { label: string; items: string[] }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="ade-modern-path">{items.join(", ")}</dd>
    </>
  );
}

function SetupScriptPreview({ script }: { script: LaneSetupScriptConfig }) {
  const labelled = (label: string | null, text: string) => (label ? `${label}: ${text}` : text);
  const lines: string[] = [];
  for (const field of LANE_SETUP_PLATFORM_FIELDS) {
    const commands = script[field.commandsKey];
    if (commands?.length) lines.push(labelled(field.label, commands.join("; ")));
    else if (commands && field.key !== "shared") lines.push(labelled(field.label, "no commands"));
  }
  for (const field of LANE_SETUP_PLATFORM_FIELDS) {
    const scriptPath = script[field.scriptKey];
    if (scriptPath) lines.push(labelled(field.label, scriptPath));
  }
  return (
    <>
      <dt>Setup script</dt>
      <dd className="ade-modern-path">{lines.join(" | ")}</dd>
    </>
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
  /**
   * A lane's ports come from its own allocation, never from the template: a
   * port lease is taken at lane create, before `applyTemplate` runs, and
   * `applyLeaseToOverrides` fills `overrides.portRange` first — so
   * `template.portRange` was only ever used by a lane with no lease at all.
   * The field is gone from the editor rather than showing a control that does
   * nothing, but any stored value round-trips untouched through save.
   */
  const preservedPortRange = initial.portRange;

  const [advancedForm, setAdvancedForm] = useState<AdvancedForm>(() => advancedFormFrom(initial));
  const patchAdvanced = useCallback((patch: Partial<AdvancedForm>) => {
    setAdvancedForm((prev) => ({ ...prev, ...patch }));
  }, []);

  // Setup script state — one set of commands by default, per-platform variants on demand
  const [setupScriptForm, setSetupScriptForm] = useState<SetupScriptForm>(() =>
    setupScriptFormFrom(initial.setupScript)
  );
  const patchSetupScript = useCallback((patch: Partial<SetupScriptForm>) => {
    setSetupScriptForm((prev) => ({ ...prev, ...patch }));
  }, []);

  // Per-platform variants and the advanced block start open only when they
  // already hold something, so an existing template never hides its own config.
  const hasPlatformVariants = LANE_SETUP_PLATFORM_FIELDS.some((field) => (
    field.key !== "shared"
    && (Array.isArray(initial.setupScript?.[field.commandsKey]) || !!initial.setupScript?.[field.scriptKey])
  ));

  const hasAdvanced =
    !!initial.docker?.composePath ||
    (initial.mountPoints ?? []).length > 0 ||
    Object.keys(initial.envVars ?? {}).length > 0;

  const isNew = !initial.name;

  function handleSubmit() {
    if (!name.trim()) return;

    const setupScript = setupScriptFromForm(setupScriptForm);

    const { dockerCompose, dockerServices, mountPoints, envVars } = advancedForm;
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
      <div className="ade-lt-editor-head">
        <div style={{ minWidth: 0 }}>
          <div className="kit-eyebrow">{isNew ? "New template" : "Edit template"}</div>
          <div className="ade-ap-rowhint" style={{ marginTop: 4 }}>
            {isNew ? "Everything here runs when a lane is created with this template." : `Editing "${initial.name}"`}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="ade-modern-btn" data-variant="ghost" onClick={onCancel}>Cancel</button>
          <button
            type="button"
            className="ade-modern-btn"
            data-tone="primary"
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
            <SettingsTextField
              value={name}
              onChange={(next) => setName(next)}
              placeholder="e.g. Web app"
              autoFocus
            />
          </div>
          <div style={{ flex: 2 }}>
            <div style={subLabelStyle}>Description (optional)</div>
            <SettingsTextField
              value={description}
              onChange={(next) => setDescription(next)}
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
              <SettingsTextField
                value={cp.source}
                onChange={(next) => setCopyPaths(updateAt(copyPaths, i, { source: next }))}
                placeholder=".claude"
                mono
                style={{ flex: 1 }}
              />
              <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"→"}</span>
              <SettingsTextField
                value={cp.dest ?? ""}
                onChange={(next) => setCopyPaths(updateAt(copyPaths, i, { dest: next || undefined }))}
                placeholder="same path if left empty"
                mono
                style={{ flex: 1 }}
              />
              <button style={removeBtn} onClick={() => setCopyPaths(removeAt(copyPaths, i))}>{"×"}</button>
            </div>
          ))}
          <button
            type="button" className="ade-modern-btn" data-size="sm"
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
              <SettingsTextField
                value={ef.source}
                onChange={(next) => setEnvFiles(updateAt(envFiles, i, { source: next }))}
                placeholder=".env.template"
                mono
                style={{ flex: 1 }}
              />
              <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"→"}</span>
              <SettingsTextField
                value={ef.dest}
                onChange={(next) => setEnvFiles(updateAt(envFiles, i, { dest: next }))}
                placeholder=".env"
                mono
                style={{ flex: 1 }}
              />
              <button style={removeBtn} onClick={() => setEnvFiles(removeAt(envFiles, i))}>{"×"}</button>
            </div>
          ))}
          <button
            type="button" className="ade-modern-btn" data-size="sm"
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
              <SettingsTextField
                value={dep.command.join(" ")}
                onChange={(next) => setDependencies(updateAt(dependencies, i, { command: next.split(/\s+/).filter(Boolean) }))}
                placeholder="npm install"
                mono
                style={{ flex: 2 }}
              />
              <SettingsTextField
                value={dep.cwd ?? ""}
                onChange={(next) => setDependencies(updateAt(dependencies, i, { cwd: next || undefined }))}
                placeholder="folder (optional)"
                mono
                style={{ flex: 1 }}
              />
              <button style={removeBtn} onClick={() => setDependencies(removeAt(dependencies, i))}>{"×"}</button>
            </div>
          ))}
          <button
            type="button" className="ade-modern-btn" data-size="sm"
            onClick={() => setDependencies([...dependencies, { command: [] }])}
          >
            + Add command
          </button>
        </Field>

        <SetupScriptFields
          value={setupScriptForm}
          onChange={patchSetupScript}
          defaultOpen={hasPlatformVariants}
        />

        <AdvancedFields
          value={advancedForm}
          onChange={patchAdvanced}
          defaultOpen={hasAdvanced}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor blocks
// ---------------------------------------------------------------------------

/** The per-OS editor column's heading and examples, in the order the table lists them. */
const PLATFORM_EDITOR_COPY: Record<
  Exclude<LaneSetupPlatformKey, "shared">,
  { label: string; commandsPlaceholder: string; scriptPlaceholder: string }
> = {
  unix: {
    label: "macOS and Linux",
    commandsPlaceholder: "chmod +x scripts/setup.sh\n./scripts/setup.sh",
    scriptPlaceholder: "scripts/setup-lane.sh",
  },
  macos: {
    label: "macOS only",
    commandsPlaceholder: "cp -cR $PRIMARY_WORKTREE_PATH/node_modules node_modules",
    scriptPlaceholder: "scripts/setup-lane-mac.sh",
  },
  linux: {
    label: "Linux only (ADE Cloud)",
    commandsPlaceholder: "npm ci --prefer-offline",
    scriptPlaceholder: "scripts/setup-lane-linux.sh",
  },
  windows: {
    label: "Windows",
    commandsPlaceholder: "powershell -File scripts\\setup.ps1",
    scriptPlaceholder: "scripts\\setup-lane.ps1",
  },
};

/**
 * The setup-script half of the editor: commands, script file, platform variants.
 * `defaultOpen` controls the per-platform disclosure only.
 */
function SetupScriptFields({
  value,
  onChange,
  defaultOpen,
}: {
  value: SetupScriptForm;
  onChange: (patch: Partial<SetupScriptForm>) => void;
  defaultOpen: boolean;
}) {
  const { commands, scriptPath, injectPrimaryPath } = value;
  // Shared commands that call a macOS-only tool also run on Linux (ADE Cloud) unless Linux has its own.
  const macosTool = macosOnlyToolOnLinux(setupScriptFromForm(value) ?? {});
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
            onChange={(e) => onChange({ commands: e.target.value })}
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
          <SettingsTextField
            value={scriptPath}
            onChange={(next) => onChange({ scriptPath: next })}
            placeholder="scripts/setup-lane.sh"
            mono
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
            onChange={(next) => onChange({ injectPrimaryPath: next })}
            label="Pass the main folder path"
          />
        </div>

        {macosTool ? (
          <div style={{ ...hintStyle, marginTop: 0, color: COLORS.warning }}>
            <code style={codeStyle}>{macosTool}</code> only exists on macOS, and these commands also run on Linux,
            including ADE Cloud. Add Linux commands below so cloud lanes don&apos;t take the slow path.
          </div>
        ) : null}

        {/* Per-platform variants — the script that runs depends on the OS */}
        <SettingsDisclosure summary="Different commands per OS" defaultOpen={defaultOpen || macosTool != null}>
          <div style={{ ...hintStyle, marginTop: 0 }}>
            When set, these run instead of the commands above on that OS. macOS-only and Linux-only commands
            win over the shared macOS and Linux ones.
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {LANE_SETUP_PLATFORM_FIELDS.map((field) => {
              if (field.key === "shared") return null;
              const copy = PLATFORM_EDITOR_COPY[field.key];
              const noCommands = value.noCommands[field.commandsKey] === true;
              return (
                <div key={field.key}>
                  <div style={subLabelStyle}>{copy.label}</div>
                  <textarea
                    style={{ ...textareaStyle, minHeight: 48, opacity: noCommands ? 0.5 : 1 }}
                    value={noCommands ? "" : value[field.commandsKey]}
                    onChange={(e) => onChange({ [field.commandsKey]: e.target.value } as Partial<SetupScriptForm>)}
                    placeholder={noCommands ? "No commands run here" : copy.commandsPlaceholder}
                    disabled={noCommands}
                    rows={2}
                  />
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 6 }}>
                    <span style={{ ...hintStyle, marginTop: 0 }}>Run no commands here, not even the shared ones</span>
                    <SettingsToggle
                      checked={noCommands}
                      onChange={(next) => onChange({ noCommands: { ...value.noCommands, [field.commandsKey]: next } })}
                      label={`Run no commands on ${copy.label}`}
                    />
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <div style={subLabelStyle}>Script file</div>
                    <SettingsTextField
                      value={value[field.scriptKey]}
                      onChange={(next) => onChange({ [field.scriptKey]: next } as Partial<SetupScriptForm>)}
                      placeholder={copy.scriptPlaceholder}
                      mono
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </SettingsDisclosure>
      </div>
    </Field>
  );
}

/** Rarely-needed editor fields: docker, .ade files, extra variables. */
function AdvancedFields({
  value,
  onChange,
  defaultOpen,
}: {
  value: AdvancedForm;
  onChange: (patch: Partial<AdvancedForm>) => void;
  defaultOpen: boolean;
}) {
  const { dockerCompose, dockerServices, mountPoints, envVars } = value;
  return (
    <SettingsDisclosure summary="Advanced" defaultOpen={defaultOpen}>
      <Field
        label="Docker services"
        hint="Started with Docker Compose when the lane is created, under a name of their own, and stopped when the lane is deleted."
      >
        <div style={{ display: "flex", gap: 12 }}>
          <div style={{ flex: 2 }}>
            <div style={subLabelStyle}>Compose file</div>
            <SettingsTextField
              value={dockerCompose}
              onChange={(next) => onChange({ dockerCompose: next })}
              placeholder="docker-compose.yml"
              mono
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={subLabelStyle}>Services</div>
            <SettingsTextField
              value={dockerServices}
              onChange={(next) => onChange({ dockerServices: next })}
              placeholder="all services if empty"
              mono
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
            <SettingsTextField
              value={mp.source}
              onChange={(next) => onChange({ mountPoints: updateAt(mountPoints, i, { source: next }) })}
              placeholder="agent-profiles/default.json"
              mono
              style={{ flex: 1 }}
            />
            <span style={{ color: COLORS.textDim, fontSize: 11 }}>{"→"}</span>
            <SettingsTextField
              value={mp.dest}
              onChange={(next) => onChange({ mountPoints: updateAt(mountPoints, i, { dest: next }) })}
              placeholder=".ade/profile.json"
              mono
              style={{ flex: 1 }}
            />
            <button style={removeBtn} onClick={() => onChange({ mountPoints: removeAt(mountPoints, i) })}>{"×"}</button>
          </div>
        ))}
        <button
          type="button" className="ade-modern-btn" data-size="sm"
          onClick={() => onChange({ mountPoints: [...mountPoints, { source: "", dest: "" }] })}
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
            <SettingsTextField
              value={v.key}
              onChange={(next) => onChange({ envVars: updateAt(envVars, i, { key: next }) })}
              placeholder="KEY"
              mono
              style={{ flex: 1 }}
            />
            <span style={{ color: COLORS.textDim, fontSize: 11 }}>=</span>
            <SettingsTextField
              value={v.value}
              onChange={(next) => onChange({ envVars: updateAt(envVars, i, { value: next }) })}
              placeholder="value"
              mono
              style={{ flex: 2 }}
            />
            <button style={removeBtn} onClick={() => onChange({ envVars: removeAt(envVars, i) })}>{"×"}</button>
          </div>
        ))}
        <button
          type="button" className="ade-modern-btn" data-size="sm"
          onClick={() => onChange({ envVars: [...envVars, { key: "", value: "" }] })}
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
