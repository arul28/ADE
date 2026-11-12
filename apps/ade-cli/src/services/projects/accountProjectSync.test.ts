import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountProjectSync, readAccountProjectState, type AccountProjectHeartbeat } from "./accountProjectSync";
import type { ProjectRecord, ProjectRegistry } from "./projectRegistry";
import { publicAccountProjectFields, publicProjectRecord } from "./publicProjectRecord";

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

  // What a phone or another computer receives for a linked folder: the link
  // only for the account it was made for, and never the account id.
  it.each<[string, string | null, boolean]>([
    ["the owner is signed in", "account-a", true],
    ["another account is signed in", "account-b", false],
    ["no account is signed in", null, false],
  ])("sends a folder's account project link only when %s", (_label, signedIn, sendsLink) => {
    const linkId = "ap_0123456789abcdef0123456789abcdef";
    const record = { projectId: "project-1", accountProjectId: linkId, accountProjectUserId: "account-a", githubRepoId: 42 };
    const answer = publicProjectRecord(record, () => signedIn);
    const fields = publicAccountProjectFields(record, signedIn);

    expect(answer.projectId).toBe("project-1");
    expect(answer.accountProjectId).toBe(sendsLink ? linkId : undefined);
    expect(fields).toEqual(sendsLink ? { accountProjectId: linkId, githubRepoId: 42 } : { githubRepoId: 42 });
    expect(JSON.stringify([answer, fields])).not.toContain("account-a");
  });

  // "Use for new lanes": the folder the person picks is the one the account
  // gets as main, on the next publish and the ones after it.
  it("publishes the folder picked for new lanes as the main copy and keeps it", async () => {
    const folder = (projectId: string, lastOpenedAt: number) => ({
      projectId,
      rootPath: `/home/dev/${projectId}`,
      gitOriginUrl: "https://github.com/octo/app.git",
      catalogVisibility: "recent",
      registrationSource: "user",
      lastOpenedAt,
      githubRepoId: null,
    }) as unknown as ProjectRecord;
    // project-1 was opened last, so it is the main copy until a pick.
    const records = [folder("project-1", 2), folder("project-2", 1)];
    const registry = {
      path: path.join(adeDir, "projects.json"),
      list: () => records,
      setAccountLinks: () => 0,
      resolveMovedProjectId: () => null,
    } as unknown as Pick<ProjectRegistry, "list" | "setAccountLinks" | "resolveMovedProjectId" | "path">;
    const published: Array<Record<string, boolean>> = [];
    let directoryDown = false;
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      if (directoryDown) return new Response("{}", { status: 503 });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { copies: Array<{ checkoutId: string; isMain: boolean }> };
        published.push(Object.fromEntries(body.copies.map((copy) => [copy.checkoutId, copy.isMain])));
      }
      return new Response(JSON.stringify({ projects: [], cursor: 0, reset: true, copies: [] }), { status: 200 });
    });
    let now = 1_000_000;
    const sync = createAccountProjectSync({
      adeDir,
      registry,
      getAccountUserId: () => "account-a",
      lookupRepo: vi.fn(async () => ({ kind: "not_found" as const })),
      readFolderStates: vi.fn(async (list: readonly unknown[]) => list.map(() => "present" as const)),
      isDevTestMachine: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });
    const heartbeat: AccountProjectHeartbeat = {
      baseUrl: "https://directory.test",
      accessToken: tokenFor("account-a"),
      machineKey: "machine-1",
      accountOwnerId: null,
      accountProjectsCursor: 0,
    };
    const beat = async () => {
      now += 60 * 60_000;
      sync.afterHeartbeat(heartbeat);
      await sync.idle();
    };

    await beat();
    expect(published.at(-1)).toEqual({ "project-1": true, "project-2": false });
    expect(sync.publishPending()).toBe(false);

    await expect(sync.setMainCheckout("project-3")).resolves.toMatchObject({ ok: false, code: "not_a_copy" });
    await expect(sync.setMainCheckout("project-2")).resolves.toEqual({ ok: true, checkoutId: "project-2", changed: true });
    // The upload fails: the pick is saved here, and the phone is told the
    // account does not have it yet (`published: false`).
    directoryDown = true;
    await beat();
    expect(published.at(-1)).toEqual({ "project-1": true, "project-2": false });
    expect(sync.publishPending()).toBe(true);
    expect(readAccountProjectState(adeDir).mainCheckouts).toEqual(["project-2"]);
    directoryDown = false;
    await beat();
    expect(published.at(-1)).toEqual({ "project-1": false, "project-2": true });
    expect(sync.publishPending()).toBe(false);

    // Opening the other folder later does not take the pick back.
    records[0] = folder("project-1", 3);
    await beat();
    expect(published.at(-1) ?? {}).not.toMatchObject({ "project-1": true });
    expect(readAccountProjectState(adeDir).mainCheckouts).toEqual(["project-2"]);
  });
});
