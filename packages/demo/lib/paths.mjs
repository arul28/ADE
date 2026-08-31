/**
 * Where things are, for both the app and the test rig.
 *
 * These live in `lib/` rather than `e2e/` because the app needs them too, and
 * a reference app must never reach into a test folder to boot itself.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const demoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const repoRoot = path.resolve(demoRoot, "..", "..");

/** The built ADE CLI, which is also the runtime the SDK spawns. */
export const runtimeBinary = path.join(repoRoot, "apps", "ade-cli", "dist", "cli.cjs");
