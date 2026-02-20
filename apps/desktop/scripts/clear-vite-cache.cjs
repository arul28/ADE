const fs = require("node:fs");
const path = require("node:path");

const cacheDir = path.join(__dirname, "..", "node_modules", ".vite");

try {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  process.stdout.write("[ade] cleared Vite optimize cache\n");
} catch (error) {
  process.stderr.write(
    `[ade] failed to clear Vite optimize cache: ${error instanceof Error ? error.message : String(error)}\n`
  );
}
