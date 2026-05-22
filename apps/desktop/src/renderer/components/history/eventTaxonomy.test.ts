import { describe, expect, it } from "vitest";
import { getEventMeta } from "./eventTaxonomy";

describe("history event taxonomy", () => {
  it("keeps git operation records visible under the git category", () => {
    for (const kind of [
      "git_fetch",
      "git_sync_rebase",
      "git_tag_create",
      "git_reset_hard",
      "git_stash_pop",
      "git_undo_head_change",
      "git_redo_head_change",
      "git_rebase_continue",
      "git_merge_abort",
    ]) {
      const meta = getEventMeta(kind);

      expect(meta.category).toBe("git");
      expect(meta.importance).not.toBe("noise");
    }
  });
});
