import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
import { useChatConfigToggle } from "./useChatConfigToggle";
import "./ChatSection.css";

/** A picture of the dock: where mods draw, on top of the prompt box. Not live data. */
function ClaudeModsArt() {
  return (
    <div className="ade-cs-mods-art" aria-hidden>
      <div className="ade-cs-mods-dock">
        <div className="ade-cs-mods-head">
          <span className="kit-eyebrow">Mods</span>
          <span className="ade-cs-mods-line" style={{ width: "22%" }} />
        </div>
        <div className="ade-cs-mods-band">
          <div className="ade-cs-mods-row">
            <span className="ade-cs-mods-line" style={{ width: "8%" }} />
            <span className="ade-cs-mods-meter"><i style={{ width: "34%" }} /></span>
            <span className="ade-cs-mods-line" style={{ width: "14%" }} />
            <span className="ade-cs-mods-meter"><i style={{ width: "15%" }} /></span>
          </div>
          <div className="ade-cs-mods-stack">
            <i style={{ width: "9%" }} />
            <i style={{ width: "5%" }} />
            <i style={{ width: "3%" }} />
          </div>
          <div className="ade-cs-mods-row">
            <span className="ade-cs-mods-line" style={{ width: "26%" }} />
            <span className="ade-cs-mods-line" style={{ width: "20%" }} />
            <span className="ade-cs-mods-line" style={{ width: "16%" }} />
          </div>
        </div>
      </div>
      <div className="ade-cs-mods-prompt">
        <span className="ade-cs-mods-line" style={{ width: "30%" }} />
      </div>
    </div>
  );
}

/**
 * Whether ADE chat draws what Claude Code mods show. The mods' hooks run
 * either way; this only controls the drawing.
 */
export function ClaudeModsSection() {
  const { onWeb, status, saving, enabled, save } = useChatConfigToggle("claudePluginUiEnabled");
  // The hosted client draws no mod UI.
  if (onWeb) return null;

  return (
    <ModernSection group="Claude mods" title="Claude mods" hint="Claude Code plugins that draw in the chat.">
      <ModernRows>
        <ModernRow
          anchor="claude-mods"
          title="Show what Claude mods draw"
          hint={status === "loading"
            ? "Loading…"
            : status === "failed"
              ? "Couldn't load the configuration. The switch stays off until it loads."
              : "What your Claude Code mods draw, on top of the prompt box. Early access in Claude Code, so it can change."}
          control={(
            <SettingsToggle
              label="Show what Claude mods draw"
              checked={enabled}
              disabled={status !== "loaded" || saving}
              onChange={(value) => void save(value)}
            />
          )}
        />
      </ModernRows>
      {enabled ? <ClaudeModsArt /> : null}
    </ModernSection>
  );
}
