import { describe, expect, it } from "vitest";
import {
  CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE,
  PLUGIN_RUNTIME_RENAME_BLOCKED_MESSAGE,
} from "../../../desktop/src/shared/cursorCloudNaming";
import { cursorCloudRenameBlockedReason } from "./cursorCloudChatRename";

describe("cursorCloudRenameBlockedReason", () => {
  it("returns the shared blocked sentence for a Cursor Cloud chat", () => {
    expect(cursorCloudRenameBlockedReason({ cursorCloudAgentId: "cloud-agent-1" }))
      .toBe(CURSOR_CLOUD_RENAME_BLOCKED_MESSAGE);
  });

  it("returns the plugin sentence when a runtime declared ownsName", () => {
    expect(cursorCloudRenameBlockedReason({
      cursorCloudAgentId: null,
      runtimeRef: { ownsName: true },
    })).toBe(PLUGIN_RUNTIME_RENAME_BLOCKED_MESSAGE);
  });

  it("lets a local chat rename proceed", () => {
    expect(cursorCloudRenameBlockedReason({ cursorCloudAgentId: null })).toBeNull();
    expect(cursorCloudRenameBlockedReason({ cursorCloudAgentId: "  " })).toBeNull();
    expect(cursorCloudRenameBlockedReason({ runtimeRef: { ownsName: false } })).toBeNull();
    expect(cursorCloudRenameBlockedReason(null)).toBeNull();
  });
});
