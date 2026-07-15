import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectSecretService } from "../../../../desktop/src/main/services/secrets/projectSecretService";
import type { AccountAuthService } from "./accountAuthService";
import { getSharedAccountAuthService } from "./sharedAccountAuthService";

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
  for (const service of activeServices.splice(0)) service.dispose();
  for (const target of tempPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
});

describe("getSharedAccountAuthService resolves CLERK OAuth config as an atomic pair", () => {
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
});
