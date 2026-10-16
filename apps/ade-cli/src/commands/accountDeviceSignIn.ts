// The device half of `ade login` and `ade connect`: reading what the brain
// answers for a device sign-in, the words that tell a person how to finish it
// on a phone or another computer, and the wait in which a browser sign-in and
// a device sign-in run side by side. `runAccountLogin` in `cli.ts` starts and
// cancels the sessions; this module only reads answers and decides who won.

import { renderTerminalQr } from "../lib/terminalQr";
import { detectTerminalCapabilities } from "./setupRender";

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

const DEFAULT_POLL_INTERVAL_SEC = 5;

export type DeviceSignInStart = {
  sessionId: string;
  userCode: string;
  verificationUri: string;
  /** The link with the code in it, when the directory sent one. */
  verificationUriComplete: string | null;
  expiresAt: string | null;
  intervalSec: number;
};

/** The brain's `startDeviceLogin` answer, or `null` when it did not start one. */
export function readDeviceSignInStart(start: Json): DeviceSignInStart | null {
  const sessionId = text(start.sessionId);
  const userCode = text(start.userCode);
  const verificationUri = text(start.verificationUri);
  if (!sessionId || !userCode || !verificationUri) return null;
  return {
    sessionId,
    userCode,
    verificationUri,
    verificationUriComplete: text(start.verificationUriComplete),
    expiresAt: text(start.expiresAt),
    intervalSec: positive(start.intervalSec) ?? DEFAULT_POLL_INTERVAL_SEC,
  };
}

/** A poll answer carries the account status under `authStatus`; older brains answer with it bare. */
export function authStatusOf(poll: Json): Json {
  return isJson(poll.authStatus) ? poll.authStatus : poll;
}

export type DeviceSignInPoll =
  | { kind: "signed_in"; authStatus: Json }
  /** Still open. `intervalSec` is set when the directory asked for a new pace. */
  | { kind: "waiting"; intervalSec: number | null }
  /** Over without a sign-in: expired, refused, or cancelled. */
  | { kind: "ended"; message: string | null; authStatus: Json };

/** The brain's `pollDeviceLogin` answer as one of three outcomes. */
export function readDeviceSignInPoll(poll: Json): DeviceSignInPoll {
  const status = text(poll.status);
  if (status === "signed_in") return { kind: "signed_in", authStatus: authStatusOf(poll) };
  if (status === "pending" || status === "slow_down") {
    return { kind: "waiting", intervalSec: positive(poll.intervalSec) };
  }
  return { kind: "ended", message: text(poll.message), authStatus: authStatusOf(poll) };
}

/**
 * How to finish a device sign-in on a phone or another computer. A phone can
 * scan the QR code, so the sign-in happens there and no password is typed on
 * this machine. Only a terminal that can draw it gets the QR code: a pipe, a
 * log file, or a narrow window gets the link and the user code as text.
 *
 * `lead` starts the sentence, for example "To finish signing in".
 */
export function deviceSignInInstructions(
  lead: string,
  device: Pick<DeviceSignInStart, "userCode" | "verificationUri" | "verificationUriComplete">,
): string {
  const terminal = detectTerminalCapabilities(process.stderr);
  const qr = terminal.unicode
    ? renderTerminalQr(device.verificationUriComplete ?? device.verificationUri, {
      color: terminal.color,
      maxColumns: process.stderr.columns,
    })
    : null;
  return (
    (qr
      ? `${lead}, scan this code with your phone:\n\n${qr}\n\n` +
        `Or open ${device.verificationUri} and enter code: ${device.userCode}\n`
      : `${lead}, open ${device.verificationUri} and enter code: ${device.userCode}\n`) +
    (device.verificationUriComplete ? `Or open: ${device.verificationUriComplete}\n` : "")
  );
}

export type BrowserOrDeviceSignIn =
  | { winner: "browser"; authStatus: Json }
  | { winner: "device"; authStatus: Json }
  /**
   * Nobody signed in. `browserStatus` is the browser sign-in's last answer
   * when it failed, and `null` when it was still open at the deadline.
   */
  | { winner: null; timedOut: boolean; browserStatus: Json | null };

