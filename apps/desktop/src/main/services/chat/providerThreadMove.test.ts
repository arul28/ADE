import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findInstanceHoldingThread, moveProviderThread } from "./providerThreadMove";

/**
 * Every case uses its own temp config homes. `moveProviderThread` copies local
 * provider transcripts, so a test must never point it at a real `~/.claude` or
 * `~/.codex`.
 */
let root: string;
let fromHome: string;
let toHome: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-thread-move-"));
  fromHome = path.join(root, "from");
  toHome = path.join(root, "to");
  fs.mkdirSync(fromHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeClaudeThread(threadId: string, body: string): string {
  const projectDir = path.join(fromHome, "projects", "-Users-me-repo");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${threadId}.jsonl`);
  fs.writeFileSync(filePath, body, "utf8");
  return filePath;
}

describe("moveProviderThread", () => {
  it("copies a Claude thread and its sidecar folder to the same relative path", async () => {
    const threadId = "claude-thread-1";
    const sourcePath = writeClaudeThread(threadId, '{"type":"user"}\n');
    // Large tool results and subagent transcripts live in a folder beside the
    // transcript and must move with it.
    const sidecar = path.join(path.dirname(sourcePath), threadId);
    fs.mkdirSync(sidecar, { recursive: true });
    fs.writeFileSync(path.join(sidecar, "subagent.json"), "sidecar", "utf8");

    const result = await moveProviderThread({
      provider: "claude",
      threadId,
      fromConfigHome: fromHome,
      toConfigHome: toHome,
    });

    const targetPath = path.join(toHome, "projects", "-Users-me-repo", `${threadId}.jsonl`);
    expect(result).toEqual({ ok: true, targetPath });
    expect(fs.readFileSync(targetPath, "utf8")).toBe('{"type":"user"}\n');
    expect(fs.readFileSync(path.join(toHome, "projects", "-Users-me-repo", threadId, "subagent.json"), "utf8"))
      .toBe("sidecar");
    // The source stays so the old account can still resume the thread.
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it("replaces an older copy already in the target home", async () => {
    const threadId = "claude-thread-2";
    writeClaudeThread(threadId, "the newer source\n");
    const targetPath = path.join(toHome, "projects", "-Users-me-repo", `${threadId}.jsonl`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, "a stale copy\n", "utf8");

    const result = await moveProviderThread({
      provider: "claude",
      threadId,
      fromConfigHome: fromHome,
      toConfigHome: toHome,
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toBe("the newer source\n");
  });

  it("reports a Claude thread that is not in the source home", async () => {
    await expect(moveProviderThread({
      provider: "claude",
      threadId: "missing-thread",
      fromConfigHome: fromHome,
      toConfigHome: toHome,
    })).resolves.toEqual({
      ok: false,
      reason: "thread_not_found",
      message: expect.stringContaining("missing-thread"),
    });
  });

  it("copies a Codex rollout to the same relative path in the target home", async () => {
    const threadId = "codex-thread-1";
    const rolloutDir = path.join(fromHome, "sessions", "2026", "10", "01");
    fs.mkdirSync(rolloutDir, { recursive: true });
    const rolloutName = `rollout-2026-10-01T00-00-00-${threadId}.jsonl`;
    fs.writeFileSync(path.join(rolloutDir, rolloutName), "codex rollout\n", "utf8");

    const result = await moveProviderThread({
      provider: "codex",
      threadId,
      fromConfigHome: fromHome,
      toConfigHome: toHome,
    });

    const targetPath = path.join(toHome, "sessions", "2026", "10", "01", rolloutName);
    expect(result).toEqual({ ok: true, targetPath });
    expect(fs.readFileSync(targetPath, "utf8")).toBe("codex rollout\n");
  });

  it("reports a Codex rollout that is not in the source home", async () => {
    fs.mkdirSync(path.join(fromHome, "sessions", "2026", "10", "01"), { recursive: true });

    await expect(moveProviderThread({
      provider: "codex",
      threadId: "codex-missing",
      fromConfigHome: fromHome,
      toConfigHome: toHome,
    })).resolves.toEqual({
      ok: false,
      reason: "thread_not_found",
      message: expect.stringContaining("codex-missing"),
    });
  });

  it("refuses to move a thread between a home and itself", async () => {
    const threadId = "claude-thread-same";
    writeClaudeThread(threadId, "{}\n");

    await expect(moveProviderThread({
      provider: "claude",
      threadId,
      fromConfigHome: fromHome,
      toConfigHome: fromHome,
    })).resolves.toEqual({
      ok: false,
      reason: "same_home",
      message: expect.any(String),
    });
  });

  it("reports copy_failed when the target home cannot be written", async () => {
    const threadId = "claude-thread-blocked";
    writeClaudeThread(threadId, "{}\n");
    // A file where the target directory should be makes the copy fail.
    const blockedTarget = path.join(root, "blocked-home");
    fs.writeFileSync(blockedTarget, "not a directory", "utf8");

    const result = await moveProviderThread({
      provider: "claude",
      threadId,
      fromConfigHome: fromHome,
      toConfigHome: blockedTarget,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("copy_failed");
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

describe("findInstanceHoldingThread", () => {
  const claudeThread = "11111111-2222-4333-8444-555555555555";
  // A v7 id: its first 48 bits are the creation time, which names the day folder.
  const codexThread = "0190f5a2-3b40-7c00-8000-000000000001";

  function home(name: string): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeClaude(configHome: string, threadId: string): void {
    const projectDir = path.join(configHome, "projects", "-Users-me-repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${threadId}.jsonl`), "{}\n", "utf8");
  }

  function writeCodex(configHome: string, threadId: string): void {
    const createdAt = new Date(Number.parseInt(threadId.replace(/-/g, "").slice(0, 12), 16));
    const pad = (value: number) => String(value).padStart(2, "0");
    const dayDir = path.join(
      configHome,
      "sessions",
      String(createdAt.getFullYear()),
      pad(createdAt.getMonth() + 1),
      pad(createdAt.getDate()),
    );
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, `rollout-2024-07-01T00-00-00-${threadId}.jsonl`), "{}\n", "utf8");
  }

  it.each([
    { provider: "claude" as const, threadId: claudeThread, write: writeClaude },
    { provider: "codex" as const, threadId: codexThread, write: writeCodex },
  ])("finds the $provider account whose config home holds the thread", ({ provider, threadId, write }) => {
    const accounts = [
      { id: "default", configHome: home(`${provider}-default`), isDefault: true },
      { id: "work", configHome: home(`${provider}-work`), isDefault: false },
      { id: "spare", configHome: home(`${provider}-spare`), isDefault: false },
    ];
    write(accounts[1]!.configHome, threadId);

    expect(findInstanceHoldingThread(provider, threadId, accounts)?.id).toBe("work");
    expect(findInstanceHoldingThread(provider, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", accounts)).toBeNull();

    // A thread copied to several accounts (a usage-limit move) stays on the default.
    write(accounts[0]!.configHome, threadId);
    expect(findInstanceHoldingThread(provider, threadId, [...accounts].reverse())?.id).toBe("default");
  });
});
