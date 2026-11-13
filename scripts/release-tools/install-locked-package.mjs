#!/usr/bin/env node
// Installs one dependency-free npm package exactly as a lockfile pins it, for
// jobs that need that package and nothing else.
//
// The release publish job and the beta feed job need only `yaml` (for
// merge-mac-latest-yml.mjs and scripts/beta/feed.mjs), but a full desktop
// `npm ci` took about 106 s of each. This reads the version, tarball URL and
// integrity from the lockfile, downloads the tarball, refuses it unless its
// SHA-512 matches the lockfile's integrity (the check `npm ci` makes), and
// unpacks it into <lockfile dir>/node_modules/<name>, where both scripts
// already resolve it. The lockfile stays the one place the version is pinned.
//
//   node scripts/release-tools/install-locked-package.mjs <lockfile> <package>
//
// It refuses a package that has dependencies, install scripts or a non-https
// registry URL: a package like that needs a real `npm ci`. It exits non-zero
// on any failure; the workflows then fall back to that `npm ci`, which makes
// the same integrity check.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALLOWED_HOST = "registry.npmjs.org";

function fail(message) {
  console.error(`[install-locked-package] ${message}`);
  process.exit(1);
}

const [lockfileArg, name] = process.argv.slice(2);
if (!lockfileArg || !name) fail("usage: install-locked-package.mjs <lockfile> <package>");
if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name)) fail(`refusing the package name ${JSON.stringify(name)}`);

const lockfile = path.resolve(lockfileArg);
const lock = JSON.parse(fs.readFileSync(lockfile, "utf8"));
const entry = lock.packages?.[`node_modules/${name}`];
if (!entry) fail(`${name} is not in ${lockfileArg}`);
const { version, resolved, integrity } = entry;
if (!version || !resolved || !integrity) fail(`${name} in ${lockfileArg} has no version, resolved URL or integrity`);
if (entry.dependencies && Object.keys(entry.dependencies).length > 0) {
  fail(`${name}@${version} has dependencies; install it with npm ci instead`);
}
if (entry.hasInstallScript) fail(`${name}@${version} has an install script; install it with npm ci instead`);

const url = new URL(resolved);
if (url.protocol !== "https:" || url.hostname !== ALLOWED_HOST) {
  fail(`${name}@${version} resolves to ${resolved}, not an https ${ALLOWED_HOST} tarball`);
}
const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
if (!match) fail(`${name}@${version} has no sha512 integrity in ${lockfileArg}`);

async function download() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
  fail(`downloading ${resolved} failed: ${lastError instanceof Error ? lastError.message : lastError}`);
}

const tarball = await download();
const actual = createHash("sha512").update(tarball).digest("base64");
if (actual !== match[1]) {
  fail(`${resolved} does not match the lockfile's integrity (expected sha512-${match[1]}, got sha512-${actual})`);
}

const target = path.join(path.dirname(lockfile), "node_modules", ...name.split("/"));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "install-locked-package-"));
try {
  const archive = path.join(scratch, "package.tgz");
  fs.writeFileSync(archive, tarball);
  const unpacked = path.join(scratch, "unpacked");
  fs.mkdirSync(unpacked);
  // npm tarballs hold one top-level directory, normally "package/".
  const untar = spawnSync("tar", ["-xzf", archive, "-C", unpacked], { stdio: "inherit" });
  if (untar.status !== 0) fail(`unpacking ${resolved} failed`);
  const roots = fs.readdirSync(unpacked);
  if (roots.length !== 1) fail(`${resolved} does not hold exactly one top-level directory`);
  const root = path.join(unpacked, roots[0]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest.name !== name || manifest.version !== version) {
    fail(`${resolved} holds ${manifest.name}@${manifest.version}, not ${name}@${version}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(root, target, { recursive: true });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(`[install-locked-package] ${name}@${version} from ${path.relative(process.cwd(), lockfile)}, integrity verified, in ${path.relative(process.cwd(), target)}`);
