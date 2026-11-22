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

/** The phone this brain drives, and the account it was started for (a phone and its token belong to one account). */
export type CloudPhoneHeld = {
  phoneId: string;
  /** NoMac's token for this phone; empty for Revyl, whose calls go through the server. */
  token: string;
  expiresAt: number;
  /** NoMac's REST base; empty for Revyl. */
  apiBase: string;
  device: string;
  minutes: CloudPhoneMinutes;
  checkedAt: number;
  account: string | null;
  provider: CloudPhoneProvider;
  /** The screen in points, when the provider said. */
  points: { width: number; height: number } | null;
};

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
  /** The phone read now, in NoMac's session words (`state`, `ended`, `failure_code`), with the HTTP status. */
  read(phone: CloudPhoneHeld): Promise<{ status: number; session: Record<string, unknown> | null }>;
  /** One cheap call the provider counts as use; answers its HTTP status. */
  keepAlive(phone: CloudPhoneHeld): Promise<number>;
  /** The screen as text: one element per line, `kind "label" #id state @x,y` in points. */
  look(phone: CloudPhoneHeld, input: { find?: string; screenshot?: boolean }): Promise<CloudPhoneToolAnswer>;
  /** Steps in `look`'s words. */
  act(phone: CloudPhoneHeld, steps: string[]): Promise<CloudPhoneToolAnswer>;
  /** A full-size PNG of the screen, and the provider's link to it (empty when there is none). */
  screenshot(phone: CloudPhoneHeld): Promise<{ bytes: Buffer; link: string }>;
  /** Builds the packed project there and starts it: the app's first screen as text, or the build's errors. */
  run(phone: CloudPhoneHeld, input: CloudPhoneRunInput): Promise<CloudPhoneToolAnswer>;
  /** Installs a packed Simulator `.app`, and launches it by `bundleId` unless `launch` is false. */
  install(phone: CloudPhoneHeld, input: { app: CloudPhonePacked; bundleId: string | null; launch: boolean }): Promise<CloudPhoneToolAnswer & { bundleId: string | null }>;
  /** Apps and the phone: launch, terminate, open_url, location, push, appearance, … */
  control(phone: CloudPhoneHeld, input: { action: string; value?: string; app?: string }): Promise<CloudPhoneToolAnswer>;
  logs(phone: CloudPhoneHeld, input: { app?: string; since?: string; grep?: string; waitFor?: string; crashes?: boolean }): Promise<CloudPhoneToolAnswer>;
  /** `start`, then `stop`: the stop answers the video. */
  record(phone: CloudPhoneHeld, action: "start" | "stop"): Promise<{ answer: CloudPhoneToolAnswer; video: { bytes: Buffer; extension: "mp4" | "mov" } | null }>;
  test(phone: CloudPhoneHeld, input: CloudPhoneRunInput & { only?: string }): Promise<CloudPhoneToolAnswer>;
};

export const textAnswer = (text: string, failed = false): CloudPhoneToolAnswer => ({ text, failed, links: [], images: [], stopNotice: null });

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
