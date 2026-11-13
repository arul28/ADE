import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeCbor, encodeCbor, type CborMap, type CborMapKey, type CborValue } from "./cbor";
import {
  createPasskey,
  getAssertion,
  rpIdAllowedForOrigin,
  type CreatePasskeyArgs,
  type CreatePasskeyResult,
  type GetAssertionArgs,
  type GetAssertionResult,
  type StoredPasskey,
} from "./webauthnAuthenticator";

/**
 * Relying-party proof for the passkey core: nothing here trusts the module's
 * own view of what it produced. The attestation object and assertions are
 * parsed as CBOR, and signatures are checked with node:crypto against the
 * public key a server would have registered.
 */
const RP_ID = "login.example.com";
const ORIGIN = "https://login.example.com";
const CHALLENGE = Buffer.from("9f2c8d1e6b4a7c3d5e0f1a2b3c4d5e6f", "hex");
const USER_ID = Buffer.from("user-handle-7f3a91", "utf8");

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

type CreateSuccess = Extract<CreatePasskeyResult, { credential: StoredPasskey }>;
type AssertionSuccess = Extract<GetAssertionResult, { credentialId: string }>;

function baseCreateArgs(): CreatePasskeyArgs {
  return {
    rpId: RP_ID,
    origin: ORIGIN,
    userId: USER_ID,
    userName: "alice@example.com",
    userDisplayName: "Alice Example",
    challenge: CHALLENGE,
    existingCredentialIds: [],
    userVerified: true,
  };
}

function create(overrides: Partial<CreatePasskeyArgs> = {}): CreateSuccess {
  const result = createPasskey({ ...baseCreateArgs(), ...overrides });
  if ("error" in result) throw new Error(`createPasskey failed: ${result.error}`);
  return result;
}

function baseAssertionArgs(candidates: StoredPasskey[]): GetAssertionArgs {
  return {
    rpId: RP_ID,
    origin: ORIGIN,
    challenge: CHALLENGE,
    candidates,
    userVerified: true,
  };
}

function assertion(candidates: StoredPasskey[], overrides: Partial<GetAssertionArgs> = {}): AssertionSuccess {
  const result = getAssertion({ ...baseAssertionArgs(candidates), ...overrides });
  if ("error" in result) throw new Error(`getAssertion failed: ${result.error}`);
  return result;
}

type ParsedAuthData = {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  aaguid: Buffer | null;
  credentialId: Buffer | null;
  coseKey: CborValue | null;
};

function parseAuthenticatorData(authData: Buffer): ParsedAuthData {
  expect(authData.length).toBeGreaterThanOrEqual(37);
  const flags = authData[32]!;
  const parsed: ParsedAuthData = {
    rpIdHash: authData.subarray(0, 32),
    flags,
    signCount: authData.readUInt32BE(33),
    aaguid: null,
    credentialId: null,
    coseKey: null,
  };
  if ((flags & FLAG_AT) !== 0) {
    expect(authData.length).toBeGreaterThanOrEqual(55);
    parsed.aaguid = authData.subarray(37, 53);
    const credentialIdLength = authData.readUInt16BE(53);
    const credentialIdEnd = 55 + credentialIdLength;
    expect(authData.length).toBeGreaterThanOrEqual(credentialIdEnd);
    parsed.credentialId = authData.subarray(55, credentialIdEnd);
    parsed.coseKey = decodeCbor(authData.subarray(credentialIdEnd));
  }
  return parsed;
}

function parseClientData(bytes: Buffer): { type: string; challenge: string; origin: string; crossOrigin: boolean } {
  return JSON.parse(bytes.toString("utf8")) as {
    type: string;
    challenge: string;
    origin: string;
    crossOrigin: boolean;
  };
}

function coseToPublicKey(value: CborValue): crypto.KeyObject {
  if (!(value instanceof Map)) throw new Error("COSE key is not a CBOR map.");
  const x = value.get(-2);
  const y = value.get(-3);
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error("COSE key has no affine coordinates.");
  return crypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(x).toString("base64url"),
      y: Buffer.from(y).toString("base64url"),
    },
    format: "jwk",
  });
}

function verifyAssertion(publicKey: crypto.KeyObject, result: AssertionSuccess): boolean {
  const clientDataHash = crypto.createHash("sha256").update(result.response.clientDataJSON).digest();
  return crypto.verify(
    "sha256",
    Buffer.concat([result.response.authenticatorData, clientDataHash]),
    publicKey,
    result.response.signature,
  );
}

