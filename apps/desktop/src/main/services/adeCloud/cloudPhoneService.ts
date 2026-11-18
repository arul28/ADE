/**
 * The ADE Cloud iPhone as a brain drives it: `ade apple …` on a chat whose
 * iPhone is `ios@cloud`, from any machine (Windows, Linux, a Mac, an ADE
 * Cloud computer).
 *
 * ADE's server starts the phone and hands this brain a token for that phone
 * only (`/cloud/phone`, `phones.ts`); the account key that starts and stops
 * phones never leaves the server. With the token this service calls the
 * phone's own tools at NoMac directly: read the screen as text, act on it,
 * screenshots, logs, recordings, and a build of the lane's code (packed here,
 * uploaded, unpacked into the account's workspace there, built with Xcode) or
 * an app built elsewhere, installed as-is.
 *
 * One phone per account: every chat on this brain that chose `ios@cloud`
 * drives the same phone, as every lane of an account shares its plan's
 * minutes. See docs/features/apple-device/ade-cloud-iphone.md.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type {
  CloudPhoneDevice,
  CloudPhoneMinutes,
  CloudPhoneStart,
  CloudPhoneSummary,
  CloudPhoneView,
} from "../../../../../account-directory/src/cloud/contract";
import type { CloudProvider } from "./cloudProvider";
import { CloudProviderError } from "./cloudProvider";
import { CLOUD_PHONE_AGENT_ACTIONS, CLOUD_PHONE_DEVICES, isCloudPhoneDevice, type CloudPhoneStatusView } from "../../../shared/cloudPhone";
import type { ComputerUseArtifactIngestionRequest } from "../../../shared/types";
import { readArtifactId } from "../ios/recording/simRecordingService";
import { isPathInside } from "../shared/pathCompare";
import { isPathEscapeError, resolvePathWithinRoot } from "../shared/utils";

export type CloudPhoneServiceDeps = {
  /** The account's ADE Cloud client, or null signed out. */
  provider: () => Promise<CloudProvider | null>;
  /** Why there is no client, in one sentence. */
  whyNoProvider: () => Promise<string | null>;
  logger?: { info?(event: string, meta?: Record<string, unknown>): void; warn?(event: string, meta?: Record<string, unknown>): void };
  fetch?: typeof fetch;
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


type Held = { phoneId: string; token: string; expiresAt: number; apiBase: string; device: string; minutes: CloudPhoneMinutes; checkedAt: number };

const READY_WAIT_MS = 6 * 60_000;
const CALL_POLL_MS = 1_000;
/** A tool call or a build job is given this long before ADE stops waiting. */
const TOOL_WAIT_MS = 15 * 60_000;
const UPLOAD_LIMIT_BYTES = 2 * 1024 ** 3;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** A held phone read ready this recently is used without reading it again. */
const READY_TRUST_MS = 20_000;
const JOB_PATTERN = /Next: job_status \{job_id: "([^"]+)"\}/;
const STILL_RUNNING = /Next: job_status again, or job_cancel\./;
const FILE_LINK = /https:\/\/nomac\.app\/api\/v1\/simulator\/files\/[A-Za-z0-9_.-]+/g;

/** NoMac's own list of what never goes up (`simulator-use` sync): build output, dependencies, version control, keys. */
const SKIP_DIRS = new Set([".git", ".hg", ".svn", "DerivedData", "build", ".build", "node_modules", "Pods", "xcuserdata", ".swiftpm", ".expo", ".gradle", ".ade"]);
const isSecretFile = (name: string): boolean =>
  (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template)$/.test(name))
  || /\.(p8|p12|pfx|pem|key|mobileprovision|provisionprofile|keystore|jks)$/i.test(name)
  || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)
  || name === ".netrc";
const skipFile = (name: string): boolean => name === ".DS_Store" || name.endsWith(".xcuserstate") || isSecretFile(name);

