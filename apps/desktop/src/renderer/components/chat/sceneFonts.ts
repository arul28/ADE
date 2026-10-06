import geistVariableUrl from "../../../../node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2?url";
import jetbrainsMonoUrl from "../../../../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";

/**
 * ADE's own fonts, for scene frames.
 *
 * A scene is another origin and its policy allows fonts from `data:` only, so
 * the frame cannot use the faces ADE's renderer loads; scenes fell back to a
 * system font and never looked like the reply around them. The two variable
 * faces ADE ships (Geist for text, JetBrains Mono for code) are fetched once
 * from the renderer's own bundle and inlined as data URLs. About 150 KB per
 * prepared document, read once per app session; every scene after the first
 * reuses the same string.
 *
 * A host where the fetch fails (a test, an odd bundle) gets the empty string,
 * and the scene uses the theme's system fallbacks — the same as before.
 */

const FONT_LOAD_TIMEOUT_MS = 1_500;

const FACES: Array<{ family: string; url: string }> = [
  { family: "Geist", url: geistVariableUrl },
  { family: "JetBrains Mono", url: jetbrainsMonoUrl },
];

let loaded: string | null = null;
let pending: Promise<string> | null = null;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function faceCss(face: { family: string; url: string }): Promise<string> {
  const response = await fetch(face.url);
  if (!response.ok) return "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  // woff2 magic. Anything else is not a font we bundled.
  if (bytes.length < 4 || bytes[0] !== 0x77 || bytes[1] !== 0x4f || bytes[2] !== 0x46 || bytes[3] !== 0x32) return "";
  return `@font-face { font-family: "${face.family}"; src: url(data:font/woff2;base64,${toBase64(bytes)}) format("woff2"); font-weight: 100 900; font-style: normal; font-display: block; }`;
}

/** The `@font-face` CSS, once it is known. Null until the first load finishes. */
export function sceneFontFaceCssNow(): string | null {
  return loaded;
}

/** Load the faces once; resolves "" when they cannot be had. Never rejects. */
export function loadSceneFontFaceCss(): Promise<string> {
  if (loaded !== null) return Promise.resolve(loaded);
  if (pending) return pending;
  const work = Promise.all(FACES.map((face) => faceCss(face).catch(() => "")))
    .then((rules) => rules.filter(Boolean).join("\n"));
  // A slow load that loses the race still lands for every scene after it.
  void work.then((css) => { if (css) loaded = css; });
  const timeout = new Promise<string>((resolve) => setTimeout(() => resolve(""), FONT_LOAD_TIMEOUT_MS));
  pending = Promise.race([work, timeout]).then((css) => {
    loaded = css;
    return css;
  });
  return pending;
}
