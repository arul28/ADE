import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CRSQLITE_REQUIRED_TARGETS,
  copyCrsqliteExtension,
  crsqliteExtensionFileName,
} from "./package-native-deps.mjs";

const vendorRoot = path.resolve(import.meta.dirname, "..", "..", "desktop", "vendor", "crsqlite");
const publishedTargets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];

test("every published runtime target is a required cr-sqlite sync peer", () => {
  for (const target of publishedTargets) {
    assert.equal(CRSQLITE_REQUIRED_TARGETS.has(target), true, target);
  }
});

test("maps each runtime target to the vendored cr-sqlite filename", () => {
  assert.equal(crsqliteExtensionFileName("darwin-arm64"), "crsqlite.dylib");
  assert.equal(crsqliteExtensionFileName("linux-x64"), "crsqlite.so");
  assert.equal(crsqliteExtensionFileName("linux-arm64"), "crsqlite.so");
  assert.equal(crsqliteExtensionFileName("win32-x64"), "crsqlite.dll");
});

test("vendors a cr-sqlite extension for every published runtime target", () => {
  for (const target of publishedTargets) {
    const fileName = crsqliteExtensionFileName(target);
    const source = path.join(vendorRoot, target, fileName);
    assert.equal(fs.existsSync(source), true, source);
    assert.ok(fs.statSync(source).size > 0, source);
  }
});

test("copyCrsqliteExtension fails closed when the vendor payload is missing", async (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-native-crsqlite-missing-"));
  t.after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));
  await assert.rejects(
    () => copyCrsqliteExtension(bundleRoot, "win32-arm64"),
    /no cr-sqlite extension vendored for required target win32-arm64/,
  );
});

test("copyCrsqliteExtension stages linux and windows payloads into the native bundle", async (t) => {
  const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-native-crsqlite-"));
  t.after(() => fs.rmSync(bundleRoot, { recursive: true, force: true }));

  for (const target of ["linux-x64", "linux-arm64", "win32-x64"]) {
    assert.equal(await copyCrsqliteExtension(bundleRoot, target), true, target);
    const destination = path.join(bundleRoot, "vendor", "crsqlite", target, crsqliteExtensionFileName(target));
    assert.equal(fs.existsSync(destination), true, destination);
    assert.equal(
      fs.statSync(destination).size,
      fs.statSync(path.join(vendorRoot, target, crsqliteExtensionFileName(target))).size,
      destination,
    );
  }
});
