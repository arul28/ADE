import { useMemo } from "react";
import { resolveTheme, resolveThemeById, type ResolvedAdeTheme } from "../../shared/theme";
import { selectEffectiveThemeId, useAppStore } from "../state/appStore";

/** The theme the window is painted with right now, resolved. */
export function useActiveResolvedTheme(): ResolvedAdeTheme {
  const themeId = useAppStore(selectEffectiveThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  return useMemo(() => resolveTheme(resolveThemeById(themeId, customThemes)), [themeId, customThemes]);
}
