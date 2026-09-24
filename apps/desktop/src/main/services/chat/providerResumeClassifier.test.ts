import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyCodexResumeFailure } from "./providerResumeClassifier";

const roots: string[] = [];

function codexHome(kind: "present" | "absent" | "error", threadId: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-resume-classifier-"));
  roots.push(root);
  if (kind === "error") {
    fs.writeFileSync(path.join(root, "sessions"), "not a directory");
    return root;
  }
  const day = path.join(root, "sessions", "2026", "07", "12");
  fs.mkdirSync(day, { recursive: true });
  if (kind === "present") {
    fs.writeFileSync(path.join(day, `rollout-test-${threadId}.jsonl`), "{}\n");
  }
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("classifyCodexResumeFailure", () => {
  // The rollout probe decides only whether a "not found" is trusted: a thread
  // is missing only when the provider says so AND no local rollout exists.
  it.each([
    [new Error("MCP server startup failed"), "present", "provider_environment", true],
    ["socket connection timed out", "absent", "transient", false],
    ["thread not found", "absent", "thread_missing", false],
    ["unknown thread: not found", "present", "unknown", true],
    ["no thread was found", "error", "unknown", null],
    ["purple banana", "absent", "unknown", false],
  ] as const)("classifies %s with a %s rollout as %s", (error, probe, kind, rolloutFileFound) => {
    const result = classifyCodexResumeFailure(error, "thread-a", {
      codexHome: codexHome(probe, "thread-a"),
    });
    expect(result).toMatchObject({ kind, rolloutFileFound });
  });

  it("keeps not-found unknown when the rollout probe exhausts its entry budget", () => {
    const root = codexHome("absent", "thread-budget");
    fs.mkdirSync(path.join(root, "sessions", "pending"));

    const result = classifyCodexResumeFailure("thread not found", "thread-budget", {
      codexHome: root,
      maxEntries: 1,
    });

    expect(result).toMatchObject({ kind: "unknown", rolloutFileFound: null });
  });
});
