import assert from "node:assert/strict";
import test from "node:test";
import { assertVerifiedMachOPayloads } from "./native-archive-verification.mjs";

test("rejects a pre-signed archive with no Mach-O payloads", () => {
  assert.throws(
    () => assertVerifiedMachOPayloads(0, "/tmp/empty.native.tar.gz"),
    /No Mach-O payloads were verified/,
  );
});

test("accepts a pre-signed archive after at least one Mach-O signature is verified", () => {
  assert.equal(assertVerifiedMachOPayloads(3, "/tmp/runtime.native.tar.gz"), 3);
});
