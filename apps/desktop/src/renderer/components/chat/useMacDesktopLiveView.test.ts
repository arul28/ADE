import { describe, expect, it } from "vitest";

import {
  RETRY_MAX_ATTEMPTS,
  shouldRetryLiveView,
} from "./useMacDesktopLiveView";

describe("shouldRetryLiveView", () => {
  it("retries only from the error state, and only with a lane", () => {
    expect(shouldRetryLiveView({ status: "error", laneId: "lane-1", failures: 0 })).toBe(true);
    expect(shouldRetryLiveView({ status: "playing", laneId: "lane-1", failures: 0 })).toBe(false);
    expect(shouldRetryLiveView({ status: "starting", laneId: "lane-1", failures: 0 })).toBe(false);
    expect(shouldRetryLiveView({ status: "idle", laneId: "lane-1", failures: 0 })).toBe(false);
    expect(shouldRetryLiveView({ status: "error", laneId: null, failures: 0 })).toBe(false);
  });

  it("stops once the budget is spent, and starts again once it is reset", () => {
    // A stream that fails for a reason a retry cannot fix — an unreadable
    // config record, say — burns the budget and then stays quiet rather than
    // restarting an encoder process every four seconds.
    expect(shouldRetryLiveView({
      status: "error",
      laneId: "lane-1",
      failures: RETRY_MAX_ATTEMPTS - 1,
    })).toBe(true);
    expect(shouldRetryLiveView({
      status: "error",
      laneId: "lane-1",
      failures: RETRY_MAX_ATTEMPTS,
    })).toBe(false);
    // `restart()` and a successful attempt both zero the count; that is what
    // makes the panel's Retry work after the budget ran out.
    expect(shouldRetryLiveView({ status: "error", laneId: "lane-1", failures: 0 })).toBe(true);
  });
});
