import { describe, expect, it } from "vitest";
import { handleKeyServiceRequest, type KeyServiceEnv } from "../src/index";

const master = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7 + 3)));
const env: KeyServiceEnv = { PASSWORD_KEK_MASTER: master, KEY_SERVICE_AUTH_SECRET: "relay-shared-secret" };

function call(path: string, body: unknown, overrides: { env?: KeyServiceEnv; auth?: string | null } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const auth = overrides.auth === undefined ? "relay-shared-secret" : overrides.auth;
  if (auth !== null) headers.set("x-ade-key-service-auth", auth);
  return handleKeyServiceRequest(
    new Request(`https://key-service.internal${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    overrides.env ?? env,
  );
}

describe("password key service", () => {
  it("gives back the same vault key it wrapped, only for the same account", async () => {
    const created = await call("/v1/create", { accountId: "user_a" });
    expect(created.status).toBe(200);
    const { dek, wrappedDek } = (await created.json()) as { dek: string; wrappedDek: string };
    expect(atob(dek)).toHaveLength(32);
    expect(wrappedDek).not.toContain(dek);

    const opened = await call("/v1/unwrap", { accountId: "user_a", wrappedDek });
    expect(opened.status).toBe(200);
    expect(((await opened.json()) as { dek: string }).dek).toBe(dek);

    // Another account's KEK cannot open it.
    const stolen = await call("/v1/unwrap", { accountId: "user_b", wrappedDek });
    expect(stolen.status).toBe(422);
    expect(await stolen.text()).not.toContain(dek);
  });

  it.each([
    ["no auth header", { auth: null }, 401],
    ["the wrong auth secret", { auth: "relay-shared-secreT" }, 401],
    ["no master key configured", { env: { KEY_SERVICE_AUTH_SECRET: "relay-shared-secret" } }, 503],
    ["a master key of the wrong length", { env: { ...env, PASSWORD_KEK_MASTER: btoa("short") } }, 503],
  ] as const)("refuses with %s", async (_label, overrides, status) => {
    const response = await call("/v1/create", { accountId: "user_a" }, overrides);
    expect(response.status).toBe(status);
    expect(await response.text()).not.toMatch(/dek/i);
  });

  it("rejects a malformed account id and a tampered wrapped key", async () => {
    expect((await call("/v1/create", { accountId: "user a\n" })).status).toBe(400);
    const { wrappedDek } = (await (await call("/v1/create", { accountId: "user_a" })).json()) as { wrappedDek: string };
    const bytes = Uint8Array.from(atob(wrappedDek), (c) => c.charCodeAt(0));
    bytes[20] = bytes[20]! ^ 1;
    const tampered = btoa(String.fromCharCode(...bytes));
    expect((await call("/v1/unwrap", { accountId: "user_a", wrappedDek: tampered })).status).toBe(422);
  });
});
