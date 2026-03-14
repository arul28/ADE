import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rebuild } from "@electron/rebuild";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(appDir, "package.json");

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const electronRange = packageJson.devDependencies?.electron;
const electronVersion = typeof electronRange === "string" ? electronRange.replace(/^[^\d]*/, "") : "";

if (!electronVersion) {
  throw new Error("Unable to determine Electron version from devDependencies.electron");
}

await rebuild({
  buildPath: appDir,
  electronVersion,
  force: true,
  onlyModules: ["node-pty", "onnxruntime-node"],
});

