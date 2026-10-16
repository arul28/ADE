import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * three.js for 3D scenes, as one classic script that sets `window.THREE`.
 *
 * A scene frame allows inline script only (`script-src 'unsafe-inline'`, no
 * fetch, no module imports from anywhere), and three ships ESM only, split
 * across files. So it is bundled here once into a minified IIFE and shipped as
 * ONE file, `assets/ade-scene-three.js`. Two readers share it:
 *
 * - the renderer, through `virtual:ade-scene-three` (that file's URL), fetches
 *   it the first time a scene that uses 3D comes on screen (`sceneThree.ts`)
 *   and inlines it into that scene's document only;
 * - `ade scene preview` in main reads the same file from the renderer's
 *   assets, or from this dev server in a dev run.
 *
 * OrbitControls rides along as `THREE.OrbitControls`: dragging a model round
 * is most of what makes a 3D view worth having. Loaders do not: a scene cannot
 * fetch, so there is nothing for them to load.
 */
export const SCENE_THREE_MODULE_ID = "virtual:ade-scene-three";
const RESOLVED_ID = `\0${SCENE_THREE_MODULE_ID}`;
/** Where the bundle lives: in the build output, and on the dev server. */
export const SCENE_THREE_ASSET = "assets/ade-scene-three.js";

async function bundleThree(): Promise<string> {
  const result = await build({
    stdin: {
      contents: [
        'import * as THREE from "three";',
        'import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";',
        "window.THREE = Object.assign({ OrbitControls }, THREE);",
      ].join("\n"),
      resolveDir: __dirname,
      loader: "js",
    },
    bundle: true,
    format: "iife",
    minify: true,
    write: false,
    target: "chrome120",
    legalComments: "eof",
    logLevel: "silent",
  });
  const code = result.outputFiles[0]?.text ?? "";
  // Inlined into a <script> element, so a literal `</script` must not end it
  // early. `<\/` means the same thing in a JS string, template or regex.
  return code.replace(/<\/(script)/gi, "<\\/$1");
}

export function sceneThreePlugin(): Plugin {
  let bundled: Promise<string> | null = null;
  const bundle = () => (bundled ??= bundleThree());
  let serving = false;
  return {
    name: "ade-scene-three",
    configResolved(config) {
      serving = config.command === "serve";
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? "").split("?")[0] !== `/${SCENE_THREE_ASSET}`) return next();
        bundle().then((code) => {
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.end(code);
        }, next);
      });
    },
    resolveId(id) {
      return id === SCENE_THREE_MODULE_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      if (serving) return `export default ${JSON.stringify(`/${SCENE_THREE_ASSET}`)};`;
      const ref = this.emitFile({ type: "asset", fileName: SCENE_THREE_ASSET, source: await bundle() });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
}
