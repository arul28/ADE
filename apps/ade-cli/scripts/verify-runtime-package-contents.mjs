#!/usr/bin/env node
/**
 * Asserts one built `@ade-dev/runtime-*` package directory still packs every
 * file the runtime needs.
 *
 * `build-runtime-npm-packages.mjs` runs the same check as it writes each
 * package. This wrapper exists so the publish workflow can run it again as its
 * own step, between build and publish, against the directories that are about
 * to be published rather than against the ones the build believed it wrote.
 *
 * Usage: node apps/ade-cli/scripts/verify-runtime-package-contents.mjs <dir>...
 */

import { verifyPackedRuntimeFiles } from "./build-runtime-npm-packages.mjs";

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error("Usage: verify-runtime-package-contents.mjs <package-dir>...");
  process.exit(2);
}

let failed = false;
for (const dir of dirs) {
  try {
    const files = verifyPackedRuntimeFiles({ packageDir: dir });
    console.log(`[runtime-packages] ${dir}: ${files.length} bin/ and native/ files all packed`);
  } catch (error) {
    failed = true;
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  }
}
process.exit(failed ? 1 : 0);
