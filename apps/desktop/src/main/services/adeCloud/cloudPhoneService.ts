/**
 * The ADE Cloud iPhone as a brain drives it: `ade apple …` on a chat whose
 * iPhone is `ios@cloud`, from any machine (Windows, Linux, a Mac, an ADE
 * Cloud computer).
 *
 * ADE's server starts the phone and picks who runs it (NoMac or Revyl,
 * `phones.ts`); the provider's key never leaves the server. This service owns
 * what every provider shares: the account's one phone, waiting for it, the
 * chat's start and end lines, argument checks, packing the lane's code or an
 * app built elsewhere, screenshots and recordings saved here and filed to the
 * proof drawer. A driver drives the phone itself, in the same words for both
 * (`cloudPhoneDriver.ts`): NoMac's with a token for that phone only
 * (`cloudPhoneNomacDriver.ts`), Revyl's through the server
 * (`cloudPhoneRevylDriver.ts`). A phone keeps the driver it started with.
 *
 * One phone per account: every chat on this brain that chose `ios@cloud`
 * drives the same phone, as every lane of an account shares its plan's
 * minutes. See docs/features/apple-device/ade-cloud-iphone.md.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLOUD_PHONE_ABILITIES,
  CLOUD_PHONE_ABILITY_WORDS,
  CLOUD_PHONE_PROVIDER_ABILITIES,
  cloudPhoneAbilitiesOf,
  cloudPhoneLacks,
  isCloudPhoneAbility,
  withoutPhoneProviderNames,
  type CloudPhoneAbility,
  type CloudPhoneBuildNeed,
  type CloudPhoneDevice,
  type CloudPhoneMinutes,
  type CloudPhoneProvider,
  type CloudPhoneStart,
  type CloudPhoneSummary,
  type CloudPhoneView,
} from "../../../../../account-directory/src/cloud/contract";
import type { CloudProvider } from "./cloudProvider";
import { CloudProviderError } from "./cloudProvider";
import {
  CLOUD_PHONE_AGENT_ACTIONS,
  CLOUD_PHONE_DEVICES,
  cloudPhoneActionAbility,
  cloudPhoneControlAbility,
  isCloudPhoneDevice,
  type CloudPhoneStatusView,
} from "../../../shared/cloudPhone";
import type { ComputerUseArtifactIngestionRequest } from "../../../shared/types";
import { readArtifactId } from "../ios/recording/simRecordingService";
import { pngLooksBlank } from "./cloudPhoneBlankFrame";
import {
  DEVICE_BUILD,
  bundleIdOfApp,
  cacheKeyOf,
  cloudPhoneProjectName,
  outputTarget,
  packApp,
  packProject,
  supportedPlatformOf,
  writeOutput,
} from "./cloudPhonePack";
import {
  cloudPhoneCallerChat,
  cloudPhoneEndLine,
  cloudPhoneStartLine,
  type CloudPhoneRun,
  type CloudPhoneRunEnd,
} from "./cloudPhoneRun";
import {
  BUILD_JOB_ID,
  CloudPhoneError,
  CloudPhoneGoneError,
  joinAnswers,
  sleep,
  textAnswer,
  type CloudPhoneBuilt,
  type CloudPhoneDriver,
  type CloudPhoneHeld as Held,
  type CloudPhoneRead,
  type CloudPhoneRunInput,
  type CloudPhoneToolAnswer,
} from "./cloudPhoneDriver";
import { createNomacDriver } from "./cloudPhoneNomacDriver";
import { createRevylDriver } from "./cloudPhoneRevylDriver";

export { CloudPhoneError, type CloudPhoneToolAnswer };

export type CloudPhoneServiceDeps = {
  /** The account's ADE Cloud client, or null signed out. */
  provider: () => Promise<CloudProvider | null>;
  /** Why there is no client, in one sentence. */
  whyNoProvider: () => Promise<string | null>;
  logger?: { info?(event: string, meta?: Record<string, unknown>): void; warn?(event: string, meta?: Record<string, unknown>): void };
  fetch?: typeof fetch;
  /** One quiet line in a chat's transcript: a phone this chat's call started has started, or has stopped. */
  notifyChat?: (chatSessionId: string, message: string) => void;
};

/**
 * The proof drawer of the project a call came from (its runtime's artifact
 * broker), given per call: one phone serves every project of the brain.
 */
export type CloudPhoneProofTarget = {
  ingest: (request: ComputerUseArtifactIngestionRequest) => unknown;
  projectRoot: string | null;
};

/** Who a capture belongs to in the proof drawer: the chat that asked, and its lane. */
type ProofOwners = { chatSessionId?: unknown; laneId?: unknown; caption?: unknown };


/** Phone ids whose start or end a chat was told, kept this many. */
const ANNOUNCED_LIMIT = 200;
const READY_WAIT_MS = 6 * 60_000;
/** A blank (all black) screenshot is taken again after this, up to this many tries in all. */
const BLANK_SCREENSHOT_WAIT_MS = 1_500;
const BLANK_SCREENSHOT_TRIES = 3;
const CALL_POLL_MS = 1_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** A held phone read ready this recently is used without reading it again. */
const READY_TRUST_MS = 20_000;
/**
 * A start refused `phone_starting` (another machine's start in flight) is
 * asked again this often, for this long: a slow cloud start runs for minutes.
 */
const START_BUSY_POLL_MS = 2_000;
const START_BUSY_WAIT_MS = 5 * 60_000;

/** Xcode 26 and later ship the Metal compiler as a separate download; a build host without it fails on any `.metal` file. */
const MISSING_METAL = /missing Metal Toolchain/i;
const METAL_SENTENCE = "The cloud iPhone's Xcode doesn't have Apple's Metal Toolchain, and this project compiles Metal shaders (a .metal file in the app or in one of its Swift packages), so it can't be built there yet. Build it on a Mac and send the app with ade apple install --app <path to the Simulator .app>.";

/** The line a build that moved to another phone for its Metal shaders starts with. */
const METAL_MOVED = "Moved to another cloud iPhone: the first one's Xcode has no Metal Toolchain, which this project's Metal shaders need.";

/** A build that failed for want of the Metal Toolchain (its own words, from either provider). */
const missedMetal = (answer: CloudPhoneToolAnswer): boolean => answer.failed && MISSING_METAL.test(answer.text);

/** A failed build's answer, led by one sentence (`lead`, else the toolchain's) when the build host lacked the Metal Toolchain. */
function explainBuildFailure(answer: CloudPhoneToolAnswer, lead = METAL_SENTENCE): CloudPhoneToolAnswer {
  if (!missedMetal(answer)) return answer;
  return { ...answer, text: `${lead}\n\n${answer.text}` };
}

/** Projects whose build needed the Metal Toolchain, kept this many (a Swift package's shaders show only in a build). */
const METAL_PROJECTS_LIMIT = 200;
/** A build that worked is installed again for an unchanged source this long (the provider keeps its app longer), for this many projects. */
const LAST_BUILD_KEEP_MS = 12 * 60 * 60_000;
const LAST_BUILDS_LIMIT = 50;
/** Chats whose phones are kept for their minutes line, at most. */
const CHAT_PHONES_LIMIT = 200;

/** Said for a build-only check where this account's builds run on the phone itself. */
const BUILD_NEEDS_PHONE = "This account's cloud iPhone builds on the phone itself, so a build-only check would start the phone (one credit a minute). Run ade apple launch to build and run it there, or build on a Mac.";

/** One line for a failed build that cost no phone. */
const NO_PHONE_SPENT = "No cloud iPhone was started for this build, so it used no phone minutes.";
/** One line for a failed build whose phone had started for its install: stopped at once. */
const EARLY_PHONE_STOPPED = "A cloud iPhone had started for the install as the build neared its end; it was stopped at once.";
/** A phone started for a build that then failed is stopped once its start answers: waited for this long. */
const EARLY_STOP_WAIT_MS = 30_000;


