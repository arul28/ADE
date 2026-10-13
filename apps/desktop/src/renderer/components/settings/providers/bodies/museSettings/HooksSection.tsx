/** The hooks Muse runs in this project. Read-only here. */
import React from "react";
import { COLORS, MONO_FONT } from "../../../../lanes/laneDesignTokens";
import type { MuseSettingsSnapshot } from "../../../../../../shared/museSettings";
import { ROW, SectionError, SectionHeader, TEXT_MUTED } from "./museSettingsShared";

export function HooksSection({ snapshot }: { snapshot: MuseSettingsSnapshot }) {
  const hooks = snapshot.hooks.ok ? snapshot.hooks.rows : [];
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionHeader title="Hooks" />
      <div style={TEXT_MUTED}>The hooks Muse runs in this project, from your settings, the project, and plugins. Read-only here.</div>
      <SectionError id="muse-hooks-error" section={snapshot.hooks} />
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
