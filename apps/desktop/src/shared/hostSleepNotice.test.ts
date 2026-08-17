import { describe, expect, it } from "vitest";
import {
  formatHostPausedDuration,
  hostResumedNoticeMessage,
  hostSleepNoticeMergeKey,
  HOST_ASLEEP_NOTICE_MESSAGE,
  HOST_ASLEEP_NOTICE_STATUS,
  HOST_AWAKE_NOTICE_STATUS,
  HOST_ASLEEP_ATTRIBUTION_MAX_MS,
  HOST_RESUME_RETRY_GRACE_MS,
  isHostResumedNoticeEvent,
  isHostSleepNoticeEvent,
  isSuspendAttributableRetryError,
  shouldAttributeRetryToHostSuspend,
} from "./hostSleepNotice";

const NOW = 1_700_000_000_000;

describe("suspend-attributable retry causes", () => {
  it("claims the causes a provider could not name", () => {
    for (const cause of ["unknown", "transient_error", "ECONNRESET", "socket hang up", "fetch failed"]) {
      expect(isSuspendAttributableRetryError(cause)).toBe(true);
    }
  });

  it("leaves causes the API actually reported alone", () => {
    for (const cause of ["overloaded", "rate_limit", "authentication_failed", "invalid_request", "server_error"]) {
      expect(isSuspendAttributableRetryError(cause)).toBe(false);
    }
  });
});

describe("shouldAttributeRetryToHostSuspend", () => {
  it("blames the sleep for a nameless failure while the host is asleep", () => {
    expect(shouldAttributeRetryToHostSuspend({
      error: "unknown",
      sleepState: "asleep",
      sleepStateAt: NOW - 1_000,
      lastResumeAt: null,
      now: NOW,
    })).toBe(true);
  });

  it("keeps a real API failure truthful even while the host is asleep", () => {
    expect(shouldAttributeRetryToHostSuspend({
      error: "overloaded",
      sleepState: "asleep",
      sleepStateAt: NOW - 1_000,
      lastResumeAt: null,
      now: NOW,
    })).toBe(false);
  });

  it("refuses the excuse when the provider attached an HTTP status", () => {
    // A status means a server answered, which a sleeping machine's socket
    // cannot do — so the sleep is not what happened here.
    expect(shouldAttributeRetryToHostSuspend({
      error: "unknown",
      errorStatus: 529,
      sleepState: "asleep",
      sleepStateAt: NOW - 1_000,
      lastResumeAt: null,
      now: NOW,
    })).toBe(false);
  });

  it("covers the socket that is only observed dead just after the wake", () => {
    expect(shouldAttributeRetryToHostSuspend({
      error: "unknown",
      sleepState: "awake",
      sleepStateAt: null,
      lastResumeAt: NOW - 5_000,
      now: NOW,
    })).toBe(true);
  });

  it("stops blaming a wake that is already old news", () => {
    expect(shouldAttributeRetryToHostSuspend({
      error: "unknown",
      sleepState: "awake",
      sleepStateAt: null,
      lastResumeAt: NOW - (HOST_RESUME_RETRY_GRACE_MS + 1),
      now: NOW,
    })).toBe(false);
  });

  it("never blames a host that has not slept at all", () => {
    expect(shouldAttributeRetryToHostSuspend({
      error: "unknown",
      sleepState: "awake",
      sleepStateAt: null,
      lastResumeAt: null,
      now: NOW,
    })).toBe(false);
  });

  it("stops holding failures once a stuck `asleep` has gone stale", () => {
    // A nap shorter than the gap detector's 60s threshold whose announced
    // resume was lost leaves `asleep` set with nothing left to clear it. Left
    // unbounded, every later network failure — for the rest of the process —
    // renders as "Paused — computer asleep" and is never counted as a retry.
    expect(shouldAttributeRetryToHostSuspend({
      error: "econnreset",
      sleepState: "asleep",
      sleepStateAt: NOW - (HOST_ASLEEP_ATTRIBUTION_MAX_MS + 1),
      lastResumeAt: null,
      now: NOW,
    })).toBe(false);
  });

  it("still blames a sleep that is inside the attribution window", () => {
    expect(shouldAttributeRetryToHostSuspend({
      error: "econnreset",
      sleepState: "asleep",
      sleepStateAt: NOW - (HOST_ASLEEP_ATTRIBUTION_MAX_MS - 1),
      lastResumeAt: null,
      now: NOW,
    })).toBe(true);
  });

  it("reads a stale `asleep` plus a fresh resume as the resume", () => {
    // The wake landed even though the sleep state never cleared, so the grace
    // window is what decides — not the stale announcement.
    expect(shouldAttributeRetryToHostSuspend({
      error: "unknown",
      sleepState: "asleep",
      sleepStateAt: NOW - (HOST_ASLEEP_ATTRIBUTION_MAX_MS + 60_000),
      lastResumeAt: NOW - 2_000,
      now: NOW,
    })).toBe(true);
  });

  it("treats a sleep announcement from the future as skew, not staleness", () => {
    expect(shouldAttributeRetryToHostSuspend({
      error: "unknown",
      sleepState: "asleep",
      sleepStateAt: NOW + 60_000,
      lastResumeAt: null,
      now: NOW,
    })).toBe(true);
  });

  it("does not let an untimestamped `asleep` excuse anything on its own", () => {
    expect(shouldAttributeRetryToHostSuspend({
      error: "unknown",
      sleepState: "asleep",
      sleepStateAt: null,
      lastResumeAt: null,
      now: NOW,
    })).toBe(false);
  });
});

