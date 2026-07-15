import fs from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SyncPeerMetadata } from "../../../../desktop/src/shared/types";
import { createSyncPairingStore } from "../sync/syncPairingStore";
import { createSyncPinStore } from "../sync/syncPinStore";
import { verifyClerkAccountAttestation } from "./accountAttestationVerifier";

const ISSUER = "https://clerk.test";
const OAUTH_CLIENT_ID = "client_ade";
const OWNER_USER_ID = "user_owner";
const tempPaths: string[] = [];
let jwksServer: Server;
let jwksUrl = "";
let signingKey: CryptoKey;
let badSigningKey: CryptoKey;

beforeAll(async () => {
  const primary = await generateKeyPair("RS256", { extractable: true });
  const bad = await generateKeyPair("RS256", { extractable: true });
  signingKey = primary.privateKey;
  badSigningKey = bad.privateKey;
  const publicJwk = await exportJWK(primary.publicKey);
  const jwks = { keys: [{ ...publicJwk, alg: "RS256", kid: "test-key", use: "sig" }] };
  jwksServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(jwks));
  });
  await new Promise<void>((resolve, reject) => {
    jwksServer.once("error", reject);
    jwksServer.listen(0, "127.0.0.1", resolve);
  });
  jwksUrl = `http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/jwks`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    jwksServer.close((error) => error ? reject(error) : resolve());
  });
});

