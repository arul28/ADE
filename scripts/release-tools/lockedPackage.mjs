// Downloads an npm tarball that a lockfile pins and puts its package in
// node_modules. Release jobs call it before any `npm ci`, so it imports Node
// built-ins and the dependency-free release-retry.mjs only.
//
// Callers: scripts/release-tools/install-locked-package.mjs (one package for a
// job that needs nothing else) and apps/desktop/scripts/
// install-cross-arch-packages.mjs (the other macOS architecture's platform
// packages).
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { retryTransient } from "../../apps/desktop/scripts/release-retry.mjs";

const execFileAsync = promisify(execFile);
const INTEGRITY_MISMATCH = "Integrity mismatch";

// Downloads `url` and returns its bytes when they match the lockfile's
// `integrity` ("<algorithm>-<base64 digest>", the check `npm ci` makes). A
// network failure or an HTTP error is retried; an integrity mismatch fails at
// once.
export async function fetchVerified(url, integrity, { attempts = 4 } = {}) {
  const [algorithm, expected] = integrity.split(/-(.*)/s);
  return retryTransient(
    `download of ${url}`,
    async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const body = Buffer.from(await response.arrayBuffer());
      const actual = crypto.createHash(algorithm).update(body).digest("base64");
      if (actual !== expected) {
        throw new Error(`${INTEGRITY_MISMATCH} for ${url} (expected ${integrity}, got ${algorithm}-${actual})`);
      }
      return body;
    },
    { attempts, delayMs: 5_000, isTransient: (text) => !text.includes(INTEGRITY_MISMATCH) },
  );
}

// Unpacks an npm tarball (its bytes) to `destination`, which it replaces. The
// tarball must hold exactly one top-level directory, normally "package/".
// With `expect`, the package.json in it must name that package and version.
export async function unpackLockedTarball(tarball, destination, { expect } = {}) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "ade-locked-package-"));
  try {
    const archive = path.join(scratch, "package.tgz");
    await fs.writeFile(archive, tarball);
    const unpacked = path.join(scratch, "unpacked");
    await fs.mkdir(unpacked);
    await execFileAsync("tar", ["-xzf", archive, "-C", unpacked]);
    const roots = await fs.readdir(unpacked);
    if (roots.length !== 1) throw new Error("the tarball does not hold exactly one top-level directory");
    const root = path.join(unpacked, roots[0]);
    if (expect) {
      const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
      if (manifest.name !== expect.name || manifest.version !== expect.version) {
        throw new Error(`the tarball holds ${manifest.name}@${manifest.version}, not ${expect.name}@${expect.version}`);
      }
    }
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(root, destination, { recursive: true, verbatimSymlinks: true });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