describe("chip copy", () => {
  it("keeps the paused label short and in sentence case", () => {
    expect(HOST_ASLEEP_NOTICE_MESSAGE).toBe("Paused — computer asleep");
    expect(HOST_ASLEEP_NOTICE_MESSAGE.split(/\s+/).length).toBeLessThanOrEqual(6);
  });

  it("names the sleep's length on the resumed half", () => {
    expect(hostResumedNoticeMessage(4 * 60_000)).toBe("Resumed · paused 4m");
    expect(hostResumedNoticeMessage(42_000)).toBe("Resumed · paused 42s");
    expect(hostResumedNoticeMessage(2 * 3_600_000 + 5 * 60_000)).toBe("Resumed · paused 2h 5m");
  });

  it("says only what it knows when the sleep was not measured", () => {
    expect(hostResumedNoticeMessage(null)).toBe("Resumed");
    expect(formatHostPausedDuration(200)).toBeNull();
  });
});

describe("chip identity", () => {
  const paused = {
    type: "system_notice",
    status: HOST_ASLEEP_NOTICE_STATUS,
    detail: { hostSleep: { sleepId: "host-sleep-1" } },
  };
  const resumed = {
    type: "system_notice",
    status: HOST_AWAKE_NOTICE_STATUS,
    detail: { hostSleep: { sleepId: "host-sleep-1", pausedMs: 240_000 } },
  };

  it("recognises both halves and tells them apart", () => {
    expect(isHostSleepNoticeEvent(paused)).toBe(true);
    expect(isHostSleepNoticeEvent(resumed)).toBe(true);
    expect(isHostResumedNoticeEvent(paused)).toBe(false);
    expect(isHostResumedNoticeEvent(resumed)).toBe(true);
    expect(isHostSleepNoticeEvent({ type: "system_notice", status: "overloaded" })).toBe(false);
  });

  it("gives both halves of one sleep the same merge key", () => {
    expect(hostSleepNoticeMergeKey(paused)).toBe(hostSleepNoticeMergeKey(resumed));
    expect(hostSleepNoticeMergeKey({ type: "system_notice", status: HOST_ASLEEP_NOTICE_STATUS }))
      .toBe("host-sleep");
  });

  it("keeps distinct sleeps on distinct rows, and says so about the id-less case", () => {
    const second = {
      type: "system_notice",
      status: HOST_ASLEEP_NOTICE_STATUS,
      detail: { hostSleep: { sleepId: "host-sleep-2" } },
    };
    expect(hostSleepNoticeMergeKey(paused)).not.toBe(hostSleepNoticeMergeKey(second));
    // …and the documented cost of the id-less fallback: two sleeps with no id
    // DO collapse onto one row. The comment on `hostSleepNoticeMergeKey` must
    // keep describing this, not the opposite.
    expect(hostSleepNoticeMergeKey({ type: "system_notice", status: HOST_ASLEEP_NOTICE_STATUS }))
      .toBe(hostSleepNoticeMergeKey({ type: "system_notice", status: HOST_AWAKE_NOTICE_STATUS }));
  });
});
