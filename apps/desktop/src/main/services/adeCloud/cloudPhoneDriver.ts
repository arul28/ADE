/**
 * One shape for every provider that runs the ADE Cloud iPhone.
 *
 * `cloudPhoneService` owns everything a person or an agent sees: starting the
 * account's phone, waiting for it, the chat's start and end lines, argument
 * checks, packing a checkout or an app, saving screenshots and recordings,
 * the proof drawer. A driver owns only how one provider's phone is driven:
 * NoMac (`cloudPhoneNomacDriver.ts`) or Revyl (`cloudPhoneRevylDriver.ts`).
 * Both answer the same calls in the same words, so an agent can't tell which
 * provider runs the phone, and a fix to the service reaches both.
 */

import type {
  CloudPhoneMinutes,
  CloudPhoneProvider,
} from "../../../../../account-directory/src/cloud/contract";
import type { CloudProvider } from "./cloudProvider";
import type { CloudPhoneRunEnd } from "./cloudPhoneRun";

/** The phone this brain drives, and the account it was started for (a phone and its token belong to one account). */
export type CloudPhoneHeld = {
  phoneId: string;
  /** The server is asked for this phone again before then (NoMac's token runs out). */
  renewBy: number;
  device: string;
  minutes: CloudPhoneMinutes;
  checkedAt: number;
  account: string | null;
  /** The screen in points, when the provider said. */
  points: { width: number; height: number } | null;
} & (
  /** NoMac: a token for this phone alone, and NoMac's REST base it calls. */
  | { provider: "nomac"; token: string; apiBase: string }
  /** Revyl: no token here; its calls go through the server. */
  | { provider: Exclude<CloudPhoneProvider, "nomac"> }
);

/**
 * The phone read now. `starting` and `ready` run; `ended` says why and when;
 * `gone` is no longer there (ended, or its token isn't good any more);
 * `unreadable` (busy with another call, or the provider didn't answer) may
 * still run. `code` names what the provider said, for a log or an error.
 */
export type CloudPhoneRead =
  | { state: "starting" | "ready" }
  | { state: "ended"; end: CloudPhoneRunEnd }
  | { state: "gone"; code: string }
  | { state: "unreadable"; code: string };

export type CloudPhoneToolAnswer = {
  text: string;
  /** The tool ran and reported a failure (a failed build, a failed step). */
  failed: boolean;
  /** Download links the answer named (screenshots, recordings): 7 days for those. */
  links: string[];
  /** Inline images (a `look` with a screenshot), base64. */
  images: Array<{ mimeType: string; data: string }>;
  /** A sentence about the phone's coming stop, when it is near. */
  stopNotice: string | null;
};

/** A `.tar.gz` on this machine, made by the service. */
export type CloudPhonePacked = { file: string; size: number; sha256: string };

export class CloudPhoneError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CloudPhoneError";
  }
}

/**
 * The phone ended between the check and the first call (idle, its limit):
 * the service starts a fresh one and makes the call once more.
 */
export class CloudPhoneGoneError extends CloudPhoneError {
  constructor() {
    super("The cloud iPhone ended.", "phone_gone");
    this.name = "CloudPhoneGoneError";
  }
}

export type CloudPhoneDriverContext = {
  fetcher: typeof fetch;
  logger?: { info?(event: string, meta?: Record<string, unknown>): void; warn?(event: string, meta?: Record<string, unknown>): void };
  /** A call reached the phone: its idle clock starts again. */
  touched(phone: CloudPhoneHeld): void;
  /** The account's ADE Cloud client (Revyl's calls go through it). */
  client(): Promise<CloudProvider>;
};

export type CloudPhoneRunInput = {
  project: CloudPhonePacked;
  /** The workspace folder the project unpacks into, the same each time. */
  name: string;
  /** A folder inside the project to build. */
  sub?: string;
  scheme?: string;
  configuration?: "Debug" | "Release";
  env?: string;
  clean?: boolean;
};

export type CloudPhoneDriver = {
  read(phone: CloudPhoneHeld): Promise<CloudPhoneRead>;
  /** One cheap call the provider counts as use: `gone` when the phone (or this token) is no longer there. */
  keepAlive(phone: CloudPhoneHeld): Promise<"alive" | "gone">;
  /** The screen as text: one element per line, `kind "label" #id state @x,y` in points. */
  look(phone: CloudPhoneHeld, input: { find?: string; screenshot?: boolean }): Promise<CloudPhoneToolAnswer>;
  /** Steps in `look`'s words. */
  act(phone: CloudPhoneHeld, steps: string[]): Promise<CloudPhoneToolAnswer>;
  /** A full-size PNG of the screen, and the provider's link to it (empty when there is none). */
  screenshot(phone: CloudPhoneHeld): Promise<{ bytes: Buffer; link: string }>;
  /** Builds the packed project there and starts it: the app's first screen as text, or the build's errors. */
  run(phone: CloudPhoneHeld, input: CloudPhoneRunInput): Promise<CloudPhoneToolAnswer>;
  /** Installs a packed Simulator `.app` (the service launches it, `control` `launch`): the answer and the bundle id it names. */
  install(phone: CloudPhoneHeld, input: { app: CloudPhonePacked }): Promise<{ answer: CloudPhoneToolAnswer; bundleId: string | null }>;
  /** Apps and the phone: launch, terminate, open_url, location, push, appearance, … */
  control(phone: CloudPhoneHeld, input: { action: string; value?: string; app?: string }): Promise<CloudPhoneToolAnswer>;
  logs(phone: CloudPhoneHeld, input: { app?: string; since?: string; grep?: string; waitFor?: string; crashes?: boolean }): Promise<CloudPhoneToolAnswer>;
  /** `start`, then `stop`: the stop answers the video. */
  record(phone: CloudPhoneHeld, action: "start" | "stop"): Promise<{ answer: CloudPhoneToolAnswer; video: { bytes: Buffer; extension: "mp4" | "mov" } | null }>;
  /** Absent where the provider can't run an app's tests yet (`runTests` is left out of the status's capabilities). */
  test?(phone: CloudPhoneHeld, input: CloudPhoneRunInput & { only?: string }): Promise<CloudPhoneToolAnswer>;
  /** `control` actions this provider's phone can't do yet, each as a person reads it ("Changing the locale"). */
  unsupportedControls: Readonly<Record<string, string>>;
};

export const textAnswer = (text: string, failed = false): CloudPhoneToolAnswer => ({ text, failed, links: [], images: [], stopNotice: null });

/** Answers one after another as one: their text in order, failed when any failed, the latest stop notice. */
export const joinAnswers = (answers: readonly CloudPhoneToolAnswer[]): CloudPhoneToolAnswer => ({
  text: answers.map((answer) => answer.text.trim()).filter(Boolean).join("\n"),
  failed: answers.some((answer) => answer.failed),
  links: [...new Set(answers.flatMap((answer) => answer.links))],
  images: answers.flatMap((answer) => answer.images),
  stopNotice: [...answers].reverse().find((answer) => answer.stopNotice)?.stopNotice ?? null,
});

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
