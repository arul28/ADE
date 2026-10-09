import { useEffect } from "react";
import { selectEffectiveThemeId, useAppStore } from "../../state/appStore";
import { resolveTheme, resolveThemeById } from "../../../shared/theme";
import { themeTintedByScene } from "../../scene/sceneTheme";
import { useSceneDocumentSync } from "../../scene/useScene";
import { applyAdeTheme } from "../../theme/applyTheme";
import { syncWindowsTitleBarOverlay } from "../../lib/windowControlsOverlay";

/**
 * Paints the theme and the scene onto <html> together, so neither can
 * overwrite the other: inline custom properties for a custom/imported theme
 * (built-in dark/light emit none and render as the stylesheet defines them),
 * `data-theme`/`data-theme-id`, and `data-scene`. With "match app colours"
 * on, a picture recolours the theme's accent and surfaces first. Isolated so a
 * scene load does not re-render the shell.
 *
 * Shared by the app shell and the hosted client's sign-in screen, which renders
 * before the app shell exists.
 */
export function ThemeDocumentSync() {
  const themeId = useAppStore(selectEffectiveThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const scene = useSceneDocumentSync();
  const tint = scene.kind === "image" && scene.matchTheme ? scene.palette : null;
  useEffect(() => {
    const theme = resolveThemeById(themeId, customThemes);
    const resolved = resolveTheme(tint ? themeTintedByScene(theme, tint) : theme);
    applyAdeTheme(resolved);
    // The Windows caption strip is painted by the OS from a colour ADE hands
    // it, so it does not inherit `data-theme` the way the header does.
    syncWindowsTitleBarOverlay({ theme: resolved.theme.baseMode });
  }, [themeId, customThemes, tint]);
  return null;
}
