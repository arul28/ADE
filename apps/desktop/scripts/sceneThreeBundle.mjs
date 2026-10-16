/**
 * three.js for 3D scenes, as one classic script that sets `window.THREE`
 * (with `THREE.OrbitControls`). A scene frame allows inline script only and
 * three ships ESM only, so it is bundled once into a minified IIFE.
 *
 * One builder for both readers, so desktop and iOS inline byte-identical
 * code: the Vite plugin (`vite.sceneThree.ts`) ships it as a renderer asset,
 * and `generate-ios-scene-shell.mjs` writes it as an iOS app resource.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function bundleSceneThree() {
  const result = await build({
    stdin: {
      contents: [
        'import * as THREE from "three";',
        'import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";',
        "window.THREE = Object.assign({ OrbitControls }, THREE);",
      ].join("\n"),
      resolveDir: desktopRoot,
      loader: "js",
    },
    bundle: true,
    format: "iife",
    minify: true,
    write: false,
    // Electron's Chromium, and the WKWebView the iOS app renders scenes in.
    target: ["chrome120", "safari16"],
    legalComments: "eof",
    logLevel: "silent",
  });
  const code = result.outputFiles[0]?.text ?? "";
  // Inlined into a <script> element, so a literal `</script` must not end it
  // early. `<\/` means the same thing in a JS string, template or regex.
  return code.replace(/<\/(script)/gi, "<\\/$1");
}
