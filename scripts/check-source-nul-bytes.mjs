/**
 * Source NUL-byte check.
 *
 * A literal NUL (0x00) in a source file is invisible in an editor and harmless
 * to the compiler, but it makes every byte-sniffing tool treat the file as
 * binary: git and GitHub stop showing its diffs, and agent `read` tools (the
 * OpenCode one, for example) refuse the file from that byte onwards. Write the
 * escape `\u0000` instead; the runtime value is identical.
 *
 * Usage:
 *   node scripts/check-source-nul-bytes.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".mdx", ".css", ".html", ".swift", ".py", ".sh",
  ".yml", ".yaml", ".toml", ".sql",
]);

/** Each NUL in `buffer` as a 1-based line and column. */
export function findNulBytes(buffer) {
  const hits = [];
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (byte === 0x0a) {
      line += 1;
      lineStart = index + 1;
    } else if (byte === 0x00) {
      hits.push({ line, column: index - lineStart + 1 });
    }
  }
  return hits;
}

export function checkFiles(repoRoot, files) {
  const violations = [];
  for (const file of files) {
    if (!SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(repoRoot, file));
    } catch {
      continue;
    }
    for (const hit of findNulBytes(buffer)) violations.push({ file, ...hit });
  }
  return violations;
}

function main() {
  const repoRoot = process.cwd();
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
  const violations = checkFiles(repoRoot, files);
  if (violations.length === 0) {
    console.log(`check-source-nul-bytes: ${files.length} tracked files, no NUL bytes in source.`);
    return;
  }
  for (const v of violations) {
    console.error(`${v.file}:${v.line}:${v.column}: literal NUL byte; write the escape \\u0000 instead.`);
  }
  console.error(`check-source-nul-bytes: ${violations.length} NUL byte(s) found.`);
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
