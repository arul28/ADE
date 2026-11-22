/**
 * The ADE Cloud iPhone on NoMac (`cloudPhoneDriver.ts` has the shape).
 *
 * The server hands this brain a token for one phone; with it this driver calls
 * the phone's own tools at NoMac directly: `ui_look`, `ui_act`, `app_run`,
 * `app_control`, `app_logs`, `screen_record`, `tests_run`, and the workspace's
 * `/sync/upload` + `/sync/fetch` for a packed checkout or app.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Readable } from "node:stream";
import {
  CloudPhoneError,
  CloudPhoneGoneError,
  sleep,
  type CloudPhoneDriver,
  type CloudPhoneDriverContext,
  type CloudPhoneHeld,
  type CloudPhonePacked,
  type CloudPhoneToolAnswer,
} from "./cloudPhoneDriver";
import { cloudPhoneGone } from "./cloudPhoneRun";

const CALL_POLL_MS = 1_000;
/** A tool call or a build job is given this long before ADE stops waiting. */
const TOOL_WAIT_MS = 15 * 60_000;
const JOB_PATTERN = /Next: job_status \{job_id: "([^"]+)"\}/;
const STILL_RUNNING = /Next: job_status again, or job_cancel\./;
const FILE_LINK = /https:\/\/nomac\.app\/api\/v1\/simulator\/files\/[A-Za-z0-9_.-]+/g;

type NomacAnswer = { status: number; body: Record<string, unknown> | null };

/**
 * NoMac's hints name its own tools ("use ui_look with screenshot"), which an
 * agent here cannot call: each becomes the `ade apple` command that does it.
 * Most specific first.
 */
