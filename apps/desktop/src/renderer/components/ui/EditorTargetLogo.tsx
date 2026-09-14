import antigravityLogoSrc from "@lobehub/icons-static-svg/icons/antigravity-color.svg";
import cursorLogoSrc from "@lobehub/icons-static-svg/icons/cursor.svg";
import traeLogoSrc from "@lobehub/icons-static-svg/icons/trae.svg";
import windsurfLogoSrc from "@lobehub/icons-static-svg/icons/windsurf.svg";
import type { EditorTarget } from "../../../shared/editorTargets";
import androidStudioLogoSrc from "../../assets/editor-logos/android-studio.svg";
import zedLogoSrc from "../../assets/editor-logos/zed.svg";
import vscodeLogoSrc from "../../assets/editor-logos/vscode.svg";
import vscodiumLogoSrc from "../../assets/editor-logos/vscodium.svg";
import kiroLogoSrc from "../../assets/editor-logos/kiro.svg";
import fleetLogoSrc from "../../assets/editor-logos/fleet.svg";
import intellijIdeaLogoSrc from "../../assets/editor-logos/intellij-idea.svg";
import sublimeLogoSrc from "../../assets/editor-logos/sublime-text.svg";
import webstormLogoSrc from "../../assets/editor-logos/webstorm.svg";
import xcodeLogoSrc from "../../assets/editor-logos/xcode.svg";
const EDITOR_LOGO_SRC: Record<EditorTarget, string> = {
  vscode: vscodeLogoSrc,
  "vscode-insiders": vscodeLogoSrc,
  vscodium: vscodiumLogoSrc,
  cursor: cursorLogoSrc,
  zed: zedLogoSrc,
  zeditor: zedLogoSrc,
  windsurf: windsurfLogoSrc,
  trae: traeLogoSrc,
  kiro: kiroLogoSrc,
  antigravity: antigravityLogoSrc,
  "sublime-text": sublimeLogoSrc,
  fleet: fleetLogoSrc,
  "intellij-idea": intellijIdeaLogoSrc,
  webstorm: webstormLogoSrc,
  "android-studio": androidStudioLogoSrc,
  xcode: xcodeLogoSrc,
};

function StaticEditorLogo({
  src,
  size,
  invertInDarkTheme,
}: {
  src: string;
  size: number;
  invertInDarkTheme?: boolean;
}) {
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={`shrink-0 object-contain${invertInDarkTheme ? " editor-target-logo--invert-in-dark" : ""}`}
    />
  );
}

export function EditorTargetLogo({
  target,
  size = 16,
}: {
  target: EditorTarget;
  size?: number;
}) {
  const src = EDITOR_LOGO_SRC[target];
  return (
    <span
      aria-hidden
      data-editor-logo={target}
      data-testid={`editor-logo-${target}`}
      className="inline-flex shrink-0 items-center justify-center"
    >
      <StaticEditorLogo
        src={src}
        size={size}
        invertInDarkTheme={
          target === "cursor" || target === "windsurf" || target === "trae"
        }
      />
    </span>
  );
}