afterEach(() => {
  for (const target of tempPaths.splice(0)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function config() {
  return { issuer: ISSUER, jwksUrl, oauthClientId: OAUTH_CLIENT_ID };
}

async function mintToken(args: {
  sub?: string | null;
  issuer?: string;
  audience?: string | string[];
  azp?: string;
  expired?: boolean;
  omitExpiration?: boolean;
  useBadKey?: boolean;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let token = new SignJWT(args.azp === undefined ? {} : { azp: args.azp })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(args.issuer ?? ISSUER)
    .setIssuedAt(now);
  if (!args.omitExpiration) token = token.setExpirationTime(args.expired ? now - 60 : now + 600);
  if (args.sub !== null) token = token.setSubject(args.sub ?? OWNER_USER_ID);
  if (args.audience !== undefined) token = token.setAudience(args.audience);
  return token.sign(args.useBadKey ? badSigningKey : signingKey);
}

describe("verifyClerkAccountAttestation", () => {
  it("accepts an owner OAuth token whose audience or azp is the configured Clerk client", async () => {
    const audienceToken = await mintToken({ audience: OAUTH_CLIENT_ID });
    const azpToken = await mintToken({ audience: "clerk-api", azp: OAUTH_CLIENT_ID });

    await expect(verifyClerkAccountAttestation({
      token: audienceToken,
      expectedUserId: OWNER_USER_ID,
      config: config(),
    })).resolves.toMatchObject({ userId: OWNER_USER_ID });
    await expect(verifyClerkAccountAttestation({
      token: azpToken,
      expectedUserId: OWNER_USER_ID,
      config: config(),
    })).resolves.toMatchObject({ userId: OWNER_USER_ID });
  });

  it("accepts a native Clerk session token with no aud", async () => {
    const token = await mintToken({ azp: "https://desktop.ade.dev" });

    await expect(verifyClerkAccountAttestation({
      token,
      expectedUserId: OWNER_USER_ID,
      config: config(),
    })).resolves.toMatchObject({ userId: OWNER_USER_ID });
  });

  it("rejects alg:none and HS256 algorithm-confusion tokens", async () => {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: ISSUER,
      sub: OWNER_USER_ID,
      aud: OAUTH_CLIENT_ID,
      iat: now,
      exp: now + 600,
    };
    const noneToken = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"),
      "",
    ].join(".");
    const hs256Token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setSubject(OWNER_USER_ID)
      .setAudience(OAUTH_CLIENT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(new TextEncoder().encode("attacker-controlled-hmac-secret"));

    for (const token of [noneToken, hs256Token]) {
      await expect(verifyClerkAccountAttestation({
        token,
        expectedUserId: OWNER_USER_ID,
        config: config(),
      })).rejects.toBeInstanceOf(Error);
    }
  });

  it.each([
    ["different Clerk user", { sub: "user_attacker" }],
    ["expired token", { expired: true }],
    ["missing expiration", { omitExpiration: true }],
    ["wrong issuer", { issuer: "https://wrong-issuer.test" }],
    ["bad signature", { useBadKey: true }],
    ["missing subject", { sub: null }],
    ["unapproved audience", { audience: "different-client", azp: "different-client" }],
  ] as const)("rejects %s", async (_label, tokenArgs) => {
    const token = await mintToken(tokenArgs);

    await expect(verifyClerkAccountAttestation({
      token,
      expectedUserId: OWNER_USER_ID,
      config: config(),
    })).rejects.toBeInstanceOf(Error);
  });
});

describe("pairPeerViaAccount", () => {
  const phonePeer: SyncPeerMetadata = {
    deviceId: "account-phone",
    deviceName: "Account phone",
    platform: "iOS",
    deviceType: "phone",
    siteId: "account-phone-site",
    dbVersion: 0,
  };

  function harness() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-pairing-"));
    tempPaths.push(dir);
    const pinStore = createSyncPinStore({ filePath: path.join(dir, "pin.json") });
    const pairingFile = path.join(dir, "pairings.json");
    return {
      pairingFile,
      pinStore,
      store: createSyncPairingStore({ filePath: pairingFile, pinStore }),
    };
  }

  function dpopPublicKey(): string {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    return Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]).toString("base64");
  }

  it("rejects any caller that does not present the verifier's opaque result", () => {
    const { store } = harness();

    expect(() => store.pairPeerViaAccount(
      phonePeer,
      { userId: OWNER_USER_ID } as never,
    )).toThrow(/not verified/i);
  });

  it("mints and authenticates the same record shape without a PIN, preserving DPoP and runtime grant gates", async () => {
    const { store, pinStore } = harness();
    const attestation = await verifyClerkAccountAttestation({
      token: await mintToken({ audience: OAUTH_CLIENT_ID }),
      expectedUserId: OWNER_USER_ID,
      config: config(),
    });
    const publicKey = dpopPublicKey();
    expect(pinStore.hasPin()).toBe(false);

    const copiedGrant = store.issueRuntimeHostGrant();
    const phonePairing = store.pairPeerViaAccount(phonePeer, attestation, {
      dpopPublicKey: publicKey,
      runtimeHostGrant: copiedGrant,
    });
    expect(phonePairing.secret).toMatch(/^[0-9a-f]{48}$/);
    expect(store.authenticate(phonePairing.deviceId, phonePairing.secret)).toBe(true);
    expect(store.getPairingRecord(phonePairing.deviceId)).toMatchObject({
      dpopPublicKey: publicKey,
      runtimeHostGranted: false,
      peerDeviceType: "phone",
      lastUsedAt: expect.any(String),
    });
    const rotatedPhonePairing = store.pairPeerViaAccount(phonePeer, attestation);
    expect(rotatedPhonePairing.secret).not.toBe(phonePairing.secret);
    expect(store.getPairingRecord(phonePairing.deviceId)?.dpopPublicKey).toBe(publicKey);

    const desktopGrant = store.issueRuntimeHostGrant();
    const desktopPairing = store.pairPeerViaAccount({
      ...phonePeer,
      deviceId: "account-desktop",
      deviceName: "Account desktop",
      platform: "macOS",
      deviceType: "desktop",
    }, attestation, {
      dpopPublicKey: publicKey,
      runtimeHostGrant: desktopGrant,
    });
    expect(store.getPairingRecord(desktopPairing.deviceId)).toMatchObject({
      dpopPublicKey: publicKey,
      runtimeHostGranted: true,
      peerDeviceType: "desktop",
    });
  });
});
