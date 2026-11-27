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

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { isPathInside } from "../shared/pathCompare";
import { pngLooksBlank } from "./cloudPhoneBlankFrame";
import {
  cloudPhoneCallerChat,
  cloudPhoneEndLine,
  cloudPhoneStartLine,
  type CloudPhoneRun,
  type CloudPhoneRunEnd,
} from "./cloudPhoneRun";
import { isPathEscapeError, resolvePathWithinRoot } from "../shared/utils";
import {
  CloudPhoneError,
  CloudPhoneGoneError,
  joinAnswers,
  sleep,
  textAnswer,
  type CloudPhoneDriver,
  type CloudPhoneHeld as Held,
  type CloudPhonePacked as Packed,
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
const UPLOAD_LIMIT_BYTES = 2 * 1024 ** 3;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** A held phone read ready this recently is used without reading it again. */
const READY_TRUST_MS = 20_000;
/**
 * A start refused `phone_starting` (another machine's start in flight) is
 * asked again this often, for this long: a slow cloud start runs for minutes.
 */
const START_BUSY_POLL_MS = 2_000;
const START_BUSY_WAIT_MS = 5 * 60_000;
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

/**
 * The folder inside the upload to build, from the files that go up. The phone
 * looks only at the folder it is given, so with no `path`, ADE finds the
 * project where a Mac's own `ade apple launch` looks (`discoverXcodeProjectPaths`
 * in `iosSimulatorService.ts`): the top, each folder at the top, and `apps/*`.
 * A `.xcodeproj`, `.xcworkspace` or XcodeGen `project.yml` marks a folder; a
 * `Package.swift` at the top leaves the choice to the phone. A named `path`
 * must be something that goes up. Throws a sentence that names `--path`.
 */
function cloudPhoneBuildFolder(files: readonly string[], requested: string | undefined, root: string): string | undefined {
  if (requested) {
    // `ios/.`, `./ios/` and `ios` are one folder; `..` never gets here (`projectArgs`).
    const named = path.posix.normalize(requested.replace(/\\/g, "/")).replace(/\/+$/, "");
    if (!named || named === ".") return undefined;
    // A folder, or a .xcodeproj / .xcworkspace bundle, with files under it: never a file.
    if (!files.some((file) => file.startsWith(`${named}/`))) {
      throw new CloudPhoneError(`${requested} isn't a folder that goes up from ${root}: it isn't there, it's a file, or git doesn't track it. Pass --path <folder>: the folder inside the project with the .xcodeproj or .xcworkspace.`, "bad_request");
    }
    return named;
  }
  // Each folder's build choices: its workspaces (a workspace carries its project), else its projects, else a project.yml.
  const folders = new Map<string, { workspaces: Set<string>; projects: Set<string>; spec: boolean }>();
  let packageAtTop = false;
  for (const file of files) {
    if (file === "Package.swift") packageAtTop = true;
    const parts = file.split("/");
    // The first bundle on the path: a project's own inner project.xcworkspace sits inside it and is never a choice.
    const marker = parts.findIndex((part, index) => /\.(xcodeproj|xcworkspace)$/i.test(part) || (part === "project.yml" && index === parts.length - 1));
    if (marker < 0) continue;
    const folder = parts.slice(0, marker);
    if (!(folder.length <= 1 || (folder.length === 2 && folder[0] === "apps"))) continue;
    const key = folder.join("/");
    const entry = folders.get(key) ?? { workspaces: new Set<string>(), projects: new Set<string>(), spec: false };
    folders.set(key, entry);
    const bundle = parts[marker]!;
    if (/\.xcworkspace$/i.test(bundle)) entry.workspaces.add(bundle);
    else if (/\.xcodeproj$/i.test(bundle)) entry.projects.add(bundle);
    else entry.spec = true;
  }
  const choices: string[] = [];
  const within = (folder: string, bundle: string): string => (folder ? `${folder}/${bundle}` : bundle);
  for (const [folder, entry] of folders) {
    const bundles = entry.workspaces.size ? entry.workspaces : entry.projects;
    if (bundles.size > 1) choices.push(...[...bundles].map((bundle) => within(folder, bundle)));
    else choices.push(folder);
  }
  // A Swift package at the top is a choice of its own when the top has no project.
  if (packageAtTop && !folders.has("")) choices.push("");
  if (choices.length === 1) return choices[0] || undefined;
  if (choices.length > 1) {
    const shown = choices.sort().map((choice) => choice || ".");
    throw new CloudPhoneError(`This project has ${shown.length} things to build (${shown.slice(0, 8).join(", ")}${shown.length > 8 ? ", …" : ""}). Pass --path to pick one, e.g. --path ${shown.find((choice) => choice !== ".") ?? shown[0]}.`, "bad_request");
  }
  throw new CloudPhoneError(`No Xcode project, workspace or XcodeGen project.yml in ${root}, its folders, or apps/*. Pass --path <folder>: the folder inside the project with the .xcodeproj or .xcworkspace.`, "no_project");
}

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

/** A `.tar.gz` of those files, made with the system's tar (Windows 10+, macOS and Linux all ship one that reads `--null -T -`). */
async function packProject(root: string, requested?: string): Promise<Packed & { count: number; sub: string | undefined; metal: boolean }> {
  const files = await projectFiles(root);
  if (!files.length) throw new CloudPhoneError("The project has no files to send.", "pack_failed");
  // Before packing: a project that can't build spends no upload and starts no phone.
  const sub = cloudPhoneBuildFolder(files, requested, root);
  const packed = await packWithTar("project", (out) => ["--null", "-czf", out, "-T", "-"], { cwd: root, input: Buffer.from(`${files.join("\0")}\0`, "utf8") });
  // The project's own shaders (a Swift package's show only when it builds: `metalProjects` keeps those).
  const inside = sub ? `${sub.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\/[^/]+\.(xcodeproj|xcworkspace)$/i, "")}/` : "";
  const metal = files.some((file) => file.startsWith(inside) && /\.metal$/i.test(file));
  return { ...packed, count: files.length, sub, metal };
}

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

/** A bundle id as Apple allows it: letters, digits, `-` and `.`. */
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

const readUInt = (bytes: Buffer, offset: number, size: number): number => {
  if (offset < 0 || offset + size > bytes.length) throw new RangeError("outside the plist");
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + bytes[offset + index]!;
  return value;
};

/**
 * One string value of a binary plist's top dictionary (`bplist00`), or null.
 * Only what an Info.plist key needs: the trailer, the offset table, a dict, and
 * ASCII or UTF-16 strings. Anything else, or a malformed file, is null.
 */
function binaryPlistString(bytes: Buffer, key: string): string | null {
  if (bytes.length < 40 || bytes.toString("latin1", 0, 8) !== "bplist00") return null;
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6]!;
  const refSize = bytes[trailer + 7]!;
  const count = readUInt(bytes, trailer + 8, 8);
  const top = readUInt(bytes, trailer + 16, 8);
  const tableAt = readUInt(bytes, trailer + 24, 8);
  const offsetOf = (ref: number): number => {
    if (ref >= count) throw new RangeError("no such object");
    return readUInt(bytes, tableAt + ref * offsetSize, offsetSize);
  };
  // A length in the marker's low half, or (0xF) in the int object after it.
  const lengthAt = (at: number): { length: number; start: number } => {
    const low = readUInt(bytes, at, 1) & 0x0f;
    if (low !== 0x0f) return { length: low, start: at + 1 };
    const size = 1 << (readUInt(bytes, at + 1, 1) & 0x0f);
    return { length: readUInt(bytes, at + 2, size), start: at + 2 + size };
  };
  const stringOf = (ref: number): string | null => {
    const at = offsetOf(ref);
    const type = readUInt(bytes, at, 1) >> 4;
    if (type !== 0x5 && type !== 0x6) return null;
    const { length, start } = lengthAt(at);
    const end = start + (type === 0x6 ? length * 2 : length);
    if (end > bytes.length) throw new RangeError("outside the plist");
    return type === 0x5
      ? bytes.toString("latin1", start, end)
      : Buffer.from(bytes.subarray(start, end)).swap16().toString("utf16le");
  };
  const dictAt = offsetOf(top);
  if (readUInt(bytes, dictAt, 1) >> 4 !== 0xd) return null;
  const { length, start } = lengthAt(dictAt);
  for (let index = 0; index < length; index += 1) {
    if (stringOf(readUInt(bytes, start + index * refSize, refSize)) !== key) continue;
    return stringOf(readUInt(bytes, start + (length + index) * refSize, refSize));
  }
  return null;
}