function cloudPhoneSkipsPath(relative: string): boolean {
  const parts = relative.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? "";
  return parts.slice(0, -1).some((part) => SKIP_DIRS.has(part)) || SKIP_DIRS.has(name) || skipFile(name);
}

export class CloudPhoneError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CloudPhoneError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command: string, args: string[], options: { cwd: string; input?: Buffer }): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err.slice(-2000) }));
    child.stdin.end(options.input ?? undefined);
  });
}

/**
 * The files a build needs: what git tracks or would track (its ignores kept),
 * minus NoMac's skip list. Only files go to tar, never a folder: git lists a
 * submodule as its folder, so its own files are listed the same way, under its
 * path, and each passes the same filter (a folder whole would carry its keys).
 */
async function projectFiles(root: string, prefix = ""): Promise<string[]> {
  const listed = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: prefix ? path.join(root, prefix) : root });
  if (listed.code !== 0) throw new CloudPhoneError(`Could not list the project's files: ${listed.stderr.trim() || "git failed"}.`, "pack_failed");
  const files: string[] = [];
  for (const entry of listed.stdout.toString("utf8").split("\0")) {
    if (!entry) continue;
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (cloudPhoneSkipsPath(relative)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(root, relative));
    } catch {
      continue; // Tracked but deleted here.
    }
    if (!stat.isDirectory()) files.push(relative);
    // A submodule that is checked out; one that isn't has no files to send.
    else if (fs.existsSync(path.join(root, relative, ".git"))) files.push(...await projectFiles(root, relative));
  }
  return files;
}

type Packed = { file: string; size: number; sha256: string };

/**
 * Packs with the system's tar into a temp `.tar.gz`, then reads its size and
 * sha256 as a stream: an archive up to 2 GB is never held in memory. The file
 * is removed when packing fails or it is over the limit.
 */
async function packWithTar(noun: "project" | "app", tarArgs: (out: string) => string[], options: { cwd: string; input?: Buffer }): Promise<Packed> {
  const out = path.join(os.tmpdir(), `ade-cloud-phone-${noun === "app" ? "app-" : ""}${randomUUID()}.tar.gz`);
  try {
    const packed = await run("tar", tarArgs(out), options);
    if (packed.code !== 0) throw new CloudPhoneError(`Could not pack the ${noun}: ${packed.stderr.trim() || "tar failed"}.`, "pack_failed");
    const { size } = await fs.promises.stat(out);
    if (size > UPLOAD_LIMIT_BYTES) throw new CloudPhoneError(`The ${noun} is over 2 GB packed, more than a cloud iPhone takes.`, "pack_too_large");
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(out)) hash.update(chunk as Buffer);
    return { file: out, size, sha256: hash.digest("hex") };
  } catch (error) {
    fs.rmSync(out, { force: true });
    throw error;
  }
}

/** A `.tar.gz` of those files, made with the system's tar (Windows 10+, macOS and Linux all ship one that reads `--null -T -`). */
async function packProject(root: string): Promise<Packed & { count: number }> {
  const files = await projectFiles(root);
  if (!files.length) throw new CloudPhoneError("The project has no files to send.", "pack_failed");
  const packed = await packWithTar("project", (out) => ["--null", "-czf", out, "-T", "-"], { cwd: root, input: Buffer.from(`${files.join("\0")}\0`, "utf8") });
  return { ...packed, count: files.length };
}

/** Sent for a `.ipa` or a device build: the cloud iPhone runs Simulator builds. */
const DEVICE_BUILD = "That is a device build (.ipa). The cloud iPhone needs a Simulator build: for Expo/EAS set \"simulator\": true; for Flutter run flutter build ios --simulator.";

/** What a bundle's Info.plist says it is for: "iPhoneSimulator", "iPhoneOS", or null when it can't be told. */
function supportedPlatformOf(bundle: string): string | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(path.join(bundle, "Info.plist"));
  } catch {
    return null;
  }
  // XML and binary plists both keep these names as plain bytes.
  const text = bytes.toString("latin1");
  if (text.includes("iPhoneSimulator")) return "iPhoneSimulator";
  if (text.includes("iPhoneOS")) return "iPhoneOS";
  return null;
}

