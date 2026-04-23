import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(desktopRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

function fail(message) {
  console.error(`[validate-win-artifacts] ${message}`);
  process.exitCode = 1;
}

function requireFile(relativePath, label) {
  const absolutePath = path.join(desktopRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    fail(`Missing ${label}: ${absolutePath}`);
  }
}

function hasExtraResource(to) {
  return Array.isArray(pkg.build?.extraResources)
    && pkg.build.extraResources.some((entry) => entry && entry.to === to);
}

requireFile("scripts/ade-cli-windows-wrapper.cmd", "Windows ADE CLI wrapper");
requireFile("scripts/ade-cli-install-path.cmd", "Windows ADE CLI PATH installer");
requireFile("vendor/crsqlite/win32-x64/crsqlite.dll", "Windows cr-sqlite extension");

if (!hasExtraResource("ade-cli/bin/ade.cmd")) {
  fail("package.json build.extraResources must ship ade-cli/bin/ade.cmd");
}
if (!hasExtraResource("ade-cli/install-path.cmd")) {
  fail("package.json build.extraResources must ship ade-cli/install-path.cmd");
}
if (!Array.isArray(pkg.build?.win?.target) || pkg.build.win.target.length === 0) {
  fail("package.json build.win.target must define at least one Windows target");
}
if (typeof pkg.scripts?.["dist:win"] !== "string" || !/\s--x64(?:\s|$)/.test(pkg.scripts["dist:win"])) {
  fail("package.json scripts.dist:win must pass --x64 until a Windows ARM64 cr-sqlite binary is bundled");
}
if (!Array.isArray(pkg.build?.asarUnpack) || !pkg.build.asarUnpack.includes("vendor/crsqlite/**")) {
  fail("package.json build.asarUnpack must unpack vendor/crsqlite/**");
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

console.log("[validate-win-artifacts] Windows package inputs are present.");
