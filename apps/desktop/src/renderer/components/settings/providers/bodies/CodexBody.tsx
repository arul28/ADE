/**
 * Codex settings extras: installed plugins from a live app-server runtime.
 * List-only — no marketplace, install, or toggle. Codex 0.153.4 `plugin/list`.
 */
import React, { useEffect, useState } from "react";
import { COLORS, SANS_FONT, SECTION_LABEL_STYLE } from "../../../lanes/laneDesignTokens";
import type { AgentChatCodexPlugin } from "../../../../../shared/types";
import type { ProvidersViewContext } from "../types";

function originLabel(origin: AgentChatCodexPlugin["origin"]): string {
  switch (origin) {
    case "bundled":
      return "bundled";
    case "local":
      return "local";
    case "remote":
      return "installed remote";
    default: {
      const _exhaustive: never = origin;
      return _exhaustive;
    }
  }
}

export function CodexBody(_props: { ctx: ProvidersViewContext }) {
  const [plugins, setPlugins] = useState<AgentChatCodexPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.ade.agentChat.listCodexPlugins({})
      .then((rows) => {
        if (!cancelled) setPlugins(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={SECTION_LABEL_STYLE}>Plugins</div>
      <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}>
        Installed Codex plugins from a live Codex chat. ADE lists them; it does not install or toggle them.
      </div>
      {error ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.danger }}>{error}</div>
      ) : plugins == null ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>Loading…</div>
      ) : plugins.length === 0 ? (
        <div style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted }}>
          Open a Codex chat to see installed plugins.
        </div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6 }}>
          {plugins.map((plugin) => (
            <li
              key={plugin.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                fontSize: 12,
                fontFamily: SANS_FONT,
                color: COLORS.textPrimary,
              }}
            >
              <span>{plugin.name}</span>
              <span style={{ color: COLORS.textMuted }}>
                {plugin.enabled ? "on" : "off"} · {originLabel(plugin.origin)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