/**
 * The held phone can't do what a command needs. Never swapped for another
 * (its app's state and minutes would go), and no restart hint: a new phone
 * starts by the server's fixed order, not by what a command needs.
 */
const lacksSentence = (ability: CloudPhoneAbility): string =>
  `This cloud iPhone can't ${CLOUD_PHONE_ABILITY_WORDS[ability]}.`;

/** A cloud iPhone's status without who runs it: agents and people see abilities, never a provider. */
const withoutProvider = (phone: CloudPhoneSummary | null): CloudPhoneStatusView["phone"] => {
  if (!phone) return null;
  const { provider: _provider, ...rest } = phone;
  return rest;
};



export function createCloudPhoneService(deps: CloudPhoneServiceDeps) {
  const fetcher = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let held: Held | null = null;
  let liveRun: CloudPhoneRun<Held> | null = null;
  /** `<phone id>:start` and `<phone id>:end`: each is told once. */
  const announced = new Set<string>();
  /** One start at a time: a second caller of the same account waits for the same phone. */
  let starting: { account: string | null; phone: Promise<Held> } | null = null;
  /** Builds (the project, its folder and scheme) that needed the Metal Toolchain: their next start names it. */
  const metalProjects = new Set<string>();
  /** Each project build's last build that worked (by `buildKey`): the same source installs it again, never builds twice. */
  const lastBuilds = new Map<string, { fingerprint: string; version: string; job: string; at: number; account: string | null }>();
  /** The phones each chat's calls drove, so `stop` and `getStatus` say what that chat's phones used. */
  const chatPhones = new Map<string, Set<string>>();

  const accountOf = (client: CloudProvider | null): string | null => client?.account ?? null;

  async function provider(): Promise<CloudProvider> {
    const client = await deps.provider();
    if (!client?.phoneState) throw new CloudPhoneError(await deps.whyNoProvider() ?? "Sign in to ADE to use the ADE Cloud iPhone.", "no_account");
    return client;
  }

  /** A call reached the run's phone: the provider's idle clock starts again. */
  function touched(phone: Held): void {
    if (liveRun?.phoneId === phone.phoneId && liveRun.account === phone.account) liveRun.lastActivityAt = Date.now();
  }

  const driverContext = { fetcher, logger: deps.logger, touched, client: provider };
  const drivers: Record<CloudPhoneProvider, CloudPhoneDriver> = {
    nomac: createNomacDriver(driverContext),
    revyl: createRevylDriver(driverContext),
  };
  const driverOf = (phone: Held): CloudPhoneDriver => drivers[phone.provider];

  /**
   * The account signed in now. After a sign-out or a switch to another account
   * the held phone is dropped, never driven. The client is made fresh per call,
   * so its account names it.
   */
  async function currentAccount(): Promise<string | null> {
    const account = accountOf(await deps.provider());
    if (held && held.account !== account) held = null;
    if (liveRun && liveRun.account !== account) liveRun = null;
    return account;
  }

  /** Tells a chat, at most once per phone and kind. A notice never fails a phone call. */
  function announce(phoneId: string, kind: "start" | "end", chatSessionId: string, message: string): void {
    const key = `${phoneId}:${kind}`;
    if (announced.has(key)) return;
    announced.add(key);
    if (announced.size > ANNOUNCED_LIMIT) announced.delete(announced.values().next().value as string);
    try {
      deps.notifyChat?.(chatSessionId, message);
    } catch (error) {
      deps.logger?.warn?.("cloud_phone.chat_notice_failed", { kind, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** The phone reads ready: the chat whose call started it is told, once. */
  function announceStart(started: CloudPhoneRun<Held>): void {
    started.readyAt ??= Date.now();
    if (started.chatSessionId && started.startLine) announce(started.phoneId, "start", started.chatSessionId, started.startLine);
    started.startLine = null;
  }

  /** The run is over: tells the chat its start was told to, once. `stopped` is a stop this brain asked for. */
  function announceEnd(ended: CloudPhoneRun<Held>, end: CloudPhoneRunEnd | "stopped"): void {
    if (liveRun === ended) liveRun = null;
    if (!ended.chatSessionId || !announced.has(`${ended.phoneId}:start`)) return;
    announce(ended.phoneId, "end", ended.chatSessionId, cloudPhoneEndLine(ended, end));
  }

  /**
   * The run's phone is no longer the account's live one: reads it with its own
   * token for why. Told only when it surely ended (it reads ended or gone, or
   * another phone replaced it); a phone the server couldn't read just now
   * still runs. `known`: the server already reads it ended, with its reason;
   * the session read adds when.
   */
  async function settleEnd(ended: CloudPhoneRun<Held>, replaced: boolean, known?: CloudPhoneRunEnd): Promise<void> {
    const read = await driverOf(ended.phone).read(ended.phone).catch((error: unknown) => {
      // Unread: the run stays open, and a later read settles it.
      deps.logger?.warn?.("cloud_phone.end_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (read?.state === "ended") return announceEnd(ended, { why: read.end.why ?? known?.why ?? null, at: read.end.at });
    if (known) return announceEnd(ended, known);
    if (read?.state === "starting" || read?.state === "ready") return;
    // Not unreadable: a phone busy with another call still runs.
    if (replaced || read?.state === "gone") announceEnd(ended, { why: null, at: null });
  }


  function hold(start: CloudPhoneStart, client: CloudProvider, chatSessionId: string | null, origin: object | null = null): Held {
    held = {
      account: accountOf(client),
      phoneId: start.phone.id,
      renewBy: start.token.expiresAt,
      device: String(start.phone.device),
      minutes: start.minutes,
      checkedAt: 0,
      points: start.points ?? null,
      // A server from before Revyl names none: NoMac.
      ...(start.provider === "revyl"
        ? { provider: "revyl" as const }
        : { provider: "nomac" as const, token: start.token.token, apiBase: start.apiBase.replace(/\/+$/, "") }),
    };
    if (liveRun?.phoneId === held.phoneId && liveRun.account === held.account) liveRun.phone = held;
    // A reused phone was started by someone else: nobody is told of it.
    else liveRun = { phoneId: held.phoneId, account: held.account, chatSessionId: start.reused ? null : chatSessionId, origin: start.reused ? null : origin, readyAt: start.phone.readyAt, lastActivityAt: null, heldAt: Date.now(), phone: held, startLine: start.reused ? null : cloudPhoneStartLine(start) };
    return held;
  }


  /** The phone's state, read from its provider; throws when it can't be read or is gone. */
  async function readPhone(phone: Held): Promise<Extract<CloudPhoneRead, { state: "starting" | "ready" | "ended" }>> {
    const read = await driverOf(phone).read(phone);
    if (read.state === "gone" || read.state === "unreadable") {
      deps.logger?.warn?.("cloud_phone.call_failed", { doing: "Reading the cloud iPhone", code: read.code, provider: phone.provider });
      throw new CloudPhoneError(`Reading the cloud iPhone failed (${read.code}).`, read.code);
    }
    return read;
  }

  async function waitUntilReady(phone: Held): Promise<void> {
    const by = Date.now() + READY_WAIT_MS;
    for (;;) {
      const read = await readPhone(phone);
      if (read.state === "ready") return;
      if (read.state === "ended") {
        held = null;
        if (liveRun?.phoneId === phone.phoneId) announceEnd(liveRun, read.end);
        throw new CloudPhoneError(`The cloud iPhone ended before it was ready (${read.end.why ?? "ended"}).`, "phone_ended");
      }
      if (Date.now() >= by) throw new CloudPhoneError("No cloud iPhone was free within 6 minutes. Try again soon.", "phone_queue_timeout");
      await sleep(CALL_POLL_MS);
    }
  }

  /**
   * The account's ready phone, started when there is none; `chatSessionId` is the agent chat told of a new one.
   * `account`: the account the command began under (a retry's), refused when another is signed in now.
   */
  async function ensure({ device, chatSessionId = null, needs = [], builds = [], missing, account: began, origin = null }: {
    device?: CloudPhoneDevice;
    chatSessionId?: string | null;
    needs?: readonly CloudPhoneAbility[];
    /** Build tools the project needs: the server is always asked, since it may move the phone to a provider that has them. */
    builds?: readonly CloudPhoneBuildNeed[];
    /** The build on this phone just failed for want of `need`: told to the server with the start. */
    missing?: { phoneId: string; need: CloudPhoneBuildNeed };
    account?: string | null;
    /** The command asking: a phone this start makes is marked its own (`CloudPhoneRun.origin`). */
    origin?: object | null;
  } = {}): Promise<Held> {
    const switched = (): CloudPhoneError => new CloudPhoneError("The ADE account changed while the cloud iPhone was in use. Try again.", "no_account");
    const account = await currentAccount();
    if (began !== undefined && account !== began) throw switched();
    // The running phone can't do what is needed: said before any call (the server says the same of one started elsewhere).
    const able = (phone: Held): Held => {
      const [lacked] = cloudPhoneLacks(phone.provider, needs);
      if (lacked) throw new CloudPhoneError(lacksSentence(lacked), "phone_lacks");
      return phone;
    };
    if (held && !builds.length && held.renewBy - Date.now() > TOKEN_REFRESH_MARGIN_MS && (!device || held.device === device)) {
      if (Date.now() - held.checkedAt < READY_TRUST_MS) return able(held);
      // A held phone may have stopped on its own (idle, its time limit): read it.
      const phone = held;
      const read = await readPhone(phone).catch(() => null);
      // Only for the phone still held, of the account still signed in: a
      // stop, a new start or a sign-out during the read wins over its answer.
      if (read?.state === "ready" && held === phone && phone.account === (await currentAccount())) {
        phone.checkedAt = Date.now();
        // Its first readiness read failed: the start is told now.
        // (A read is not use: NoMac's idle clock runs on, so lastActivityAt stays.)
        if (liveRun?.phoneId === phone.phoneId && liveRun.startLine) announceStart(liveRun);
        return able(phone);
      }
      if (held === phone) held = null;
      // It stopped on its own: the chat told of its start is told now.
      if (read?.state === "ended" && liveRun?.phoneId === phone.phoneId) announceEnd(liveRun, read.end);
    }
    // A start already running for another account is not this caller's phone: wait for it to end, then start our own.
    while (starting && starting.account !== account) await starting.phone.catch(() => undefined);
    // A start that names build tools asks the server itself (it may swap the phone): it waits out another one first.
    while (builds.length && starting) await starting.phone.catch(() => undefined);
    if (!starting) {
      const starter = (async () => {
        const client = await provider();
        // Signed out or switched while this waited: the start is never sent under another account.
        if (accountOf(client) !== account) throw new CloudPhoneError("The ADE account changed while the cloud iPhone started. Try again.", "no_account");
        // Another machine's start for this account is in flight: asked again until it holds the live phone.
        const startOnce = async (): Promise<CloudPhoneStart> => {
          const by = Date.now() + START_BUSY_WAIT_MS;
          for (;;) {
            try {
              return await client.phoneStart!({ ...(device ? { device } : {}), ...(needs.length ? { needs } : {}), ...(builds.length ? { builds } : {}), ...(missing ? { missing } : {}) });
            } catch (error) {
              if (!(error instanceof CloudProviderError) || error.code !== "phone_starting" || Date.now() + START_BUSY_POLL_MS > by) throw error;
              await sleep(START_BUSY_POLL_MS);
            }
          }
        };
        const start = await startOnce().catch(async (error: unknown) => {
          // The account's running phone (started on another machine) lacks a need: the agent decides to stop it.
          // With build tools in play the server's sentence already names both what builds and what's lacking.
          if (!(error instanceof CloudProviderError) || error.code !== "phone_lacks" || !needs[0] || builds.length) throw error;
          // Name the need it lacks, read from the running phone (the first need when it can't be read).
          const running = await client.phoneState!().then((state) => state.phone?.provider, () => undefined);
          throw new CloudPhoneError(lacksSentence((running && cloudPhoneLacks(running, needs)[0]) || needs[0]), "phone_lacks");
        });
        const previous = liveRun;
        const phone = hold(start, client, chatSessionId, origin);
        deps.logger?.info?.("cloud_phone.held", { phoneId: phone.phoneId, reused: start.reused, minutesLeft: start.minutes.left });
        // A new phone replaced the one this brain took: that one ended.
        if (previous && previous !== liveRun && previous.account === phone.account) await settleEnd(previous, true);
        await waitUntilReady(phone);
        phone.checkedAt = Date.now();
        if (liveRun?.phoneId === phone.phoneId) {
          if (!start.reused) liveRun.lastActivityAt = Date.now();
          announceStart(liveRun);
        }
        return phone;
      })().finally(() => { if (starting?.phone === starter) starting = null; });
      starting = { account, phone: starter };
    }
    const phone = await starting.phone;
    // Signed out or switched while it started: never hand this phone to another account.
    if (phone.account !== (await currentAccount())) throw new CloudPhoneError("The ADE account changed while the cloud iPhone started. Try again.", "no_account");
    if (began !== undefined && phone.account !== began) throw switched();
    // Another caller's start (no needs) may have made this one: the server checked only that caller's needs.
    return able(phone);
  }


  /**
   * Runs one command on the account's ready phone with its own driver. The
   * phone ended between the check and the command's first call (idle, its
   * limit): once more on a fresh one.
   */
  async function withPhone<T>(
    chatSessionId: string | null,
    run: (phone: Held, driver: CloudPhoneDriver) => Promise<T>,
    need?: CloudPhoneAbility,
    build: { builds?: readonly CloudPhoneBuildNeed[]; missing?: { phoneId: string; need: CloudPhoneBuildNeed }; account?: string | null } = {},
  ): Promise<T> {
    const needs = need ? [need] : [];
    const phone = await ensure({ chatSessionId, needs, ...build });
    noteChatPhone(chatSessionId, phone.phoneId);
    try {
      return await run(phone, driverOf(phone));
    } catch (error) {
      if (!(error instanceof CloudPhoneGoneError)) throw error;
      if (held === phone) held = null;
      // Only for the account the command began under: after a switch, never on the new account's phone.
      // The report went with the first start: never twice.
      const fresh = await ensure({ chatSessionId, needs, builds: build.builds ?? [], account: phone.account });
      noteChatPhone(chatSessionId, fresh.phoneId);
      return await run(fresh, driverOf(fresh));
    }
  }

  /** A chat's call drove this phone: its minutes are the chat's to read (`chatUse`). */
  function noteChatPhone(chatSessionId: string | null, phoneId: string): void {
    if (!chatSessionId) return;
    const phones = chatPhones.get(chatSessionId) ?? new Set<string>();
    phones.add(phoneId);
    chatPhones.delete(chatSessionId);
    chatPhones.set(chatSessionId, phones);
    if (chatPhones.size > CHAT_PHONES_LIMIT) chatPhones.delete(chatPhones.keys().next().value as string);
  }

  /**
   * What the phones a chat drove used this period, in the server's own
   * minutes (`recent`, billed minutes or so far), or null when this brain saw
   * the chat drive none or the server names no phones (an older one).
   */
  function chatUseOf(state: { recent?: Array<{ id?: string; minutes: number }> }, chatSessionId: string | null): { minutes: number; phones: number; partial: boolean } | null {
    const phones = chatSessionId ? chatPhones.get(chatSessionId) : null;
    if (!phones?.size || !state.recent?.some((use) => typeof use.id === "string")) return null;
    const used = state.recent.filter((use) => use.id && phones.has(use.id));
    // The server lists only the period's newest phones: a chat phone older than those is missing from the sum.
    return { minutes: used.reduce((sum, use) => sum + use.minutes, 0), phones: used.length, partial: used.length < phones.size };
  }

  /** The driver whose builds run on build runners before any phone (Revyl's), when a provider has them. */
  const runnerDriver = (): CloudPhoneDriver | null => Object.values(drivers).find((driver) => driver.buildOnRunner) ?? null;

  /**
   * A build before any phone starts, where this account's builds run on
   * build runners (the server decides): a failed build costs no phone
   * minutes, and the phone starts only for a build that worked, alongside its
   * last seconds when `startPhone` asks for one. An unchanged source (`reuse`)
   * installs the last build that worked instead of building again. Null where
   * the build runs on the phone itself (NoMac's, or a NoMac phone this brain
   * holds): the caller builds there. `spent`: for a failed build, what it cost
   * in phone minutes, as one line.
   */
  async function buildBeforePhone(
    input: CloudPhoneRunInput & { prebuilt?: boolean },
    options: { startPhone?: { chatSessionId: string | null; needs: readonly CloudPhoneAbility[] }; reuse?: { key: string; fingerprint: string } },
  ): Promise<{ built: CloudPhoneBuilt; reused: boolean; spent: string | null } | null> {
    const driver = runnerDriver();
    if (!driver?.buildOnRunner) return null;
    const account = await currentAccount();
    if (!(await mayBuildBeforePhone(account, input.builds ?? []))) return null;
    const last = options.reuse ? lastBuilds.get(options.reuse.key) : undefined;
    if (last && options.reuse && last.fingerprint === options.reuse.fingerprint && last.account === account && Date.now() - last.at < LAST_BUILD_KEEP_MS) {
      deps.logger?.info?.("cloud_phone.build_reused", { job: last.job });
      return { built: { ok: true, version: last.version, seconds: 0, job: last.job }, reused: true, spent: null };
    }
    // This command's own token: only a phone its start makes is ever stopped for it.
    const origin = {};
    const early: { phone: Promise<Held> | null } = { phone: null };
    const start = options.startPhone;
    const nearlyDone = start
      ? () => {
        // The build's step passed: the phone comes up while the app is packed. A failed start is the install's to say.
        early.phone = ensure({ chatSessionId: start.chatSessionId, needs: start.needs, builds: input.builds ?? [], account, origin });
        early.phone.catch(() => undefined);
      }
      : undefined;
    // A Revyl phone already up is touched while the build runs, so its idle stop doesn't come first.
    const awake = held?.provider === "revyl" && held.account === account ? held : undefined;
    let built: CloudPhoneBuilt | "phone_builds";
    try {
      built = await driver.buildOnRunner(account, input, nearlyDone, awake);
    } catch (error) {
      // A status read failed, or the build outran its wait: a phone started alongside it goes again.
      if (early.phone) await stopPhoneStartedFor(early.phone, origin);
      throw error;
    }
    if (built === "phone_builds") return null;
    if (built.ok) {
      if (options.reuse) {
        lastBuilds.delete(options.reuse.key);
        lastBuilds.set(options.reuse.key, { fingerprint: options.reuse.fingerprint, version: built.version, job: built.job, at: Date.now(), account });
        if (lastBuilds.size > LAST_BUILDS_LIMIT) lastBuilds.delete(lastBuilds.keys().next().value as string);
      }
      return { built, reused: false, spent: null };
    }
    // Packing the app failed after a phone started for it (rare): one this start made goes again.
    if (!early.phone) return { built, reused: false, spent: NO_PHONE_SPENT };
    return { built, reused: false, spent: (await stopPhoneStartedFor(early.phone, origin)) ? EARLY_PHONE_STOPPED : null };
  }

  /**
   * Whether a build could run before any phone, as far as the brain can tell
   * before asking: never with a NoMac phone held here (it builds on itself),
   * nor on a server from before builds with no phone (it names no
   * `toolchains` and would answer phone_not_running). With no build tool in
   * play the route's first stop decides; with one (`metal`) any stop that
   * builds first may get it, and the server says.
   */
  async function mayBuildBeforePhone(account: string | null, builds: readonly CloudPhoneBuildNeed[]): Promise<boolean> {
    if (held?.provider === "nomac" && held.account === account) return false;
    const state = await (await provider()).phoneState!().catch((error: unknown) => {
      // Unread: the phone builds, as before (with the phone up).
      deps.logger?.warn?.("cloud_phone.build_first_state_failed", { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    const toolchains = state?.toolchains;
    if (!toolchains?.length) return false;
    return builds.length ? toolchains.some((toolchain) => toolchain.buildsBeforePhone) : toolchains[0]!.buildsBeforePhone === true;
  }

  /**
   * Stops a phone `buildBeforePhone` started alongside a build that then
   * failed, only when this command's own start made it (`origin`): never a
   * phone already up, one another chat or the person started meanwhile, nor
   * one the start found running. Its start answers in seconds (its readiness
   * can take minutes), so that answer is waited for briefly; a start still in
   * flight then is stopped once it settles, whichever way. Answers whether it
   * stopped one now.
   */
  async function stopPhoneStartedFor(early: Promise<Held>, origin: object): Promise<boolean> {
    const mine = (): CloudPhoneRun<Held> | null => (liveRun?.origin === origin ? liveRun : null);
    let settled = false;
    void early.then(() => { settled = true; }, () => { settled = true; });
    const by = Date.now() + EARLY_STOP_WAIT_MS;
    while (!mine() && !settled && Date.now() < by) await sleep(250);
    const run = mine();
    if (run) return stopRun(run);
    if (!settled) {
      const stopLate = () => {
        const late = mine();
        if (late) void stopRun(late);
      };
      void early.then(stopLate, stopLate);
    }
    return false;
  }

  /** Stops this run's phone by its id (never another the account started since): its chat is told. */
  async function stopRun(run: CloudPhoneRun<Held>): Promise<boolean> {
    try {
      if (!(await (await provider()).phoneStop!({ phoneId: run.phoneId })).stopped) return false;
    } catch (error) {
      deps.logger?.warn?.("cloud_phone.early_phone_stop_failed", { error: error instanceof Error ? error.message : String(error) });
      return false;
    }
    deps.logger?.info?.("cloud_phone.early_phone_stopped", { phoneId: run.phoneId });
    if (held?.phoneId === run.phoneId) held = null;
    if (liveRun === run) announceEnd(run, "stopped");
    return true;
  }

  /** A build that failed before the phone, with what it cost in phone minutes (`spent`) when that is known. */
  const failedBuildAnswer = (built: Extract<CloudPhoneBuilt, { ok: false }>, spent: string | null): CloudPhoneToolAnswer =>
    (spent ? { ...built.answer, text: `${built.answer.text}\n\n${spent}` } : built.answer);

  /**
   * One build of the project at `root`, as `launch` and `build` make it:
   * packed, with its build key (the project, its folder and scheme: a Metal
   * need and the last good build are kept per key) and, unless it builds
   * clean, what an unchanged source reuses. The caller removes the archive.
   */
  function projectBuild(args: { root?: unknown; path?: unknown; scheme?: unknown; configuration?: unknown; clean?: unknown; xcode?: unknown } | null | undefined, env?: string) {
    const { root, sub } = projectArgs(args);
    const configuration = args?.configuration === undefined ? undefined : args.configuration === "Release" ? "Release" : args.configuration === "Debug" ? "Debug" : null;
    if (configuration === null) throw new CloudPhoneError("configuration is Debug or Release.", "bad_request");
    const scheme = textArg(args?.scheme, "scheme", 200);
    const xcode = xcodeArg(args?.xcode);
    const clean = args?.clean === true;
    return {
      configuration,
      scheme,
      xcode,
      clean,
      /** Packs the checkout (the slow part): after the caller's own refusals. */
      pack: async () => {
        const packed = await packProject(root, sub);
        const name = cloudPhoneProjectName(root);
        const buildKey = `${name}\0${packed.sub ?? ""}\0${scheme ?? ""}`;
        const input: CloudPhoneRunInput = {
          project: packed,
          name,
          ...(packed.sub ? { sub: packed.sub } : {}),
          ...(scheme ? { scheme } : {}),
          ...(configuration ? { configuration } : {}),
          ...(env ? { env } : {}),
          ...(clean ? { clean: true } : {}),
          // A project known to compile Metal names it, so the server builds (or starts, or swaps to) where Xcode has
          // the toolchain. The build, not the checkout: another app in the same checkout may have no shaders.
          builds: packed.metal || metalProjects.has(buildKey) ? ["metal"] : [],
          lockfiles: packed.lockfiles,
          cacheKey: cacheKeyOf(name, packed.sub),
          ...(xcode ? { xcode } : {}),
        };
        const reuse = clean ? undefined : { key: buildKey, fingerprint: `${packed.fingerprint}\0${configuration ?? ""}\0${xcode ?? ""}` };
        return { packed, input, buildKey, reuse };
      },
    };
  }

  /** The driver's call for an ability the phone has (`ensure` checked it): absent only if the table and the driver disagree. */
  function abilityCall<T>(method: T | undefined, ability: CloudPhoneAbility): T {
    if (!method) throw new CloudPhoneError(lacksSentence(ability), "phone_lacks");
    return method;
  }

  /** Files a capture to the calling project's proof drawer, owned by its chat and lane. Null when there is no drawer. */
  function fileProof(
    proof: CloudPhoneProofTarget | null | undefined,
    owners: ProofOwners,
    input: { kind: "screenshot" | "video_recording"; path: string; mimeType: string; title: string },
  ): string | null {
    if (!proof) return null;
    const chatSessionId = typeof owners.chatSessionId === "string" && owners.chatSessionId.trim() ? owners.chatSessionId.trim() : null;
    const laneId = typeof owners.laneId === "string" && owners.laneId.trim() ? owners.laneId.trim() : null;
    const ownerList: Array<{ kind: "chat_session" | "lane"; id: string }> = [
      ...(chatSessionId ? [{ kind: "chat_session" as const, id: chatSessionId }] : []),
      ...(laneId ? [{ kind: "lane" as const, id: laneId }] : []),
    ];
    try {
      return readArtifactId(proof.ingest({
        backend: { name: "ade-cloud-iphone", style: "local_fallback", toolName: input.kind === "screenshot" ? "cloud_iphone_screenshot" : "cloud_iphone_recording" },
        ...(ownerList.length ? { owners: ownerList } : {}),
        ...(proof.projectRoot ? { callerRoot: proof.projectRoot } : {}),
        provenance: { source: "ade-capture" },
        inputs: [{ kind: input.kind, title: input.title, path: input.path, mimeType: input.mimeType }],
      } as ComputerUseArtifactIngestionRequest));
    } catch (error) {
      deps.logger?.warn?.("cloud_phone.proof_file_failed", { kind: input.kind, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  const textArg = (value: unknown, name: string, max = 4_000): string | undefined => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || value.length > max) throw new CloudPhoneError(`${name} must be text.`, "bad_request");
    return value;
  };

  /** An Xcode version to build with (`27.1`): the server says which it has. */
  const xcodeArg = (value: unknown): string | undefined => {
    const version = textArg(value, "xcode", 10);
    if (version && !/^\d{2}\.\d$/.test(version)) throw new CloudPhoneError("xcode is a version like 27.2.", "bad_request");
    return version;
  };

  /** A build's project folder on this machine, and the folder inside it to build (`path`). */
  const projectArgs = (args: { root?: unknown; path?: unknown } | null | undefined): { root: string; sub: string | undefined } => {
    const root = textArg(args?.root, "root", 2_000);
    if (!root || !fs.existsSync(root)) throw new CloudPhoneError("root is the project's folder on this machine.", "bad_request");
    const sub = textArg(args?.path, "path", 500);
    if (sub && (path.isAbsolute(sub) || sub.split(/[\\/]/).includes(".."))) throw new CloudPhoneError("path is a folder inside the project.", "bad_request");
    return { root, sub };
  };

  return {
    /** The phone, its credits and abilities; for a chat's call, what that chat's phones used this period (`chatUse`). */
    async getStatus(args?: unknown): Promise<CloudPhoneStatusView> {
      const client = await deps.provider();
      if (!client?.phoneState) {
        return { access: "off", minutes: null, phone: null, capabilities: [], supported: false, reason: await deps.whyNoProvider() ?? "Sign in to ADE to use the ADE Cloud iPhone." };
      }
      const askedAt = Date.now();
      const state = await client.phoneState();
      if (!state.phone) held = null;
      const tracked = liveRun;
      if (tracked && tracked.account !== accountOf(client)) liveRun = null;
      else if (tracked && askedAt > tracked.heldAt) {
        const live = state.phone?.id === tracked.phoneId ? state.phone : null;
        // Ended: its own session read names when (a late read must not count the wait as use).
        if (live?.state === "ended") await settleEnd(tracked, true, { why: live.endReason, at: null });
        else if (live) tracked.readyAt ??= live.readyAt;
        // Not the account's live phone now: it ended, or the server couldn't read it just now.
        else await settleEnd(tracked, Boolean(state.phone));
      }
      // Access is on or off (an older server's `soon` reads as off).
      const reason = state.access === "on" ? null : "The ADE Cloud iPhone isn't available right now.";
      const lastActivityAt = liveRun && state.phone?.id === liveRun.phoneId && state.phone.state !== "ended" ? liveRun.lastActivityAt : null;
      // What the phone can do: the server says, for the live phone or the next one (an
      // older server: the live phone's provider, or with none running, NoMac's).
      const abilities = state.abilities ? cloudPhoneAbilitiesOf(state.abilities) : [...CLOUD_PHONE_PROVIDER_ABILITIES[state.phone?.provider ?? "nomac"]];
      const lacks = CLOUD_PHONE_ABILITIES.filter((ability) => !abilities.includes(ability));
      // An action that needs an ability the phone lacks is left out, not discovered by a failed call.
      const capabilities = state.access !== "on" ? [] : CLOUD_PHONE_AGENT_ACTIONS.filter((action) => {
        const needed = cloudPhoneActionAbility(action);
        return !needed || abilities.includes(needed);
      });
      const chatUse = chatUseOf(state, cloudPhoneCallerChat(args));
      return { ...state, phone: withoutProvider(state.phone), abilities, lacks: state.access === "on" ? lacks : [], capabilities, supported: state.access === "on", reason, lastActivityAt, ...(chatUse ? { chatUse } : {}) };
    },

    /** Starts the account's phone (or answers the live one); `needs`: abilities it must have (`CLOUD_PHONE_ABILITIES`). */
    async start(args: { device?: unknown; needs?: unknown } | null | undefined): Promise<{ phone: CloudPhoneStatusView["phone"]; minutes: CloudPhoneMinutes; abilities: CloudPhoneAbility[] }> {
      const device = args?.device;
      if (device !== undefined && !isCloudPhoneDevice(device)) {
        throw new CloudPhoneError(`device is ${CLOUD_PHONE_DEVICES.join(", ")}.`, "bad_request");
      }
      const asked = Array.isArray(args?.needs) ? args.needs : typeof args?.needs === "string" ? args.needs.split(/[,\s]+/).filter(Boolean) : [];
      if (!asked.every(isCloudPhoneAbility)) throw new CloudPhoneError(`needs is a list of ${CLOUD_PHONE_ABILITIES.join(", ")}.`, "bad_request");
      const chatSessionId = cloudPhoneCallerChat(args);
      const phone = await ensure({ device, chatSessionId, needs: cloudPhoneAbilitiesOf(asked) });
      noteChatPhone(chatSessionId, phone.phoneId);
      const state = await (await provider()).phoneState!();
      return { phone: withoutProvider(state.phone), minutes: state.minutes ?? phone.minutes, abilities: [...CLOUD_PHONE_PROVIDER_ABILITIES[phone.provider]] };
    },

    /** Stops the account's phone; for a chat's call, what that chat's phones used this period (`chatUse`). */
    async stop(args?: unknown): Promise<{ stopped: boolean; chatUse?: { minutes: number; phones: number; partial: boolean } | null }> {
      held = null;
      const stopping = liveRun;
      const client = await provider();
      const result = await client.phoneStop!();
      deps.logger?.info?.("cloud_phone.stopped", { stopped: result.stopped });
      // Whoever stopped it (an agent, the person's Stop), the chat told of its start is told.
      if (stopping && liveRun === stopping) {
        if (result.stopped) announceEnd(stopping, "stopped");
        else await settleEnd(stopping, false);
      }
      const chatSessionId = cloudPhoneCallerChat(args);
      if (!chatSessionId || !chatPhones.has(chatSessionId)) return result;
      // The server's own minutes for this chat's phones, the one just stopped included: never this brain's count.
      const state = await client.phoneState!().catch(() => null);
      return { ...result, chatUse: state ? chatUseOf(state, chatSessionId) : null };
    },

    /**
     * Builds the project at `root` with no phone, to check that it compiles:
     * where this account's builds run on build runners, a build costs no
     * phone minutes and, when it works, `launch` of the same source installs
     * it without building again. Elsewhere (builds on the phone itself) it is
     * refused with a sentence, and spends nothing.
     */
    async build(args: { root?: unknown; path?: unknown; scheme?: unknown; configuration?: unknown; clean?: unknown; xcode?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer & { files: number; bytes: number; job: string | null }> {
      const project = projectBuild(args);
      // Nothing is packed where no build can run before a phone: said at once, spending nothing.
      if (!(await mayBuildBeforePhone(await currentAccount(), ["metal"]))) return { ...textAnswer(BUILD_NEEDS_PHONE, true), files: 0, bytes: 0, job: null };
      const { packed, input, reuse } = await project.pack();
      try {
        const first = await buildBeforePhone(input, reuse ? { reuse } : {});
        const sized = { files: packed.count, bytes: packed.size };
        if (!first) return { ...textAnswer(BUILD_NEEDS_PHONE, true), ...sized, job: null };
        if (!first.built.ok) return { ...failedBuildAnswer(first.built, first.spent), ...sized, job: first.built.job };
        const words = first.reused
          ? `It builds: the source hasn't changed since build ${first.built.job}, which worked.`
          : `Built in ${first.built.seconds} s with no cloud iPhone started (build ${first.built.job}).`;
        return { ...textAnswer(`${words} ade apple launch installs this build on the phone without building again while the source stays the same.`), ...sized, job: first.built.job };
      } finally {
        fs.rmSync(packed.file, { force: true });
      }
    },

    /**
     * A build's whole log by its job (a failed build's answer names it), for
     * this account: saved to `outPath` (inside the project or the temp folder;
     * a temp file by default), with its steps, its first errors and its tail
     * as the answer. No phone is needed or started.
     */
    async buildLog(args: { job?: unknown; outPath?: unknown; grep?: unknown } | null | undefined, proof?: CloudPhoneProofTarget | null): Promise<CloudPhoneToolAnswer & { path: string; lines: number; complete: boolean }> {
      const job = textArg(args?.job, "job", 64);
      if (!job || !BUILD_JOB_ID.test(job)) throw new CloudPhoneError("job is the build's id, as a failed build's answer names it.", "bad_request");
      const grep = textArg(args?.grep, "grep", 300);
      const pattern = grep ? (() => { try { return new RegExp(grep, "i"); } catch { return null; } })() : null;
      const requested = textArg(args?.outPath, "outPath", 1_000);
      const projectRoot = proof?.projectRoot ?? null;
      const target = outputTarget(requested, projectRoot, `ade-cloud-iphone-build-${job.slice(0, 8)}.log`);
      const driver = runnerDriver();
      if (!driver?.buildLog) throw new CloudPhoneError("This account's cloud iPhones keep no build logs here.", "bad_request");
      const read = await driver.buildLog(await currentAccount(), job);
      // The file an agent reads names no provider, as the answer doesn't.
      const log = { ...read, lines: read.lines.map(withoutPhoneProviderNames) };
      writeOutput(target, requested, projectRoot, `${log.lines.join("\n")}\n`);
      const matched = grep ? log.lines.filter((line) => (pattern ? pattern.test(line) : line.toLowerCase().includes(grep.toLowerCase()))).slice(0, 80) : [];
      const errors = [...new Set(log.lines.filter((line) => /:\d+(:\d+)?: (fatal )?error:/.test(line)))].slice(0, 40);
      const text = [
        `Build ${job}: ${log.status}.`,
        ...log.steps.map((step) => `  ${step.name}: ${step.status ?? "not run"}${step.seconds != null ? ` (${step.seconds} s)` : ""}`),
        `${log.lines.length} lines${log.complete ? "" : " (the newest; older ones were not read)"}, saved to ${target}.`,
        ...(grep ? ["", `Lines matching ${JSON.stringify(grep)} (${matched.length}${matched.length === 80 ? "+" : ""}):`, ...matched] : []),
        ...(!grep && errors.length ? ["", "Compiler errors:", ...errors] : []),
        ...(!grep ? ["", "The end of the log:", ...log.lines.slice(-20)] : []),
      ].join("\n");
      return { ...textAnswer(text), path: target, lines: log.lines.length, complete: log.complete };
    },

    /**
     * The pane's "still here": one cheap call (the screen as text) to the live
     * phone, which NoMac counts as use, so a person watching doesn't hit the
     * idle stop. Never starts a phone: with none live here it answers `ok: false`.
     */
    async keepAlive(): Promise<{ ok: boolean }> {
      await currentAccount();
      let phone = held && held.renewBy > Date.now() ? held : null;
      if (!phone) {
        // Another machine's brain (or this one before a restart) started it:
        // take a token for the account's live phone. `attach` never starts
        // one: with none running the server answers phone_not_running.
        const client = await provider();
        // The cheap read first: no phone on, nothing to ask for.
        const state = await client.phoneState!().catch((error: unknown) => {
          deps.logger?.warn?.("cloud_phone.keep_alive_read_failed", { error: error instanceof Error ? error.message : String(error) });
          return null;
        });
        if (state?.phone?.state !== "ready") return { ok: false };
        let start: CloudPhoneStart;
        try {
          start = await client.phoneStart!({ attach: true });
        } catch (error) {
          if (error instanceof CloudProviderError && error.code === "phone_not_running") return { ok: false };
          throw error;
        }
        if (!start.reused) {
          // A server from before `attach` started a phone nobody asked for: stop it at once.
          deps.logger?.warn?.("cloud_phone.keep_alive_started_phone", { phoneId: start.phone.id });
          await client.phoneStop?.().catch((error: unknown) => {
            deps.logger?.warn?.("cloud_phone.keep_alive_stop_failed", { error: error instanceof Error ? error.message : String(error) });
          });
          return { ok: false };
        }
        if (start.phone.state !== "ready") return { ok: false };
        phone = hold(start, client, null);
        phone.checkedAt = Date.now();
      }
      // Gone, or only this token (the next status read settles whether it ended).
      if ((await driverOf(phone).keepAlive(phone)) === "gone") {
        if (held === phone) held = null;
        return { ok: false };
      }
      touched(phone);
      return { ok: true };
    },

    /** The screen as text: one element per line, with its label and center in points. */
    async look(args: { find?: unknown; screenshot?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const find = textArg(args?.find, "find", 200);
      return withPhone(cloudPhoneCallerChat(args), (phone, driver) => driver.look(phone, { ...(find ? { find } : {}), screenshot: args?.screenshot === true }));
    },

    /** Steps in `look`'s words: `tap "Sign In"`, `fill #email a@b.c`, `swipe up`, `wait "Welcome" 10`, `home`. */
    async act(args: { steps?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const steps = Array.isArray(args?.steps) ? args.steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0) : [];
      if (!steps.length || steps.length > 50) throw new CloudPhoneError("steps is a list of 1 to 50 steps, e.g. [\"tap \\\"Sign In\\\"\"].", "bad_request");
      return withPhone(cloudPhoneCallerChat(args), (phone, driver) => driver.act(phone, steps));
    },

    /**
     * A full-size PNG of the screen, saved to `outPath` (inside the project or
     * the temp folder; a temp file by default), and filed to the calling
     * project's proof drawer (`noProof` leaves it out).
     */
    async screenshot(
      args: (ProofOwners & { outPath?: unknown; noProof?: unknown }) | null | undefined,
      proof?: CloudPhoneProofTarget | null,
    ): Promise<{ path: string; link: string; bytes: number; artifactId: string | null }> {
      // Checked before the phone is used: a refused path spends no minutes.
      const requested = textArg(args?.outPath, "outPath", 1_000);
      const projectRoot = proof?.projectRoot ?? null;
      const target = outputTarget(requested, projectRoot, `ade-cloud-iphone-${Date.now()}.png`);
      // A frame taken while an app draws its first screen comes back all
      // black: take it again a moment later, twice at most.
      let link = "";
      let bytes: Buffer = Buffer.alloc(0);
      for (let attempt = 0; attempt < BLANK_SCREENSHOT_TRIES; attempt += 1) {
        if (attempt > 0) await sleep(BLANK_SCREENSHOT_WAIT_MS);
        const shot = await withPhone(cloudPhoneCallerChat(args), (phone, driver) => driver.screenshot(phone));
        link = shot.link;
        bytes = shot.bytes;
        if (!pngLooksBlank(bytes)) break;
        deps.logger?.info?.("cloud_phone.screenshot_blank", { attempt });
      }
      // Checked again after the phone's seconds: a link planted meanwhile is refused, and the write never follows one.
      writeOutput(target, requested, projectRoot, bytes);
      const caption = textArg(args?.caption, "caption", 300) ?? "ADE Cloud iPhone screenshot";
      const artifactId = args?.noProof === true ? null : fileProof(proof, args ?? {}, { kind: "screenshot", path: target, mimeType: "image/png", title: caption });
      return { path: target, link, bytes: bytes.length, artifactId };
    },

    /**
     * Builds the project at `root` and starts it on the phone: packs what git
     * tracks there and uploads it. Where the account's builds run on build
     * runners, the build comes first and the phone starts only for a build
     * that worked (a failed one costs no phone minutes), and an unchanged
     * source installs the last build that worked again; elsewhere it builds on
     * the phone (`app_run`). Answers the app's first screen as text, or the
     * build's errors.
     */
    async launch(args: { root?: unknown; path?: unknown; scheme?: unknown; configuration?: unknown; env?: unknown; clean?: unknown; xcode?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer & { files: number; bytes: number }> {
      const chatSessionId = cloudPhoneCallerChat(args);
      const env = textArg(args?.env, "env", 8_000);
      const project = projectBuild(args, env);
      const { packed, input, buildKey, reuse } = await project.pack();
      const builds = input.builds ?? [];
      try {
        // env values need a phone that passes them to the app.
        const need = env ? "launchEnv" as const : undefined;
        const first = await buildBeforePhone(input, { startPhone: { chatSessionId, needs: need ? [need] : [] }, ...(reuse ? { reuse } : {}) });
        if (first) {
          if (!first.built.ok) return { ...failedBuildAnswer(first.built, first.spent), files: packed.count, bytes: packed.size };
          const built = first.built;
          const answer = await withPhone(chatSessionId, async (phone, driver) => (driver.installBuilt
            ? (await driver.installBuilt(phone, { version: built.version, seconds: first.reused ? null : built.seconds }, { ...(env ? { env } : {}), launch: true })).answer
            // The route moved to a phone that builds on itself while this built: it builds there.
            : await driver.run(phone, input)), need, { builds });
          return { ...answer, files: packed.count, bytes: packed.size };
        }
        const ran: { phone?: Held } = {};
        const answer = await withPhone(chatSessionId, (phone, driver) => {
          ran.phone = phone;
          return driver.run(phone, input);
        }, need, { builds });
        const failedOn = ran.phone;
        if (!missedMetal(answer) || !failedOn) return { ...explainBuildFailure(answer), files: packed.count, bytes: packed.size };
        metalProjects.add(buildKey);
        if (metalProjects.size > METAL_PROJECTS_LIMIT) metalProjects.delete(metalProjects.values().next().value as string);
        // Told to the server, which keeps that provider out of Metal builds for a day and moves this phone to one with
        // the toolchain when the plan allows (a refusal says why, and the phone stays). Built once more there, never again.
        let moved: CloudPhoneToolAnswer | null = null;
        let refusal: string | null = null;
        try {
          moved = await withPhone(chatSessionId, async (phone, driver) => (phone.phoneId === failedOn.phoneId ? null : await driver.run(phone, input)), need, {
            builds: ["metal"],
            missing: { phoneId: failedOn.phoneId, need: "metal" },
            // Only under the account the first build ran under: after a switch, never on another account's phone.
            account: failedOn.account,
          });
        } catch (error) {
          if (!(error instanceof CloudProviderError) && !(error instanceof CloudPhoneError)) throw error;
          refusal = error.message;
          deps.logger?.info?.("cloud_phone.metal_move_refused", { code: error.code });
        }
        if (moved) {
          deps.logger?.info?.("cloud_phone.metal_moved", { failed: moved.failed });
          return { ...explainBuildFailure({ ...moved, text: `${METAL_MOVED}\n\n${moved.text}` }), files: packed.count, bytes: packed.size };
        }
        return { ...explainBuildFailure(answer, refusal ?? METAL_SENTENCE), files: packed.count, bytes: packed.size };
      } finally {
        fs.rmSync(packed.file, { force: true });
      }
    },

    /**
     * Installs a Simulator `.app` built on this machine (Expo/EAS with
     * `"simulator": true`, React Native, Flutter `--simulator`): packs the
     * whole bundle, uploads it, has the phone unpack it as `app`, installs it,
     * and launches it by its bundle id unless `launch` is false. With no
     * bundle id to name, the answer says it was installed and not launched.
     */
    async installApp(args: { appPath?: unknown; launch?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer & { bundleId: string | null }> {
      const requested = textArg(args?.appPath, "appPath", 2_000);
      if (!requested) throw new CloudPhoneError("appPath is the Simulator .app folder to install.", "bad_request");
      const appPath = path.resolve(requested);
      if (/\.ipa$/i.test(appPath)) throw new CloudPhoneError(DEVICE_BUILD, "device_build");
      let directory = false;
      try {
        directory = fs.statSync(appPath).isDirectory();
      } catch {
        directory = false;
      }
      if (!directory || !/\.app$/i.test(appPath)) {
        throw new CloudPhoneError("appPath is an existing .app folder made by a Simulator build.", "bad_request");
      }
      if (supportedPlatformOf(appPath) === "iPhoneOS") throw new CloudPhoneError(DEVICE_BUILD, "device_build");
      // The app's own Info.plist names it; the install answer is the fallback.
      const plistId = bundleIdOfApp(appPath);
      const packed = await packApp(appPath);
      const chatSessionId = cloudPhoneCallerChat(args);
      try {
        // Where builds run before a phone, the app goes up and is taken as a build first: the phone starts only for one that worked.
        const first = await buildBeforePhone({ project: packed, name: "app", prebuilt: true }, { startPhone: { chatSessionId, needs: [] } });
        if (first && !first.built.ok) return { ...failedBuildAnswer(first.built, first.spent), bundleId: plistId };
        const built = first?.built.ok ? first.built : null;
        return await withPhone(chatSessionId, async (phone, driver) => {
          const installed = built && driver.installBuilt
            ? await driver.installBuilt(phone, { version: built.version, seconds: built.seconds }, { launch: false, prebuilt: true })
            : await driver.install(phone, { app: packed });
          const bundleId = plistId ?? installed.bundleId;
          if (args?.launch === false || installed.answer.failed) return { ...installed.answer, bundleId };
          // Launched only by name: unnamed, NoMac launches the app launched LAST, which may be an earlier build's.
          if (!bundleId) {
            return { ...joinAnswers([installed.answer, textAnswer("Installed, but not launched: ADE could not tell the app's bundle id. Launch it with ade apple relaunch --bundle-id <id>.")]), bundleId };
          }
          // The install is done: a phone gone at the launch is told, never answered by installing all over again.
          const launched = await driver.control(phone, { action: "launch", app: bundleId }).catch((error: unknown) => {
            if (!(error instanceof CloudPhoneGoneError)) throw error;
            return textAnswer("Installed, but the cloud iPhone stopped before the app launched. A new phone won't have it: run the install again.", true);
          });
          return { ...joinAnswers([installed.answer, launched]), bundleId };
        });
      } finally {
        fs.rmSync(packed.file, { force: true });
      }
    },

    /**
     * Apps and the phone: launch, terminate, open_url, location, push,
     * appearance, … (`app_control`). A launch's `args` (one token each) and
     * `env` (`KEY=VALUE`) are its launch values for that launch only.
     */
    async control(args: { action?: unknown; value?: unknown; app?: unknown; args?: unknown; env?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const action = textArg(args?.action, "action", 40);
      if (!action) throw new CloudPhoneError("action is required (launch, terminate, open_url, location, push, appearance, …).", "bad_request");
      const tokens = Array.isArray(args?.args) ? args.args : args?.args === undefined ? [] : null;
      if (!tokens || tokens.length > 256 || !tokens.every((token): token is string => typeof token === "string" && token.length <= 4_000)) {
        throw new CloudPhoneError("args is a list of up to 256 launch arguments.", "bad_request");
      }
      const env = textArg(args?.env, "env", 8_000);
      if ((tokens.length || env) && action !== "launch") throw new CloudPhoneError("Launch arguments and env values go with action launch.", "bad_request");
      // A provider that takes one string reads the tokens joined.
      const value = textArg(args?.value, "value") ?? (tokens.length ? tokens.join(" ") : undefined);
      const app = textArg(args?.app, "app", 300);
      const need = cloudPhoneControlAbility(action, value ?? env);
      return withPhone(cloudPhoneCallerChat(args), (phone, driver) => driver.control(phone, {
        action,
        ...(value !== undefined ? { value } : {}),
        ...(app ? { app } : {}),
        ...(tokens.length ? { args: tokens } : {}),
        ...(env ? { env } : {}),
      }), need);
    },

    async logs(args: { app?: unknown; since?: unknown; grep?: unknown; waitFor?: unknown; crashes?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const app = textArg(args?.app, "app", 300);
      const since = textArg(args?.since, "since", 20);
      const grep = textArg(args?.grep, "grep", 300);
      const waitFor = textArg(args?.waitFor, "waitFor", 300);
      return withPhone(cloudPhoneCallerChat(args), (phone, driver) => driver.logs(phone, {
        ...(app ? { app } : {}),
        ...(since ? { since } : {}),
        ...(grep ? { grep } : {}),
        ...(waitFor ? { waitFor } : {}),
        ...(args?.crashes === true ? { crashes: true } : {}),
      }));
    },

    /**
     * `start`, then `stop`: the stop downloads the MP4 (NoMac keeps its link 7
     * days) and files it to the proof drawer, while the phone keeps running.
     */
    async record(
      args: (ProofOwners & { action?: unknown; noProof?: unknown }) | null | undefined,
      proof?: CloudPhoneProofTarget | null,
    ): Promise<CloudPhoneToolAnswer & { path: string | null; artifactId: string | null }> {
      const action = args?.action === "start" || args?.action === "stop" ? args.action : null;
      if (!action) throw new CloudPhoneError("action is start or stop.", "bad_request");
      const { answer, video } = await withPhone(cloudPhoneCallerChat(args), (phone, driver) => driver.record(phone, action));
      if (!video || answer.failed) return { ...answer, path: null, artifactId: null };
      const target = path.join(os.tmpdir(), `ade-cloud-iphone-${Date.now()}.${video.extension}`);
      fs.writeFileSync(target, video.bytes);
      const caption = textArg(args?.caption, "caption", 300) ?? "ADE Cloud iPhone recording";
      const artifactId = args?.noProof === true ? null : fileProof(proof, args ?? {}, { kind: "video_recording", path: target, mimeType: video.extension === "mov" ? "video/quicktime" : "video/mp4", title: caption });
      return { ...answer, path: target, artifactId };
    },

    async runTests(args: { root?: unknown; path?: unknown; scheme?: unknown; only?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const { root, sub } = projectArgs(args);
      const chatSessionId = cloudPhoneCallerChat(args);
      const scheme = textArg(args?.scheme, "scheme", 200);
      const only = textArg(args?.only, "only", 2_000);
      const packed = await packProject(root, sub);
      try {
        return explainBuildFailure(await withPhone(chatSessionId, (phone, driver) => abilityCall(driver.test, "tests").call(driver, phone, {
          project: packed,
          name: cloudPhoneProjectName(root),
          ...(packed.sub ? { sub: packed.sub } : {}),
          ...(scheme ? { scheme } : {}),
          ...(only ? { only } : {}),
        }), "tests"));
      } finally {
        fs.rmSync(packed.file, { force: true });
      }
    },

    /** The app's CPU, memory and frame rate over the next `seconds` (default 5, at most 30). */
    async perf(args: { seconds?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const seconds = typeof args?.seconds === "number" && Number.isFinite(args.seconds) ? Math.min(30, Math.max(1, Math.round(args.seconds))) : undefined;
      return withPhone(cloudPhoneCallerChat(args), (phone, driver) => abilityCall(driver.perf, "perf").call(driver, phone, seconds ? { seconds } : {}), "perf");
    },

    /** A link that shows the live phone (a control link by default), signed for this account. */
    async view(args: { control?: unknown } | null | undefined): Promise<CloudPhoneView> {
      try {
        return await (await provider()).phoneView!({ control: args?.control !== false });
      } catch (error) {
        if (error instanceof CloudProviderError && error.code === "phone_not_running") held = null;
        throw error;
      }
    },

    dispose(): void {
      held = null;
      liveRun = null;
    },
  };
}

export type CloudPhoneService = ReturnType<typeof createCloudPhoneService>;
