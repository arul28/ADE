import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  kimiWorkDirKey,
  listKimiSessionCandidates,
  selectKimiLaunchSession,
} from "./ptyService";

// Fixtures follow Kimi Code 0.39.1's on-disk layout, read from the installed
// binary (`encodeWorkDirKey`, session-store.ts): no Kimi sessions exist on the
// machine this was written on, so the layout is verified against the binary's
// source, not against a live session.
describe("Kimi session capture", () => {
  let root: string;
  let kimiHome: string;
  let cwd: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ade-kimi-capture-")));
    kimiHome = path.join(root, ".kimi-code");
    cwd = path.join(root, "work", "My Repo!");
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeSession(bucket: string, id: string, state: Record<string, unknown> | null, history: "wire" | "context" | null = "wire") {
    const dir = path.join(kimiHome, "sessions", bucket, id);
    fs.mkdirSync(dir, { recursive: true });
    if (state) fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state));
    if (history === "wire") {
      fs.mkdirSync(path.join(dir, "agents", "main"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agents", "main", "wire.jsonl"), "{}\n");
    } else if (history === "context") {
      fs.writeFileSync(path.join(dir, "context.jsonl"), "{}\n");
    }
    return dir;
  }

  it("reproduces Kimi's workspace bucket name", () => {
    // Real entry from ~/.kimi-code/workspaces.json on the dev machine.
    expect(kimiWorkDirKey("/Users/admin")).toBe("wd_admin_2151c536b962");
    expect(kimiWorkDirKey("/tmp/My Repo!")).toMatch(/^wd_my-repo_[0-9a-f]{12}$/);
    expect(kimiWorkDirKey("/")).toMatch(/^wd_workspace_[0-9a-f]{12}$/);
    expect(kimiWorkDirKey(`/x/${"a".repeat(60)}`)).toMatch(new RegExp(`^wd_${"a".repeat(40)}_[0-9a-f]{12}$`));
    // Windows paths hash their forward-slash spelling.
    expect(kimiWorkDirKey("C:\\Users\\dev\\ADE")).toMatch(/^wd_ade_[0-9a-f]{12}$/);
    expect(kimiWorkDirKey("C:\\Users\\dev\\ADE")).toBe(kimiWorkDirKey("C:/Users/dev/ADE"));
  });

  it("lists sessions from the cwd's bucket and ignores other buckets", () => {
    const now = Date.now();
    writeSession(kimiWorkDirKey(cwd), "session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", { workDir: cwd, createdAt: now });
    writeSession(kimiWorkDirKey(cwd), "session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", null, "context");
    writeSession(kimiWorkDirKey(path.join(root, "elsewhere")), "session_cccccccc-cccc-4ccc-8ccc-cccccccccccc", { createdAt: now });
    // A folder with neither state nor history is not a session yet.
    writeSession(kimiWorkDirKey(cwd), "session_dddddddd-dddd-4ddd-8ddd-dddddddddddd", null, null);

    const ids = listKimiSessionCandidates({ kimiHome, cwd }).map((candidate) => candidate.id).sort();
    expect(ids).toEqual([
      "session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "session_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    ]);
  });

  it("also reads buckets that workspaces.json maps to this cwd", () => {
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.writeFileSync(path.join(kimiHome, "workspaces.json"), JSON.stringify({
      version: 1,
      workspaces: { wd_alias_0123456789ab: { root: cwd, name: "alias" } },
      deleted_workspace_ids: [],
    }));
    writeSession("wd_alias_0123456789ab", "session_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { workDir: cwd, createdAt: Date.now() });
    expect(listKimiSessionCandidates({ kimiHome, cwd }).map((candidate) => candidate.id))
      .toEqual(["session_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]);
  });

  it("ignores a workspaces.json id that would leave the sessions folder", () => {
    fs.mkdirSync(kimiHome, { recursive: true });
    const escaping = "wd_x/../../../outside";
    fs.writeFileSync(path.join(kimiHome, "workspaces.json"), JSON.stringify({
      version: 1,
      workspaces: { [escaping]: { root: cwd, name: "escape" } },
    }));
    writeSession(escaping, "session_ffffffff-ffff-4fff-8fff-ffffffffffff", { workDir: cwd, createdAt: Date.now() });
    expect(listKimiSessionCandidates({ kimiHome, cwd })).toEqual([]);
  });

  it("selects the session born in the launch window, preferring a recorded cwd", () => {
    const startedAtMs = Date.parse("2026-09-23T12:00:00.000Z");
    const bucket = kimiWorkDirKey(cwd);
    writeSession(bucket, "session_11111111-1111-4111-8111-111111111111", { workDir: cwd, createdAt: startedAtMs - 60_000 });
    writeSession(bucket, "session_22222222-2222-4222-8222-222222222222", { createdAt: new Date(startedAtMs + 2_000).toISOString() });
    writeSession(bucket, "session_33333333-3333-4333-8333-333333333333", { workDir: cwd, createdAt: startedAtMs + 5_000 });
    writeSession(bucket, "session_44444444-4444-4444-8444-444444444444", { workDir: path.join(root, "other"), createdAt: startedAtMs + 1_000 });

    const candidates = listKimiSessionCandidates({ kimiHome, cwd });
    const best = selectKimiLaunchSession({
      candidates,
      cwd,
      startedAtMs,
      excludedIds: new Set(),
      maxStartDeltaMs: 120_000,
    });
    // #1 predates the launch, #4 records another cwd, #3 proved its cwd.
    expect(best).toMatchObject({ id: "session_33333333-3333-4333-8333-333333333333", cwdMatched: true });

    const withoutProven = selectKimiLaunchSession({
      candidates,
      cwd,
      startedAtMs,
      excludedIds: new Set(["session_33333333-3333-4333-8333-333333333333"]),
      maxStartDeltaMs: 120_000,
    });
    expect(withoutProven).toMatchObject({ id: "session_22222222-2222-4222-8222-222222222222", cwdMatched: false });
  });

  it("captures nothing when no session was born after the launch", () => {
    const startedAtMs = Date.now();
    writeSession(kimiWorkDirKey(cwd), "session_55555555-5555-4555-8555-555555555555", { workDir: cwd, createdAt: startedAtMs - 10 * 60_000 });
    expect(selectKimiLaunchSession({
      candidates: listKimiSessionCandidates({ kimiHome, cwd }),
      cwd,
      startedAtMs,
      excludedIds: new Set(),
      maxStartDeltaMs: 120_000,
    })).toBeNull();
  });
});
