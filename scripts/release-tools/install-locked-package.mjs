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
// on any failure; the workflows then warn and fall back to that `npm ci`,
// which makes the same integrity check. The download, the integrity check and
// the unpacking are in ./lockedPackage.mjs.

import fs from "node:fs";
import path from "node:path";

import { fetchVerified, unpackLockedTarball } from "./lockedPackage.mjs";

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
if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) fail(`${name}@${version} has no sha512 integrity in ${lockfileArg}`);

const target = path.join(path.dirname(lockfile), "node_modules", ...name.split("/"));
try {
  const tarball = await fetchVerified(resolved, integrity, { attempts: 3 });
  await unpackLockedTarball(tarball, target, { expect: { name, version } });
} catch (error) {
  fail(`${resolved}: ${error instanceof Error ? error.message : error}`);
}
console.log(`[install-locked-package] ${name}@${version} from ${path.relative(process.cwd(), lockfile)}, integrity verified, in ${path.relative(process.cwd(), target)}`);
