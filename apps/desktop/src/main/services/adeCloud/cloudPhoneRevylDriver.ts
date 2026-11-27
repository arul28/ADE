/**
 * The ADE Cloud iPhone on Revyl (`cloudPhoneDriver.ts` has the shape).
 *
 * Revyl has no token for one phone, so every call goes through ADE's server
 * (`CloudProvider.phoneCall`, `/cloud/phone/call`), which holds Revyl's key,
 * names the account's live phone, and allows only the calls listed in
 * `phoneRevyl.ts`. Revyl answers the raw accessibility tree and plain device
 * actions; this driver turns them into the same screen text and `act` steps
 * NoMac answers (`cloudPhoneScreenText.ts`), and a build into an upload, a
 * build on Revyl's Xcode runner, an install and a launch. It never calls
 * Revyl's AI-billed steps: an element is found in the tree, here.
 */

import fs from "node:fs";
import {
  CloudPhoneError,
  CloudPhoneGoneError,
  sleep,
  textAnswer,
  type CloudPhoneDriver,
  type CloudPhoneDriverContext,
  type CloudPhoneHeld,
  type CloudPhoneRunInput,
  type CloudPhoneToolAnswer,
} from "./cloudPhoneDriver";
import { findElement, readTarget, screenOf, screenText, stepWords, targetWords, type Screen, type StepTarget } from "./cloudPhoneScreenText";
import { BRAND } from "../../../shared/brand";

type Raw = { status: number; type: string | null; body: Buffer };
/** One command's calls: its first finding no live phone means the phone ended before it (`CloudPhoneGoneError`). */
type Command = { first: boolean };
const command = (): Command => ({ first: true });

/** A build is followed this long, read this often. */
const BUILD_WAIT_MS = 15 * 60_000;
const BUILD_POLL_MS = 2_000;
/** While a build runs, the phone is touched this often so its idle stop doesn't come first. */
const BUILD_KEEP_AWAKE_MS = 60_000;
/** The device can still be connecting for a few seconds after the phone reads ready. */
const CONNECT_WAIT_MS = 20_000;
/** `wait` and `gone` read the screen this often, for at most this long. */
const WAIT_POLL_MS = 700;
const WAIT_LIMIT_S = 30;
/** After an app launches, its first screen is read after this. */
const LAUNCH_SETTLE_MS = 1_500;
/** Reads of a just-launched app's screen before its empty answer is shown as it is. */
const LAUNCH_SETTLE_READS = 4;
const LOG_LINES = 200;

/** Calls that only read, so a gateway error may be tried again. */
const SAFE_TO_REPEAT = new Set(["proxy.hierarchy", "proxy.screenshot", "proxy.health", "proxy.device_logs", "proxy.performance_metrics", "build.status", "build.logs"]);
/** `key` step names as Revyl's keys. */
const KEYS: Record<string, string> = { return: "ENTER", enter: "ENTER", escape: "ESCAPE", delete: "BACKSPACE", backspace: "BACKSPACE", tab: "TAB", space: "SPACE" };
/** `scroll down` shows what is below: the finger moves up. */
const SCROLL_SWIPE: Record<string, string> = { down: "up", up: "down", left: "right", right: "left" };
const DIRECTIONS = new Set(["up", "down", "left", "right"]);

/** The `orientation` control's values (Revyl refuses its exact landscape sides on an iPhone). */
const ORIENTATIONS = new Set(["portrait", "landscape"]);
/** `perf` samples for this long by default. */
const PERF_SECONDS = 5;
/** One read of the performance capture takes this many samples at most (two a second). */
const PERF_READ_LIMIT = 5_000;
/** Pages read to reach the capture's end: a phone's longest run fits in 3. */
const PERF_PAGES_MAX = 4;

