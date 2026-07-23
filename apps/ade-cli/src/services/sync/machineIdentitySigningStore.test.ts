import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMachineIdentitySigningStore } from "./machineIdentitySigningStore";

describe("machineIdentitySigningStore", () => {
  it("creates once with mode 0600 and reloads the same key", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-signing-"));
    const filePath = path.join(dir, "machine-identity-signing.json");
    const first = createMachineIdentitySigningStore({ filePath }).getOrCreate();
    const second = createMachineIdentitySigningStore({ filePath }).getOrCreate();

    expect(first.publicKeyRawBase64).toBe(second.publicKeyRawBase64);
    expect(first.privateKeyPkcs8Base64).toBe(second.privateKeyPkcs8Base64);
    expect(Buffer.from(first.publicKeyRawBase64, "base64")).toHaveLength(32);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("shares one cached identity across consumers of the same file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-signing-shared-"));
    const filePath = path.join(dir, "machine-identity-signing.json");
    const publisherStore = createMachineIdentitySigningStore({ filePath });
    const published = publisherStore.getOrCreate();
    fs.writeFileSync(filePath, "{broken", { mode: 0o600 });

    const hostStore = createMachineIdentitySigningStore({ filePath });
    const signedByHost = hostStore.getOrCreate();

    expect(hostStore).toBe(publisherStore);
    expect(signedByHost.publicKeyRawBase64).toBe(published.publicKeyRawBase64);
    expect(signedByHost.privateKeyPkcs8Base64).toBe(
      published.privateKeyPkcs8Base64,
    );
  });

  it("regenerates a corrupt file and logs a warning", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-machine-signing-corrupt-"));
    const filePath = path.join(dir, "machine-identity-signing.json");
    const warn = vi.fn();
    fs.writeFileSync(filePath, "{broken", { mode: 0o600 });

    const value = createMachineIdentitySigningStore({
      filePath,
      logger: { warn },
    }).getOrCreate();

    expect(Buffer.from(value.publicKeyRawBase64, "base64")).toHaveLength(32);
    expect(warn).toHaveBeenCalledWith(
      "machine_identity_signing.corrupt_regenerated",
      { filePath },
    );
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({
      version: 1,
      publicKeyRawBase64: value.publicKeyRawBase64,
    });
  });
});
