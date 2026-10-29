#!/usr/bin/env node
// Builds the three beta-feed assets from a published beta release.
//
//   node scripts/beta/feed.mjs --tag v1.2.128-beta.3 --in <dir> --out <dir> \
//     --assets <file with one asset name per line> [--repo arul28/ADE]
//
// <dir> holds what was downloaded from the versioned release: latest-mac.yml,
// latest.yml when Windows was published, and release-manifest.json. <out>
// receives latest-mac.yml / latest.yml with every url and path made absolute
// to https://github.com/<repo>/releases/download/<tag>/ (sha512, size and the
// rest kept as they are), and beta.json, a copy of the release's manifest.
//
// Fails, and so leaves the feed on the previous beta, when a manifest names a
// different version, references a file the release does not carry, or the
// release manifest is not this beta's.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { absolutizeUpdateInfo, isBetaTag } from "./beta-lib.mjs";

// The yaml package comes from apps/desktop's install, the same one
// merge-mac-latest-yml.mjs uses; the workflow runs npm ci --ignore-scripts there.
const desktopRequire = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "desktop", "package.json"),
);
const { parse, stringify } = desktopRequire("yaml");

function parseArgs(argv) {
  const options = { repo: process.env.GH_REPO || process.env.GITHUB_REPOSITORY || "arul28/ADE" };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, "");
    options[key] = argv[++index];
  }
  for (const required of ["tag", "in", "out", "assets"]) {
    if (!options[required]) throw new Error(`--${required} is required.`);
  }
  return options;
}

export function buildFeed({ tag, repo, inDir, outDir, assets }) {
  if (!isBetaTag(tag)) throw new Error(`${tag} is not a beta tag; only real betas reach the feed.`);
  const version = tag.slice(1);
  const assetNames = new Set(assets);
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];

  for (const name of ["latest-mac.yml", "latest.yml"]) {
    const source = path.join(inDir, name);
    if (!fs.existsSync(source)) {
      if (name === "latest-mac.yml") throw new Error(`${tag} has no latest-mac.yml.`);
      continue;
    }
    const doc = parse(fs.readFileSync(source, "utf8"));
    if (doc?.version !== version) throw new Error(`${name} is for ${doc?.version}, not ${version}.`);
    const { doc: rewritten, referenced } = absolutizeUpdateInfo(doc, { repo, tag });
    const missing = referenced.filter((file) => !assetNames.has(file));
    if (missing.length > 0) throw new Error(`${name} references files ${tag} does not carry: ${missing.join(", ")}`);
    fs.writeFileSync(path.join(outDir, name), stringify(rewritten));
    written.push(name);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(inDir, "release-manifest.json"), "utf8"));
  if (manifest.tag !== tag || manifest.version !== version || manifest.track !== "beta") {
    throw new Error(`release-manifest.json describes ${manifest.tag} (${manifest.track}), not beta ${tag}.`);
  }
  fs.writeFileSync(path.join(outDir, "beta.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  written.push("beta.json");
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const assets = fs.readFileSync(options.assets, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  const written = buildFeed({ tag: options.tag, repo: options.repo, inDir: options.in, outDir: options.out, assets });
  console.log(`[beta-feed] wrote ${written.join(", ")} for ${options.tag}`);
}
