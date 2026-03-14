// Electron entrypoint for `electron .`
// We point Electron at the compiled main process output.
const path = require("node:path");

// When developing, `tsup --watch` writes to `dist/main/main.cjs`.
require(path.join(__dirname, "dist", "main", "main.cjs"));

