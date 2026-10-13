/**
 * Muse Code's right-hand body: plugins and marketplaces, skills, hooks,
 * computer use, and feedback to Meta.
 *
 * Every call goes to the machine the Settings page is showing
 * (`useSettingsMachineScope().pin`) and runs on a Settings-owned `muse serve`
 * host there, one per page visit: this component mints the visit's
 * `handleId`, and closes that host when it unmounts or the page switches
 * machine. A chat's host is never touched. Muse's own errors are shown as Muse
 * words them; ADE does not paper over them.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import {
  COLORS,
  MONO_FONT,
  SANS_FONT,
  SECTION_LABEL_STYLE,
  outlineButton,
  primaryButton,
} from "../../../lanes/laneDesignTokens";
import { useSettingsMachineScope } from "../../SettingsMachineScope";
import type {
  MuseComputerUseState,
  MuseFeedbackClassification,
  MuseFeedbackResult,
  MuseSettingsRequest,
  MuseSettingsResult,
  MuseSettingsSection,
  MuseSettingsSkill,
  MuseSettingsSnapshot,
  MuseSkillActivation,
  MuseSkillImportResult,
  MuseSkillImportSource,
  MuseSkillScope,
} from "../../../../../shared/museSettings";
import type { OpenProjectBinding } from "../../../../../shared/types";
import type { ProvidersViewContext } from "../types";

/** How often computer-use setup is re-read while Muse reports it in progress. */
const SETUP_POLL_MS = 2_000;

