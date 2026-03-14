import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(appDir, "package.json");

const buildNumberRaw = process.env.ADE_BUILD_NUMBER ?? process.env.GITHUB_RUN_NUMBER;
if (!buildNumberRaw) {
  throw new Error("ADE_BUILD_NUMBER or GITHUB_RUN_NUMBER is required");
}

const buildNumber = Number.parseInt(buildNumberRaw, 10);
if (!Number.isFinite(buildNumber) || buildNumber <= 0) {
  throw new Error(`Invalid build number: ${buildNumberRaw}`);
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const [major = "1", minor = "0"] = String(packageJson.version ?? "1.0.0").split(".");
packageJson.version = `${major}.${minor}.${buildNumber}`;

await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
process.stdout.write(`${packageJson.version}\n`);

