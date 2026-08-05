// Single source of truth for which ADE runtime sidecars a build is allowed to
// contain. Every packaging stage reads this: materialization, the pre-build CI
// gate, the pre-package validator, and the afterPack assertion. CommonJS so the
// electron-builder afterPack hook can require it directly.

const fs = require("node:fs");
const path = require("node:path");

const RUNTIME_TARGETS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];

// Set by each release packaging job to the one target it builds for. When it is
// present every stage below narrows to that target and treats any other
// target's sidecar as a hard failure, so a re-widened artifact download cannot
// silently ship a foreign-platform payload again.
const RUNTIME_TARGET_ENV = "ADE_RUNTIME_TARGET";
const ALLOW_HOST_ONLY_ENV = "ADE_RUNTIME_RESOURCES_ALLOW_HOST_ONLY";

function artifactNamesForTarget(target) {
  return [target === "win32-x64" ? `ade-${target}.exe` : `ade-${target}`, `ade-${target}.native.tar.gz`];
}

function runtimeBinaryNameForTarget(target) {
  return artifactNamesForTarget(target)[0];
}

function isRuntimeArtifactName(name) {
  return RUNTIME_TARGETS.some((target) => artifactNamesForTarget(target).includes(name));
}

function isRuntimeBinaryName(name) {
  return RUNTIME_TARGETS.some((target) => runtimeBinaryNameForTarget(target) === name);
}

function hostRuntimeTarget() {
  const platform = process.platform === "darwin"
    ? "darwin"
    : process.platform === "linux"
      ? "linux"
      : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${platform}-${arch}`;
}

function normalizeRuntimeTarget(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (!RUNTIME_TARGETS.includes(normalized)) {
    throw new Error(
      `[runtime-resources] ${RUNTIME_TARGET_ENV}="${normalized}" is not a known runtime target. `
      + `Expected one of: ${RUNTIME_TARGETS.join(", ")}.`,
    );
  }
  return normalized;
}

/**
 * Resolve the exact runtime target set this build must contain.
 *
 * - `target`: a packaging job pinned to one target. Nothing else may be present.
 * - `host-only`: local channel packaging, which builds only the host sidecar.
 * - `full`: the historical local behavior that stages every target.
 */
function resolveRuntimeTargets(env = process.env) {
  const explicitTarget = normalizeRuntimeTarget(env[RUNTIME_TARGET_ENV]);
  if (explicitTarget) {
    return { mode: "target", targets: [explicitTarget], exclusive: true };
  }
  if (env[ALLOW_HOST_ONLY_ENV] === "1") {
    const host = hostRuntimeTarget();
    return { mode: "host-only", targets: RUNTIME_TARGETS.includes(host) ? [host] : [], exclusive: false };
  }
  return { mode: "full", targets: [...RUNTIME_TARGETS], exclusive: false };
}

function expectedArtifactNames(targets) {
  return targets.flatMap((target) => artifactNamesForTarget(target));
}

function listRuntimeArtifactNames(runtimeDir) {
  let entries;
  try {
    entries = fs.readdirSync(runtimeDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && isRuntimeArtifactName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Compare a runtime directory against an expected target set. `unexpected` only
 * ever lists recognized runtime artifacts, so unrelated scratch files (the
 * `.sea` staging dir, extracted `.native` trees) are not mistaken for leakage.
 */
function diffRuntimeArtifacts(runtimeDir, targets) {
  const expected = expectedArtifactNames(targets);
  const actual = listRuntimeArtifactNames(runtimeDir);
  return {
    expected,
    actual,
    missing: expected.filter((name) => !actual.includes(name)),
    unexpected: actual.filter((name) => !expected.includes(name)),
  };
}

function formatRuntimeArtifactDiff(runtimeDir, targets, diff) {
  const lines = [
    `Runtime resources in ${runtimeDir} do not match target set [${targets.join(", ")}].`,
  ];
  if (diff.missing.length > 0) lines.push(`  Missing: ${diff.missing.join(", ")}`);
  if (diff.unexpected.length > 0) lines.push(`  Unexpected: ${diff.unexpected.join(", ")}`);
  return lines.join("\n");
}

module.exports = {
  ALLOW_HOST_ONLY_ENV,
  RUNTIME_TARGETS,
  RUNTIME_TARGET_ENV,
  artifactNamesForTarget,
  diffRuntimeArtifacts,
  expectedArtifactNames,
  formatRuntimeArtifactDiff,
  hostRuntimeTarget,
  isRuntimeArtifactName,
  isRuntimeBinaryName,
  listRuntimeArtifactNames,
  normalizeRuntimeTarget,
  resolveRuntimeTargets,
  runtimeBinaryNameForTarget,
};
