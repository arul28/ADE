import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { crsqliteExtensionFileName, currentTarget } from "./package-native-deps.mjs";
import { expectedArchiveEntries, extractExtension, tarExtractArgs } from "./probe-runtime-crsqlite.mjs";

test("probe helper names the vendored cr-sqlite path inside a native archive", () => {
  assert.equal(crsqliteExtensionFileName("linux-x64"), "crsqlite.so");
  assert.deepEqual(expectedArchiveEntries("linux-arm64"), [
    "./vendor/crsqlite/linux-arm64/crsqlite.so",
    "vendor/crsqlite/linux-arm64/crsqlite.so",
  ]);
  assert.deepEqual(expectedArchiveEntries("darwin-x64"), [
    "./vendor/crsqlite/darwin-x64/crsqlite.dylib",
    "vendor/crsqlite/darwin-x64/crsqlite.dylib",
  ]);
  assert.deepEqual(expectedArchiveEntries("win32-x64"), [
    "./vendor/crsqlite/win32-x64/crsqlite.dll",
    "vendor/crsqlite/win32-x64/crsqlite.dll",
  ]);
});

test("tar extract args never pass -C so a Windows drive letter is not a remote host", () => {
  const archive = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ade-win32-x64.native.tar.gz";
  const entry = "./vendor/crsqlite/win32-x64/crsqlite.dll";
  assert.deepEqual(tarExtractArgs(archive, entry), ["-xzf", archive, entry]);
});

test("extractExtension unpacks an archive entry into cwd rather than tar -C", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ade-crsqlite-extract-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const payload = path.join(tmp, "payload");
  const relativeEntry = "vendor/crsqlite/win32-x64/crsqlite.dll";
  fs.mkdirSync(path.dirname(path.join(payload, relativeEntry)), { recursive: true });
  fs.writeFileSync(path.join(payload, relativeEntry), "dll-bytes");
  const archive = path.join(tmp, "ade-win32-x64.native.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", payload, relativeEntry], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(packed.status, 0, packed.stderr);
  const extracted = extractExtension(archive, relativeEntry);
  t.after(extracted.cleanup);
  assert.equal(fs.readFileSync(extracted.filePath, "utf8"), "dll-bytes");
});

test("probe helper can load the host's vendored cr-sqlite extension", (t) => {
  const target = currentTarget();
  let fileName;
  try {
    fileName = crsqliteExtensionFileName(target);
  } catch {
    t.skip(`no vendored cr-sqlite for host ${target}`);
    return;
  }
  const extension = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "desktop",
    "vendor",
    "crsqlite",
    target,
    fileName,
  );
  if (!fs.existsSync(extension)) {
    t.skip(`no vendored cr-sqlite at ${extension}`);
    return;
  }
  const result = spawnSync(process.execPath, [path.join(import.meta.dirname, "probe-runtime-crsqlite.mjs"), "--extension", extension], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /recorded 1 CRR change/);
});
