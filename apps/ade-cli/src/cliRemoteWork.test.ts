import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRemoteAndroidArgs } from "./cliRemoteWork";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A checkout whose commit is on origin, with one uncommitted file. */
let root = "";
let checkout = "";
let head = "";

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-remote-work-"));
  const origin = path.join(root, "origin.git");
  checkout = path.join(root, "checkout");
  git(root, "init", "-q", "--bare", origin);
  git(root, "init", "-q", "-b", "main", checkout);
  git(checkout, "config", "user.email", "test@example.com");
  git(checkout, "config", "user.name", "Test");
  fs.writeFileSync(path.join(checkout, "build.gradle.kts"), "// app\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "-q", "-m", "init");
  git(checkout, "remote", "add", "origin", origin);
  git(checkout, "push", "-q", "origin", "main");
  head = git(checkout, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(checkout, "Greeting.kt"), "fun greeting() = \"hi\"\n");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("withRemoteAndroidArgs", () => {
  // `--machine` with no `--lane`: a verb that builds the lane's code must carry
  // the uncommitted changes to the other machine; other verbs use the copy as
  // it is, and machine reads make no copy at all.
  it.each([
    ["renderComposePreviews", {}, "sync"],
    ["listComposePreviews", { module: "ui" }, "sync"],
    ["runInstrumentationTests", {}, "sync"],
    ["installApp", { gradle: true }, "sync"],
    ["installApp", {}, "head"],
    ["setPosture", { angle: 90 }, "head"],
    ["listSystemImages", {}, "none"],
  ] as const)("%s %o sends %s", (action, args, expected) => {
    const params = { name: "run_ade_action", arguments: { domain: "android_emulator", action, args: { ...args, chatSessionId: "chat-1" } } };
    const sent = withRemoteAndroidArgs(params, checkout) as { arguments: { args: Record<string, unknown> } };
    const remoteWork = sent.arguments.args.remoteWork as Record<string, unknown>;
    // The other machine sets the chat from the caller's identity.
    expect(sent.arguments.args.chatSessionId).toBeUndefined();
    if (expected === "sync") {
      expect(remoteWork.head).toBe(head);
      expect(remoteWork.fetchRef).toBe("main");
      expect(Buffer.from(String(remoteWork.patchBase64), "base64").toString("utf8")).toContain("Greeting.kt");
    } else if (expected === "head") {
      expect(remoteWork).toEqual({ head, fetchRef: "main", branch: "main", sync: "none" });
    } else {
      expect(remoteWork).toEqual({ sync: "none" });
    }
  });
});
