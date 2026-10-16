import { describe, expect, it } from "vitest";
import { waitForBrowserOrDeviceSignIn } from "./accountDeviceSignIn";

/**
 * `ade login` on a machine with a browser waits for two sign-ins at once: the
 * browser on this machine, and a device sign-in a phone can finish. These pin
 * who wins, what the person is told, and that the optional one (the device)
 * can never take the required one (the browser) down with it.
 */

type Answer = Record<string, unknown> | Error;

const PENDING = { status: "pending" };
const signedIn = (email: string) => ({ status: "signed_in", authStatus: { signedIn: true, email } });

/** Answers each poll in turn; the last answer repeats. */
function polls(answers: Answer[]): { poll: () => Promise<Record<string, unknown>>; count: () => number } {
  let index = 0;
  return {
    poll: async () => {
      const answer = answers[Math.min(index, answers.length - 1)];
      index += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    count: () => index,
  };
}

async function wait(args: { browser: Answer[]; device: Answer[] | null; deadlinePassed?: boolean }) {
  const written: string[] = [];
  const browser = polls(args.browser);
  const device = args.device ? polls(args.device) : null;
  const result = await waitForBrowserOrDeviceSignIn({
    pollBrowser: browser.poll,
    // Interval 0: the device is polled on every turn, so no test waits on a clock.
    device: device ? { intervalSec: 0, poll: device.poll } : null,
    deadlineMs: args.deadlinePassed ? Date.now() - 1 : Number.POSITIVE_INFINITY,
    sleep: async () => {},
    write: (text) => written.push(text),
  });
  // What the person read, one entry per line. The wording is the module's to
  // change; these tests count the lines and look for the brain's own messages.
  const lines = written.join("").split("\n").filter(Boolean);
  return { result, lines, devicePolls: device?.count() ?? 0 };
}

describe("waitForBrowserOrDeviceSignIn", () => {
  it.each([
    [
      "the browser signs in first",
      { browser: [PENDING, signedIn("browser@example.com")], device: [PENDING] },
      { winner: "browser", authStatus: { signedIn: true, email: "browser@example.com" } },
      0,
    ],
    [
      "the phone signs in first",
      { browser: [PENDING], device: [PENDING, signedIn("phone@example.com")] },
      { winner: "device", authStatus: { signedIn: true, email: "phone@example.com" } },
      0,
    ],
    [
      "the browser sign-in fails and the phone finishes afterwards",
      { browser: [{ status: "expired", message: "ADE account sign-in expired." }], device: [PENDING, PENDING, signedIn("phone@example.com")] },
      { winner: "device", authStatus: { signedIn: true, email: "phone@example.com" } },
      // The browser failure, and that the phone is still worth waiting for.
      2,
    ],
    [
      // The brain ends the device sign-in the moment the browser one completes,
      // so the device poll can report "cancelled" just before the browser poll
      // reports the sign-in. That is a win, not a cancellation.
      "the browser signs in while a device poll is in flight",
      { browser: [PENDING, signedIn("browser@example.com")], device: [{ status: "error", message: "ADE account device sign-in was cancelled." }] },
      { winner: "browser", authStatus: { signedIn: true, email: "browser@example.com" } },
      0,
    ],
    [
      "the phone finishes in the last moment before the deadline",
      { browser: [PENDING], device: [PENDING, signedIn("phone@example.com")], deadlinePassed: true },
      { winner: "device", authStatus: { signedIn: true, email: "phone@example.com" } },
      0,
    ],
  ] as Array<[string, Parameters<typeof wait>[0], unknown, number]>)("signs in when %s", async (_label, scenario, expected, linesWritten) => {
    const { result, lines } = await wait(scenario);
    expect(result).toEqual(expected);
    // A sign-in that worked is never reported as a way in that "ended".
    expect(lines).toHaveLength(linesWritten);
    expect(lines.join(" ")).not.toContain("cancelled");
  });

  it("keeps the browser sign-in alive when the phone sign-in stops answering or ends", async () => {
    // Polls of the optional sign-in that throw are "still waiting", not a
    // failure of the whole login; after three in a row it is dropped, once.
    const flaky = await wait({
      browser: [PENDING, PENDING, PENDING, PENDING, PENDING, signedIn("browser@example.com")],
      device: [new Error("rpc reset")],
    });
    expect(flaky.result).toMatchObject({ winner: "browser" });
    expect(flaky.devicePolls).toBe(3);
    expect(flaky.lines).toHaveLength(1);

    // One failed poll between good ones is forgiven and never mentioned.
    const blip = await wait({
      browser: [PENDING, PENDING, PENDING, PENDING, signedIn("browser@example.com")],
      device: [new Error("rpc reset"), PENDING, new Error("rpc reset"), PENDING],
    });
    expect(blip.result).toMatchObject({ winner: "browser" });
    expect(blip.lines).toEqual([]);

    // The code expired on the phone side: said once, and the browser goes on.
    const expired = await wait({
      browser: [PENDING, PENDING, PENDING, signedIn("browser@example.com")],
      device: [PENDING, { status: "expired", message: "ADE account device sign-in expired." }],
    });
    expect(expired.result).toMatchObject({ winner: "browser" });
    expect(expired.devicePolls).toBe(2);
    expect(expired.lines).toHaveLength(1);
    expect(expired.lines[0]).toContain("ADE account device sign-in expired.");
  });

  it("reports no sign-in exactly once per reason, and says which side is still worth waiting for", async () => {
    // The browser failed first: said at once, with the phone still open.
    const browserThenDevice = await wait({
      browser: [{ status: "error", message: "The browser sign-in was refused." }],
      device: [PENDING, { status: "error", message: "The phone sign-in was refused." }],
    });
    expect(browserThenDevice.result).toEqual({
      winner: null,
      timedOut: false,
      browserStatus: { status: "error", message: "The browser sign-in was refused." },
    });
    expect(browserThenDevice.lines).toHaveLength(3);
    expect(browserThenDevice.lines[0]).toContain("The browser sign-in was refused.");
    expect(browserThenDevice.lines[2]).toContain("The phone sign-in was refused.");

    // No phone sign-in beside it: the browser failure is the whole result.
    const browserOnly = await wait({ browser: [{ status: "error", message: "The browser sign-in was refused." }], device: null });
    expect(browserOnly.result).toMatchObject({ winner: null, timedOut: false });
    expect(browserOnly.lines).toEqual(["The browser sign-in was refused."]);

    // Nobody finished in time. Nothing is written here: the caller owns the
    // timeout line, because it takes one last look at the browser first.
    const timedOut = await wait({ browser: [PENDING], device: [PENDING], deadlinePassed: true });
    expect(timedOut.result).toEqual({ winner: null, timedOut: true, browserStatus: null });
    expect(timedOut.lines).toEqual([]);

    // A failed poll of the required sign-in is not swallowed.
    await expect(wait({ browser: [new Error("brain is gone")], device: [PENDING] })).rejects.toThrow("brain is gone");
  });
});
