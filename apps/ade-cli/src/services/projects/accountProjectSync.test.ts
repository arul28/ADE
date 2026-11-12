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

  it("counts a project opened on purpose as a copy in a hidden folder, but the first fill adds only real folders", async () => {
    const records = ([
      // [folder, source, name]
      ["/home/dev/work/app", "desktop", "app"],
      ["/home/dev/.dotfiles", "desktop", "dotfiles"],
      ["C:\\Users\\dev\\.config\\nvim", "cli-explicit", "nvim"],
      ["/home/dev/scratch/tool", "mobile", "tool"],
      // Not copies: found and never opened, a tool's folder, the OS temp folder.
      ["/home/dev/.cache/found", "runtime-auto", "found"],
      ["/home/dev/work/app/node_modules/dep", "desktop", "dep"],
      ["C:\\Users\\dev\\src\\app\\.claude\\worktrees\\lane", "desktop", "lane"],
      ["/home/dev/work/app/.ade/worktrees/lane", "cli-explicit", "adelane"],
      [path.join(os.tmpdir(), "probe"), "desktop", "probe"],
    ] as const).map(([rootPath, registrationSource, name], index) => ({
      projectId: `project-${index}`,
      rootPath,
      gitOriginUrl: `https://github.com/octo/${name}.git`,
      catalogVisibility: "recent",
      registrationSource,
      lastOpenedAt: 1_000_000 - index,
    }) as unknown as ProjectRecord);
    const registry = {
      path: path.join(adeDir, "projects.json"),
      list: () => records,
      setAccountLinks: () => 0,
      resolveMovedProjectId: () => null,
    } as unknown as Pick<ProjectRegistry, "list" | "setAccountLinks" | "resolveMovedProjectId" | "path">;
    const published: Array<{ name: string; add: string }> = [];
    const fetchImpl = vi.fn(async (_url: URL | string, init?: RequestInit) => {
      if (init?.method === "PUT") published.push(...JSON.parse(String(init.body)).copies);
      return new Response(JSON.stringify({ projects: [], cursor: 0, reset: true, copies: [] }), { status: 200 });
    });
    const sync = createAccountProjectSync({
      adeDir,
      registry,
      getAccountUserId: () => "account-a",
      lookupRepo: vi.fn(async () => ({ kind: "not_found" as const })),
      readFolderStates: vi.fn(async (list: readonly unknown[]) => list.map(() => "present" as const)),
      isDevTestMachine: () => false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 1_000_000,
    });

    sync.afterHeartbeat({ baseUrl: "https://directory.test", accessToken: tokenFor("account-a"), machineKey: "machine-1", accountOwnerId: null, accountProjectsCursor: 0 });
    await sync.idle();

    expect(Object.fromEntries(published.map((copy) => [copy.name, copy.add]))).toEqual({
      app: "auto",
      dotfiles: "none",
      nvim: "none",
      tool: "none",
    });
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
});
