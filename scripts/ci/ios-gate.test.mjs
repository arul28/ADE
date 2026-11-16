import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// `ios-gate.sh --fingerprint` decides whether a pull request reuses an earlier
// test-ios pass. A change that can affect the iOS build must change the hash
// (or a broken app merges green); a change that cannot must keep it (or the
// reuse never happens).

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ios-gate.sh");

const BASE_FILES = {
  ".github/workflows/ci.yml": "name: CI\njobs:\n  ios-gate:\n    runs-on: ubuntu-latest\n",
  "apps/ios/ADE/App.swift": "struct App {}\n",
  "apps/ios/ADE/Café.swift": "struct Cafe {}\n",
  "apps/desktop/src/shared/attention/board.cases.json": "[]\n",
  "apps/desktop/src/main/service.ts": "export {};\n",
  "docs/logging.md": "# Logging\n",
};

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  });
}

function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

function fingerprint(cwd) {
  const out = execFileSync("bash", [GATE, "--fingerprint"], { cwd, encoding: "utf8" }).trim();
  assert.match(out, /^[0-9a-f]{64}$/);
  return out;
}

function baseRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ios-gate-"));
  git(root, "init", "-q");
  writeFiles(root, BASE_FILES);
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

const CASES = [
  { edit: "a docs file", files: { "docs/logging.md": "# Logging\nmore\n" }, changes: false },
  { edit: "a desktop file the Swift tests do not read", files: { "apps/desktop/src/main/service.ts": "export const x = 1;\n" }, changes: false },
  { edit: "an app source file", files: { "apps/ios/ADE/App.swift": "struct App { let x = 1 }\n" }, changes: true },
  { edit: "an app file whose name git would quote", files: { "apps/ios/ADE/Café.swift": "struct Cafe { let x = 1 }\n" }, changes: true },
  { edit: "a new app file", files: { "apps/ios/ADE/New.swift": "struct New {}\n" }, changes: true },
  { edit: "a shared case table the Swift tests read", files: { "apps/desktop/src/shared/attention/board.cases.json": "[1]\n" }, changes: true },
  { edit: "ci.yml outside the iOS jobs", files: { ".github/workflows/ci.yml": `${BASE_FILES[".github/workflows/ci.yml"]}  lint:\n    runs-on: ubuntu-latest\n` }, changes: true },
];

for (const { edit, files, changes } of CASES) {
  test(`fingerprint ${changes ? "changes" : "stays the same"} after ${edit}`, () => {
    const root = baseRepo();
    try {
      const before = fingerprint(root);
      writeFiles(root, files);
      git(root, "add", "-A");
      git(root, "commit", "-qm", "edit");
      const after = fingerprint(root);
      if (changes) assert.notEqual(after, before);
      else assert.equal(after, before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
