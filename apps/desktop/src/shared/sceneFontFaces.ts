/**
 * ADE's own fonts inside scene frames, as one definition for both loaders: the
 * chat's (`renderer/.../sceneFonts.ts`, from the renderer bundle) and
 * `ade scene preview`'s (`main/.../scenePreviewRenderer.ts`, from the packaged
 * assets or the dev packages). A preview that loaded different faces would not
 * look like the chat it is checking.
 *
 * A frame may load fonts from `data:` only, so each face travels as a data URL.
 */

export type SceneFontFace = {
  family: string;
  /** Path under `node_modules` (dev runs and the renderer's `?url` import). */
  packageFile: string;
  /** The hashed copy's name in the packaged renderer's `assets/`. */
  assetPattern: RegExp;
};

export const SCENE_FONT_FACES: readonly SceneFontFace[] = [
  {
    family: "Geist",
    packageFile: "geist/dist/fonts/geist-sans/Geist-Variable.woff2",
    assetPattern: /^Geist-Variable.*\.woff2$/,
  },
  {
    family: "JetBrains Mono",
    packageFile: "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
    assetPattern: /^jetbrains-mono-latin-wght-normal.*\.woff2$/,
  },
];

/** The woff2 magic (`wOF2`). Anything else is not a font ADE bundled. */
export function isWoff2(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32;
}

/** One `@font-face` rule with the face inlined. Variable fonts: the full weight axis. */
export function sceneFontFaceRule(family: string, base64: string): string {
  return `@font-face { font-family: "${family}"; src: url(data:font/woff2;base64,${base64}) format("woff2"); font-weight: 100 900; font-style: normal; font-display: block; }`;
}
