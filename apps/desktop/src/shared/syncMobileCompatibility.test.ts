import { describe, expect, it } from "vitest";
import {
  MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS,
  evaluateMobileSyncCompatibility,
} from "./syncMobileCompatibility";

describe("sync mobile compatibility contract", () => {
  it("reports full compatibility when every required mobile action is advertised", () => {
    expect(evaluateMobileSyncCompatibility(MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS)).toEqual({
      mode: "full",
      missingActions: [],
    });
  });

  it("keeps a connected host in limited mode when required actions are missing", () => {
    expect(evaluateMobileSyncCompatibility(["chat.send", "work.listSessions"])).toEqual({
      mode: "limited",
      missingActions: MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS.filter(
        (action) => action !== "chat.send" && action !== "work.listSessions",
      ),
    });
  });
});
