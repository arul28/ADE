import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PrSummary } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createPrChatLinkStore } from "./prChatLinkStore";

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
}

const NOW = "2026-10-08T00:00:00Z";

describe("prChatLinkStore", () => {
  it("marks a linked chat on another lane as cross-lane, against the real tables", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-chat-links-"));
    const db = await openKvDb(path.join(root, ".ade.db"), createLogger());
    try {
      db.run(
        "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
        ["proj-1", root, "ADE", "main", NOW, NOW],
      );
      for (const laneId of ["lane-1", "lane-2"]) {
        db.run(
          `insert into lanes(id, project_id, name, base_ref, branch_ref, worktree_path, status, created_at)
           values (?, 'proj-1', ?, 'main', ?, ?, 'active', ?)`,
          [laneId, laneId, `feat/${laneId}`, path.join(root, laneId), NOW],
        );
      }
      db.run(
        `insert into pull_requests(id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, state, base_branch, head_branch, created_at, updated_at)
         values ('pr-layer', 'proj-1', 'lane-1', 'arul28', 'ADE', 12, 'https://github.com/arul28/ADE/pull/12', 'open', 'main', 'feat/lane-1', ?, ?)`,
        [NOW, NOW],
      );
      // A chat on the PR's own lane, a stack coordinator on another lane, and a
      // link whose chat this machine has no session row for.
      for (const [sessionId, laneId] of [["lane-chat", "lane-1"], ["coordinator", "lane-2"]] as const) {
        db.run(
          `insert into terminal_sessions(id, lane_id, title, started_at, transcript_path, status)
           values (?, ?, 'chat', ?, '', 'running')`,
          [sessionId, laneId, NOW],
        );
      }
      for (const sessionId of ["lane-chat", "coordinator", "unknown-chat"]) {
        db.run(
          `insert into pull_request_chat_sessions(id, project_id, pr_id, lane_id, session_id, created_at, updated_at)
           values (?, 'proj-1', 'pr-layer', 'lane-1', ?, ?, ?)`,
          [`edge-${sessionId}`, sessionId, NOW, NOW],
        );
      }

      const store = createPrChatLinkStore({
        db,
        projectId: "proj-1",
        logger: createLogger(),
        knownStackNumberForPr: () => null,
      });
      const [summary] = store.withChatSessionLinks([{ id: "pr-layer", laneId: "lane-1" } as PrSummary]);

      expect([...(summary?.chatSessionIds ?? [])].sort()).toEqual(["coordinator", "lane-chat", "unknown-chat"]);
      // Only the chat whose session row puts it on another lane is cross-lane;
      // an unknown chat keeps counting as a claim.
      expect(summary?.crossLaneChatSessionIds).toEqual(["coordinator"]);
      expect([...(store.chatSessionIdsByPrId(["pr-layer"]).get("pr-layer") ?? [])].sort())
        .toEqual(["coordinator", "lane-chat", "unknown-chat"]);
    } finally {
      db.close?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("claims a persisted origin once, preserves explicit unlinks, and retries failed writes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-pr-origin-"));
    const db = await openKvDb(path.join(root, "ade.db"), createLogger());
    try {
      db.run("insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values ('proj', ?, 'ADE', 'main', ?, ?)", [root, NOW, NOW]);
      for (const lane of ["origin", "other"]) {
        db.run("insert into lanes(id, project_id, name, base_ref, branch_ref, worktree_path, status, created_at) values (?, 'proj', ?, 'main', ?, ?, 'active', ?)", [lane, lane, lane, path.join(root, lane), NOW]);
      }
      db.run("insert into pull_requests(id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, state, base_branch, head_branch, created_at, updated_at) values ('pr', 'proj', 'origin', 'acme', 'ade', 1, 'https://github.com/acme/ade/pull/1', 'merged', 'main', 'origin', ?, ?)", [NOW, NOW]);
      for (const [id, lane] of [["first", "origin"], ["second", "origin"], ["foreign", "other"]]) {
        db.run("insert into terminal_sessions(id, lane_id, title, started_at, transcript_path, status, tool_type) values (?, ?, 'chat', ?, '', 'running', 'codex-chat')", [id, lane, NOW]);
      }
      const store = createPrChatLinkStore({ db, projectId: "proj", logger: createLogger(), knownStackNumberForPr: () => null });
      expect(store.rememberLanePrChatOrigin({ prId: "pr", laneId: "origin" })).toBe(true);
      expect(store.claimLanePrChatOrigin({ laneId: "origin", sessionId: "foreign" }).status).toBe("retry");
      expect(store.claimLanePrChatOrigin({ laneId: "origin", sessionId: "missing" }).status).toBe("retry");
      expect(store.unlinkPrFromChatSession({ prId: "pr", sessionId: "first" })).toBe(true);
      expect(store.claimLanePrChatOrigin({ laneId: "origin", sessionId: "first" }).status).toBe("ignored");
      expect(store.chatSessionIdsByPrId(["pr"]).get("pr")).toBeUndefined();
      db.run("create trigger fail_origin_claim before update of claimed_session_id on pull_request_lane_chat_origins begin select raise(abort, 'injected disk write failure'); end");
      expect(store.claimLanePrChatOrigin({ laneId: "origin", sessionId: "second" }).status).toBe("retry");
      expect(store.chatSessionIdsByPrId(["pr"]).get("pr")).toBeUndefined();
      db.run("drop trigger fail_origin_claim");
      expect(store.claimLanePrChatOrigin({ laneId: "origin", sessionId: "second" }).status).toBe("linked");
      expect(store.claimLanePrChatOrigin({ laneId: "origin", sessionId: "first" }).status).toBe("ignored");
      expect(store.chatSessionIdsByPrId(["pr"]).get("pr")).toEqual(["second"]);
      expect(db.get<{ merge_followup_pending: number }>("select merge_followup_pending from pull_request_lane_chat_origins")?.merge_followup_pending).toBe(1);
      expect(store.unlinkPrFromChatSession({ prId: "pr", sessionId: "second" })).toBe(true);
      expect(db.get<{ merge_followup_pending: number }>("select merge_followup_pending from pull_request_lane_chat_origins")?.merge_followup_pending).toBe(0);
    } finally {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

});
