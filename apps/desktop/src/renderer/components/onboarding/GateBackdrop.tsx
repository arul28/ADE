import { useAppearanceStore } from "../../state/appearanceStore";
import { isWebClientMode } from "../../lib/webClientMode";
import { DEFAULT_SCENE_PREFERENCES, type ScenePreferences } from "../../scene/scenePreferences";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";

/**
 * ADE Web's first look for a visitor who never picked a scene: one shipped
 * picture, the same for everyone, instead of the web app's flat default. The
 * desktop keeps its own default (a shuffled picture).
 */
const WEB_SIGNED_OUT_SCENE: ScenePreferences = {
  ...DEFAULT_SCENE_PREFERENCES,
  mode: "image",
  imageId: "ade:mountain-vista",
};

/**
 * ADE's mesh, drawn as one window-sized field behind the glass card, with a
 * vignette that keeps the card's edges legible. Follows the theme and any
 * image scene on its own.
 */
export function GateBackdrop() {
  const theme = useAppearanceStore((s) => s.theme);
  return (
    <>
      <WorkToolPickerBackdrop
        theme={theme}
        field="window"
        untouchedScene={isWebClientMode() ? WEB_SIGNED_OUT_SCENE : undefined}
      />
      <div className="ade-gate-vignette" aria-hidden="true" />
    </>
  );
}
