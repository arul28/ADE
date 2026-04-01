// Electron entrypoint for `electron .`
// We point Electron at the compiled main process output.
const fs = require("node:fs");
const path = require("node:path");

// `tsup` writes `dist/main/main.cjs` (watch mode in dev, or one-shot after install/build).
const mainEntry = path.join(__dirname, "dist", "main", "main.cjs");
if (!fs.existsSync(mainEntry)) {
  console.error(
    "[ade] Missing main process bundle:\n" +
      `  ${mainEntry}\n` +
      "Run from apps/desktop: npm run dev  (or: npx tsup  /  npm run build)\n" +
      "After npm install, postinstall should run tsup once if this file was absent.",
  );
  process.exit(1);
}

require(mainEntry);