const NOMAC_TOOL_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/`?\bui_look`?(?:\s*[({]\s*|\s+with\s+)`?screenshot(?:_file)?`?(?:\s*[:=]\s*true)?(?:\s*[)}])?`?/gi, "`ade apple screenshot`"],
  [/`?\bui_look\b`?/g, "`ade apple snapshot`"],
  [/`?\bui_act\b`?/g, "`ade apple act`"],
  [/`?\bapp_logs\b`?/g, "`ade apple logs`"],
  [/`?\bapp_run\b`?/g, "`ade apple launch`"],
  [/`?\bscreen_record\b`?/g, "`ade apple record start`"],
  [/`?\btests_run\b`?/g, "`ade apple test`"],
];

/** A NoMac answer's text in ADE's words. */
export function inAdeWords(text: string): string {
  let out = text;
  for (const [pattern, words] of NOMAC_TOOL_WORDS) out = out.replace(pattern, words);
  return out;
}

function answerOf(body: Record<string, unknown> | null): CloudPhoneToolAnswer {
  const result = body?.result as { content?: unknown; isError?: unknown } | undefined;
  const content = Array.isArray(result?.content) ? result.content as Array<Record<string, unknown>> : [];
  const text = content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text as string).join("\n");
  const images = content.flatMap((block) => block.type === "image" && typeof block.data === "string"
    ? [{ mimeType: typeof block.mimeType === "string" ? block.mimeType : "image/jpeg", data: block.data }]
    : []);
  const notice = body?.stop_notice as { message?: unknown } | null | undefined;
  return {
    text,
    failed: result?.isError === true,
    links: [...new Set(text.match(FILE_LINK) ?? [])],
    images,
    stopNotice: typeof notice?.message === "string" ? notice.message : null,
  };
}

/** The bundle id an install answer names, when it names one. */
export function bundleIdOf(text: string): string | null {
  const named = /bundle(?:\s*id)?\s*[:=]?\s*([A-Za-z][\w-]*(?:\.[\w-]+)+)/i.exec(text)?.[1];
  if (named) return named;
  // NoMac's own wording elsewhere: "installed dev.example.App." (app_run).
  const installed = /\binstalled\s+([A-Za-z][\w-]*(?:\.[\w-]+){2,})/i.exec(text)?.[1];
  if (installed) return installed.replace(/\.$/, "");
  return /\(([A-Za-z][\w-]*(?:\.[\w-]+){2,})\)/.exec(text)?.[1] ?? null;
}

/** That folder in the phone's unpacked copy. */
const onPhone = (uploadedRoot: string, sub: string | undefined): string => (sub ? `${uploadedRoot}/${sub.replace(/\\/g, "/")}` : uploadedRoot);

export function createNomacDriver(ctx: CloudPhoneDriverContext): CloudPhoneDriver {
  const { fetcher } = ctx;

  /** One call to the phone's NoMac session. A POST that must run once passes an `idempotencyKey` (`newKey()`, or one its retries share). */
  async function nomac(phone: CloudPhoneHeld, method: string, route: string, body?: unknown, idempotencyKey?: string): Promise<NomacAnswer> {
    const response = await fetcher(`${phone.apiBase}/sessions/${encodeURIComponent(phone.phoneId)}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${phone.token}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(90_000),
      redirect: "error",
    });
    const parsed = await response.json().catch(() => null) as unknown;
    return { status: response.status, body: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null };
  }

  const newKey = (): string => `ade-${randomUUID()}`;

  function failureOf(answer: NomacAnswer, doing: string): CloudPhoneError {
    const error = answer.body?.error as { code?: unknown; message?: unknown } | string | undefined;
    const code = typeof error === "string" ? error : typeof error?.code === "string" ? error.code : `http_${answer.status}`;
    const message = typeof answer.body?.message === "string"
      ? answer.body.message
      : typeof error === "object" && typeof error?.message === "string" ? error.message : null;
    // The answer's keys (never its values): a 200 with no result says what NoMac sent instead.
    ctx.logger?.warn?.("cloud_phone.call_failed", { doing, status: answer.status, code, bodyKeys: answer.body ? Object.keys(answer.body).slice(0, 12) : null });
    return new CloudPhoneError(message ? `${doing}: ${message}` : `${doing} failed (${code}).`, code);
  }

  /** A tool call NoMac held past 45 s answers `running` with its id: read it back until it ends, within `by`. */
  async function calledThrough(phone: CloudPhoneHeld, first: NomacAnswer, doing: string, by: number): Promise<NomacAnswer> {
    let answer = first;
    while (answer.status === 200 && answer.body?.state === "running" && typeof answer.body.id === "string") {
      if (Date.now() >= by) throw new CloudPhoneError(`${doing} is still running after 15 minutes.`, "tool_timeout");
      await sleep(CALL_POLL_MS);
      answer = await nomac(phone, "GET", `/calls/${encodeURIComponent(answer.body.id)}`);
    }
    return answer;
  }

  /**
   * Runs one of the phone's tools to its end: a call past 45 s is read back, a
   * build past 40 s is followed as a job. A phone that ended before the first
   * call answers `CloudPhoneGoneError`, and the service tries a fresh one.
   */
  async function tool(phone: CloudPhoneHeld, name: string, args: Record<string, unknown>, doing: string): Promise<CloudPhoneToolAnswer> {
    const by = Date.now() + TOOL_WAIT_MS;
    let answer = await nomac(phone, "POST", `/tools/${name}`, args, newKey());
    if (cloudPhoneGone(answer.status)) throw new CloudPhoneGoneError();
    if (answer.status === 200) ctx.touched(phone);
    answer = await calledThrough(phone, answer, doing, by);
    if (answer.status !== 200 || !answer.body?.result) throw failureOf(answer, doing);
    let result = answerOf(answer.body);
    // A long build answers with a job; job_status waits up to 40 s a call.
    let job = JOB_PATTERN.exec(result.text)?.[1] ?? null;
    while (job) {
      if (Date.now() >= by) throw new CloudPhoneError(`${doing} is still running after 15 minutes.`, "tool_timeout");
      // job_status is a tool call too: one that runs past 45 s is read back like any other.
      const next = await calledThrough(phone, await nomac(phone, "POST", "/tools/job_status", { job_id: job }, newKey()), doing, by);
      if (next.status !== 200 || !next.body?.result) throw failureOf(next, doing);
      ctx.touched(phone);
      result = answerOf(next.body);
      job = STILL_RUNNING.test(result.text) ? job : null;
    }
    return { ...result, text: inAdeWords(result.text) };
  }

  /** Uploads a packed archive with the closed link, then has the phone unpack it under `name`. */
  async function uploadPacked(phone: CloudPhoneHeld, packed: CloudPhonePacked, name: string, what: string): Promise<{ root: string; app: string | null }> {
    const link = await nomac(phone, "POST", "/sync/upload", { size: packed.size, sha256: packed.sha256 });
    const uploadUrl = link.body?.upload_url;
    if (link.status !== 200 || typeof uploadUrl !== "string" || !uploadUrl.startsWith("https://")) throw failureOf(link, `Uploading ${what}`);
    // Streamed from disk with its length: up to 2 GB is never held in memory.
    const put = await fetcher(uploadUrl, {
      method: "PUT",
      headers: { "content-length": String(packed.size) },
      body: Readable.toWeb(fs.createReadStream(packed.file)) as unknown as BodyInit,
      duplex: "half",
      signal: AbortSignal.timeout(30 * 60_000),
    } as RequestInit);
    if (!put.ok) throw new CloudPhoneError(`Uploading ${what} failed (${put.status}).`, "upload_failed");
    const key = `ade-fetch-${packed.sha256.slice(0, 32)}`;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const response = await nomac(phone, "POST", "/sync/fetch", { sha256: packed.sha256, name }, key);
      const body = response.body;
      if (response.status !== 200) throw failureOf(response, `Unpacking ${what}`);
      if (body?.state === "failed") throw new CloudPhoneError(`Unpacking ${what} failed: ${String(body.error ?? "unknown")}.`, "fetch_failed");
      if (body?.state !== "running" && typeof body?.root === "string") {
        return { root: body.root, app: typeof body.app === "string" ? body.app : null };
      }
      await sleep(CALL_POLL_MS);
    }
    throw new CloudPhoneError(`Unpacking ${what} took over 10 minutes.`, "fetch_timeout");
  }

  /** Downloads a file link the phone answered (7 days for screenshots and recordings). */
  async function download(link: string, what: string): Promise<Buffer> {
    const response = await fetcher(link, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!response.ok) throw new CloudPhoneError(`Downloading the ${what} failed (${response.status}).`, "download_failed");
    return Buffer.from(await response.arrayBuffer());
  }

  return {
    async read(phone) {
      const answer = await nomac(phone, "GET", "");
      const session = answer.body?.session as Record<string, unknown> | undefined;
      return { status: answer.status, session: session && typeof session === "object" ? session : null };
    },

    async keepAlive(phone) {
      const answer = await nomac(phone, "POST", "/tools/ui_look", {}, newKey());
      if (answer.status !== 200 && !cloudPhoneGone(answer.status)) throw failureOf(answer, "Keeping the cloud iPhone awake");
      return answer.status;
    },

    look(phone, input) {
      return tool(phone, "ui_look", { ...(input.find ? { find: input.find } : {}), ...(input.screenshot ? { screenshot: true } : {}) }, "Reading the screen");
    },

    act(phone, steps) {
      return tool(phone, "ui_act", { steps }, "Acting on the screen");
    },

    async screenshot(phone) {
      const answer = await tool(phone, "ui_look", { screenshot_file: true }, "Taking a screenshot");
      const found = answer.links.find((candidate) => /\.png/i.test(Buffer.from(candidate.split("/files/")[1]?.split(".")[0] ?? "", "base64url").toString("utf8"))) ?? answer.links[0];
      if (!found) throw new CloudPhoneError("The cloud iPhone did not answer with a screenshot.", "no_screenshot");
      return { bytes: await download(found, "screenshot"), link: found };
    },

    async run(phone, input) {
      const placed = await uploadPacked(phone, input.project, input.name, "the project");
      return tool(phone, "app_run", {
        path: onPhone(placed.root, input.sub),
        ...(input.scheme ? { scheme: input.scheme } : {}),
        ...(input.configuration ? { configuration: input.configuration } : {}),
        ...(input.env ? { env: input.env } : {}),
        ...(input.clean ? { clean: true } : {}),
      }, "Building and running the app");
    },

    async install(phone, input) {
      const placed = await uploadPacked(phone, input.app, "app", "the app");
      if (!placed.app) throw new CloudPhoneError("The phone did not find a .app in what was uploaded.", "fetch_failed");
      const installed = await tool(phone, "app_control", { action: "install", app: placed.app }, "Installing the app");
      const installedId = input.bundleId ?? bundleIdOf(installed.text);
      const wantsLaunch = input.launch && !installed.failed;
      // Launched only by name: unnamed, NoMac launches the app launched LAST, which may be an earlier build's.
      const answers = wantsLaunch && installedId
        ? [installed, await tool(phone, "app_control", { action: "launch", app: installedId }, "Launching the app")]
        : [installed];
      const skipped = wantsLaunch && !installedId
        ? "Installed, but not launched: ADE could not tell the app's bundle id. Launch it with ade apple relaunch --bundle-id <id>."
        : null;
      return {
        text: [...answers.map((answer) => answer.text.trim()), skipped ?? ""].filter(Boolean).join("\n"),
        failed: answers.some((answer) => answer.failed),
        links: [...new Set(answers.flatMap((answer) => answer.links))],
        images: answers.flatMap((answer) => answer.images),
        stopNotice: [...answers].reverse().find((answer) => answer.stopNotice)?.stopNotice ?? null,
        bundleId: installedId,
      };
    },

    control(phone, input) {
      return tool(phone, "app_control", { action: input.action, ...(input.value !== undefined ? { value: input.value } : {}), ...(input.app ? { app: input.app } : {}) }, `The phone's ${input.action}`);
    },

    logs(phone, input) {
      return tool(phone, "app_logs", {
        ...(input.app ? { app: input.app } : {}),
        ...(input.since ? { since: input.since } : {}),
        ...(input.grep ? { grep: input.grep } : {}),
        ...(input.waitFor ? { wait_for: input.waitFor } : {}),
        ...(input.crashes ? { crashes: true } : {}),
      }, "Reading the app's logs");
    },

    async record(phone, action) {
      const answer = await tool(phone, "screen_record", { action }, action === "start" ? "Starting a recording" : "Stopping the recording");
      const link = action === "stop" ? answer.links[0] ?? null : null;
      if (!link || answer.failed) return { answer, video: null };
      return { answer, video: { bytes: await download(link, "recording"), extension: "mp4" } };
    },

    async test(phone, input) {
      const placed = await uploadPacked(phone, input.project, input.name, "the project");
      return tool(phone, "tests_run", {
        path: onPhone(placed.root, input.sub),
        ...(input.scheme ? { scheme: input.scheme } : {}),
        ...(input.only ? { only: input.only } : {}),
      }, "Running the tests");
    },
  };
}
