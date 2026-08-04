// Post-packaging CI gate. Runs after electron-builder and before any upload or
// publish step, on macOS and Windows alike, so an oversized artifact never
// reaches a release draft.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import artifactSizeBudget from "./artifact-size-budget.cjs";

const {
  budgetForArtifact,
  findArtifactSizeViolations,
  formatArtifactSizeViolations,
  formatBytes,
} = artifactSizeBudget;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");

function parseReleaseDir() {
  const flag = process.argv.slice(2).find((arg) => arg.startsWith("--release-dir="));
  const value = flag ? flag.slice("--release-dir=".length) : "release";
  return path.resolve(desktopRoot, value);
}

function main() {
  const releaseDir = parseReleaseDir();
  let entries;
  try {
    entries = fs.readdirSync(releaseDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `[artifact-size] Unable to read release output ${releaseDir}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const artifacts = entries
    .filter((entry) => entry.isFile() && budgetForArtifact(entry.name))
    .map((entry) => ({
      name: entry.name,
      size: fs.statSync(path.join(releaseDir, entry.name)).size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (artifacts.length === 0) {
    throw new Error(`[artifact-size] No size-budgeted release artifacts found in ${releaseDir}.`);
  }

  for (const artifact of artifacts) {
    const budget = budgetForArtifact(artifact.name);
    console.log(
      `[artifact-size] ${artifact.name}: ${formatBytes(artifact.size)} `
      + `(${budget.label} budget ${formatBytes(budget.maxBytes)})`,
    );
  }

  const violations = findArtifactSizeViolations(artifacts);
  if (violations.length > 0) {
    throw new Error(
      `[artifact-size] Release artifacts exceed their size budget:\n${formatArtifactSizeViolations(violations)}`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