/**
 * The bundle id a `.app` names in its Info.plist (XML or binary), read here
 * before upload, or null when it can't be told.
 */
function bundleIdOfApp(bundle: string): string | null {
  try {
    const bytes = fs.readFileSync(path.join(bundle, "Info.plist"));
    const id = bytes.toString("latin1", 0, 6) === "bplist"
      ? binaryPlistString(bytes, "CFBundleIdentifier")
      : /<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>\s*([^<]*?)\s*<\/string>/.exec(bytes.toString("utf8"))?.[1] ?? null;
    return id && BUNDLE_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** A `.tar.gz` of one `.app` folder, whole: a bundle's own folders and files are part of it. */
function packApp(appPath: string): Promise<Packed> {
  const parent = path.dirname(appPath);
  return packWithTar("app", (out) => ["-czf", out, "-C", parent, path.basename(appPath)], { cwd: parent });
}

/** Create or truncate, never through a symlink (no `O_NOFOLLOW` on Windows, where `/tmp` isn't allowed). */
const WRITE_NO_FOLLOW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0);

/** The temp folders: the OS's, and on macOS and Linux `/tmp` too (`/private/tmp` on macOS, its real path). */
const tempRoots = (): string[] => (process.platform === "win32" ? [os.tmpdir()] : [...new Set([os.tmpdir(), "/tmp"])]);

/**
 * Where a screenshot is saved. Like the local simulator, which refuses an out
 * path outside its build root, only inside the calling project or a temp
 * folder; a relative path resolves under the project. Both sides are compared
 * as real paths, so `/tmp` and `/private/tmp` match, and a symlink inside an
 * allowed folder that points out of it is caught.
 */
function screenshotTarget(requested: string | undefined, projectRoot: string | null): string {
  const temp = os.tmpdir();
  if (!requested) return path.join(temp, `ade-cloud-iphone-${Date.now()}.png`);
  const target = path.resolve(projectRoot ?? temp, requested);
  const allowed = [projectRoot, ...tempRoots()].filter((root): root is string => Boolean(root)).some((root) => {
    if (!fs.existsSync(root)) return isPathInside(target, root);
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


/** The workspace folder a project unpacks into: the same one each time, so builds stay incremental. */
function cloudPhoneProjectName(root: string): string {
  const base = path.basename(root).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "project";
  return `${base}-${createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 12)}`;
}


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


  function hold(start: CloudPhoneStart, client: CloudProvider, chatSessionId: string | null): Held {
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
    else liveRun = { phoneId: held.phoneId, account: held.account, chatSessionId: start.reused ? null : chatSessionId, readyAt: start.phone.readyAt, lastActivityAt: null, heldAt: Date.now(), phone: held, startLine: start.reused ? null : cloudPhoneStartLine(start) };
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
  async function ensure({ device, chatSessionId = null, needs = [], builds = [], missing, account: began }: {
    device?: CloudPhoneDevice;
    chatSessionId?: string | null;
    needs?: readonly CloudPhoneAbility[];
    /** Build tools the project needs: the server is always asked, since it may move the phone to a provider that has them. */
    builds?: readonly CloudPhoneBuildNeed[];
    /** The build on this phone just failed for want of `need`: told to the server with the start. */
    missing?: { phoneId: string; need: CloudPhoneBuildNeed };
    account?: string | null;
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
        const phone = hold(start, client, chatSessionId);
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
    try {
      return await run(phone, driverOf(phone));
    } catch (error) {
      if (!(error instanceof CloudPhoneGoneError)) throw error;
      if (held === phone) held = null;
      // Only for the account the command began under: after a switch, never on the new account's phone.
      // The report went with the first start: never twice.
      const fresh = await ensure({ chatSessionId, needs, builds: build.builds ?? [], account: phone.account });
      return await run(fresh, driverOf(fresh));
    }
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

  /** A build's project folder on this machine, and the folder inside it to build (`path`). */
  const projectArgs = (args: { root?: unknown; path?: unknown } | null | undefined): { root: string; sub: string | undefined } => {
    const root = textArg(args?.root, "root", 2_000);
    if (!root || !fs.existsSync(root)) throw new CloudPhoneError("root is the project's folder on this machine.", "bad_request");
    const sub = textArg(args?.path, "path", 500);
    if (sub && (path.isAbsolute(sub) || sub.split(/[\\/]/).includes(".."))) throw new CloudPhoneError("path is a folder inside the project.", "bad_request");
    return { root, sub };
  };

  return {
    async getStatus(): Promise<CloudPhoneStatusView> {
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
      return { ...state, phone: withoutProvider(state.phone), abilities, lacks: state.access === "on" ? lacks : [], capabilities, supported: state.access === "on", reason, lastActivityAt };
    },

    /** Starts the account's phone (or answers the live one); `needs`: abilities it must have (`CLOUD_PHONE_ABILITIES`). */
    async start(args: { device?: unknown; needs?: unknown } | null | undefined): Promise<{ phone: CloudPhoneStatusView["phone"]; minutes: CloudPhoneMinutes; abilities: CloudPhoneAbility[] }> {
      const device = args?.device;
      if (device !== undefined && !isCloudPhoneDevice(device)) {
        throw new CloudPhoneError(`device is ${CLOUD_PHONE_DEVICES.join(", ")}.`, "bad_request");
      }
      const asked = Array.isArray(args?.needs) ? args.needs : typeof args?.needs === "string" ? args.needs.split(/[,\s]+/).filter(Boolean) : [];
      if (!asked.every(isCloudPhoneAbility)) throw new CloudPhoneError(`needs is a list of ${CLOUD_PHONE_ABILITIES.join(", ")}.`, "bad_request");
      const phone = await ensure({ device, chatSessionId: cloudPhoneCallerChat(args), needs: cloudPhoneAbilitiesOf(asked) });
      const state = await (await provider()).phoneState!();
      return { phone: withoutProvider(state.phone), minutes: state.minutes ?? phone.minutes, abilities: [...CLOUD_PHONE_PROVIDER_ABILITIES[phone.provider]] };
    },

    async stop(): Promise<{ stopped: boolean }> {
      held = null;
      const stopping = liveRun;
      const result = await (await provider()).phoneStop!();
      deps.logger?.info?.("cloud_phone.stopped", { stopped: result.stopped });
      // Whoever stopped it (an agent, the person's Stop), the chat told of its start is told.
      if (stopping && liveRun === stopping) {
        if (result.stopped) announceEnd(stopping, "stopped");
        else await settleEnd(stopping, false);
      }
      return result;
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
      const target = screenshotTarget(requested, proof?.projectRoot ?? null);
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
      screenshotTarget(requested, proof?.projectRoot ?? null);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(target, WRITE_NO_FOLLOW, 0o600);
      try {
        fs.writeFileSync(fd, bytes);
      } finally {
        fs.closeSync(fd);
      }
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
      const chatSessionId = cloudPhoneCallerChat(args);
      const scheme = textArg(args?.scheme, "scheme", 200);
      const env = textArg(args?.env, "env", 8_000);
      const packed = await packProject(root, sub);
      try {
        const name = cloudPhoneProjectName(root);
        const input: CloudPhoneRunInput = {
          project: packed,
          name,
          ...(packed.sub ? { sub: packed.sub } : {}),
          ...(scheme ? { scheme } : {}),
          ...(configuration ? { configuration } : {}),
          ...(env ? { env } : {}),
          ...(args?.clean === true ? { clean: true } : {}),
        };
        // env values need a phone that passes them to the app.
        const need = env ? "launchEnv" as const : undefined;
        // A project known to compile Metal names it, so the server starts (or swaps to) a phone whose Xcode has the toolchain.
        // The build, not the checkout: another app in the same checkout may have no shaders.
        const buildKey = `${name}\0${packed.sub ?? ""}\0${scheme ?? ""}`;
        const builds: CloudPhoneBuildNeed[] = packed.metal || metalProjects.has(buildKey) ? ["metal"] : [];
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
        return await withPhone(chatSessionId, async (phone, driver) => {
          const installed = await driver.install(phone, { app: packed });
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

    /** Apps and the phone: launch, terminate, open_url, location, push, appearance, … (`app_control`). */
    async control(args: { action?: unknown; value?: unknown; app?: unknown } | null | undefined): Promise<CloudPhoneToolAnswer> {
      const action = textArg(args?.action, "action", 40);
      if (!action) throw new CloudPhoneError("action is required (launch, terminate, open_url, location, push, appearance, …).", "bad_request");
      const value = textArg(args?.value, "value");
      const app = textArg(args?.app, "app", 300);
      const need = cloudPhoneControlAbility(action, value);
      return withPhone(cloudPhoneCallerChat(args), (phone, driver) => driver.control(phone, { action, ...(value !== undefined ? { value } : {}), ...(app ? { app } : {}) }), need);
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