const parseJson = (raw: Raw): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(raw.body.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/** The server's or Revyl's words for a refusal. */
function refusalOf(raw: Raw): { code: string; message: string } {
  const body = parseJson(raw);
  const error = body?.error as { code?: unknown; message?: unknown } | undefined;
  const detail = body?.detail;
  const code = typeof error?.code === "string" ? error.code : typeof body?.code === "string" ? body.code : `http_${raw.status}`;
  const message = typeof error?.message === "string" ? error.message
    : typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map((item) => (item as { msg?: unknown })?.msg).filter((msg): msg is string => typeof msg === "string").join("; ")
        : typeof body?.error === "string" ? body.error : "";
  return { code, message };
}

/** A device action's own answer: `{ success, error }`. */
function actionFailure(raw: Raw): string | null {
  if (raw.status >= 400) return refusalOf(raw).message || `the phone answered ${raw.status}`;
  const body = parseJson(raw);
  if (body && body.success === false) return typeof body.error === "string" && body.error ? body.error : "the phone refused it";
  return null;
}

const videoExtension = (bytes: Buffer): "mp4" | "mov" => (bytes.toString("latin1", 4, 10) === "ftypqt" ? "mov" : "mp4");

/** `30s`, `5m`, `2h` as milliseconds, or null. */
function sinceMs(value: string | undefined): number | null {
  const match = value ? /^(\d+)\s*([smh])$/i.exec(value.trim()) : null;
  if (!match) return null;
  return Number(match[1]) * ({ s: 1_000, m: 60_000, h: 3_600_000 } as const)[match[2]!.toLowerCase() as "s" | "m" | "h"];
}

/** The samples' summary: average and peak CPU, memory, and the frame rate. */
function perfText(body: Record<string, unknown>, seconds: number): string {
  const items = Array.isArray(body.items) ? body.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
  const nums = (read: (item: Record<string, unknown>) => unknown): number[] => items.map(read).map(Number).filter(Number.isFinite);
  const cpu = nums((item) => (item.cpu as Record<string, unknown> | undefined)?.app_percent);
  const rssMb = nums((item) => (item.memory_app as Record<string, unknown> | undefined)?.rss_kb).map((kb) => kb / 1024);
  const fps = nums((item) => item.fps);
  if (!items.length || (!cpu.length && !rssMb.length && !fps.length)) {
    return `No samples in ${seconds} s. They come from the app ADE launched last while it runs: launch your app (ade apple relaunch --bundle-id <id>), then run this again.`;
  }
  const avg = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  const lines = [
    `${items.length} samples over ${seconds} s, for the app ADE launched last:`,
    cpu.length ? `CPU: ${avg(cpu).toFixed(1)}% average, ${Math.max(...cpu).toFixed(1)}% peak` : null,
    rssMb.length ? `Memory: ${avg(rssMb).toFixed(0)} MB average, ${Math.max(...rssMb).toFixed(0)} MB peak` : null,
    fps.length ? `Frame rate: ${avg(fps).toFixed(1)} fps average, ${Math.min(...fps).toFixed(1)} fps lowest` : "Frame rate: none drawn (the screen didn't change)",
  ];
  return lines.filter(Boolean).join("\n");
}

export function createRevylDriver(ctx: CloudPhoneDriverContext): CloudPhoneDriver {
  /**
   * One call to the phone through the server. The first call of a command
   * that finds no live phone answers `CloudPhoneGoneError` (the service tries
   * a fresh one); a phone still connecting is waited for briefly.
   */
  async function call(phone: CloudPhoneHeld, action: string, body?: Record<string, unknown>, options: { query?: Record<string, string>; timeoutMs?: number; cmd?: Command } = {}): Promise<Raw> {
    const first = options.cmd?.first === true;
    if (options.cmd) options.cmd.first = false;
    const by = Date.now() + CONNECT_WAIT_MS;
    for (;;) {
      // Checked before every dispatch, a retry too: the call carries the token signed in now, and
      // after a switch that is another account's, never this command's next step.
      const client = await ctx.client();
      if (!client.phoneCall) throw new CloudPhoneError(`Update ${BRAND.NAME} to drive this cloud iPhone.`, "no_account");
      if ((client.account ?? null) !== phone.account) throw new CloudPhoneError(`The ${BRAND.NAME} account changed while the cloud iPhone was in use. Try again.`, "no_account");
      // `phoneId`: the held phone. A replacement (another chat stopped and started one) is refused
      // `phone_not_running`, so a command never goes on on a phone it didn't start on.
      const raw = await client.phoneCall({ action, phoneId: phone.phoneId, ...(body ? { body } : {}), ...(options.query ? { query: options.query } : {}) }, { timeoutMs: options.timeoutMs });
      const { code } = raw.status === 409 || raw.status >= 500 ? refusalOf(raw) : { code: "" };
      if (raw.status === 409 && code === "phone_not_running") {
        if (first) throw new CloudPhoneGoneError();
        throw new CloudPhoneError("The cloud iPhone ended.", "phone_ended");
      }
      // Ready on the server, still connecting at the phone: a moment more. A gateway error is
      // tried again only for a read: a tap or a build may have happened before the 502.
      const connecting = (raw.status === 409 && code === "phone_starting") || (SAFE_TO_REPEAT.has(action) && (raw.status === 502 || raw.status === 503));
      if (connecting && Date.now() < by) {
        await sleep(1_000);
        continue;
      }
      if (raw.status < 400) ctx.touched(phone);
      return raw;
    }
  }

  async function callJson(phone: CloudPhoneHeld, action: string, body?: Record<string, unknown>, options: { query?: Record<string, string>; timeoutMs?: number; cmd?: Command } = {}): Promise<Record<string, unknown>> {
    const raw = await call(phone, action, body, options);
    if (raw.status >= 400) {
      const { code, message } = refusalOf(raw);
      throw new CloudPhoneError(message || `The cloud iPhone answered ${raw.status}.`, code);
    }
    return parseJson(raw) ?? {};
  }

  async function readScreen(phone: CloudPhoneHeld, cmd?: Command): Promise<Screen> {
    const raw = await call(phone, "proxy.hierarchy", undefined, { cmd });
    if (raw.status >= 400) {
      const { code, message } = refusalOf(raw);
      throw new CloudPhoneError(`Reading the screen: ${message || `the phone answered ${raw.status}`}.`, code);
    }
    // An unreadable tree is an error, never an empty screen: a `gone` would pass on it.
    const unreadable = (): CloudPhoneError => new CloudPhoneError(`Reading the screen: the cloud iPhone answered a screen ${BRAND.NAME} couldn't read.`, "screen_unreadable");
    let tree: unknown;
    try {
      tree = JSON.parse(raw.body.toString("utf8"));
    } catch {
      throw unreadable();
    }
    // Revyl answers the tree itself, or wrapped (`{ hierarchy: … }`).
    const unwrapped = tree && typeof tree === "object" && !Array.isArray(tree) && "hierarchy" in tree ? (tree as { hierarchy: unknown }).hierarchy : tree;
    let parsed: unknown = unwrapped;
    if (typeof unwrapped === "string") {
      try {
        parsed = JSON.parse(unwrapped);
      } catch {
        throw unreadable();
      }
    }
    if (!parsed || typeof parsed !== "object") throw unreadable();
    const screen = screenOf(parsed, phone.points);
    // The size a read reports is the size now (a rotation swaps it): later gestures aim by it.
    if (screen.width && screen.height) phone.points = { width: screen.width, height: screen.height };
    return screen;
  }

  async function screenshotPng(phone: CloudPhoneHeld, cmd?: Command): Promise<Buffer> {
    const raw = await call(phone, "proxy.screenshot", undefined, { cmd });
    if (raw.status >= 400) throw new CloudPhoneError(`Taking a screenshot: ${refusalOf(raw).message || `the phone answered ${raw.status}`}.`, refusalOf(raw).code);
    const body = raw.type?.includes("json") ? parseJson(raw) : null;
    // A JSON answer carries the PNG as base64.
    const encoded = body ? [body.screenshot, body.image, body.data, body.png].find((value): value is string => typeof value === "string") : null;
    const bytes = encoded ? Buffer.from(encoded.replace(/^data:image\/\w+;base64,/, ""), "base64") : raw.body;
    if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) throw new CloudPhoneError("The cloud iPhone did not answer with a screenshot.", "no_screenshot");
    return bytes;
  }

  /** A device action; its own failure is a sentence, never a throw. */
  async function act(phone: CloudPhoneHeld, name: string, body: Record<string, unknown> = {}, cmd?: Command): Promise<string | null> {
    return actionFailure(await call(phone, `proxy.${name}`, body, { cmd, timeoutMs: name === "install" ? 150_000 : undefined }));
  }

  /** Where a step's element is: a point, or the element found on the screen. */
  async function locate(phone: CloudPhoneHeld, target: StepTarget, cmd: Command): Promise<{ x: number; y: number; frame?: { x: number; y: number; width: number; height: number } } | string> {
    if (target.by === "point") return { x: target.x, y: target.y };
    const found = findElement(await readScreen(phone, cmd), target);
    return found ? { x: found.x, y: found.y, frame: found.frame } : `nothing on the screen is ${targetWords(target)}`;
  }

  /** Waits for an element to show (`gone`: to go), up to `seconds`. */
  async function waitFor(phone: CloudPhoneHeld, target: StepTarget, seconds: number, gone: boolean, cmd: Command): Promise<string | null> {
    const by = Date.now() + Math.min(WAIT_LIMIT_S, Math.max(0.5, seconds)) * 1_000;
    for (;;) {
      const present = findElement(await readScreen(phone, cmd), target) != null;
      if (present !== gone) return null;
      if (Date.now() >= by) return gone ? `${targetWords(target)} was still on the screen after ${seconds} s` : `${targetWords(target)} didn't show within ${seconds} s`;
      await sleep(WAIT_POLL_MS);
    }
  }

  /** One `act` step, in NoMac's words; answers why it failed, or null. */
  async function step(phone: CloudPhoneHeld, raw: string, cmd: Command): Promise<string | null> {
    const words = stepWords(raw.trim());
    const verb = words[0]?.word.toLowerCase() ?? "";
    const rest = words.slice(1);
    const textOf = (from: number): string => rest.slice(from).map((word) => word.word).join(" ");
    const needTarget = (): StepTarget | string => (rest[0] ? readTarget(rest[0]) : `${verb} needs an element: "Label", #id or @x,y`);
    /** The first word's element on the screen now, or why not. */
    const targetPoint = async (): Promise<Awaited<ReturnType<typeof locate>>> => {
      const target = needTarget();
      return typeof target === "string" ? target : locate(phone, target, cmd);
    };
    switch (verb) {
      case "tap":
      case "double-tap": {
        const at = await targetPoint();
        if (typeof at === "string") return at;
        return act(phone, verb === "tap" ? "tap" : "double_tap", { x: at.x, y: at.y }, cmd);
      }
      case "hold": {
        const at = await targetPoint();
        if (typeof at === "string") return at;
        const seconds = Number(rest[1]?.word ?? 1);
        return act(phone, "longpress", { x: at.x, y: at.y, duration_ms: Math.round(Math.min(10, Math.max(0.1, Number.isFinite(seconds) ? seconds : 1)) * 1_000) }, cmd);
      }
      case "type": {
        const value = textOf(0);
        if (!value) return "type needs the text to type";
        // Revyl types at a point: the field that has the keyboard, untapped.
        const focused = (await readScreen(phone, cmd)).elements.find((element) => element.state.includes("focused"));
        if (!focused) return "nothing has the keyboard: tap a field first, or use fill";
        return act(phone, "input", { x: focused.x, y: focused.y, text: value, clear_first: false, skip_tap: true }, cmd);
      }
      case "fill": {
        const at = await targetPoint();
        if (typeof at === "string") return at;
        return act(phone, "input", { x: at.x, y: at.y, text: textOf(1), clear_first: true }, cmd);
      }
      case "key": {
        const key = KEYS[(rest[0]?.word ?? "").toLowerCase()];
        return key ? act(phone, "key", { key }, cmd) : "key is return, escape, delete, tab or space";
      }
      case "swipe":
      case "scroll": {
        const direction = (rest[0]?.word ?? "").toLowerCase();
        if (!DIRECTIONS.has(direction)) return `${verb} is up, down, left or right`;
        // No known size (the phone just turned): one read learns it. A gone phone still throws (its retry).
        const size = phone.points ?? await readScreen(phone, cmd).catch((error: unknown) => {
          if (error instanceof CloudPhoneGoneError) throw error;
          return null;
        });
        const width = size?.width || 400;
        const height = size?.height || 870;
        let at: { x: number; y: number } = { x: Math.round(width / 2), y: Math.round(height / 2) };
        if (rest[1]) {
          const found = await locate(phone, readTarget(rest[1]), cmd);
          if (typeof found === "string") return found;
          at = found;
        }
        return act(phone, "swipe", { direction: verb === "scroll" ? SCROLL_SWIPE[direction] : direction, x: at.x, y: at.y, duration_ms: 500 }, cmd);
      }
      case "set": {
        const at = await targetPoint();
        if (typeof at === "string") return at;
        const value = Number(rest[1]?.word);
        if (!Number.isFinite(value) || !at.frame) return "set takes a slider and a value from 0 to 100";
        const toX = Math.round(at.frame.x + (Math.min(100, Math.max(0, value)) / 100) * at.frame.width);
        return act(phone, "drag", { start_x: at.x, start_y: at.y, end_x: toX, end_y: at.y }, cmd);
      }
      case "back": {
        const current = await readScreen(phone, cmd);
        const back = current.elements.find((element) => element.traits.includes("BackButton") || element.id === "BackButton")
          ?? findElement(current, { by: "label", label: "Back" });
        if (back) return act(phone, "tap", { x: back.x, y: back.y }, cmd);
        // No back button: the edge swipe.
        const height = current.height || phone.points?.height || 870;
        const width = current.width || phone.points?.width || 400;
        return act(phone, "drag", { start_x: 2, start_y: Math.round(height / 2), end_x: Math.round(width * 0.7), end_y: Math.round(height / 2) }, cmd);
      }
      case "home":
        return act(phone, "go_home", {}, cmd);
      case "wait":
      case "gone": {
        const target = needTarget();
        if (typeof target === "string") return target;
        const seconds = Number(rest[1]?.word ?? 10);
        return waitFor(phone, target, Number.isFinite(seconds) ? seconds : 10, verb === "gone", cmd);
      }
      default:
        return `${JSON.stringify(verb)} isn't a step (tap, hold, type, fill, key, swipe, scroll, set, back, home, wait, gone)`;
    }
  }

  /**
   * The app's first screen, after it launched. A just-launched app often has
   * no accessibility tree yet (an empty screen): read again, up to
   * `LAUNCH_SETTLE_READS` times. The app already launched: a screen that can't
   * be read is a note, never a failure (a gone phone too: a retry would build
   * and install all over again on a new one).
   */
  async function settledScreen(phone: CloudPhoneHeld): Promise<string> {
    for (let read = 1; ; read += 1) {
      await sleep(LAUNCH_SETTLE_MS);
      try {
        const screen = await readScreen(phone);
        if (screen.elements.length || read >= LAUNCH_SETTLE_READS) return screenText(screen);
      } catch (error) {
        if (error instanceof CloudPhoneGoneError) return "The cloud iPhone stopped right after the launch.";
        return `The screen couldn't be read just now (${error instanceof Error ? error.message : "no answer"}). Run ade apple snapshot to look again.`;
      }
    }
  }

  /** Uploads the packed project as a build's source: the key Revyl stored it under. */
  async function uploadSource(phone: CloudPhoneHeld, packed: { file: string; size: number }, cmd: Command): Promise<string> {
    const link = await callJson(phone, "build.upload_url", { file_size: packed.size }, { cmd });
    const url = link.upload_url;
    const fields = link.upload_fields as Record<string, unknown> | undefined;
    if (typeof url !== "string" || !url.startsWith("https://") || !fields || typeof fields.key !== "string") {
      throw new CloudPhoneError("The cloud iPhone gave no place to upload the project.", "upload_failed");
    }
    // A presigned POST: its fields, then the file last. The file is read from disk as it goes.
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) if (typeof value === "string") form.append(name, value);
    form.append("file", await fs.openAsBlob(packed.file, { type: "application/gzip" }), "source.tar.gz");
    const posted = await ctx.fetcher(url, { method: "POST", body: form, signal: AbortSignal.timeout(30 * 60_000) });
    if (!posted.ok) throw new CloudPhoneError(`Uploading the project failed (${posted.status}).`, "upload_failed");
    return fields.key;
  }

  /** Follows a build to its end; the phone is kept awake meanwhile. */
  async function followBuild(phone: CloudPhoneHeld, job: string, doing: string): Promise<{ ok: true; version: string; seconds: number } | { ok: false; text: string }> {
    const started = Date.now();
    let awakeAt = started;
    for (;;) {
      const status = await callJson(phone, "build.status", { job });
      const state = String(status.status ?? "").toLowerCase();
      if (state === "success" || state === "succeeded" || state === "completed") {
        const version = typeof status.version_id === "string" ? status.version_id : null;
        if (!version) return { ok: false, text: `${doing}: the build finished but left no app.` };
        return { ok: true, version, seconds: Math.round((Date.now() - started) / 1000) };
      }
      if (state === "failed" || state === "error" || state === "cancelled" || state === "canceled" || state === "timeout") {
        return { ok: false, text: await buildErrors(phone, job, status) };
      }
      if (Date.now() - started > BUILD_WAIT_MS) throw new CloudPhoneError(`${doing} is still running after 15 minutes.`, "tool_timeout");
      if (Date.now() - awakeAt > BUILD_KEEP_AWAKE_MS) {
        awakeAt = Date.now();
        await call(phone, "proxy.health").catch((error: unknown) => {
          ctx.logger?.warn?.("cloud_phone.build_keep_awake_failed", { error: error instanceof Error ? error.message : String(error) });
        });
      }
      await sleep(BUILD_POLL_MS);
    }
  }

  /** A failed build's own error lines, as Xcode wrote them. */
  async function buildErrors(phone: CloudPhoneHeld, job: string, status: Record<string, unknown>): Promise<string> {
    const logs = await callJson(phone, "build.logs", { job }).catch((error: unknown) => {
      ctx.logger?.warn?.("cloud_phone.build_logs_failed", { error: error instanceof Error ? error.message : String(error) });
      return {} as Record<string, unknown>;
    });
    const lines = Array.isArray(logs.events)
      ? (logs.events as Array<Record<string, unknown>>).map((event) => (typeof event.message === "string" ? event.message : "")).filter(Boolean)
      : [];
    const errors = lines.filter((line) => /error:|\berror\b|failed|No (Xcode|scheme)/i.test(line) && !/^\s*builtin-/.test(line));
    const shown = (errors.length ? errors : lines).slice(-40);
    const why = [status.error, status.suggested_fix].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return ["The build failed.", ...why, ...(shown.length ? ["", ...shown] : [])].join("\n");
  }

  /** Builds the packed project on Revyl's runner; the build's version, or its errors. */
  async function build(phone: CloudPhoneHeld, input: CloudPhoneRunInput, mode: "build" | "prebuilt"): Promise<{ ok: true; version: string; seconds: number } | { ok: false; text: string }> {
    // The upload and the submission make no device call: the phone is kept awake through them too.
    const keepAwake = setInterval(() => {
      void call(phone, "proxy.health").catch((error: unknown) => {
        ctx.logger?.warn?.("cloud_phone.build_keep_awake_failed", { error: error instanceof Error ? error.message : String(error) });
      });
    }, BUILD_KEEP_AWAKE_MS);
    let started: Record<string, unknown>;
    try {
      const key = await uploadSource(phone, input.project, command());
      started = await callJson(phone, "build.start", {
        source_key: key,
        ...(mode === "prebuilt" ? { prebuilt: true } : {}),
        ...(input.sub ? { path: input.sub.replace(/\\/g, "/") } : {}),
        ...(input.scheme ? { scheme: input.scheme } : {}),
        ...(input.configuration ? { configuration: input.configuration } : {}),
        ...(input.clean ? { clean: true } : {}),
      }, { timeoutMs: 150_000 });
    } finally {
      clearInterval(keepAwake);
    }
    const job = typeof started.build_job_id === "string" ? started.build_job_id : null;
    if (!job) throw new CloudPhoneError("The cloud iPhone didn't start the build.", "build_failed");
    return followBuild(phone, job, mode === "prebuilt" ? "Installing the app" : "Building the app");
  }

  /** Installs a built version into the live phone; its bundle id, or why not. */
  async function installVersion(phone: CloudPhoneHeld, version: string): Promise<{ bundleId: string | null; failure: string | null }> {
    const raw = await call(phone, "build.install", { version_id: version }, { timeoutMs: 150_000 });
    const body = parseJson(raw);
    return {
      bundleId: typeof body?.bundle_id === "string" ? body.bundle_id : null,
      failure: actionFailure(raw),
    };
  }

  return {
    async read(phone) {
      const client = await ctx.client();
      const state = await client.phoneState!();
      const live = state.phone?.id === phone.phoneId ? state.phone : null;
      if (!live) return { state: "gone", code: "phone_gone" };
      if (live.state === "ended") return { state: "ended", end: { why: live.endReason, at: null } };
      return { state: live.state };
    },

    async keepAlive(phone) {
      const raw = await call(phone, "proxy.hierarchy", undefined, { cmd: command() }).catch((error: unknown) => {
        if (error instanceof CloudPhoneGoneError) return null;
        throw error;
      });
      if (!raw || raw.status === 404 || raw.status === 409) return "gone";
      if (raw.status >= 400) throw new CloudPhoneError(`Keeping the cloud iPhone awake failed (${raw.status}).`, refusalOf(raw).code);
      return "alive";
    },

    async look(phone, input) {
      const screen = await readScreen(phone, command());
      const answer = textAnswer(screenText(screen, input.find));
      if (input.screenshot) answer.images.push({ mimeType: "image/png", data: (await screenshotPng(phone)).toString("base64") });
      return answer;
    },

    async act(phone, steps) {
      const started = Date.now();
      const lines: string[] = [];
      let failedAt: number | null = null;
      const cmd = command();
      for (let index = 0; index < steps.length; index += 1) {
        const why = await step(phone, steps[index]!, cmd);
        if (why) {
          lines.push(`✗ ${steps[index]}: ${why}.`);
          failedAt = index;
          break;
        }
        lines.push(`✓ ${steps[index]}`);
      }
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      const done = failedAt ?? steps.length;
      lines.push(failedAt == null
        ? `${done} step${done === 1 ? "" : "s"} done in ${seconds} s.`
        : `Stopped at step ${failedAt + 1} of ${steps.length} (${done} done in ${seconds} s).`);
      // What the steps left on the screen, so a `snapshot` after is rarely needed.
      await sleep(400);
      const after = await readScreen(phone).then((screen) => screenText(screen)).catch(() => null);
      return textAnswer([...lines, ...(after ? ["", after] : [])].join("\n"), failedAt != null);
    },

    async screenshot(phone) {
      return { bytes: await screenshotPng(phone, command()), link: "" };
    },

    async run(phone, input) {
      const built = await build(phone, input, "build");
      if (!built.ok) return textAnswer(built.text, true);
      const installed = await installVersion(phone, built.version);
      if (installed.failure) return textAnswer(`Built in ${built.seconds} s, but installing it failed: ${installed.failure}.`, true);
      if (!installed.bundleId) return textAnswer(`Built in ${built.seconds} s and installed. Launch it with ade apple relaunch --bundle-id <id>.`);
      const launched = await act(phone, "launch", { bundle_id: installed.bundleId });
      if (launched) return textAnswer(`Built in ${built.seconds} s and installed ${installed.bundleId}, but launching it failed: ${launched}.`, true);
      // env values never get here: they need the `launchEnv` ability, which the service checks.
      return textAnswer(`Built in ${built.seconds} s, installed ${installed.bundleId} and launched it.\n\n${await settledScreen(phone)}`);
    },

    async install(phone, input) {
      // A `.app` goes up like a project, and Revyl's runner takes it as the build's app.
      const built = await build(phone, { project: input.app, name: "app" }, "prebuilt");
      if (!built.ok) return { answer: textAnswer(built.text, true), bundleId: null };
      const installed = await installVersion(phone, built.version);
      if (installed.failure) return { answer: textAnswer(`Installing the app failed: ${installed.failure}.`, true), bundleId: installed.bundleId };
      return { answer: textAnswer(`Installed ${installed.bundleId ?? "the app"}.`), bundleId: installed.bundleId };
    },

    async control(phone, input) {
      const { action, value, app } = input;
      const needApp = (): string | null => app ?? null;
      const done = (failure: string | null, words: string): CloudPhoneToolAnswer => textAnswer(failure ? `${words} failed: ${failure}.` : `${words}.`, failure != null);
      switch (action) {
        case "launch": {
          const id = needApp();
          if (!id) return textAnswer("launch needs the app's bundle id (--app).", true);
          const failure = await act(phone, "launch", { bundle_id: id }, command());
          if (failure) return done(failure, `Launching ${id}`);
          return textAnswer(`Launched ${id}.\n\n${await settledScreen(phone)}`);
        }
        case "terminate": {
          const id = needApp();
          if (!id) return textAnswer("terminate needs the app's bundle id (--app).", true);
          return done(await act(phone, "kill_app", { bundle_id: id }, command()), `Terminated ${id}`);
        }
        case "open_url": {
          if (!value) return textAnswer("open_url needs the URL.", true);
          return done(await act(phone, "open_url", { url: value }, command()), `Opened ${value}`);
        }
        case "location": {
          const [lat, lon] = (value ?? "").split(/[,\s]+/).map(Number);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return textAnswer("location is \"<latitude>,<longitude>\".", true);
          return done(await act(phone, "set_location", { latitude: lat, longitude: lon }, command()), `Moved the phone to ${lat},${lon}`);
        }
        case "appearance": {
          const mode = (value ?? "").toLowerCase();
          if (mode !== "dark" && mode !== "light") return textAnswer("appearance is dark or light.", true);
          return done(await act(phone, "set_appearance", { appearance: mode }, command()), `Appearance is ${mode}`);
        }
        case "text_size": {
          if (!value) return textAnswer("text_size is a size (xs … xxxl, ax-m … ax-xxxl) or a scale from 0.5 to 2.", true);
          const scale = Number(value);
          return done(await act(phone, "set_font_size", { scale: Number.isFinite(scale) ? scale : value.toLowerCase() }, command()), `Text size is ${value}`);
        }
        case "push": {
          const id = needApp();
          if (!id) return textAnswer("push needs the app's bundle id (--app).", true);
          let payload: unknown = null;
          try {
            payload = value ? JSON.parse(value) : null;
          } catch {
            payload = null;
          }
          const aps = payload && typeof payload === "object" ? payload : { aps: { alert: { body: value ?? "" } } };
          return done(await act(phone, "push_notification", { bundle_id: id, payload: aps }, command()), `Sent a notification to ${id}`);
        }
        case "grant":
        case "revoke":
        case "reset_permissions": {
          const id = needApp();
          if (!id) return textAnswer(`${action} needs the app's bundle id (--app).`, true);
          const names = (value ?? "").split(/[,\s]+/).filter(Boolean);
          if (!names.length) return textAnswer(`${action} needs the permission (location, camera, photos, microphone, contacts, …).`, true);
          const setting = action === "grant" ? "allow" : action === "revoke" ? "deny" : "reset";
          return done(await act(phone, "set_permissions", { bundle_id: id, permissions: Object.fromEntries(names.map((name) => [name, setting])) }, command()), `${names.join(", ")} ${setting === "allow" ? "allowed" : setting === "deny" ? "denied" : "reset"} for ${id}`);
        }
        case "shake":
          return done(await act(phone, "shake", {}, command()), "Shook the phone");
        case "orientation": {
          const turn = (value ?? "").toLowerCase();
          if (!ORIENTATIONS.has(turn)) return textAnswer("orientation is portrait or landscape.", true);
          const turned = await act(phone, "set_orientation", { orientation: turn }, command());
          // The screen's width and height swap: the next gesture reads them again.
          phone.points = null;
          return done(turned, `The phone is ${turn}`);
        }
        default:
          return textAnswer(`${action} isn't a cloud iPhone control (launch, terminate, open_url, location, push, appearance, text_size, grant, revoke, reset_permissions, shake, orientation).`, true);
      }
    },

    async logs(phone, input) {
      const pattern = input.grep ? (() => { try { return new RegExp(input.grep!, "i"); } catch { return null; } })() : null;
      const waitPattern = input.waitFor ? (() => { try { return new RegExp(input.waitFor!, "i"); } catch { return null; } })() : null;
      const since = sinceMs(input.since);
      const cutoff = since ? Date.now() - since : null;
      const keep = (line: string): boolean => {
        if (input.app && !line.toLowerCase().includes(input.app.toLowerCase()) && !line.toLowerCase().includes((input.app.split(".").pop() ?? "").toLowerCase())) return false;
        if (input.grep && !(pattern ? pattern.test(line) : line.toLowerCase().includes(input.grep.toLowerCase()))) return false;
        if (input.crashes && !/crash|EXC_|SIGABRT|SIGSEGV|Terminating app|fatal error|abort\(/i.test(line)) return false;
        if (cutoff) {
          const at = Date.parse(line.slice(0, 32).trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
          if (Number.isFinite(at) && at < cutoff) return false;
        }
        return true;
      };
      const lines: string[] = [];
      let cursor: string | undefined;
      const by = Date.now() + (input.waitFor ? WAIT_LIMIT_S * 1_000 : 0);
      const cmd = command();
      for (;;) {
        const body = await callJson(phone, "proxy.device_logs", undefined, { cmd, ...(cursor ? { query: { cursor } } : {}) });
        const items = Array.isArray(body.items) ? body.items.filter((item): item is string => typeof item === "string") : [];
        lines.push(...items.filter(keep));
        if (typeof body.next_cursor === "string") cursor = body.next_cursor;
        const seen = waitPattern ? lines.some((line) => waitPattern.test(line)) : input.waitFor ? lines.some((line) => line.includes(input.waitFor!)) : true;
        if (seen || Date.now() >= by) {
          const shown = lines.slice(-LOG_LINES);
          const missed = input.waitFor && !seen ? `\n${JSON.stringify(input.waitFor)} didn't show within ${WAIT_LIMIT_S} s.` : "";
          return textAnswer(shown.length ? `${shown.join("\n")}${missed}` : `No log lines${input.grep || input.app || input.crashes ? " match" : " yet"}.${missed}`, Boolean(missed));
        }
        await sleep(1_000);
      }
    },

    async perf(phone, input) {
      const seconds = input.seconds ?? PERF_SECONDS;
      const cmd = command();
      // The capture's cursor is an offset from the phone's start: page to its end (2 hours at 2 a second is
      // under 3 pages), then read what came in over `seconds`.
      let cursor: string | null = null;
      for (let page = 0; page < PERF_PAGES_MAX; page += 1) {
        const read = await callJson(phone, "proxy.performance_metrics", undefined, { cmd, query: { limit: String(PERF_READ_LIMIT), ...(cursor ? { cursor } : {}) } });
        const next = typeof read.next_cursor === "string" ? read.next_cursor : null;
        if (next) cursor = next;
        if (!next || !Array.isArray(read.items) || read.items.length < PERF_READ_LIMIT) break;
      }
      await sleep(seconds * 1_000);
      const body = await callJson(phone, "proxy.performance_metrics", undefined, { query: { limit: String(PERF_READ_LIMIT), ...(cursor ? { cursor } : {}) } });
      return textAnswer(perfText(body, seconds));
    },

    async record(phone, action) {
      if (action === "start") {
        const body = await callJson(phone, "proxy.start_screen_recording", {}, { cmd: command() });
        if (body.success === false || typeof body.recording_id !== "string") {
          return { answer: textAnswer(`Starting a recording failed: ${typeof body.error === "string" ? body.error : "the phone refused it"}.`, true), video: null };
        }
        return { answer: textAnswer("Recording. Stop it with ade apple record stop."), video: null };
      }
      // The server knows the running recording's id (Revyl names it only at its start).
      const raw = await call(phone, "proxy.stop_screen_recording", {}, { cmd: command(), timeoutMs: 150_000 });
      if (raw.status === 404 && refusalOf(raw).code === "not_recording") return { answer: textAnswer("No recording is running on this cloud iPhone.", true), video: null };
      if (raw.status >= 400 || raw.type?.includes("json")) {
        return { answer: textAnswer(`Stopping the recording failed: ${actionFailure(raw) ?? refusalOf(raw).message}.`, true), video: null };
      }
      return { answer: textAnswer("Recording stopped."), video: { bytes: raw.body, extension: videoExtension(raw.body) } };
    },
  };
}
