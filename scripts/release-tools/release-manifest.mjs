#!/usr/bin/env node
// Writes release-manifest.json, the asset every ADE release carries (stable
// and beta). A machine reads it before it installs a build, to learn whether
// that build can open the data it already has and speak its sync protocol.
// The contract is in docs/plans/beta-track.md.
//
//   node scripts/release-tools/release-manifest.mjs --tag v1.2.128-beta.3 \
//     --commit <40-char sha> --out release-manifest.json [--root <repo checkout>]
//
// The numbers are read from the source of the commit being released, not from
// a build: DB_COMPAT_LEVEL in apps/desktop/src/shared/releaseCompat.ts and
// SYNC_PROTOCOL_VERSION / SYNC_PROTOCOL_MIN_SUPPORTED in
// apps/ade-cli/src/services/sync/syncProtocol.ts. Each must be a plain integer
// literal declared exactly once; anything else fails the release, because a
// manifest with a guessed number would let a machine switch to a build that
// cannot read its database (T3 #26288).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trackOfTag } from "../beta/beta-lib.mjs";

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument ${arg}`);
    options[arg.slice(2)] = argv[++index];
  }
  return options;
}

/** The integer value of `export const NAME = <n>;`, which must appear exactly once. */
export function readIntegerConstant(source, name, file) {
  const pattern = new RegExp(`^export const ${name}(?:\\s*:\\s*[\\w.<>|\\s]+?)?\\s*=\\s*(\\d+)\\s*;`, "gm");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`${file}: expected exactly one "export const ${name} = <integer>;", found ${matches.length}.`);
  }
  const value = Number(matches[0][1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${file}: ${name} must be a positive integer.`);
  return value;
}

export function buildReleaseManifest({ root, tag, commit, publishedAt = new Date().toISOString() }) {
  const tagMatch = RELEASE_TAG.exec(tag ?? "");
  if (!tagMatch) throw new Error(`Release tag must look like v1.2.3 or v1.2.3-beta.4, got ${tag}.`);
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`Commit must be a 40-character lowercase sha, got ${commit}.`);
  const read = (relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) throw new Error(`${relative} is missing; cannot fill release-manifest.json.`);
    return [fs.readFileSync(file, "utf8"), relative];
  };
  const [compatSource, compatFile] = read("apps/desktop/src/shared/releaseCompat.ts");
  const [syncSource, syncFile] = read("apps/ade-cli/src/services/sync/syncProtocol.ts");
  const syncVersion = readIntegerConstant(syncSource, "SYNC_PROTOCOL_VERSION", syncFile);
  const minSupported = readIntegerConstant(syncSource, "SYNC_PROTOCOL_MIN_SUPPORTED", syncFile);
  if (minSupported > syncVersion) {
    throw new Error(`${syncFile}: SYNC_PROTOCOL_MIN_SUPPORTED (${minSupported}) is above SYNC_PROTOCOL_VERSION (${syncVersion}).`);
  }
  const version = tagMatch[1];
  return {
    schema: 1,
    version,
    tag,
    track: trackOfTag(version),
    commit,
    publishedAt,
    dbCompat: readIntegerConstant(compatSource, "DB_COMPAT_LEVEL", compatFile),
    syncProtocol: { version: syncVersion, minSupported },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  if (!options.out) throw new Error("--out is required.");
  const root = path.resolve(options.root ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const manifest = buildReleaseManifest({
    root,
    tag: options.tag,
    commit: String(options.commit ?? "").toLowerCase(),
    publishedAt: options["published-at"] || undefined,
  });
  fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest));
}
