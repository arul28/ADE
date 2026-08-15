import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import {
  assertRuntimeEntitlements,
  buildRuntimeCodesignArgs,
  forbiddenRuntimeEntitlement,
  requiredRuntimeEntitlement,
  runtimeEntitlementsPath,
} from "./notarize-static-runtime.mjs";

test("signs the hardened macOS runtime with the least-privilege JIT entitlement", async () => {
  const entitlements = await fs.readFile(runtimeEntitlementsPath, "utf8");
  const args = buildRuntimeCodesignArgs("/tmp/ade-darwin-arm64", "Developer ID Application: ADE");

  assert.doesNotThrow(() => assertRuntimeEntitlements(entitlements, "/tmp/ade-darwin-arm64"));
  assert.equal(args[args.indexOf("--entitlements") + 1], runtimeEntitlementsPath);
  assert.deepEqual(args.slice(args.indexOf("--options"), args.indexOf("--options") + 2), ["--options", "runtime"]);
  assert.equal(entitlements.includes("com.apple.security.cs.allow-unsigned-executable-memory"), false);
});

test("rejects a signed runtime when the JIT entitlement is absent or disabled", () => {
  const missing = "<?xml version=\"1.0\"?><plist><dict></dict></plist>";
  const disabled = `<plist><dict><key>${requiredRuntimeEntitlement}</key><false/></dict></plist>`;
  const malformed = `<plist><dict><key>${requiredRuntimeEntitlement}</key></dict></plist>`;

  assert.throws(() => assertRuntimeEntitlements(missing, "/tmp/ade"), /missing com\.apple\.security\.cs\.allow-jit/u);
  assert.throws(() => assertRuntimeEntitlements(disabled, "/tmp/ade"), /missing com\.apple\.security\.cs\.allow-jit/u);
  assert.throws(() => assertRuntimeEntitlements(malformed, "/tmp/ade"), /missing com\.apple\.security\.cs\.allow-jit/u);
});

test("rejects the broader unsigned executable memory entitlement", () => {
  const xmlOutput = `<plist><dict><key>${forbiddenRuntimeEntitlement}</key><true/></dict></plist>`;
  const codesignOutput = `[Dict]\n\t[Key] ${forbiddenRuntimeEntitlement}\n\t[Value]\n\t\t[Bool] true`;
  const validOutput = `[Dict]\n\t[Key] ${requiredRuntimeEntitlement}\n\t[Value]\n\t\t[Bool] true`;

  assert.throws(
    () => assertRuntimeEntitlements(xmlOutput, "/tmp/ade"),
    /grants com\.apple\.security\.cs\.allow-unsigned-executable-memory/u,
  );
  assert.throws(
    () => assertRuntimeEntitlements(codesignOutput, "/tmp/ade"),
    /grants com\.apple\.security\.cs\.allow-unsigned-executable-memory/u,
  );
  assert.doesNotThrow(() => assertRuntimeEntitlements(validOutput, "/tmp/ade"));
});

test("accepts the codesign display format emitted by current macOS", () => {
  const codesignOutput = `[Dict]\n\t[Key] ${requiredRuntimeEntitlement}\n\t[Value]\n\t\t[Bool] true`;

  assert.doesNotThrow(() => assertRuntimeEntitlements(codesignOutput, "/tmp/ade"));
  assert.equal(codesignOutput.includes(`[Key] ${requiredRuntimeEntitlement}`), true);
  assert.equal(codesignOutput.endsWith("[Bool] true"), true);
});
