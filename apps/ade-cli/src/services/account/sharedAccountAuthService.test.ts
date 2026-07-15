import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProjectSecretService } from "../../../../desktop/src/main/services/secrets/projectSecretService";
import type { AccountAuthService } from "./accountAuthService";
import {
  DEFAULT_ADE_CLERK_ISSUER,
  DEFAULT_ADE_CLERK_JWKS_URL,
  DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
  DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL,
  DEVELOPMENT_ADE_CLERK_ISSUER,
  DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
} from "../../../../desktop/src/shared/accountDirectory";
import {
  getSharedAccountAttestationConfig,
  getSharedAccountAuthService,
  registerAccountConfigProjectRoot,
} from "./sharedAccountAuthService";

const tempPaths: string[] = [];
const activeServices: AccountAuthService[] = [];

function makeProjectRoot(secrets: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-shared-account-"));
  tempPaths.push(root);
  const service = createProjectSecretService(root);
  for (const [name, value] of Object.entries(secrets)) {
    service.set({ name, value });
  }
  return root;
}

function uniqueSecretsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-shared-account-store-"));
  tempPaths.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const service of activeServices.splice(0)) service.dispose();
  for (const target of tempPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("getSharedAccountAuthService resolves CLERK OAuth config as an atomic pair", () => {
  it("uses ADE production when no project or environment override exists", async () => {
    const service = getSharedAccountAuthService({
      secretsDir: uniqueSecretsDir(),
      projectRoots: () => [],
      env: {} as NodeJS.ProcessEnv,
    });
    activeServices.push(service);

    const start = await service.startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    expect(authorizeUrl.origin).toBe(DEFAULT_ADE_CLERK_ISSUER);
    expect(authorizeUrl.searchParams.get("client_id")).toBe(
      DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
    );
  });

  it("routes a development Clerk project through the isolated development device bridge", async () => {
    const developmentRoot = makeProjectRoot({
      CLERK_ISSUER: DEVELOPMENT_ADE_CLERK_ISSUER,
      CLERK_OAUTH_CLIENT_ID: DEVELOPMENT_ADE_CLERK_OAUTH_CLIENT_ID,
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        device_code: "device-code",
        user_code: "ABCD-EFGH",
        verification_uri: `${DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL}/device`,
        verification_uri_complete: `${DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 5,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const service = getSharedAccountAuthService({
      secretsDir: uniqueSecretsDir(),
      projectRoots: () => [developmentRoot],
      env: {} as NodeJS.ProcessEnv,
    });
    activeServices.push(service);

    await service.startDeviceLogin();

    expect(requests).toEqual([`${DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL}/device/code`]);
  });

  it("does not combine an issuer from one project with a clientId from another", async () => {
    const issuerRoot = makeProjectRoot({ CLERK_ISSUER: "https://issuer-a.example.test" });
    const clientRoot = makeProjectRoot({ CLERK_OAUTH_CLIENT_ID: "client-from-b" });
    const service = getSharedAccountAuthService({
      secretsDir: uniqueSecretsDir(),
      projectRoots: () => [issuerRoot, clientRoot],
      env: {} as NodeJS.ProcessEnv,
    });
    activeServices.push(service);

    // The first root yields only an issuer; its clientId half must come from that
    // same root or env — never cross-mixed from clientRoot. With no env fallback
    // the pair is incomplete, so login is reported unconfigured rather than
    // silently pairing issuer-a with client-from-b.
    await expect(service.startLogin()).rejects.toThrow(/not configured/i);
  });

  it("fills the missing half of the winning root's pair from env", async () => {
    const issuerRoot = makeProjectRoot({ CLERK_ISSUER: "https://issuer-a.example.test" });
    const service = getSharedAccountAuthService({
      secretsDir: uniqueSecretsDir(),
      projectRoots: () => [issuerRoot],
      env: { CLERK_OAUTH_CLIENT_ID: "client-from-env" } as NodeJS.ProcessEnv,
    });
    activeServices.push(service);

    const start = await service.startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    expect(authorizeUrl.origin).toBe("https://issuer-a.example.test");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client-from-env");
  });

  it("prioritizes the invoking project root over a project registered earlier", async () => {
    const otherRoot = makeProjectRoot({
      CLERK_ISSUER: "https://other.example.test",
      CLERK_OAUTH_CLIENT_ID: "other-client",
    });
    const invokingRoot = makeProjectRoot({
      CLERK_ISSUER: "https://invoking.example.test",
      CLERK_OAUTH_CLIENT_ID: "invoking-client",
    });
    const secretsDir = uniqueSecretsDir();
    // `other` is registered first (as registerAccountProjects would for the
    // machine's registered projects); `ade login` then prioritizes its invoking
    // root so that project's Clerk app wins, not `other`'s.
    registerAccountConfigProjectRoot(otherRoot, secretsDir);
    registerAccountConfigProjectRoot(invokingRoot, secretsDir, { prioritize: true });
    const service = getSharedAccountAuthService({
      secretsDir,
      projectRoots: () => [],
      env: {} as NodeJS.ProcessEnv,
    });
    activeServices.push(service);

    const start = await service.startLogin();
    const authorizeUrl = new URL(start.authorizeUrl);
    expect(authorizeUrl.origin).toBe("https://invoking.example.test");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("invoking-client");
  });
});

describe("getSharedAccountAttestationConfig", () => {
  it("uses the complete ADE production verifier when there are no overrides", () => {
    expect(getSharedAccountAttestationConfig({
      secretsDir: uniqueSecretsDir(),
      projectRoots: () => [],
      env: {} as NodeJS.ProcessEnv,
    })).toEqual({
      issuer: DEFAULT_ADE_CLERK_ISSUER,
      jwksUrl: DEFAULT_ADE_CLERK_JWKS_URL,
      oauthClientId: DEFAULT_ADE_CLERK_OAUTH_CLIENT_ID,
    });
  });

  it("resolves issuer, JWKS URL, and OAuth client id from one winning project", () => {
    const issuerRoot = makeProjectRoot({ CLERK_ISSUER: "https://issuer-a.example.test" });
    const otherRoot = makeProjectRoot({
      CLERK_JWKS_URL: "https://wrong-project.example.test/jwks",
      CLERK_OAUTH_CLIENT_ID: "wrong-project-client",
    });

    expect(getSharedAccountAttestationConfig({
      secretsDir: uniqueSecretsDir(),
      projectRoots: () => [issuerRoot, otherRoot],
      env: {
        CLERK_JWKS_URL: "https://env.example.test/jwks",
        CLERK_OAUTH_CLIENT_ID: "env-client",
      } as NodeJS.ProcessEnv,
    })).toEqual({
      issuer: "https://issuer-a.example.test",
      jwksUrl: "https://env.example.test/jwks",
      oauthClientId: "env-client",
    });
  });
});
