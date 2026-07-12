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
  it.each(["present", "absent", "error"] as const)("classifies MCP startup failures with a %s rollout probe", (probe) => {
    const result = classifyCodexResumeFailure(new Error("MCP server startup failed"), "thread-a", {
      codexHome: codexHome(probe, "thread-a"),
    });
    expect(result.kind).toBe("provider_environment");
    expect(result.rolloutFileFound).toBe(probe === "present" ? true : probe === "absent" ? false : null);
  });

  it.each(["present", "absent", "error"] as const)("classifies timeout failures with a %s rollout probe", (probe) => {
    const result = classifyCodexResumeFailure("socket connection timed out", "thread-b", {
      codexHome: codexHome(probe, "thread-b"),
    });
    expect(result.kind).toBe("transient");
  });

  it("classifies a missing local and provider thread as thread_missing", () => {
    const result = classifyCodexResumeFailure("thread not found", "thread-c", {
      codexHome: codexHome("absent", "thread-c"),
    });
    expect(result).toMatchObject({ kind: "thread_missing", rolloutFileFound: false });
  });

  it("does not trust provider deletion when the rollout still exists", () => {
    const result = classifyCodexResumeFailure("unknown thread: not found", "thread-d", {
      codexHome: codexHome("present", "thread-d"),
    });
    expect(result).toMatchObject({ kind: "unknown", rolloutFileFound: true });
  });

  it("keeps not-found unknown when the rollout probe is unavailable", () => {
    const result = classifyCodexResumeFailure("no thread was found", "thread-e", {
      codexHome: codexHome("error", "thread-e"),
    });
    expect(result).toMatchObject({ kind: "unknown", rolloutFileFound: null });
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

  it.each(["present", "absent", "error"] as const)("keeps gibberish unknown with a %s rollout probe", (probe) => {
    const result = classifyCodexResumeFailure("purple banana", "thread-f", {
      codexHome: codexHome(probe, "thread-f"),
    });
    expect(result.kind).toBe("unknown");
  });
});
