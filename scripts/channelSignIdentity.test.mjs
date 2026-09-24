import assert from "node:assert/strict";
import test from "node:test";

import {
  ADE_LOCAL_SIGN_IDENTITY,
  parseCodesigningIdentities,
  resolveChannelSignIdentity,
} from "./channelSignIdentity.mjs";

const HASH_ADE_LOCAL = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const HASH_DEVELOPER_ID = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

test("parses identities from security find-identity output", () => {
  const stdout = [
    "Policy: Codesigning",
    `  1) ${HASH_ADE_LOCAL} "ADE Local"`,
    `  2) ${HASH_DEVELOPER_ID} "Developer ID Application: Example (TEAM123)"`,
    "     2 valid identities found",
  ].join("\n");
  assert.deepEqual(parseCodesigningIdentities(stdout), [
    { hash: HASH_ADE_LOCAL, name: "ADE Local" },
    { hash: HASH_DEVELOPER_ID, name: "Developer ID Application: Example (TEAM123)" },
  ]);
});

test("returns no identities when the keychain has none", () => {
  assert.deepEqual(parseCodesigningIdentities("     0 valid identities found"), []);
  assert.deepEqual(parseCodesigningIdentities(""), []);
  assert.deepEqual(parseCodesigningIdentities(undefined), []);
});

test("the --sign flag wins over env and auto-detection", () => {
  assert.deepEqual(
    resolveChannelSignIdentity({
      flag: "My Cert",
      env: "Env Cert",
      identities: [{ hash: HASH_ADE_LOCAL, name: "ADE Local" }],
    }),
    { identity: "My Cert", source: "flag" },
  );
});

test("the flag accepts an exact SHA-1 hash", () => {
  assert.deepEqual(resolveChannelSignIdentity({ flag: HASH_ADE_LOCAL, identities: [] }), {
    identity: HASH_ADE_LOCAL,
    source: "flag",
  });
});

test("a blank flag falls through to the env var", () => {
  assert.deepEqual(resolveChannelSignIdentity({ flag: "  ", env: "Env Cert", identities: [] }), {
    identity: "Env Cert",
    source: "env",
  });
});

test("the ADE_CHANNEL_SIGN_IDENTITY env var wins over auto-detection", () => {
  assert.deepEqual(
    resolveChannelSignIdentity({
      env: "  My Cert  ",
      identities: [{ hash: HASH_ADE_LOCAL, name: "ADE Local" }],
    }),
    { identity: "My Cert", source: "env" },
  );
});

test("auto-detects a certificate named exactly ADE Local", () => {
  assert.deepEqual(
    resolveChannelSignIdentity({
      identities: [{ hash: HASH_DEVELOPER_ID, name: "Some Other Cert" }, { hash: HASH_ADE_LOCAL, name: ADE_LOCAL_SIGN_IDENTITY }],
    }),
    { identity: ADE_LOCAL_SIGN_IDENTITY, source: "auto" },
  );
});

test("never auto-picks a Developer ID or a partial name match", () => {
  assert.deepEqual(
    resolveChannelSignIdentity({
      identities: [
        { hash: HASH_DEVELOPER_ID, name: "Developer ID Application: Example (TEAM123)" },
        { hash: HASH_ADE_LOCAL, name: "ADE Local Dev" },
      ],
    }),
    { identity: null, source: "adhoc" },
  );
});

test("falls back to ad-hoc when nothing is provided or detected", () => {
  assert.deepEqual(resolveChannelSignIdentity({}), { identity: null, source: "adhoc" });
  assert.deepEqual(resolveChannelSignIdentity(), { identity: null, source: "adhoc" });
});
