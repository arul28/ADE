import { describe, expect, it } from "vitest";
import { connectSentry } from "./capture";
import { forwardLogToSentry } from "./logBridge";

/**
 * What an error line becomes in Sentry.
 *
 * The boundary is the SDK: `connectSentry` is how every process hands its
 * Sentry to this code, so a fake one stands in for the process boundary and
 * this module runs for real.
 */
function fakeSentry(): Array<{ error: unknown }> {
  const captured: Array<{ error: unknown }> = [];
  connectSentry({
    withScope: (callback) => callback({
      setTag: () => undefined,
      setExtras: () => undefined,
      setFingerprint: () => undefined,
      setLevel: () => undefined,
    }),
    captureException: (error) => { captured.push({ error }); },
    addBreadcrumb: () => undefined,
    logger: { warn: () => undefined, error: () => undefined },
  });
  return captured;
}

describe("forwardLogToSentry", () => {
  it("makes the error the issue, and the event name only the fallback", () => {
    const captured = fakeSentry();
    const failure = Object.assign(new Error("unable to open database file"), { code: "unknown" });

    // What the project-open path logs now: the error under the key this module
    // lifts. The issue is titled and grouped by the failure.
    forwardLogToSentry("error", "project.open.failed", { error: failure });
    // What it logged before: the message as text, which no key here reads. The
    // event carries no exception, so every project-open failure in the fleet
    // collapsed into one issue named by the event alone.
    forwardLogToSentry("error", "project.open.failed", { error: failure.message });

    expect(captured).toHaveLength(2);
    expect(captured[0]!.error).toBe(failure);
    expect(captured[1]!.error).not.toBe(failure);
    expect((captured[1]!.error as Error).name).toBe("AdeProblem");
    expect((captured[1]!.error as Error).message).toBe("project.open.failed");
  });
});
