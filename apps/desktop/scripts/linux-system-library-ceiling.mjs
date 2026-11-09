import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// What Ubuntu 22.04 and Debian 12 provide, the oldest systems ADE supports. A
// native binary linked against anything newer refuses to load there, and the
// build image rather than our code decides that, so only a check of the
// finished package catches it.
const CEILINGS = {
  GLIBC: [2, 35],
  GLIBCXX: [3, 4, 30],
  CXXABI: [1, 3, 13],
};

// Prebuilt by Cursor and used only by its provider's sandbox on arm64.
const THIRD_PARTY_EXCEPTIONS = ["@cursor/sdk-linux-arm64/bin/cursorsandbox"];

function isElf(file) {
  const handle = fs.openSync(file, "r");
  try {
    const magic = Buffer.alloc(4);
    fs.readSync(handle, magic, 0, 4, 0);
    return magic.toString("latin1") === "\x7fELF";
  } finally {
    fs.closeSync(handle);
  }
}

function isAbove(version, ceiling) {
  for (let index = 0; index < Math.max(version.length, ceiling.length); index += 1) {
    const difference = (version[index] ?? 0) - (ceiling[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function requirementsAboveCeiling(file) {
  const result = spawnSync("readelf", ["--version-info", "--wide", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`[validate-linux-artifacts] readelf failed on ${file}: ${result.error?.message || result.stderr}`);
  }
  const above = new Set();
  for (const [, library, version] of result.stdout.matchAll(/Name: (GLIBC|GLIBCXX|CXXABI)_(\d+(?:\.\d+)*)/g)) {
    if (isAbove(version.split(".").map(Number), CEILINGS[library])) above.add(`${library}_${version}`);
  }
  return [...above];
}

export function assertSystemLibraryCeiling(directories) {
  const violations = [];
  for (const directory of directories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      if (THIRD_PARTY_EXCEPTIONS.some((suffix) => file.endsWith(suffix)) || !isElf(file)) continue;
      const above = requirementsAboveCeiling(file);
      if (above.length > 0) violations.push(`${path.relative(directory, file)} needs ${above.join(", ")}`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`[validate-linux-artifacts] Native binaries need a newer system than ADE supports:\n  ${violations.join("\n  ")}`);
  }
}
