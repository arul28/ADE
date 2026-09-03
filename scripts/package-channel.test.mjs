import assert from "node:assert/strict";
import test from "node:test";

import {
  macBuilderArgs,
  normalizeSignIdentity,
  parseArgs,
  parseCodesigningIdentities,
  resolveSignSelection,
  selectAutoSignIdentity,
  signingCertificateType,
} from "./package-channel.mjs";

const CHANNEL_CONFIG = {
  productName: "ADE Alpha",
  appId: "com.ade.desktop.alpha",
  cliName: "ade-alpha",
  adeHome: "/Users/example/.ade-alpha",
  outputDir: "release-alpha",
};

const FIND_IDENTITY_OUTPUT = [
  "  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \"Apple Development: Example Person (TEAM1234)\"",
  "  2) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB \"Developer ID Application: Example Person (TEAM1234)\"",
  "     2 valid identities found",
].join("\n");

function builderArgs(identity) {
  return macBuilderArgs({
    channel: "alpha",
    config: CHANNEL_CONFIG,
    outputRoot: "/repo/apps/desktop/release-alpha",
    identity,
  });
}

test("selects a Developer ID Application identity over an Apple Development one", () => {
  const identity = selectAutoSignIdentity(FIND_IDENTITY_OUTPUT);
  assert.equal(identity.qualifier, "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  assert.equal(identity.type, "distribution");
  assert.match(identity.display, /^Developer ID Application: Example Person \(TEAM1234\) \(B{40}\)$/);
});

test("falls back to an Apple Development identity as a development certificate", () => {
  const identity = selectAutoSignIdentity(
    "  1) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \"Apple Development: Example Person (TEAM1234)\"",
  );
  assert.equal(identity.qualifier, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.equal(identity.type, "development");
});

test("skips revoked identities", () => {
  const output = [
    "  1) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB \"Developer ID Application: Example Person (TEAM1234)\" (CSSMERR_TP_CERT_REVOKED)",
    "  2) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA \"Apple Development: Example Person (TEAM1234)\"",
  ].join("\n");
  assert.deepEqual(
    parseCodesigningIdentities(output).map((entry) => entry.name),
    ["Apple Development: Example Person (TEAM1234)"],
  );
  assert.equal(selectAutoSignIdentity(output).qualifier, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
});

test("returns no identity when every candidate is revoked or absent", () => {
  assert.equal(
    selectAutoSignIdentity(
      "  1) BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB \"Developer ID Application: Example Person\" (CSSMERR_TP_CERT_REVOKED)",
    ),
    null,
  );
  assert.equal(selectAutoSignIdentity("     0 valid identities found"), null);
  assert.equal(selectAutoSignIdentity(""), null);
});

test("strips the certificate-type prefix electron-builder rejects", () => {
  const identity = normalizeSignIdentity("Developer ID Application: Example Person (TEAM1234)");
  assert.equal(identity.qualifier, "Example Person (TEAM1234)");
  assert.equal(identity.display, "Developer ID Application: Example Person (TEAM1234)");
  assert.equal(identity.type, "distribution");
});

test("keeps a hash qualifier and an Apple Development name as given", () => {
  assert.equal(normalizeSignIdentity(" ABCDEF ").qualifier, "ABCDEF");
  assert.equal(normalizeSignIdentity("Apple Development: Example Person").type, "development");
  assert.equal(signingCertificateType("Mac Developer: Example Person"), "development");
  assert.equal(normalizeSignIdentity("   "), null);
});

test("parses --sign, --sign=value and --sign-auto", () => {
  assert.equal(parseArgs(["alpha", "--sign", "Example Person"]).signIdentity, "Example Person");
  assert.equal(parseArgs(["alpha", "--sign=Example Person"]).signIdentity, "Example Person");
  assert.equal(parseArgs(["alpha", "--sign-auto"]).signAuto, true);
  const defaults = parseArgs(["alpha"]);
  assert.equal(defaults.signIdentity, null);
  assert.equal(defaults.signAuto, false);
});

test("the flag wins over the environment variable", () => {
  const env = { ADE_CHANNEL_SIGN_IDENTITY: "From Env" };
  assert.deepEqual(resolveSignSelection(parseArgs(["alpha", "--sign", "From Flag"]), env), {
    mode: "explicit",
    value: "From Flag",
    fromEnv: false,
  });
  assert.deepEqual(resolveSignSelection(parseArgs(["alpha", "--sign-auto"]), env), { mode: "auto" });
  assert.deepEqual(resolveSignSelection(parseArgs(["alpha"]), env), {
    mode: "explicit",
    value: "From Env",
    fromEnv: true,
  });
  assert.deepEqual(resolveSignSelection(parseArgs(["alpha"]), { ADE_CHANNEL_SIGN_IDENTITY: "  " }), {
    mode: "adhoc",
  });
  assert.deepEqual(resolveSignSelection(parseArgs(["alpha"]), {}), { mode: "adhoc" });
});

test("builds the ad-hoc electron-builder arguments when no identity is chosen", () => {
  const args = builderArgs(null);
  assert.ok(args.includes("-c.mac.identity=null"));
  assert.ok(args.includes("-c.mac.notarize=false"));
  assert.ok(!args.some((arg) => arg.startsWith("-c.mac.type=")));
  assert.ok(!args.some((arg) => arg.startsWith("-c.mac.provisioningProfile=")));
});

test("passes a distribution identity without a development type", () => {
  const args = builderArgs(selectAutoSignIdentity(FIND_IDENTITY_OUTPUT));
  assert.ok(args.includes("-c.mac.identity=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"));
  assert.ok(!args.includes("-c.mac.identity=null"));
  assert.ok(!args.some((arg) => arg.startsWith("-c.mac.type=")));
  assert.ok(args.includes("-c.mac.provisioningProfile=null"));
  assert.ok(args.includes("-c.mac.notarize=false"));
});

test("adds the development type for an Apple Development identity", () => {
  const args = builderArgs(normalizeSignIdentity("Apple Development: Example Person (TEAM1234)"));
  assert.ok(args.includes("-c.mac.identity=Apple Development: Example Person (TEAM1234)"));
  assert.ok(args.includes("-c.mac.type=development"));
  assert.ok(args.includes("-c.mac.provisioningProfile=null"));
});

test("keeps the channel arguments the packaged app depends on", () => {
  const args = builderArgs(null);
  for (const expected of [
    "electron-builder",
    "--dir",
    "--mac",
    "-c.appId=com.ade.desktop.alpha",
    "-c.productName=ADE Alpha",
    "-c.mac.icon=build/icon.alpha.icns",
    "-c.directories.output=/repo/apps/desktop/release-alpha",
    "-c.extraMetadata.adePackageChannel=alpha",
    "-c.extraMetadata.adeCliName=ade-alpha",
    "-c.mac.extendInfo.LSEnvironment.ADE_HOME=/Users/example/.ade-alpha",
  ]) {
    assert.ok(args.includes(expected), `missing ${expected}`);
  }
});
