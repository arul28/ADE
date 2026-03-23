const fs = require("node:fs");
const path = require("node:path");

const EXECUTABLE_MASK = 0o111;
const NODE_PTY_HELPER_PATH_PATCHES = [
  {
    from: "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
    to: "helperPath = helperPath.replace(/app\\.asar(?!\\.unpacked)/, 'app.asar.unpacked');",
  },
  {
    from: "helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');",
    to: "helperPath = helperPath.replace(/node_modules\\.asar(?!\\.unpacked)/, 'node_modules.asar.unpacked');",
  },
];

function pathExists(targetPath) {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function listDirectories(rootPath) {
  if (!pathExists(rootPath)) return [];
  return fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(rootPath, entry.name));
}

function ensureExecutable(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) return false;
  const currentMode = stat.mode & 0o777;
  if ((currentMode & EXECUTABLE_MASK) === EXECUTABLE_MASK) {
    return false;
  }
  fs.chmodSync(filePath, currentMode | EXECUTABLE_MASK);
  return true;
}

function normalizeFileSet(filePaths, label) {
  const normalized = [];
  for (const filePath of filePaths) {
    if (!pathExists(filePath)) continue;
    if (ensureExecutable(filePath)) normalized.push(filePath);
  }
  return normalized.map((filePath) => ({ filePath, label }));
}

function collectDesktopRuntimeExecutableCandidates(rootPath) {
  const candidates = [];

  for (const prebuildDir of listDirectories(path.join(rootPath, "node_modules", "node-pty", "prebuilds"))) {
    candidates.push({
      filePath: path.join(prebuildDir, "spawn-helper"),
      label: "node-pty spawn helper",
    });
  }

  for (const packageDir of listDirectories(path.join(rootPath, "node_modules", "@openai"))) {
    if (!path.basename(packageDir).startsWith("codex-darwin-")) continue;
    for (const vendorDir of listDirectories(path.join(packageDir, "vendor"))) {
      candidates.push({
        filePath: path.join(vendorDir, "codex", "codex"),
        label: "Codex CLI binary",
      });
      candidates.push({
        filePath: path.join(vendorDir, "path", "rg"),
        label: "Codex ripgrep helper",
      });
    }
  }

  for (const vendorDir of listDirectories(path.join(rootPath, "node_modules", "@anthropic-ai", "claude-agent-sdk", "vendor", "ripgrep"))) {
    candidates.push({
      filePath: path.join(vendorDir, "rg"),
      label: "Claude ripgrep helper",
    });
  }

  return candidates;
}

function normalizeDesktopRuntimeBinaries(rootPath) {
  const normalized = [];
  for (const candidate of collectDesktopRuntimeExecutableCandidates(rootPath)) {
    if (!pathExists(candidate.filePath)) continue;
    if (ensureExecutable(candidate.filePath)) {
      normalized.push(candidate);
    }
  }

  const helperPathFiles = [
    path.join(rootPath, "node_modules", "node-pty", "lib", "unixTerminal.js"),
    path.join(rootPath, "node_modules", "node-pty", "src", "unixTerminal.ts"),
  ];

  for (const filePath of helperPathFiles) {
    if (!pathExists(filePath)) continue;
    const original = fs.readFileSync(filePath, "utf8");
    let updated = original;
    for (const patch of NODE_PTY_HELPER_PATH_PATCHES) {
      updated = updated.replace(patch.from, patch.to);
    }
    if (updated === original) continue;
    fs.writeFileSync(filePath, updated, "utf8");
    normalized.push({
      filePath,
      label: "node-pty helper path patch",
    });
  }

  return normalized;
}

function resolvePackagedRuntimeRoot(appBundlePath) {
  return path.join(appBundlePath, "Contents", "Resources", "app.asar.unpacked");
}

module.exports = {
  normalizeDesktopRuntimeBinaries,
  resolvePackagedRuntimeRoot,
};
