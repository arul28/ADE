import { useCallback, useEffect, useState } from "react";
import { isWebClientMode } from "../../lib/webClientMode";
import { showToast } from "../app/toast/toastStore";
import { ModernRow, ModernRows, ModernSection, SettingsToggle } from "./primitives";
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
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.ade.projectConfig.get()
      .then((snapshot) => {
        if (cancelled) return;
        setEnabled(snapshot.effective.ai?.chat?.claudePluginUiEnabled === true);
        setLoaded(true);
      })
      .catch(() => {
        // The toggle stays off-limits until the configuration loads.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Saves optimistically; a failed save puts the toggle back and says so. */
  const save = useCallback(async (value: boolean) => {
    if (saving) return;
    setSaving(true);
    setEnabled(value);
    try {
      await window.ade.ai.updateConfig({ chat: { claudePluginUiEnabled: value } });
    } catch (error) {
      setEnabled(!value);
      showToast({
        title: "Couldn't save the setting",
        message: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setSaving(false);
    }
  }, [saving]);

  // The setting is the host's project configuration, and the hosted client draws no mod UI.
  if (isWebClientMode()) return null;

  return (
    <ModernSection group="Claude mods" title="Claude mods" hint="Claude Code plugins that draw in the chat.">
      <ModernRows>
        <ModernRow
          anchor="claude-mods"
          title="Show what Claude mods draw"
          hint={loaded
            ? "What your Claude Code mods draw, on top of the prompt box. Early access in Claude Code, so it can change."
            : "Loading…"}
          control={(
            <SettingsToggle
              label="Show what Claude mods draw"
              checked={enabled}
              disabled={!loaded || saving}
              onChange={(value) => void save(value)}
            />
          )}
        />
      </ModernRows>
      {enabled ? <ClaudeModsArt /> : null}
    </ModernSection>
  );
}