const TEXT_MUTED: React.CSSProperties = { fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 };
const TEXT_ERROR: React.CSSProperties = { fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger, lineHeight: 1.5 };
const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 12,
  fontFamily: SANS_FONT,
  color: COLORS.textPrimary,
  padding: "5px 0",
  borderTop: `1px solid ${COLORS.borderMuted}`,
  minWidth: 0,
};
const FIELD: React.CSSProperties = {
  background: COLORS.cardBg,
  border: `1px solid ${COLORS.border}`,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: MONO_FONT,
  color: COLORS.textPrimary,
  outline: "none",
  minWidth: 0,
};
const SMALL_BUTTON = outlineButton({ height: 24, padding: "0 9px", fontSize: 11 });

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newHandleId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `muse-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * One Settings host per page visit on the page's machine. The id is per mount
 * and per machine: switching machine closes the old machine's host.
 */
function useMuseSettingsHost(pin: OpenProjectBinding | null) {
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const handleId = useMemo(() => newHandleId(), [pinKey]);
  useEffect(() => {
    const closingPin = pinRef.current;
    return () => {
      void window.ade?.ai?.museSettingsClose?.({ handleId }, closingPin).catch(() => undefined);
    };
  }, [handleId]);
  const run = useCallback(
    async <R extends MuseSettingsRequest>(request: R): Promise<MuseSettingsResult<R["kind"]>> => {
      const call = window.ade?.ai?.museSettings;
      if (!call) throw new Error("This ADE build cannot manage Muse settings on that machine. Update ADE there and try again.");
      return await call({ handleId, request }, pinRef.current);
    },
    [handleId],
  );
  return { run };
}

type Run = ReturnType<typeof useMuseSettingsHost>["run"];

function SectionHeader({ title, onRefresh, busy }: { title: string; onRefresh?: () => void; busy?: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <div style={SECTION_LABEL_STYLE}>{title}</div>
      {onRefresh ? (
        <button type="button" style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12 })} disabled={busy} onClick={onRefresh}>
          <ArrowsClockwise size={11} weight="bold" /> {busy ? "Refreshing…" : "Refresh"}
        </button>
      ) : null}
    </div>
  );
}

function SectionError<T>({ section }: { section: MuseSettingsSection<T> }) {
  return section.ok ? null : <div style={TEXT_ERROR}>{section.error}</div>;
}

function pluginSourceLabel(source: string): string {
  switch (source) {
    case "curated": return "curated";
    case "marketplaceUserAdded": return "from a marketplace";
    case "foreignImport": return "imported";
    case "nativeLocal": return "local folder";
    default: return source;
  }
}

// ── Plugins & marketplaces ─────────────────────────────────────────────────

function PluginsSection({ snapshot, run, reload }: { snapshot: MuseSettingsSnapshot; run: Run; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [folderScope, setFolderScope] = useState<"default" | "user" | "project">("default");
  const [marketName, setMarketName] = useState("");
  const [marketSource, setMarketSource] = useState("");

  const act = useCallback(async (key: string, work: () => Promise<string | null>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const message = await work();
      setNotice(message);
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [reload]);

  const installed = snapshot.plugins.ok ? snapshot.plugins.rows : [];
  const installedIds = new Set(installed.map((plugin) => plugin.id));
  const available = snapshot.availablePlugins.ok ? snapshot.availablePlugins.rows : [];
  const marketplaces = snapshot.marketplaces.ok ? snapshot.marketplaces.rows : [];

  const installResult = (result: MuseSettingsResult<"pluginInstall">) =>
    `Installed ${result.plugin.id} ${result.plugin.version}.${result.warning ? ` ${result.warning}` : ""}`;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="Plugins" />
      <div style={TEXT_MUTED}>Muse's installed plugins on this machine, and the marketplaces it installs from.</div>
      <SectionError section={snapshot.plugins} />
      {snapshot.plugins.ok && installed.length === 0 ? <div style={TEXT_MUTED}>No plugins installed.</div> : null}
      {installed.length ? (
        <div>
          {installed.map((plugin) => (
            <div key={plugin.id} style={ROW}>
              <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                {plugin.id} <span style={{ color: COLORS.textDim }}>{plugin.version}</span>
              </span>
              <span style={{ color: COLORS.textMuted, flexShrink: 0 }}>
                {plugin.enabled ? "on" : "off"} · {pluginSourceLabel(plugin.source)}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ ...SECTION_LABEL_STYLE, marginTop: 6 }}>Available from marketplaces</div>
      <SectionError section={snapshot.availablePlugins} />
      {snapshot.availablePlugins.ok && available.length === 0 ? (
        <div style={TEXT_MUTED}>Add a marketplace below to see the plugins it offers.</div>
      ) : null}
      {available.map((plugin) => {
        const key = `install:${plugin.marketplace}:${plugin.name}`;
        const isInstalled = installedIds.has(plugin.name);
        return (
          <div key={key} style={ROW}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
              {plugin.name}
              {plugin.version ? <span style={{ color: COLORS.textDim }}> {plugin.version}</span> : null}
              <span style={{ color: COLORS.textMuted }}> · {plugin.marketplace}</span>
            </span>
            <button
              type="button"
              style={SMALL_BUTTON}
              disabled={busy != null}
              onClick={() => void act(key, async () => installResult(await run({
                kind: "pluginInstall",
                target: { marketplace: plugin.marketplace, name: plugin.name },
              })))}
            >
              {busy === key ? "Installing…" : isInstalled ? "Reinstall" : "Install"}
            </button>
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
        <input
          aria-label="Plugin folder"
          value={folder}
          onChange={(event) => setFolder(event.target.value)}
          placeholder="Install from a folder on that machine: /path/to/plugin"
          style={{ ...FIELD, flex: "1 1 240px" }}
        />
        <select aria-label="Install scope" value={folderScope} onChange={(event) => setFolderScope(event.target.value as typeof folderScope)} style={FIELD}>
          <option value="default">Default scope</option>
          <option value="user">User</option>
          <option value="project">This project</option>
        </select>
        <button
          type="button"
          style={SMALL_BUTTON}
          disabled={busy != null || !folder.trim()}
          onClick={() => void act("install:folder", async () => {
            const result = await run({ kind: "pluginInstall", target: { path: folder.trim(), scope: folderScope } });
            setFolder("");
            return installResult(result);
          })}
        >
          {busy === "install:folder" ? "Installing…" : "Install"}
        </button>
      </div>

      <div style={{ ...SECTION_LABEL_STYLE, marginTop: 6 }}>Marketplaces</div>
      <SectionError section={snapshot.marketplaces} />
      {snapshot.marketplaces.ok && marketplaces.length === 0 ? <div style={TEXT_MUTED}>No marketplaces configured.</div> : null}
      {marketplaces.map((market) => (
        <div key={market.name} style={ROW}>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            {market.name}
            <span style={{ color: COLORS.textMuted }}>
              {" "}· {market.pluginCount} plugin{market.pluginCount === 1 ? "" : "s"}
              {market.skippedCount ? ` (${market.skippedCount} skipped)` : ""}
            </span>
            <div style={{ fontSize: 10, fontFamily: MONO_FONT, color: COLORS.textDim, overflowWrap: "anywhere" }}>{market.sourcePath}</div>
          </span>
          <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            <button
              type="button"
              style={SMALL_BUTTON}
              disabled={busy != null}
              onClick={() => void act(`update:${market.name}`, async () => {
                const result = await run({ kind: "marketplaceUpdate", name: market.name });
                return `Updated ${result.marketplace.name}: ${result.marketplace.pluginCount} plugin${result.marketplace.pluginCount === 1 ? "" : "s"}.`;
              })}
            >
              {busy === `update:${market.name}` ? "Updating…" : "Update"}
            </button>
            <button
              type="button"
              style={SMALL_BUTTON}
              disabled={busy != null}
              onClick={() => void act(`remove:${market.name}`, async () => {
                await run({ kind: "marketplaceRemove", name: market.name });
                return `Removed ${market.name}. Plugins already installed from it stay installed.`;
              })}
            >
              {busy === `remove:${market.name}` ? "Removing…" : "Remove"}
            </button>
          </span>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <input aria-label="Marketplace name" value={marketName} onChange={(event) => setMarketName(event.target.value)} placeholder="Name" style={{ ...FIELD, flex: "0 1 140px" }} />
        <input
          aria-label="Marketplace source"
          value={marketSource}
          onChange={(event) => setMarketSource(event.target.value)}
          placeholder="owner/repo, a git URL, or a folder on that machine"
          style={{ ...FIELD, flex: "1 1 220px" }}
        />
        <button
          type="button"
          style={SMALL_BUTTON}
          disabled={busy != null || !marketName.trim() || !marketSource.trim()}
          onClick={() => void act("market:add", async () => {
            const result = await run({ kind: "marketplaceAdd", name: marketName.trim(), source: marketSource.trim() });
            setMarketName("");
            setMarketSource("");
            return `Added ${result.marketplace.name}: ${result.marketplace.pluginCount} plugin${result.marketplace.pluginCount === 1 ? "" : "s"}.`;
          })}
        >
          {busy === "market:add" ? "Adding…" : "Add marketplace"}
        </button>
      </div>
      {notice ? <div style={TEXT_MUTED}>{notice}</div> : null}
      {error ? <div style={TEXT_ERROR}>{error}</div> : null}
    </section>
  );
}

// ── Skills ─────────────────────────────────────────────────────────────────

const ACTIVATION_LABEL: Record<MuseSkillActivation, string> = {
  on: "On",
  userInvocableOnly: "Only when typed",
  off: "Off",
};

const SKILL_SCOPES: readonly MuseSkillScope[] = ["user", "project", "bundled", "plugin"];

function skillScope(skill: MuseSettingsSkill): MuseSkillScope | null {
  return (SKILL_SCOPES as readonly string[]).includes(skill.scope) ? skill.scope as MuseSkillScope : null;
}

function describeImport(source: MuseSkillImportSource, result: MuseSkillImportResult): string {
  const who = source === "claude" ? "Claude Code" : "Codex";
  const parts = [
    `${result.installed.length} ${result.dryRun ? "to import" : "imported"}`,
    result.skipped.length ? `${result.skipped.length} already imported` : null,
    result.quarantined.length ? `${result.quarantined.length} quarantined` : null,
    result.failed.length ? `${result.failed.length} failed` : null,
  ].filter(Boolean);
  const names = result.installed.length ? `: ${result.installed.slice(0, 8).join(", ")}${result.installed.length > 8 ? ", …" : ""}` : "";
  return `${who} skills — ${parts.join(", ")}${names}.`;
}

function SkillsSection({ snapshot, run, reload }: { snapshot: MuseSettingsSnapshot; run: Run; reload: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ source: MuseSkillImportSource; text: string; count: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const skills = snapshot.skills.ok ? snapshot.skills.rows : [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((skill) => skill.id.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
  }, [query, skills]);

  const setActivation = useCallback(async (skill: MuseSettingsSkill, activation: MuseSkillActivation) => {
    const scope = skillScope(skill);
    if (!scope) return;
    setBusy(skill.id);
    setError(null);
    try {
      await run({ kind: "skillSetActivation", selector: skill.id, scope, activation });
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [reload, run]);

  const previewImport = useCallback(async (source: MuseSkillImportSource) => {
    setBusy(`import:${source}`);
    setError(null);
    setNotice(null);
    try {
      const result = await run({ kind: "skillImport", source, dryRun: true });
      setPreview({ source, text: describeImport(source, result), count: result.installed.length });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [run]);

  const confirmImport = useCallback(async () => {
    if (!preview) return;
    setBusy(`import:${preview.source}`);
    setError(null);
    try {
      const result = await run({ kind: "skillImport", source: preview.source, dryRun: false });
      setNotice(describeImport(preview.source, result));
      setPreview(null);
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [preview, reload, run]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="Skills" />
      <div style={TEXT_MUTED}>
        Turn a skill on, off, or on only when you type it. Project skills load once Muse trusts this workspace.
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <input aria-label="Search Muse skills" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search skills" style={{ ...FIELD, flex: "1 1 200px", fontFamily: SANS_FONT }} />
        {(["claude", "codex"] as const).map((source) => (
          <button key={source} type="button" style={SMALL_BUTTON} disabled={busy != null} onClick={() => void previewImport(source)}>
            {busy === `import:${source}` && !preview ? "Checking…" : `Import from ${source === "claude" ? "Claude Code" : "Codex"}`}
          </button>
        ))}
      </div>
      {preview ? (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={TEXT_MUTED}>{preview.text}</span>
          {preview.count > 0 ? (
            <button type="button" style={primaryButton({ height: 24, padding: "0 10px", fontSize: 11 })} disabled={busy != null} onClick={() => void confirmImport()}>
              {busy ? "Importing…" : "Import"}
            </button>
          ) : null}
          <button type="button" style={SMALL_BUTTON} disabled={busy != null} onClick={() => setPreview(null)}>Cancel</button>
        </div>
      ) : null}
      {notice ? <div style={TEXT_MUTED}>{notice}</div> : null}
      <SectionError section={snapshot.skills} />
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        {filtered.map((skill) => {
          const scope = skillScope(skill);
          const activation = (["on", "userInvocableOnly", "off"] as const).includes(skill.activation as MuseSkillActivation)
            ? skill.activation as MuseSkillActivation
            : null;
          return (
            <div key={skill.id} style={ROW}>
              <span style={{ minWidth: 0 }}>
                <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{skill.id}</span>
                <div
                  title={skill.description}
                  style={{ fontSize: 10, color: COLORS.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 520 }}
                >
                  {skill.description}
                </div>
              </span>
              <select
                aria-label={`${skill.id} activation`}
                value={activation ?? skill.activation}
                disabled={!scope || busy != null}
                onChange={(event) => void setActivation(skill, event.target.value as MuseSkillActivation)}
                style={{ ...FIELD, fontFamily: SANS_FONT, flexShrink: 0 }}
              >
                {activation ? null : <option value={skill.activation}>{skill.activation}</option>}
                {(Object.keys(ACTIVATION_LABEL) as MuseSkillActivation[]).map((value) => (
                  <option key={value} value={value}>{ACTIVATION_LABEL[value]}</option>
                ))}
              </select>
            </div>
          );
        })}
        {snapshot.skills.ok && filtered.length === 0 ? <div style={TEXT_MUTED}>No skills match.</div> : null}
      </div>
      {error ? <div style={TEXT_ERROR}>{error}</div> : null}
    </section>
  );
}

// ── Hooks (read-only) ──────────────────────────────────────────────────────

function HooksSection({ snapshot }: { snapshot: MuseSettingsSnapshot }) {
  const hooks = snapshot.hooks.ok ? snapshot.hooks.rows : [];
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="Hooks" />
      <div style={TEXT_MUTED}>The hooks Muse runs in this project, from your settings, the project, and plugins. Read-only here.</div>
      <SectionError section={snapshot.hooks} />
      {snapshot.hooks.ok && hooks.length === 0 ? <div style={TEXT_MUTED}>No hooks installed.</div> : null}
      {hooks.map((hook) => (
        <div key={`${hook.event}:${hook.key}`} style={ROW}>
          <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <span style={{ fontFamily: MONO_FONT, fontSize: 11 }}>{hook.event}</span>
            <span style={{ color: COLORS.textMuted }}> · {hook.key}</span>
          </span>
          <span style={{ color: COLORS.textMuted, flexShrink: 0 }}>{hook.handlerKind} · {hook.enabled ? "on" : "off"}</span>
        </div>
      ))}
    </section>
  );
}

// ── Computer use ───────────────────────────────────────────────────────────

const PERMISSION_LABEL: Record<string, string> = {
  accessibility: "Accessibility",
  screenRecording: "Screen Recording",
  inputMonitoring: "Input Monitoring",
};

const SETUP_LABEL: Record<string, string> = {
  dormant: "Not set up",
  inProgress: "Setting up…",
  restartRequired: "Restart required",
  readyForTarget: "Ready",
  stopped: "Stopped",
};

function ComputerUseSection({ run }: { run: Run }) {
  const [state, setState] = useState<MuseComputerUseState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blockApp, setBlockApp] = useState("");

  const act = useCallback(async (key: string, request: MuseSettingsRequest & {
    kind: "computerUse" | "computerUseUpdate" | "computerUseSetupStart" | "computerUseSetupCheck";
  }) => {
    setBusy(key);
    setError(null);
    try {
      setState(await run(request) as MuseComputerUseState);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [run]);

  useEffect(() => {
    void act("read", { kind: "computerUse" });
  }, [act]);

  // Re-read only while Muse says setup is running; it settles on its own.
  const inProgress = state?.available === true && state.setup?.setup === "inProgress";
  useEffect(() => {
    if (!inProgress) return undefined;
    let stopped = false;
    const timer = window.setInterval(() => {
      void run({ kind: "computerUse" })
        .then((next) => { if (!stopped) setState(next); })
        .catch(() => undefined);
    }, SETUP_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [inProgress, run]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="Computer use" onRefresh={() => void act("read", { kind: "computerUse" })} busy={busy === "read"} />
      <div style={TEXT_MUTED}>Muse's own computer-use setup on this machine: its macOS permissions and what it may control.</div>
      {state == null && !error ? <div style={TEXT_MUTED}>Loading…</div> : null}
      {state && !state.available ? (
        <div style={TEXT_MUTED}>
          Muse does not offer computer use on this machine yet. Muse said: <span style={{ fontFamily: MONO_FONT }}>{state.reason}</span>
        </div>
      ) : null}
      {state?.available ? (
        <>
          {state.setup ? (
            <>
              <div style={ROW}>
                <span>Setup</span>
                <span style={{ color: COLORS.textMuted }}>{SETUP_LABEL[state.setup.setup] ?? state.setup.setup}</span>
              </div>
              {(["accessibility", "screenRecording", "inputMonitoring"] as const).map((key) => (
                <div key={key} style={ROW}>
                  <span>{PERMISSION_LABEL[key]}</span>
                  <span style={{ color: state.setup?.[key] === "granted" ? COLORS.success : COLORS.textMuted }}>{state.setup?.[key]}</span>
                </div>
              ))}
              {state.setup.message ? <div style={TEXT_MUTED}>{state.setup.message}</div> : null}
              {state.setup.refused ? <div style={TEXT_ERROR}>Muse refused setup: {state.setup.refused}</div> : null}
            </>
          ) : null}
          {state.setupError ? <div style={TEXT_ERROR}>{state.setupError}</div> : null}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button
              type="button"
              style={primaryButton({ height: 26, padding: "0 10px", fontSize: 12 })}
              disabled={busy != null || inProgress}
              onClick={() => void act("start", { kind: "computerUseSetupStart" })}
            >
              {busy === "start" || inProgress ? "Setting up…" : state.setup?.setup === "readyForTarget" ? "Run setup again" : "Set up computer use"}
            </button>
            {state.hostSetup ? (
              <button type="button" style={SMALL_BUTTON} disabled={busy != null} onClick={() => void act("check", { kind: "computerUseSetupCheck" })}>
                {busy === "check" ? "Checking…" : "Check permissions"}
              </button>
            ) : null}
          </div>
          {state.settings ? (
            <>
              {(["computerControl", "screenshots"] as const).map((key) => (
                <div key={key} style={ROW}>
                  <span>{key === "computerControl" ? "Computer control" : "Screenshots"}</span>
                  <select
                    aria-label={key === "computerControl" ? "Computer control" : "Screenshots"}
                    value={state.settings?.[key] ?? "ask"}
                    disabled={busy != null}
                    onChange={(event) => void act(`set:${key}`, {
                      kind: "computerUseUpdate",
                      patch: { [key]: event.target.value as "ask" | "alwaysAllow" },
                    })}
                    style={{ ...FIELD, fontFamily: SANS_FONT }}
                  >
                    <option value="ask">Ask each time</option>
                    <option value="alwaysAllow">Always allow</option>
                  </select>
                </div>
              ))}
              <div style={{ ...SECTION_LABEL_STYLE, marginTop: 4 }}>Blocked apps</div>
              {state.settings.blockedApps.length === 0 ? <div style={TEXT_MUTED}>No apps blocked.</div> : null}
              {state.settings.blockedApps.map((app) => (
                <div key={app.bundleId} style={ROW}>
                  <span style={{ fontFamily: MONO_FONT, fontSize: 11, overflowWrap: "anywhere" }}>
                    {app.bundleId}{app.prefix ? "*" : ""}
                  </span>
                  {app.locked ? (
                    <span style={{ color: COLORS.textDim }}>built in</span>
                  ) : (
                    <button
                      type="button"
                      style={SMALL_BUTTON}
                      disabled={busy != null}
                      onClick={() => void act(`unblock:${app.bundleId}`, { kind: "computerUseUpdate", patch: { unblockApps: [app.bundleId] } })}
                    >
                      Unblock
                    </button>
                  )}
                </div>
              ))}
              <div style={{ display: "flex", gap: 6 }}>
                <input aria-label="App bundle id to block" value={blockApp} onChange={(event) => setBlockApp(event.target.value)} placeholder="com.example.App" style={{ ...FIELD, flex: "1 1 200px" }} />
                <button
                  type="button"
                  style={SMALL_BUTTON}
                  disabled={busy != null || !blockApp.trim()}
                  onClick={() => {
                    const bundleId = blockApp.trim();
                    setBlockApp("");
                    void act("block", { kind: "computerUseUpdate", patch: { blockApps: [bundleId] } });
                  }}
                >
                  Block app
                </button>
              </div>
            </>
          ) : null}
          {state.settingsError ? <div style={TEXT_ERROR}>{state.settingsError}</div> : null}
        </>
      ) : null}
      {error ? <div style={TEXT_ERROR}>{error}</div> : null}
    </section>
  );
}

// ── Feedback ───────────────────────────────────────────────────────────────

const FEEDBACK_OUTCOME: Record<string, string> = {
  uploaded: "Sent to Meta. Thanks.",
  recorded: "Recorded by Meta. Thanks.",
  acceptedWithoutReceipt: "Sent; Meta did not confirm receipt.",
  noCredential: "Not sent: Muse needs a Meta sign-in or API key to send feedback. It was saved locally.",
  authRejected: "Not sent: Meta rejected this machine's sign-in. It was saved locally.",
  rateLimited: "Not sent: too many reports right now. Try again later.",
  disabled: "Feedback is turned off for this Muse account. It was saved locally.",
  dark: "Feedback upload is off in this Muse build. It was saved locally.",
  failed: "Not sent. It was saved locally.",
};

function FeedbackSection({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const [classification, setClassification] = useState<MuseFeedbackClassification>("bug");
  const [note, setNote] = useState("");
  const [withFiles, setWithFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MuseFeedbackResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next = await run({ kind: "feedback", classification, note: note.trim(), withFiles });
      setResult(next);
      if (next.outcome === "uploaded" || next.outcome === "recorded" || next.outcome === "acceptedWithoutReceipt") {
        setNote("");
        setOpen(false);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }, [classification, note, run, withFiles]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="Feedback" />
      {open ? (
        <>
          <select aria-label="Feedback type" value={classification} onChange={(event) => setClassification(event.target.value as MuseFeedbackClassification)} style={{ ...FIELD, fontFamily: SANS_FONT, alignSelf: "flex-start" }}>
            <option value="bug">Bug</option>
            <option value="badResult">Bad result</option>
            <option value="goodResult">Good result</option>
            <option value="other">Other</option>
          </select>
          <textarea
            aria-label="Feedback for Meta"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
            placeholder="What happened? This goes to Meta, not to ADE."
            style={{ ...FIELD, fontFamily: SANS_FONT, resize: "vertical" }}
          />
          <label style={{ ...TEXT_MUTED, display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={withFiles} onChange={(event) => setWithFiles(event.target.checked)} />
            Include Muse's local logs
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              style={primaryButton({ height: 26, padding: "0 10px", fontSize: 12 })}
              disabled={busy || !note.trim()}
              onClick={() => void submit()}
            >
              {busy ? "Sending…" : "Send to Meta"}
            </button>
            <button type="button" style={SMALL_BUTTON} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <button type="button" style={{ ...outlineButton({ height: 26, padding: "0 10px", fontSize: 12 }), alignSelf: "flex-start" }} onClick={() => setOpen(true)}>
          Send feedback to Meta
        </button>
      )}
      {result ? (
        <div style={result.outcome === "uploaded" || result.outcome === "recorded" ? TEXT_MUTED : TEXT_ERROR}>
          {FEEDBACK_OUTCOME[result.outcome] ?? `Muse answered: ${result.outcome}.`}
          {result.cause ? ` ${result.cause}` : ""}
        </div>
      ) : null}
      {error ? <div style={TEXT_ERROR}>{error}</div> : null}
    </section>
  );
}

// ── Body ───────────────────────────────────────────────────────────────────

const DIVIDER: React.CSSProperties = { borderTop: `1px solid ${COLORS.border}`, margin: "4px 0" };

export function MuseBody({ ctx }: { ctx: ProvidersViewContext }) {
  const { pin } = useSettingsMachineScope();
  const connection = ctx.status?.providerConnections?.muse ?? null;
  const ready = Boolean(connection?.runtimeDetected);
  if (ctx.isInitialCheckInFlight) return <div style={TEXT_MUTED}>Checking Muse…</div>;
  if (!ready) {
    return (
      <div style={TEXT_MUTED}>
        Download Muse (left) to manage its plugins, skills, hooks, and computer use on this machine.
      </div>
    );
  }
  return <MuseSettingsPanels key={pin?.key ?? "local"} pin={pin} />;
}

function MuseSettingsPanels({ pin }: { pin: OpenProjectBinding | null }) {
  const { run } = useMuseSettingsHost(pin);
  const [snapshot, setSnapshot] = useState<MuseSettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setSnapshot(await run({ kind: "snapshot" }));
      setError(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={TEXT_MUTED}>
          Read from Muse on this machine{snapshot ? <> for <span style={{ fontFamily: MONO_FONT }}>{snapshot.workspaceRoot}</span></> : null}.
        </div>
        <button type="button" style={outlineButton({ height: 26, padding: "0 10px", fontSize: 12 })} disabled={loading} onClick={() => void reload()}>
          <ArrowsClockwise size={11} weight="bold" /> {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error ? <div style={TEXT_ERROR}>{error}</div> : null}
      {snapshot == null && !error ? <div style={TEXT_MUTED}>Starting Muse…</div> : null}
      {snapshot ? (
        <>
          <PluginsSection snapshot={snapshot} run={run} reload={reload} />
          <div style={DIVIDER} />
          <SkillsSection snapshot={snapshot} run={run} reload={reload} />
          <div style={DIVIDER} />
          <HooksSection snapshot={snapshot} />
        </>
      ) : null}
      <div style={DIVIDER} />
      <ComputerUseSection run={run} />
      <div style={DIVIDER} />
      <FeedbackSection run={run} />
    </div>
  );
}
