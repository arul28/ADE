import fs from "node:fs";
import { parse, stringify } from "yaml";

/**
 * Merge per-arch `latest-mac.yml` files into one unified updater feed.
 *
 * ADE builds each macOS arch in a SEPARATE electron-builder invocation (a single
 * combined `--arm64 --x64` invocation races the two apps' code-signing and ships
 * one unsigned Electron Framework — see v1.2.5). Each invocation writes its own
 * `latest-mac.yml` listing only its arch's zip/dmg. electron-updater selects the
 * right file per arch from the `files:` array (MacUpdater filters by whether the
 * url contains "arm64"), so we merge both arches' `files:` into one feed.
 *
 * Usage: node merge-mac-latest-yml.mjs <in-arm64.yml> <in-x64.yml> <out.yml>
 */

const args = process.argv.slice(2);
const outPath = args.pop();
const inputPaths = args;
if (inputPaths.length < 2 || !outPath) {
  console.error("usage: merge-mac-latest-yml.mjs <in1.yml> <in2.yml> [...] <out.yml>");
  process.exit(1);
}

const docs = inputPaths.map((p) => {
  const parsed = parse(fs.readFileSync(p, "utf8"));
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`[merge-mac-yml] ${p} is not a valid latest-mac.yml`);
  }
  return parsed;
});

const version = docs[0].version;
for (const doc of docs) {
  if (doc.version !== version) {
    throw new Error(`[merge-mac-yml] version mismatch: ${doc.version} != ${version}`);
  }
}

// Union of files[] across inputs, deduped by url (preserve first-seen order).
const filesByUrl = new Map();
for (const doc of docs) {
  for (const file of doc.files ?? []) {
    if (file?.url && !filesByUrl.has(file.url)) filesByUrl.set(file.url, file);
  }
}
const files = [...filesByUrl.values()];

const zips = files.filter((file) => file.url.endsWith(".zip"));
const hasArm = zips.some((file) => file.url.includes("arm64"));
const hasIntel = zips.some((file) => !file.url.includes("arm64"));
if (!hasArm || !hasIntel) {
  throw new Error(
    `[merge-mac-yml] merged feed must contain both an arm64 and an intel zip; ` +
      `got: ${zips.map((file) => file.url).join(", ") || "none"}`,
  );
}

// Legacy top-level pointer (electron-updater uses files[] for mac arch matching,
// but keep a valid path/sha512 for older clients). Prefer the arm64 zip.
const primary = zips.find((file) => file.url.includes("arm64")) ?? zips[0];

const merged = {
  version,
  files,
  path: primary.url,
  sha512: primary.sha512,
  releaseDate: docs[0].releaseDate,
};

fs.writeFileSync(outPath, stringify(merged));
console.log(
  `[merge-mac-yml] wrote ${outPath} with ${files.length} files (zips: ${zips.map((f) => f.url).join(", ")})`,
);
