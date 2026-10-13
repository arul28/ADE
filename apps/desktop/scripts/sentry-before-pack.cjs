// electron-builder beforePack hook (package.json "build"). It lives here, not in
// the repo-root scripts/sentry/, because electron-builder refuses hook paths
// outside apps/desktop.
//
// Injects Sentry debug IDs into apps/desktop/dist and apps/ade-cli/dist before
// they are packed into app.asar and extraResources. A no-op unless
// ADE_BUILD_SOURCEMAPS=1, so local `npm run dist:*` builds are unchanged.

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const injectScript = path.resolve(__dirname, "..", "..", "..", "scripts", "sentry", "inject-debug-ids.mjs");
let injected = null;

module.exports = async function beforePack() {
  if (process.env.ADE_BUILD_SOURCEMAPS !== "1") return;
  // One electron-builder run packs each arch in turn; inject once.
  if (!injected) {
    injected = import(pathToFileURL(injectScript).href)
      .then((module) => module.injectDebugIds())
      .catch((error) => {
        console.log(`::warning::Sentry debug ID injection failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
  await injected;
};
