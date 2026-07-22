import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  PRE_SIGNED_RUNTIME_ARCHIVES_ENV,
  nativeArchiveAction,
  nativeArchiveNotarizeArgs,
} from "./mac-runtime-archive-mode.mjs";

test("uses verification, never re-signing, for explicitly pre-signed runtime archives", () => {
  const binaryPath = "/tmp/ade-darwin-arm64";
  assert.equal(nativeArchiveAction({ [PRE_SIGNED_RUNTIME_ARCHIVES_ENV]: "1" }), "verify");
  assert.deepEqual(nativeArchiveNotarizeArgs(binaryPath, "verify"), [
    `--binary=${binaryPath}`,
    "--verify-native-only",
  ]);
});

test("retains signing for local runtime archives", () => {
  const binaryPath = "/tmp/ade-darwin-x64";
  assert.equal(nativeArchiveAction({}), "sign");
  assert.deepEqual(nativeArchiveNotarizeArgs(binaryPath, "sign"), [
    `--binary=${binaryPath}`,
    "--sign-native-only",
  ]);
});

test("release mac packaging explicitly marks downloaded matrix artifacts as pre-signed", async () => {
  const workflowPath = path.resolve(import.meta.dirname, "../../../.github/workflows/release-core.yml");
  const workflow = await fs.readFile(workflowPath, "utf8");
  assert.match(
    workflow,
    /Build signed \$\{\{ matrix\.arch \}\} macOS release[\s\S]*?ADE_RUNTIME_ARCHIVES_PRE_SIGNED: "1"[\s\S]*?npm run dist:mac:\$\{\{ matrix\.arch \}\}:signed/,
  );
});
