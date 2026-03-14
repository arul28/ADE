import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(appDir, "package.json");

const releaseTag = (process.env.ADE_RELEASE_TAG ?? process.env.GITHUB_REF_NAME ?? "").trim();
if (!releaseTag) {
  throw new Error("ADE_RELEASE_TAG or GITHUB_REF_NAME is required");
}

if (!releaseTag.startsWith("v") || releaseTag.length < 2) {
  throw new Error(`Release tag must look like v1.2.3, received: ${releaseTag}`);
}

const version = releaseTag.slice(1);
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) {
  throw new Error(`Release tag must contain a semver-compatible version, received: ${releaseTag}`);
}

const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
packageJson.version = version;

await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
process.stdout.write(`${packageJson.version}\n`);
