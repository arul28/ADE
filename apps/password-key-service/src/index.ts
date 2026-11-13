/**
 * The Passwords key service.
 *
 * Every ADE account with Passwords on has one random vault key (the "DEK")
 * that seals its items on the person's devices and cloud lanes. ade-push-relay
 * stores that key only wrapped, and only this Worker can wrap or unwrap it:
 *
 *   KEK(account) = HKDF-SHA256(PASSWORD_KEK_MASTER, salt, info = accountId)
 *   wrapped      = nonce || AES-256-GCM(KEK, DEK, aad = "ade.passwords.dek\n" + accountId)
 *
 * So the relay's database and secrets open nothing alone, and one account's
 * wrapped key is useless for any other account. This Worker stores nothing
 * and logs no key material; deciding *who* may get a key (a signed-in device,
 * a cloud computer with the toggle on) is the relay's job, which has the
 * account session. This Worker only trusts the relay, by a shared secret on
 * every call over a service binding, and has no public address.
 *
 * Endpoints (POST, JSON):
 *   /v1/create  { accountId }             -> { dek, wrappedDek }
 *   /v1/unwrap  { accountId, wrappedDek } -> { dek }
 * Keys travel base64. Any failure is a short code, never a reason that could
 * help someone probe it.
 */

export type KeyServiceEnv = {
  PASSWORD_KEK_MASTER?: string;
  KEY_SERVICE_AUTH_SECRET?: string;
};

const KEK_SALT = new TextEncoder().encode("ade.passwords.kek.v1");
const DEK_AAD_PREFIX = "ade.passwords.dek\n";
const AUTH_HEADER = "x-ade-key-service-auth";
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_\-:.]{1,128}$/;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const refuse = (status: number, code: string) => json(status, { error: code });

/** Constant-time string comparison, so the auth check leaks no prefix length. */
function sameSecret(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

async function accountKek(env: KeyServiceEnv, accountId: string): Promise<CryptoKey | null> {
  const raw = env.PASSWORD_KEK_MASTER?.trim();
  if (!raw) return null;
  let master: Uint8Array<ArrayBuffer>;
  try {
    master = fromBase64(raw);
  } catch {
    return null;
  }
  // A short or malformed master is a misconfiguration, not something to stretch.
  if (master.length !== 32) return null;
  const base = await crypto.subtle.importKey("raw", master, "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: KEK_SALT, info: new TextEncoder().encode(accountId) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function aadFor(accountId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${DEK_AAD_PREFIX}${accountId}`);
}

async function wrap(kek: CryptoKey, accountId: string, dek: Uint8Array<ArrayBuffer>): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aadFor(accountId) }, kek, dek),
  );
  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, nonce.length);
  return toBase64(out);
}

async function unwrap(kek: CryptoKey, accountId: string, wrapped: string): Promise<Uint8Array | null> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64(wrapped);
  } catch {
    return null;
  }
  if (bytes.length !== 12 + 32 + 16) return null;
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aadFor(accountId) },
        kek,
        bytes.subarray(12),
      ),
    );
  } catch {
    return null;
  }
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleKeyServiceRequest(request: Request, env: KeyServiceEnv): Promise<Response> {
  const auth = env.KEY_SERVICE_AUTH_SECRET?.trim();
  if (!auth || !env.PASSWORD_KEK_MASTER?.trim()) return refuse(503, "unconfigured");
  if (!sameSecret(request.headers.get(AUTH_HEADER) ?? "", auth)) return refuse(401, "unauthorized");
  if (request.method !== "POST") return refuse(405, "method_not_allowed");

  const path = new URL(request.url).pathname;
  const body = await readBody(request);
  const accountId = typeof body?.accountId === "string" ? body.accountId : "";
  if (!ACCOUNT_ID_PATTERN.test(accountId)) return refuse(400, "bad_account");
  const kek = await accountKek(env, accountId);
  if (!kek) return refuse(503, "unconfigured");

  if (path === "/v1/create") {
    const dek = crypto.getRandomValues(new Uint8Array(32));
    return json(200, { dek: toBase64(dek), wrappedDek: await wrap(kek, accountId, dek) });
  }
  if (path === "/v1/unwrap") {
    const wrapped = typeof body?.wrappedDek === "string" ? body.wrappedDek : "";
    const dek = await unwrap(kek, accountId, wrapped);
    if (!dek) return refuse(422, "unwrap_failed");
    return json(200, { dek: toBase64(dek) });
  }
  return refuse(404, "not_found");
}

export default {
  fetch: (request: Request, env: KeyServiceEnv) => handleKeyServiceRequest(request, env),
};
