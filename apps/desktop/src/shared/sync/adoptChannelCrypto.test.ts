import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAdoptChallengeSignatureInput,
  deriveAdoptSessionKey,
  generateX25519EphemeralKeyPair,
  rawPublicKeyFromSpki,
  seal,
  signEd25519,
  unseal,
  verifyEd25519,
} from "./adoptChannelCrypto";

describe("adoptChannelCrypto", () => {
  it("derives the same session key and seals/unseals a payload", () => {
    const client = generateX25519EphemeralKeyPair();
    const host = generateX25519EphemeralKeyPair();
    const nonce = randomBytes(32);
    const clientKey = deriveAdoptSessionKey({
      privateKey: client.privateKey,
      peerPublicKeyRaw: host.publicKeyRaw,
      nonce,
    });
    const hostKey = deriveAdoptSessionKey({
      privateKey: host.privateKey,
      peerPublicKeyRaw: client.publicKeyRaw,
      nonce,
    });
    expect(clientKey).toEqual(hostKey);

    const aad = Buffer.from("ade-adopt-v1|host|client");
    const plaintext = Buffer.from('{"accountToken":"secret"}');
    const sealed = seal(clientKey, aad, plaintext);
    expect(unseal(hostKey, aad, sealed)).toEqual(plaintext);
  });

  it("rejects tampering, the wrong AAD, and the wrong key", () => {
    const key = randomBytes(32);
    const aad = Buffer.from("correct aad");
    const sealed = seal(key, aad, Buffer.from("credential"));
    const tampered = Buffer.from(sealed, "base64");
    tampered[15] ^= 0x01;

    expect(() => unseal(key, aad, tampered.toString("base64"))).toThrow();
    expect(() => unseal(key, Buffer.from("wrong aad"), sealed)).toThrow();
    expect(() => unseal(randomBytes(32), aad, sealed)).toThrow();
  });

  it("builds the exact canonical challenge signature string", () => {
    expect(buildAdoptChallengeSignatureInput({
      hostDeviceId: "host-device",
      nonce: "bm9uY2U=",
      clientEphemeralPublicKey: "Y2xpZW50",
      hostEphemeralPublicKey: "aG9zdA==",
      ts: 1_783_500_123_456,
    })).toMatchInlineSnapshot(
      `"ade-adopt-v1|host-device|bm9uY2U=|Y2xpZW50|aG9zdA==|1783500123456"`,
    );
  });

  it("signs and verifies Ed25519 with the raw 32-byte public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeyRaw = rawPublicKeyFromSpki(publicKey);
    const message = Buffer.from("ade-adopt-v1|host|nonce|client|host-eph|123");
    const signature = signEd25519(privateKey, message);
    expect(publicKeyRaw).toHaveLength(32);
    expect(verifyEd25519(publicKeyRaw, message, signature)).toBe(true);
    expect(verifyEd25519(publicKeyRaw, Buffer.from("changed"), signature)).toBe(false);
  });

  it("matches the fixed iOS ChaChaPoly combined-vector bytes", () => {
    // iOS compatibility vector:
    // client X25519 private = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
    // client X25519 public  = 8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f
    // host X25519 private   = 202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f
    // host X25519 public    = 358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254
    // HKDF salt = 000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f
    // session key = 73dd8c3462d2bd6af30580cd4147d5049e6b96d6e0caad0abb512e47ea9c056e
    // AEAD nonce = 000102030405060708090a0b
    // aad = "ade-adopt-v1|host-vector|client-vector"
    // plaintext = "{\"deviceId\":\"client-vector\",\"accountToken\":\"token-vector\",\"dpop\":null}"
    // sealed base64 =
    // AAECAwQFBgcICQoL2ZbKNSOix6tRlgt6GSfO7OGy0Pp8/04VMGCtmGI+2K5fKpJv27j0R8un/fPj0v1aEAizUH3l7uZ6nwS6WM8f+GJfCvAcH6bo1KfPq04vbY2jLUSXuYo=
    const x25519Pkcs8Prefix = Buffer.from(
      "302e020100300506032b656e04220420",
      "hex",
    );
    const clientPrivateKey = createPrivateKey({
      key: Buffer.concat([x25519Pkcs8Prefix, Buffer.from(
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "hex",
      )]),
      format: "der",
      type: "pkcs8",
    });
    const hostPrivateKey = createPrivateKey({
      key: Buffer.concat([x25519Pkcs8Prefix, Buffer.from(
        "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
        "hex",
      )]),
      format: "der",
      type: "pkcs8",
    });
    expect(rawPublicKeyFromSpki(createPublicKey(clientPrivateKey)).toString("hex"))
      .toBe("8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f");
    const hostPublicKey = rawPublicKeyFromSpki(createPublicKey(hostPrivateKey));
    expect(hostPublicKey.toString("hex"))
      .toBe("358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254");
    const key = deriveAdoptSessionKey({
      privateKey: clientPrivateKey,
      peerPublicKeyRaw: hostPublicKey,
      nonce: Buffer.from(
        "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
        "hex",
      ),
    });
    expect(key.toString("hex")).toBe(
      "73dd8c3462d2bd6af30580cd4147d5049e6b96d6e0caad0abb512e47ea9c056e",
    );
    const aeadNonce = Buffer.from(
      "000102030405060708090a0b",
      "hex",
    );
    const aad = Buffer.from("ade-adopt-v1|host-vector|client-vector");
    const plaintext = Buffer.from(
      '{"deviceId":"client-vector","accountToken":"token-vector","dpop":null}',
    );
    const expected =
      "AAECAwQFBgcICQoL2ZbKNSOix6tRlgt6GSfO7OGy0Pp8/04VMGCtmGI+2K5fKpJv27j0R8un/fPj0v1aEAizUH3l7uZ6nwS6WM8f+GJfCvAcH6bo1KfPq04vbY2jLUSXuYo=";
    expect(seal(key, aad, plaintext, aeadNonce)).toBe(expected);
    expect(unseal(key, aad, expected)).toEqual(plaintext);
  });
});