/** A device poll that throws this many times in a row is given up on. */
const DEVICE_POLL_FAILURE_LIMIT = 3;
const BROWSER_POLL_INTERVAL_MS = 500;

/**
 * Wait for the first of two sign-ins: the browser on this machine, and a
 * device sign-in that runs beside it (`device` is `null` when none started).
 *
 * The device sign-in is the optional one. A poll of it that fails is not a
 * failed sign-in, so it cannot end the browser sign-in; after three failures in
 * a row it is dropped and said so. The browser sign-in is the required one: a
 * failed poll of it throws, as it does without a device beside it.
 *
 * Everything a person must read is written through `write` at the moment it
 * happens, so nothing is held back and nothing is said twice.
 */
export async function waitForBrowserOrDeviceSignIn(args: {
  pollBrowser: () => Promise<Json>;
  device: { intervalSec: number; poll: () => Promise<Json> } | null;
  /** Epoch ms after which the wait gives up; `Infinity` for no limit. */
  deadlineMs: number;
  sleep: (ms: number) => Promise<unknown>;
  write: (text: string) => void;
}): Promise<BrowserOrDeviceSignIn> {
  let device = args.device
    ? { ...args.device, nextPollAtMs: Date.now() + args.device.intervalSec * 1000, failures: 0 }
    : null;
  let browserStatus: Json | null = null;
  // One look at the browser sign-in. Returns the result when it signed in;
  // when it failed, says so once and remembers it.
  const checkBrowser = async (): Promise<BrowserOrDeviceSignIn | null> => {
    if (browserStatus) return null;
    const poll = await args.pollBrowser();
    const status = text(poll.status);
    if (status === "signed_in") return { winner: "browser", authStatus: authStatusOf(poll) };
    if (status !== "pending") {
      browserStatus = authStatusOf(poll);
      args.write(`${text(poll.message) ?? "ADE account sign-in failed."}\n`);
      if (device) args.write("Still waiting for the sign-in on another device…\n");
    }
    return null;
  };
  const pollDevice = async (poll: () => Promise<Json>): Promise<DeviceSignInPoll | null> => {
    try {
      return readDeviceSignInPoll(await poll());
    } catch {
      return null;
    }
  };
  // Said when the device sign-in stops while the browser one is still open,
  // so the QR code above is not read as a way in that still works.
  const browserStillOpen = () => (browserStatus ? "" : " The browser sign-in is still open.");

  while (true) {
    await args.sleep(Number.isFinite(args.deadlineMs)
      ? Math.min(BROWSER_POLL_INTERVAL_MS, Math.max(1, args.deadlineMs - Date.now()))
      : BROWSER_POLL_INTERVAL_MS);
    const browserWon = await checkBrowser();
    if (browserWon) return browserWon;
    if (device && Date.now() >= device.nextPollAtMs) {
      const poll = await pollDevice(device.poll);
      if (poll?.kind === "signed_in") return { winner: "device", authStatus: poll.authStatus };
      if (poll?.kind === "ended") {
        device = null;
        // The brain ends the device sign-in when the browser one completes, so
        // look at the browser first: "ended" then is not news, it is the win.
        const wonMeanwhile = await checkBrowser();
        if (wonMeanwhile) return wonMeanwhile;
        args.write(`${poll.message ?? "The sign-in on another device ended."}${browserStillOpen()}\n`);
      } else if (!poll && device.failures + 1 >= DEVICE_POLL_FAILURE_LIMIT) {
        args.write(`The sign-in on another device stopped answering.${browserStillOpen()}\n`);
        device = null;
      } else {
        device.failures = poll ? 0 : device.failures + 1;
        device.intervalSec = poll?.intervalSec ?? device.intervalSec;
        device.nextPollAtMs = Date.now() + device.intervalSec * 1000;
      }
    }
    if (browserStatus && !device) return { winner: null, timedOut: false, browserStatus };
    if (Number.isFinite(args.deadlineMs) && Date.now() >= args.deadlineMs) {
      // One last look: the phone can finish in the final interval.
      const last = device ? await pollDevice(device.poll) : null;
      if (last?.kind === "signed_in") return { winner: "device", authStatus: last.authStatus };
      return { winner: null, timedOut: true, browserStatus };
    }
  }
}