/** A `.tar.gz` of one `.app` folder, whole: a bundle's own folders and files are part of it. */
function packApp(appPath: string): Promise<Packed> {
  const parent = path.dirname(appPath);
  return packWithTar("app", (out) => ["-czf", out, "-C", parent, path.basename(appPath)], { cwd: parent });
}

/**
 * Where a screenshot is saved. Like the local simulator, which refuses an out
 * path outside its build root, only inside the calling project or the temp
 * folder; a relative path resolves under the project. The real-path check
 * catches a symlink inside an allowed folder that points out of it.
 */
function screenshotTarget(requested: string | undefined, projectRoot: string | null): string {
  const temp = os.tmpdir();
  if (!requested) return path.join(temp, `ade-cloud-iphone-${Date.now()}.png`);
  const target = path.resolve(projectRoot ?? temp, requested);
  const allowed = [projectRoot, temp].filter((root): root is string => Boolean(root)).some((root) => {
    if (!isPathInside(target, root)) return false;
    if (!fs.existsSync(root)) return true;
    try {
      resolvePathWithinRoot(root, target, { allowMissing: true });
      return true;
    } catch (error) {
      if (isPathEscapeError(error)) return false;
      throw error;
    }
  });
  if (!allowed) {
    throw new CloudPhoneError(
      `${target} is outside ${projectRoot ? `the project (${projectRoot}) and ` : ""}the temp folder. outPath must be a path inside ${projectRoot ? "one of them; a relative path resolves under the project" : "the temp folder"}.`,
      "out_path_outside_root",
    );
  }
  return target;
}

/** The bundle id an install answer names, when it names one. */
function bundleIdOf(text: string): string | null {
  const named = /bundle(?:\s*id)?\s*[:=]?\s*([A-Za-z][\w-]*(?:\.[\w-]+)+)/i.exec(text)?.[1];
  if (named) return named;
  // NoMac's own wording elsewhere: "installed dev.example.App." (app_run).
  const installed = /\binstalled\s+([A-Za-z][\w-]*(?:\.[\w-]+){2,})/i.exec(text)?.[1];
  if (installed) return installed.replace(/\.$/, "");
  return /\(([A-Za-z][\w-]*(?:\.[\w-]+){2,})\)/.exec(text)?.[1] ?? null;
}