describe("CBOR", () => {
  it("round-trips the value types a WebAuthn response uses", () => {
    const value: CborValue = new Map<CborMapKey, CborValue>([
      ["fmt", "none"],
      ["attStmt", new Map<CborMapKey, CborValue>()],
      ["authData", Buffer.from([0x00, 0xff, 0x10])],
      [1, 2],
      [-1, -7],
      ["flags", true],
      ["nested", [1, "two", false, null, new Map<CborMapKey, CborValue>([["k", Buffer.from("v")]])]],
    ]);
    expect(decodeCbor(encodeCbor(value))).toEqual(value);
  });

  it("writes map keys in CTAP2 canonical order: shorter first, then bytewise", () => {
    const encoded = encodeCbor(
      new Map<CborMapKey, CborValue>([
        ["aa", "aay"],
        [2, "two"],
        ["b", "bee"],
        [-1, "neg"],
        [10, "ten"],
      ]),
    );
    expect(encoded.toString("hex")).toBe(
      "a5026374776f0a6374656e20636e656761626362656562616163616179",
    );
  });

  it("encodes negative integers in the CBOR negative form", () => {
    expect(encodeCbor([-1, -24, -25]).toString("hex")).toBe("8320373818");
  });

  it("encodes bytes, text, booleans and null", () => {
    expect(encodeCbor([Buffer.from([0x01, 0x02]), "hi", true, false, null]).toString("hex")).toBe(
      "85420102626869f5f4f6",
    );
  });

  it("rejects truncated, indefinite, duplicate-key and trailing-byte input", () => {
    expect(() => decodeCbor(Buffer.from([0x18]))).toThrow(/truncated/i);
    expect(() => decodeCbor(Buffer.from([0x9f]))).toThrow(/additional information/i);
    expect(() => decodeCbor(Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(/duplicate/i);
    expect(() => decodeCbor(Buffer.from([0x01, 0x02]))).toThrow(/trailing/i);
  });
});

describe("rpIdAllowedForOrigin", () => {
  it.each([
    ["an exact host", "example.com", "https://example.com", true],
    ["a parent domain", "example.com", "https://login.example.com", true],
    ["a deeper parent", "example.com", "https://a.b.example.com", true],
    ["a non-default port", "example.com", "https://example.com:8443", true],
    ["an uppercase origin and RP ID", "EXAMPLE.com", "HTTPS://LOGIN.EXAMPLE.COM/", true],
    ["localhost over http", "localhost", "http://localhost:3000", true],
    ["a *.localhost name", "localhost", "http://app.localhost:5173", true],
    ["a site under a shared suffix", "a.github.io", "https://a.github.io", true],
    ["a two-label domain with a public suffix", "example.co.uk", "https://login.example.co.uk", true],
    ["another host", "evil.com", "https://example.com", false],
    ["a bare TLD", "com", "https://example.com", false],
    ["http for a public host", "example.com", "http://example.com", false],
    ["a shared-hosting suffix", "github.io", "https://a.github.io", false],
    ["a two-label public suffix", "co.uk", "https://login.example.co.uk", false],
    ["a suffix that is not label-aligned", "ample.com", "https://example.com", false],
    ["a lookalike host", "example.com", "https://example.com.evil.com", false],
    ["a path, not an origin", "example.com", "https://example.com/login", false],
    ["a non-http scheme", "example.com", "ftp://example.com", false],
    ["garbage", "example.com", "not an origin", false],
    ["an IP-label suffix", "0.0.1", "http://127.0.0.1:3000", false],
  ])("%s", (_label, rpId, origin, allowed) => {
    expect(rpIdAllowedForOrigin(rpId, origin)).toBe(allowed);
  });
});

describe("createPasskey", () => {
  it("creates an ES256 passkey a relying party can verify", () => {
    const result = create();
    const { credential, response } = result;

    expect(credential.rpId).toBe(RP_ID);
    expect(credential.userHandle).toBe(USER_ID.toString("base64url"));
    expect(credential.userName).toBe("alice@example.com");
    expect(credential.userDisplayName).toBe("Alice Example");
    expect(credential.signCount).toBe(0);
    expect(Number.isNaN(Date.parse(credential.createdAt))).toBe(false);
    expect(credential.credentialId).toBe(result.credentialId.toString("base64url"));
    expect(response.publicKeyAlgorithm).toBe(-7);
    expect(response.transports).toEqual(["internal", "hybrid"]);

    const clientDataJSON = response.clientDataJSON.toString("utf8");
    expect(Object.keys(JSON.parse(clientDataJSON) as Record<string, unknown>)).toEqual([
      "type",
      "challenge",
      "origin",
      "crossOrigin",
    ]);
    expect(parseClientData(response.clientDataJSON)).toEqual({
      type: "webauthn.create",
      challenge: CHALLENGE.toString("base64url"),
      origin: ORIGIN,
      crossOrigin: false,
    });

    const attestation = decodeCbor(response.attestationObject);
    expect(attestation).toBeInstanceOf(Map);
    const attestationMap = attestation as CborMap;
    expect(attestationMap.get("fmt")).toBe("none");
    expect(attestationMap.get("attStmt")).toEqual(new Map());
    const attestedAuthData = attestationMap.get("authData");
    expect(Buffer.isBuffer(attestedAuthData)).toBe(true);
    expect((attestedAuthData as Buffer).equals(response.authenticatorData)).toBe(true);

    const parsed = parseAuthenticatorData(attestedAuthData as Buffer);
    expect(parsed.rpIdHash).toEqual(crypto.createHash("sha256").update(RP_ID).digest());
    expect(parsed.flags).toBe(FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT);
    expect(parsed.signCount).toBe(0);
    expect(parsed.aaguid).toEqual(Buffer.alloc(16));
    expect(parsed.credentialId).toEqual(result.credentialId);

    const coseKey = parsed.coseKey as CborMap;
    expect(coseKey.get(1)).toBe(2);
    expect(coseKey.get(3)).toBe(-7);
    expect(coseKey.get(-1)).toBe(1);
    const x = coseKey.get(-2);
    const y = coseKey.get(-3);
    expect(x).toBeInstanceOf(Uint8Array);
    expect(y).toBeInstanceOf(Uint8Array);
    expect((x as Uint8Array).length).toBe(32);
    expect((y as Uint8Array).length).toBe(32);

    const publicKey = coseToPublicKey(coseKey);
    expect(publicKey.asymmetricKeyType).toBe("ec");
    expect(publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(publicKey.export({ type: "spki", format: "der" }).equals(response.publicKey)).toBe(true);

    // The stored private key is the one behind the published public key.
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(credential.privateKeyPkcs8, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const probe = Buffer.from("passkey key pair probe");
    expect(crypto.verify("sha256", probe, publicKey, crypto.sign("sha256", probe, privateKey))).toBe(true);
  });

  it("sets UV only when the caller verified the user", () => {
    const parsed = parseAuthenticatorData(create({ userVerified: false }).response.authenticatorData);
    expect(parsed.flags & FLAG_UV).toBe(0);
    expect(parsed.flags).toBe(FLAG_UP | FLAG_BE | FLAG_BS | FLAG_AT);
  });

  it("returns InvalidStateError when the exclude list names an existing credential", () => {
    const first = create();
    const excluded = createPasskey({
      ...baseCreateArgs(),
      existingCredentialIds: [first.credentialId],
      excludeCredentialIds: [first.credentialId],
    });
    expect(excluded).toEqual({ error: "InvalidStateError" });
  });

  it("creates another passkey when the exclude list does not match", () => {
    const first = create();
    const second = create({
      existingCredentialIds: [first.credentialId],
      excludeCredentialIds: [Buffer.alloc(16, 0x07)],
    });
    expect(second.credential.credentialId).not.toBe(first.credential.credentialId);
  });

  it("refuses an RP ID the origin does not own", () => {
    expect(createPasskey({ ...baseCreateArgs(), rpId: "evil.com" })).toEqual({ error: "NotAllowedError" });
    expect(createPasskey({ ...baseCreateArgs(), rpId: "com" })).toEqual({ error: "NotAllowedError" });
    expect(createPasskey({ ...baseCreateArgs(), origin: "http://login.example.com" })).toEqual({
      error: "NotAllowedError",
    });
    expect(createPasskey({ ...baseCreateArgs(), crossOrigin: true as unknown as false })).toEqual({
      error: "NotAllowedError",
    });
  });
});

describe("getAssertion", () => {
  it("signs authenticatorData || sha256(clientDataJSON) with ES256 DER", () => {
    const created = create();
    const result = assertion([created.credential]);

    expect(result.credentialId).toBe(created.credential.credentialId);
    expect(result.updatedSignCount).toBe(0);

    const clientDataJSON = result.response.clientDataJSON.toString("utf8");
    expect(Object.keys(JSON.parse(clientDataJSON) as Record<string, unknown>)).toEqual([
      "type",
      "challenge",
      "origin",
      "crossOrigin",
    ]);
    expect(parseClientData(result.response.clientDataJSON)).toEqual({
      type: "webauthn.get",
      challenge: CHALLENGE.toString("base64url"),
      origin: ORIGIN,
      crossOrigin: false,
    });

    const parsed = parseAuthenticatorData(result.response.authenticatorData);
    expect(parsed.rpIdHash).toEqual(crypto.createHash("sha256").update(RP_ID).digest());
    expect(parsed.flags).toBe(FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS);
    expect(parsed.signCount).toBe(0);
    expect(parsed.credentialId).toBeNull();
    expect(parsed.coseKey).toBeNull();
    expect(result.response.userHandle).toEqual(USER_ID);
    expect(result.response.signature[0]).toBe(0x30);

    const publicKey = crypto.createPublicKey({ key: created.response.publicKey, format: "der", type: "spki" });
    expect(verifyAssertion(publicKey, result)).toBe(true);

    // The signature is bound to both halves: tampering with either fails.
    const tamperedAuthData = Buffer.from(result.response.authenticatorData);
    tamperedAuthData[32] = tamperedAuthData[32]! ^ FLAG_UV;
    const clientDataHash = crypto.createHash("sha256").update(result.response.clientDataJSON).digest();
    expect(
      crypto.verify("sha256", Buffer.concat([tamperedAuthData, clientDataHash]), publicKey, result.response.signature),
    ).toBe(false);

    const tamperedClientData = Buffer.from(
      result.response.clientDataJSON.toString("utf8").replace(ORIGIN, "https://evil.example"),
      "utf8",
    );
    expect(
      crypto.verify(
        "sha256",
        Buffer.concat([
          result.response.authenticatorData,
          crypto.createHash("sha256").update(tamperedClientData).digest(),
        ]),
        publicKey,
        result.response.signature,
      ),
    ).toBe(false);
  });

  it("sets UV on an assertion only when the caller verified the user", () => {
    const created = create();
    const parsed = parseAuthenticatorData(
      assertion([created.credential], { userVerified: false }).response.authenticatorData,
    );
    expect(parsed.flags & FLAG_UV).toBe(0);
    expect(parsed.flags).toBe(FLAG_UP | FLAG_BE | FLAG_BS);
  });

  it("keeps the synced-passkey signature counter at zero", () => {
    const created = create();
    expect(assertion([created.credential]).updatedSignCount).toBe(0);
    expect(assertion([created.credential]).updatedSignCount).toBe(0);
    expect(parseAuthenticatorData(assertion([created.credential]).response.authenticatorData).signCount).toBe(0);
  });

  it("requires both the allow list and the RP ID to match", () => {
    const created = create();
    const other = create();
    expect(
      getAssertion({ ...baseAssertionArgs([created.credential]), allowCredentialIds: [other.credentialId] }),
    ).toEqual({ error: "NotAllowedError" });

    expect(assertion([created.credential], { allowCredentialIds: [created.credentialId] }).credentialId).toBe(
      created.credential.credentialId,
    );
    expect(assertion([created.credential], { allowCredentialIds: [] }).credentialId).toBe(
      created.credential.credentialId,
    );

    expect(
      getAssertion({
        ...baseAssertionArgs([created.credential]),
        rpId: "other.example.com",
        origin: "https://other.example.com",
      }),
    ).toEqual({ error: "NotAllowedError" });

    expect(
      getAssertion({
        ...baseAssertionArgs([{ ...created.credential, rpId: "other.example.com" }]),
      }),
    ).toEqual({ error: "NotAllowedError" });

    expect(
      getAssertion({
        ...baseAssertionArgs([created.credential]),
        rpId: "evil.com",
      }),
    ).toEqual({ error: "NotAllowedError" });

    expect(
      getAssertion({
        ...baseAssertionArgs([created.credential]),
        crossOrigin: true as unknown as false,
      }),
    ).toEqual({ error: "NotAllowedError" });
  });
});
