import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PrWatchStopReason } from "../../../shared/prWatch";
import { openFreshKvDb } from "../../../test/freshKvDb";
import { createPrChatWatchStore } from "./prChatWatchStore";

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
}

const NOW = "2026-10-08T00:00:00Z";

describe("prChatWatchStore.activeBySession", () => {
  it("folds each chat's live watches for its row, and drops a watch for every stop reason", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-chat-watches-"));
    const db = await openFreshKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-1", root, "ADE", "main", NOW, NOW],
      );
      db.run(
        `insert into lanes(id, project_id, name, base_ref, branch_ref, worktree_path, status, created_at)
         values ('lane-1', 'proj-1', 'lane-1', 'main', 'feat/1', ?, 'active', ?)`,
        [path.join(root, "lane-1"), NOW],
      );
      for (const [prId, number] of [["pr-a", 11], ["pr-b", 12]] as const) {
        db.run(
          `insert into pull_requests(id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, state, base_branch, head_branch, created_at, updated_at)
           values (?, 'proj-1', 'lane-1', 'arul28', 'ADE', ?, ?, 'open', 'main', 'feat/1', ?, ?)`,
          [prId, number, `https://github.com/arul28/ADE/pull/${number}`, NOW, NOW],
        );
      }
      const store = createPrChatWatchStore({ db, projectId: "proj-1", logger: createLogger() });
      const arm = (prId: string, sessionId: string) =>
        store.arm({ prId, sessionId, mode: "watch", armedBy: "agent", headSha: null });

      const first = arm("pr-a", "chat-two-prs");
      arm("pr-b", "chat-two-prs");
      const single = arm("pr-b", "chat-one-pr");

      const active = store.activeBySession();
      expect(active.get("chat-two-prs")).toEqual({ startedAt: first.startedAt, githubPrNumber: 11, count: 2 });
      expect(active.get("chat-one-pr")).toEqual({ startedAt: single.startedAt, githubPrNumber: 12, count: 1 });

      const reasons: PrWatchStopReason[] = ["merged", "closed", "unreadable", "exhausted", "unwatched", "chat_gone"];
      for (const reason of reasons) {
        const watch = arm("pr-a", "chat-stopping");
        expect(store.activeBySession().has("chat-stopping")).toBe(true);
        store.stop(watch.id, reason);
        expect(store.activeBySession().has("chat-stopping")).toBe(false);
      }
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
