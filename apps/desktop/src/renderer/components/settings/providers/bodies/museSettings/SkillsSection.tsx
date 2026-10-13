/** Muse's skills: turn each on, off, or only-when-typed, and import from Claude Code or Codex. */
import React, { useCallback, useMemo, useState } from "react";
import { COLORS, MONO_FONT, SANS_FONT, primaryButton } from "../../../../lanes/laneDesignTokens";
import { showToast } from "../../../../app/toast/toastStore";
import { useSettingsAction } from "../../../useSettingsAction";
import type {
  MuseSettingsSkill,
  MuseSettingsSnapshot,
  MuseSkillActivation,
  MuseSkillImportResult,
  MuseSkillImportSource,
  MuseSkillScope,
} from "../../../../../../shared/museSettings";
import type { MuseRun } from "./museSettingsShared";
import { ErrorNotice, FIELD, ROW, SMALL_BUTTON, SectionError, SectionHeader, TEXT_MUTED, isOneOf } from "./museSettingsShared";

const SKILL_ACTIVATIONS: readonly MuseSkillActivation[] = ["on", "userInvocableOnly", "off"];
const isSkillActivation = isOneOf<MuseSkillActivation>(SKILL_ACTIVATIONS);
const isSkillScope = isOneOf<MuseSkillScope>(["user", "project", "bundled", "plugin"]);
const IMPORT_SOURCE_LABEL: Record<MuseSkillImportSource, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const ACTIVATION_LABEL: Record<MuseSkillActivation, string> = {
  on: "On",
  userInvocableOnly: "Only when typed",
  off: "Off",
};

function skillScope(skill: MuseSettingsSkill): MuseSkillScope | null {
  return isSkillScope(skill.scope) ? skill.scope : null;
}

function describeImport(source: MuseSkillImportSource, result: MuseSkillImportResult): string {
  const who = IMPORT_SOURCE_LABEL[source];
  const parts = [
    `${result.installed.length} ${result.dryRun ? "to import" : "imported"}`,
    result.skipped.length ? `${result.skipped.length} already imported` : null,
    result.quarantined.length ? `${result.quarantined.length} quarantined` : null,
    result.failed.length ? `${result.failed.length} failed` : null,
  ].filter(Boolean);
  const names = result.installed.length ? `: ${result.installed.slice(0, 8).join(", ")}${result.installed.length > 8 ? ", …" : ""}` : "";
  return `${who} skills — ${parts.join(", ")}${names}.`;
}

type ImportPreview = { source: MuseSkillImportSource; text: string; count: number };

export function SkillsSection({ snapshot, run, reload }: { snapshot: MuseSettingsSnapshot; run: MuseRun; reload: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const action = useSettingsAction();
  const busy = action.busy;
  const skills = useMemo(() => (snapshot.skills.ok ? snapshot.skills.rows : []), [snapshot.skills]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter((skill) => skill.id.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q));
  }, [query, skills]);

  const setActivation = useCallback(async (skill: MuseSettingsSkill, activation: MuseSkillActivation) => {
    const scope = skillScope(skill);
    if (!scope) return;
    await action.run(skill.id, async () => {
      await run({ kind: "skillSetActivation", selector: skill.id, scope, activation });
      await reload();
    });
  }, [action.run, reload, run]);

  const previewImport = useCallback(async (source: MuseSkillImportSource) => {
    const result = await action.run(`import:${source}`, () => run({ kind: "skillImport", source, dryRun: true }));
    if (result) setPreview({ source, text: describeImport(source, result), count: result.installed.length });
  }, [action.run, run]);

  const confirmImport = useCallback(async () => {
    if (!preview) return;
    const { source } = preview;
    const message = await action.run(`import:${source}`, async () => {
      const result = await run({ kind: "skillImport", source, dryRun: false });
      setPreview(null);
      await reload();
      return describeImport(source, result);
    });
    if (message) showToast({ tone: "success", title: message });
  }, [action.run, preview, reload, run]);

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
            {busy === `import:${source}` && !preview ? "Checking…" : `Import from ${IMPORT_SOURCE_LABEL[source]}`}
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
      <SectionError id="muse-skills-error" section={snapshot.skills} />
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        {filtered.map((skill) => {
          const scope = skillScope(skill);
          const activation = isSkillActivation(skill.activation) ? skill.activation : null;
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
                onChange={(event) => {
                  const next = event.target.value;
                  if (isSkillActivation(next)) void setActivation(skill, next);
                }}
                style={{ ...FIELD, fontFamily: SANS_FONT, flexShrink: 0 }}
              >
                {activation ? null : <option value={skill.activation}>{skill.activation}</option>}
                {SKILL_ACTIVATIONS.map((value) => (
                  <option key={value} value={value}>{ACTIVATION_LABEL[value]}</option>
                ))}
              </select>
            </div>
          );
        })}
        {snapshot.skills.ok && filtered.length === 0 ? <div style={TEXT_MUTED}>No skills match.</div> : null}
      </div>
      <ErrorNotice id="muse-skills-action-error" message={action.error} />
    </section>
  );
}
