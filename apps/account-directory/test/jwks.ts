import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll } from "vitest";

/**
 * One JWKS keypair and one loopback server per test file that needs to mint a
 * Clerk-shaped token.
 *
 * Importing this module registers the `beforeAll`/`afterAll` that own the
 * server, so a suite gets the keys by importing and nothing else. It carries
 * NO env builder on purpose: the suites disagree about what an env is (a D1
 * fake here, an R2 fake there) and folding that in is what would force one
 * suite to drag in the other's fixtures just to sign a token.
 */

export const ISSUER = "https://clerk.test";
export const OAUTH_CLIENT_ID = "client_ade";

let jwksServer: Server;
let jwksUrl = "";
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let badSigningKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

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
    jwksServer.close((error) => (error ? reject(error) : resolve()));
  });
});

/** Read inside a test or an env builder — it is empty until `beforeAll` runs. */
export function jwksEndpoint(): string {
  return jwksUrl;
}

export async function mintToken(args: {
  sub?: string | null;
  issuer?: string;
  audience?: string | string[];
  azp?: string;
  expired?: boolean;
  useBadKey?: boolean;
  /** Standard OIDC authentication time, in seconds since the epoch. */
  authTime?: number;
  /** Clerk's factor-verification-age claim: [firstFactorMinutes, secondFactorMinutes]. */
  fva?: unknown;
} = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let token = new SignJWT({
    ...(args.azp === undefined ? {} : { azp: args.azp }),
    ...(args.authTime === undefined ? {} : { auth_time: args.authTime }),
    ...(args.fva === undefined ? {} : { fva: args.fva }),
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(args.issuer ?? ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(args.expired ? now - 60 : now + 600);
  if (args.sub !== null) token = token.setSubject(args.sub ?? "user_1");
  if (args.audience !== undefined) token = token.setAudience(args.audience);
  return token.sign(args.useBadKey ? badSigningKey : signingKey);
}

/**
 * A token that proves the user just signed in interactively — the only kind the
 * directory accepts `pairing: true` on. `fva[0] = 0` is Clerk's "first factor
 * verified within the last minute"; `-1` is "no second factor registered".
 */
export async function mintFreshAuthToken(sub = "user_1"): Promise<string> {
  return mintToken({ sub, fva: [0, -1] });
}
