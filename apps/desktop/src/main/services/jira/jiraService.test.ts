import { describe, expect, it, vi } from "vitest";
import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import type { JiraConnectArgs } from "../../../shared/types/jira";
import { createJiraCredentialService } from "./jiraCredentialService";
import { createJiraService } from "./jiraService";

class MemoryCredentialStore implements SyncCredentialStore {
  private values = new Map<string, string>();

  async get(key: string): Promise<string | null> { return this.getSync(key); }
  async set(key: string, value: string): Promise<void> { this.setSync(key, value); }
  async delete(key: string): Promise<void> { this.deleteSync(key); }
  getSync(key: string): string | null { return this.values.get(key) ?? null; }
  setSync(key: string, value: string): void { this.values.set(key, value); }
  deleteSync(key: string): void { this.values.delete(key); }
  updateSync(updater: (values: Record<string, string>) => boolean | void): void {
    const next = Object.fromEntries(this.values);
    if (updater(next) === false) return;
    this.values = new Map(Object.entries(next));
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function myself(accountId: string, displayName: string) {
  return { accountId, displayName, emailAddress: `${accountId}@example.test` };
}

function authorization(credentials: JiraConnectArgs): string {
  return `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString("base64")}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("createJiraService credential changes", () => {
  const oldCredentials = {
    siteUrl: "https://old.atlassian.net",
    email: "old@example.test",
    apiToken: "old-token",
  };
  const newCredentials = {
    siteUrl: "https://new.atlassian.net",
    email: "new@example.test",
    apiToken: "new-token",
  };

  it("keeps a saved connected account when a candidate connect is rejected", async () => {
    const store = new MemoryCredentialStore();
    const credentials = createJiraCredentialService({ credentialStore: store });
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === authorization(oldCredentials)) return response(myself("old-account", "Old account"));
      return response({ errorMessages: ["Unauthorized"] }, 401);
    });
    const service = createJiraService({ credentials, fetchImpl });

    await service.connect(oldCredentials);
    await expect(service.connect(newCredentials)).rejects.toThrow("Unauthorized");

    const status = await service.getConnectionStatus();
    expect(status).toMatchObject({
      connected: true,
      siteUrl: oldCredentials.siteUrl,
      email: oldCredentials.email,
      account: { accountId: "old-account", displayName: "Old account" },
      error: null,
    });
    expect(credentials.getCredentials()).toEqual(oldCredentials);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ignores an old credential probe that resolves after a new account connects", async () => {
    const store = new MemoryCredentialStore();
    const credentials = createJiraCredentialService({ credentialStore: store });
    credentials.setCredentials(oldCredentials);
    const oldProbeStarted = deferred<void>();
    const oldProbeResponse = deferred<Response>();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      if (auth === authorization(oldCredentials)) {
        oldProbeStarted.resolve();
        return await oldProbeResponse.promise;
      }
      return response(myself("new-account", "New account"));
    });
    const service = createJiraService({ credentials, fetchImpl });

    const oldProbe = service.getConnectionStatus();
    await oldProbeStarted.promise;
    await service.connect(newCredentials);
    oldProbeResponse.resolve(response(myself("old-account", "Old account")));
    await oldProbe;

    const status = await service.getConnectionStatus();
    expect(status).toMatchObject({
      connected: true,
      siteUrl: newCredentials.siteUrl,
      email: newCredentials.email,
      account: { accountId: "new-account", displayName: "New account" },
      error: null,
    });
    expect(credentials.getCredentials()).toEqual(newCredentials);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