/** The workspace folder a project unpacks into: the same one each time, so builds stay incremental. */
function cloudPhoneProjectName(root: string): string {
  const base = path.basename(root).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "project";
  return `${base}-${createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 12)}`;
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

export function createCloudPhoneService(deps: CloudPhoneServiceDeps) {
  const fetcher = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  let held: Held | null = null;
  /**
   * The account `held` was started for. A phone and its token belong to one
   * account: after a sign-out or a switch to another account it is dropped,
   * never driven. The client is made fresh per call, so its account names it.
   */
  let heldFor: string | null = null;
  /** One start at a time: a second caller waits for the same phone. */
  let starting: Promise<Held> | null = null;

  const accountOf = (client: CloudProvider | null): string | null => client?.account ?? null;

  async function provider(): Promise<CloudProvider> {
    const client = await deps.provider();
    if (!client?.phoneState) throw new CloudPhoneError(await deps.whyNoProvider() ?? "Sign in to ADE to use the ADE Cloud iPhone.", "no_account");
    return client;
  }

  /** Drops the held phone when the signed-in account is no longer the one it was started for. */
  async function dropOtherAccountsPhone(): Promise<void> {
    if (held && accountOf(await deps.provider()) !== heldFor) held = null;
  }

  function hold(start: CloudPhoneStart, client: CloudProvider): Held {
    heldFor = accountOf(client);
    held = {
      phoneId: start.phone.id,
      token: start.token.token,
      expiresAt: start.token.expiresAt,
      apiBase: start.apiBase.replace(/\/+$/, ""),
      device: String(start.phone.device),
      minutes: start.minutes,
      checkedAt: 0,
    };
    return held;
  }

  /** One call to the phone's NoMac session. A POST that must run once passes an `idempotencyKey` (`newKey()`, or one its retries share). */
  async function nomac(phone: Held, method: string, route: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
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

  function failureOf(answer: { status: number; body: Record<string, unknown> | null }, doing: string): CloudPhoneError {
    const error = answer.body?.error as { code?: unknown; message?: unknown } | string | undefined;
    const code = typeof error === "string" ? error : typeof error?.code === "string" ? error.code : `http_${answer.status}`;
    const message = typeof answer.body?.message === "string"
      ? answer.body.message
      : typeof error === "object" && typeof error?.message === "string" ? error.message : null;
    deps.logger?.warn?.("cloud_phone.call_failed", { doing, status: answer.status, code });
    return new CloudPhoneError(message ? `${doing}: ${message}` : `${doing} failed (${code}).`, code);
  }

  /** The phone's state read with its own token. */
  async function readSession(phone: Held): Promise<{ state: string; session: Record<string, unknown> | null }> {
    const answer = await nomac(phone, "GET", "");
    const session = answer.body?.session as Record<string, unknown> | undefined;
    if (answer.status !== 200 || typeof session?.state !== "string") throw failureOf(answer, "Reading the cloud iPhone");
    return { state: session.state, session };
  }

  async function waitUntilReady(phone: Held): Promise<void> {
    const by = Date.now() + READY_WAIT_MS;
    for (;;) {
      const { state, session } = await readSession(phone);
      if (state === "ready") return;
      if (state === "stopping" || state === "stopped" || state === "failed") {
        held = null;
        const why = (session?.failure_code ?? (session?.ended as { reason?: unknown } | undefined)?.reason ?? state) as string;
        throw new CloudPhoneError(`The cloud iPhone ended before it was ready (${why}).`, "phone_ended");
      }
      if (Date.now() >= by) throw new CloudPhoneError("No cloud iPhone was free within 6 minutes. Try again soon.", "phone_queue_timeout");
      await sleep(CALL_POLL_MS);
    }
  }

  /** The account's ready phone, started when there is none. */
  async function ensure(device?: CloudPhoneDevice): Promise<Held> {
    await dropOtherAccountsPhone();
    if (held && held.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS && (!device || held.device === device)) {
      if (Date.now() - held.checkedAt < READY_TRUST_MS) return held;
      // A held phone may have stopped on its own (idle, its time limit): read it.
      const read = await readSession(held).catch(() => null);
      if (read?.state === "ready") {
        held.checkedAt = Date.now();
        return held;
      }
      held = null;
    }
    starting ??= (async () => {
      const client = await provider();
      const start = await client.phoneStart!({ ...(device ? { device } : {}) });
      const phone = hold(start, client);
      deps.logger?.info?.("cloud_phone.held", { phoneId: phone.phoneId, reused: start.reused, minutesLeft: start.minutes.left });
      await waitUntilReady(phone);
      phone.checkedAt = Date.now();
      return phone;
    })().finally(() => { starting = null; });
    return starting;
  }

  /** Runs one of the phone's tools to its end: a call past 45 s is read back, a build past 40 s is followed as a job. */
  async function tool(name: string, args: Record<string, unknown>, doing: string): Promise<CloudPhoneToolAnswer> {
    let phone = await ensure();
    const by = Date.now() + TOOL_WAIT_MS;
    let answer = await nomac(phone, "POST", `/tools/${name}`, args, newKey());
    // The phone ended between the check and the call (idle, its limit): once more on a fresh one.
    if (answer.status === 401 || answer.status === 404 || answer.status === 409 || answer.status === 410) {
      held = null;
      phone = await ensure();
      answer = await nomac(phone, "POST", `/tools/${name}`, args, newKey());
    }
    while (answer.status === 200 && answer.body?.state === "running" && typeof answer.body.id === "string") {
      if (Date.now() >= by) throw new CloudPhoneError(`${doing} is still running after 15 minutes.`, "tool_timeout");
      await sleep(CALL_POLL_MS);
      answer = await nomac(phone, "GET", `/calls/${encodeURIComponent(answer.body.id)}`);
    }
    if (answer.status !== 200 || !answer.body?.result) throw failureOf(answer, doing);
    let result = answerOf(answer.body);
    // A long build answers with a job; job_status waits up to 40 s a call.
    let job = JOB_PATTERN.exec(result.text)?.[1] ?? null;
    while (job) {
      if (Date.now() >= by) throw new CloudPhoneError(`${doing} is still running after 15 minutes.`, "tool_timeout");
      const next = await nomac(phone, "POST", "/tools/job_status", { job_id: job }, newKey());
      if (next.status !== 200 || !next.body?.result) throw failureOf(next, doing);
      result = answerOf(next.body);
      job = STILL_RUNNING.test(result.text) ? job : null;
    }
    return result;
  }

  /** Uploads a packed archive with the closed link, then has the phone unpack it under `name`. */
  async function uploadPacked(phone: Held, packed: Packed, name: string, what: string): Promise<{ root: string; app: string | null }> {
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

  async function uploadProject(root: string): Promise<{ root: string; files: number; bytes: number }> {
    const phone = await ensure();
    const packed = await packProject(root);
    try {
      const placed = await uploadPacked(phone, packed, cloudPhoneProjectName(root), "the project");
      return { root: placed.root, files: packed.count, bytes: packed.size };
    } finally {
      fs.rmSync(packed.file, { force: true });
    }
  }

  /** Downloads a file link the phone answered (7 days for screenshots and recordings). */
  async function download(link: string, what: string): Promise<Buffer> {
    const response = await fetcher(link, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!response.ok) throw new CloudPhoneError(`Downloading the ${what} failed (${response.status}).`, "download_failed");
    return Buffer.from(await response.arrayBuffer());
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

  /** A build's project folder on this machine, and the folder inside it to build (`path`). */
  const projectArgs = (args: { root?: unknown; path?: unknown } | null | undefined): { root: string; sub: string | undefined } => {
    const root = textArg(args?.root, "root", 2_000);
    if (!root || !fs.existsSync(root)) throw new CloudPhoneError("root is the project's folder on this machine.", "bad_request");
    const sub = textArg(args?.path, "path", 500);
    if (sub && (path.isAbsolute(sub) || sub.split(/[\\/]/).includes(".."))) throw new CloudPhoneError("path is a folder inside the project.", "bad_request");
    return { root, sub };
  };
  /** That folder in the phone's unpacked copy. */
  const onPhone = (uploadedRoot: string, sub: string | undefined): string => (sub ? `${uploadedRoot}/${sub.replace(/\\/g, "/")}` : uploadedRoot);

  return {
    async getStatus(): Promise<CloudPhoneStatusView> {
      const client = await deps.provider();
      if (!client?.phoneState) {
        return { access: "off", minutes: null, phone: null, capabilities: [], supported: false, reason: await deps.whyNoProvider() ?? "Sign in to ADE to use the ADE Cloud iPhone." };
      }
      const state = await client.phoneState();
      if (!state.phone) held = null;
      const reason = state.access === "on" ? null
        : state.access === "soon" ? "The ADE Cloud iPhone is coming soon. It isn't on this account yet."
          : "The ADE Cloud iPhone isn't available right now.";
      return { ...state, capabilities: state.access === "on" ? CLOUD_PHONE_AGENT_ACTIONS : [], supported: state.access === "on", reason };
    },

    async start(args: { device?: unknown } | null | undefined): Promise<{ phone: CloudPhoneSummary | null; minutes: CloudPhoneMinutes }> {
      const device = args?.device;
      if (device !== undefined && !isCloudPhoneDevice(device)) {
        throw new CloudPhoneError(`device is ${CLOUD_PHONE_DEVICES.join(", ")}.`, "bad_request");
      }
      const phone = await ensure(device);
      const state = await (await provider()).phoneState!();
      return { phone: state.phone, minutes: state.minutes ?? phone.minutes };
    },

    async stop(): Promise<{ stopped: boolean }> {
      held = null;
      const result = await (await provider()).phoneStop!();
      deps.logger?.info?.("cloud_phone.stopped", { stopped: result.stopped });
      return result;
    },

    /** The screen as text: one element per line, with its label and center in points. */
    async look(args: { find?: unknown; screenshot?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const find = textArg(args?.find, "find", 200);
      return tool("ui_look", { ...(find ? { find } : {}), ...(args?.screenshot === true ? { screenshot: true } : {}) }, "Reading the screen");
    },

    /** Steps in `look`'s words: `tap "Sign In"`, `fill #email a@b.c`, `swipe up`, `wait "Welcome" 10`, `home`. */
    async act(args: { steps?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const steps = Array.isArray(args?.steps) ? args.steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0) : [];
      if (!steps.length || steps.length > 50) throw new CloudPhoneError("steps is a list of 1 to 50 steps, e.g. [\"tap \\\"Sign In\\\"\"].", "bad_request");
      return tool("ui_act", { steps }, "Acting on the screen");
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
      const target = screenshotTarget(requested, proof?.projectRoot ?? null);
      const answer = await tool("ui_look", { screenshot_file: true }, "Taking a screenshot");
      const link = answer.links.find((candidate) => /\.png/i.test(Buffer.from(candidate.split("/files/")[1]?.split(".")[0] ?? "", "base64url").toString("utf8"))) ?? answer.links[0];
      if (!link) throw new CloudPhoneError("The cloud iPhone did not answer with a screenshot.", "no_screenshot");
      const bytes = await download(link, "screenshot");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, bytes);
      const caption = textArg(args?.caption, "caption", 300) ?? "ADE Cloud iPhone screenshot";
      const artifactId = args?.noProof === true ? null : fileProof(proof, args ?? {}, { kind: "screenshot", path: target, mimeType: "image/png", title: caption });
      return { path: target, link, bytes: bytes.length, artifactId };
    },

    /**
     * Builds the project at `root` on the phone (Xcode 27.2) and starts it:
     * packs what git tracks there, uploads it, unpacks only what changed, then
     * `app_run`. Answers the app's first screen as text, or the build's errors.
     */
    async launch(args: { root?: unknown; path?: unknown; scheme?: unknown; configuration?: unknown; env?: unknown; clean?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer & { files: number; bytes: number }> {
      const { root, sub } = projectArgs(args);
      const configuration = args?.configuration === undefined ? undefined : args.configuration === "Release" ? "Release" : args.configuration === "Debug" ? "Debug" : null;
      if (configuration === null) throw new CloudPhoneError("configuration is Debug or Release.", "bad_request");
      const uploaded = await uploadProject(root);
      const target = onPhone(uploaded.root, sub);
      const scheme = textArg(args?.scheme, "scheme", 200);
      const env = textArg(args?.env, "env", 8_000);
      const answer = await tool("app_run", {
        path: target,
        ...(scheme ? { scheme } : {}),
        ...(configuration ? { configuration } : {}),
        ...(env ? { env } : {}),
        ...(args?.clean === true ? { clean: true } : {}),
      }, "Building and running the app");
      return { ...answer, files: uploaded.files, bytes: uploaded.bytes };
    },

    /**
     * Installs a Simulator `.app` built on this machine (Expo/EAS with
     * `"simulator": true`, React Native, Flutter `--simulator`): packs the
     * whole bundle, uploads it, has the phone unpack it as `app`, installs it,
     * and launches it unless `launch` is false.
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
      const packed = await packApp(appPath);
      try {
        const phone = await ensure();
        const placed = await uploadPacked(phone, packed, "app", "the app");
        if (!placed.app) throw new CloudPhoneError("The phone did not find a .app in what was uploaded.", "fetch_failed");
        const installed = await tool("app_control", { action: "install", app: placed.app }, "Installing the app");
        // Named, not the default: NoMac's default is the app launched LAST, which may be an earlier build's.
        const installedId = bundleIdOf(installed.text);
        const answers = args?.launch === false || installed.failed
          ? [installed]
          : [installed, await tool("app_control", { action: "launch", ...(installedId ? { app: installedId } : {}) }, "Launching the app")];
        return {
          text: answers.map((answer) => answer.text.trim()).filter(Boolean).join("\n"),
          failed: answers.some((answer) => answer.failed),
          links: [...new Set(answers.flatMap((answer) => answer.links))],
          images: answers.flatMap((answer) => answer.images),
          stopNotice: [...answers].reverse().find((answer) => answer.stopNotice)?.stopNotice ?? null,
          bundleId: installedId,
        };
      } finally {
        fs.rmSync(packed.file, { force: true });
      }
    },

    /** Apps and the phone: launch, terminate, open_url, location, push, appearance, … (`app_control`). */
    async control(args: { action?: unknown; value?: unknown; app?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const action = textArg(args?.action, "action", 40);
      if (!action) throw new CloudPhoneError("action is required (launch, terminate, open_url, location, push, appearance, …).", "bad_request");
      const value = textArg(args?.value, "value");
      const app = textArg(args?.app, "app", 300);
      return tool("app_control", { action, ...(value !== undefined ? { value } : {}), ...(app ? { app } : {}) }, `The phone's ${action}`);
    },

    async logs(args: { app?: unknown; since?: unknown; grep?: unknown; waitFor?: unknown; crashes?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const app = textArg(args?.app, "app", 300);
      const since = textArg(args?.since, "since", 20);
      const grep = textArg(args?.grep, "grep", 300);
      const waitFor = textArg(args?.waitFor, "waitFor", 300);
      return tool("app_logs", {
        ...(app ? { app } : {}),
        ...(since ? { since } : {}),
        ...(grep ? { grep } : {}),
        ...(waitFor ? { wait_for: waitFor } : {}),
        ...(args?.crashes === true ? { crashes: true } : {}),
      }, "Reading the app's logs");
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
      const answer = await tool("screen_record", { action }, action === "start" ? "Starting a recording" : "Stopping the recording");
      const link = action === "stop" ? answer.links[0] ?? null : null;
      if (!link || answer.failed) return { ...answer, path: null, artifactId: null };
      const bytes = await download(link, "recording");
      const target = path.join(os.tmpdir(), `ade-cloud-iphone-${Date.now()}.mp4`);
      fs.writeFileSync(target, bytes);
      const caption = textArg(args?.caption, "caption", 300) ?? "ADE Cloud iPhone recording";
      const artifactId = args?.noProof === true ? null : fileProof(proof, args ?? {}, { kind: "video_recording", path: target, mimeType: "video/mp4", title: caption });
      return { ...answer, path: target, artifactId };
    },

    async runTests(args: { root?: unknown; path?: unknown; scheme?: unknown; only?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const { root, sub } = projectArgs(args);
      const uploaded = await uploadProject(root);
      const scheme = textArg(args?.scheme, "scheme", 200);
      const only = textArg(args?.only, "only", 2_000);
      return tool("tests_run", {
        path: onPhone(uploaded.root, sub),
        ...(scheme ? { scheme } : {}),
        ...(only ? { only } : {}),
      }, "Running the tests");
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
    },
  };
}

export type CloudPhoneService = ReturnType<typeof createCloudPhoneService>;
