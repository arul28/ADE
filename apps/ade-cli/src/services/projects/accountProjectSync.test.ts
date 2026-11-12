import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountProjectSync, readAccountProjectState, type AccountProjectHeartbeat } from "./accountProjectSync";
import type { ProjectRecord, ProjectRegistry } from "./projectRegistry";

/** A JWT whose payload names `sub`. The sync reads the subject without checking the signature. */
function tokenFor(sub: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ sub })}.signature`;
}

let adeDir = "";

beforeEach(() => {
  adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-account-sync-"));
});

afterEach(() => {
  fs.rmSync(adeDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("account project sync", () => {
  it("publishes nothing for an account that signed out or switched while the folder checks ran", async () => {
    let signedInAs: string | null = "account-a";
    const record = {
      projectId: "project-1",
      rootPath: "/home/dev/app",
      gitOriginUrl: "https://github.com/octo/app.git",
      catalogVisibility: "recent",
      registrationSource: "user",
      lastOpenedAt: 1,
      githubRepoId: null,
    } as unknown as ProjectRecord;
    const registry = {
      path: path.join(adeDir, "projects.json"),
      list: () => [record],
      setAccountLinks: () => 0,
      resolveMovedProjectId: () => null,
    } as unknown as Pick<ProjectRegistry, "list" | "setAccountLinks" | "resolveMovedProjectId" | "path">;
    const methods: string[] = [];
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ projects: [], cursor: 0, reset: true, copies: [] }), { status: 200 });
    });
    const sync = createAccountProjectSync({
      adeDir,
      registry,
      getAccountUserId: () => signedInAs,
      lookupRepo: vi.fn(async () => ({ kind: "not_found" as const })),
      // The person switches account while the folder check is in flight.
      readFolderStates: vi.fn(async (records: readonly unknown[]) => {
        signedInAs = "account-b";
        return records.map(() => "present" as const);
      }),
      isDevTestMachine: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const heartbeat: AccountProjectHeartbeat = {
      baseUrl: "https://directory.test",
      accessToken: tokenFor("account-a"),
      machineKey: "machine-1",
      accountOwnerId: null,
      accountProjectsCursor: 0,
    };

    sync.afterHeartbeat(heartbeat);
    await sync.idle();

    expect(methods).not.toContain("PUT");
    expect(readAccountProjectState(adeDir).published).toBeNull();
  });
});
