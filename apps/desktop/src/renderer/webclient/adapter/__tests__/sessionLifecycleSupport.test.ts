import { describe, expect, it } from "vitest";
import { sessionLifecycleSupported } from "../sessionLifecycleSupport";

describe("sessionLifecycleSupported", () => {
  it("requires the per-row settle/snooze/wake actions the controls issue", () => {
    expect(sessionLifecycleSupported([])).toBe(false);
    expect(sessionLifecycleSupported(
      ["work.listSessions", "session.snoozeSession"].map((action) => ({
        action,
        scope: "project" as const,
        policy: { viewerAllowed: true },
      })),
    )).toBe(false);
    expect(sessionLifecycleSupported(
      ["session.settleSession", "session.snoozeSession", "session.wakeSession"].map((action) => ({
        action,
        scope: "project" as const,
        policy: { viewerAllowed: true },
      })),
    )).toBe(true);
  });
});
