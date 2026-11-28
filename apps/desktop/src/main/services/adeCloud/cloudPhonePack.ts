/**
 * What goes up to a cloud iPhone, packed on this machine: a checkout's files
 * (what git tracks or would track, minus build output, dependencies and key
 * files) or one Simulator `.app`, as a `.tar.gz` made with the system's tar;
 * the folder inside it to build; and where a capture or a log may be saved
 * here. `cloudPhoneService.ts` uses these for every provider.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPathInside } from "../shared/pathCompare";
import { isPathEscapeError, resolvePathWithinRoot } from "../shared/utils";
import { CloudPhoneError, type CloudPhonePacked as Packed } from "./cloudPhoneDriver";

const UPLOAD_LIMIT_BYTES = 2 * 1024 ** 3;
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
async function projectFiles(root: string, prefix = "", stats = new Map<string, { size: number; mtimeMs: number }>()): Promise<{ files: string[]; stats: Map<string, { size: number; mtimeMs: number }> }> {
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
    if (!stat.isDirectory()) {
      files.push(relative);
      stats.set(relative, { size: stat.size, mtimeMs: stat.mtimeMs });
    }
    // A submodule that is checked out; one that isn't has no files to send.
    else if (fs.existsSync(path.join(root, relative, ".git"))) files.push(...(await projectFiles(root, relative, stats)).files);
  }
  return { files, stats };
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

/** The cache name of one project build (its workspace folder and the folder inside it), as the provider's build keeps it. */
export const cacheKeyOf = (name: string, sub: string | undefined): string =>
  createHash("sha256").update(`${name}\0${sub ?? ""}`).digest("hex").slice(0, 24);

/**
 * What a build's source is, without its archive: every file that goes up, by
 * path, size and change time, as listed before it was packed (a file saved
 * while tar runs reads as changed next time, never as the same source). Two
 * packs with one fingerprint build the same app (a tarball's own bytes differ
 * each time: its gzip header has a clock), so a build that worked is used
 * again rather than paid for twice.
 */
function sourceFingerprint(files: readonly string[], stats: ReadonlyMap<string, { size: number; mtimeMs: number }>): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort()) {
    const stat = stats.get(file);
    hash.update(`${file}\0${stat?.size ?? -1}\0${stat?.mtimeMs ?? -1}\n`);
  }
  return hash.digest("hex");
}

/** A `.tar.gz` of those files, made with the system's tar (Windows 10+, macOS and Linux all ship one that reads `--null -T -`). */
export async function packProject(root: string, requested?: string): Promise<Packed & { count: number; sub: string | undefined; metal: boolean; lockfiles: string[]; fingerprint: string }> {
  const { files, stats } = await projectFiles(root);
  if (!files.length) throw new CloudPhoneError("The project has no files to send.", "pack_failed");
  // Before packing: a project that can't build spends no upload and starts no phone.
  const sub = cloudPhoneBuildFolder(files, requested, root);
  const fingerprint = sourceFingerprint(files, stats);
  const packed = await packWithTar("project", (out) => ["--null", "-czf", out, "-T", "-"], { cwd: root, input: Buffer.from(`${files.join("\0")}\0`, "utf8") });
  // The project's own shaders (a Swift package's show only when it builds: `metalProjects` keeps those).
  const inside = sub ? `${sub.replace(/\\/g, "/").replace(/\/+$/, "").replace(/\/[^/]+\.(xcodeproj|xcworkspace)$/i, "")}/` : "";
  const metal = files.some((file) => file.startsWith(inside) && /\.metal$/i.test(file));
  // Its dependency lockfiles: the build's dependency caches are saved again only when one changes.
  const lockfiles = files.filter((file) => file.startsWith(inside) && (/(^|\/)Package\.resolved$/.test(file) || file === `${inside}Podfile.lock`)).slice(0, 20);
  return { ...packed, count: files.length, sub, metal, lockfiles, fingerprint };
}

/** Sent for a `.ipa` or a device build: the cloud iPhone runs Simulator builds. */
export const DEVICE_BUILD = "That is a device build (.ipa). The cloud iPhone needs a Simulator build: for Expo/EAS set \"simulator\": true; for Flutter run flutter build ios --simulator.";

/** What a bundle's Info.plist says it is for: "iPhoneSimulator", "iPhoneOS", or null when it can't be told. */
export function supportedPlatformOf(bundle: string): string | null {
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
export function bundleIdOfApp(bundle: string): string | null {
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
export function packApp(appPath: string): Promise<Packed> {
  const parent = path.dirname(appPath);
  return packWithTar("app", (out) => ["-czf", out, "-C", parent, path.basename(appPath)], { cwd: parent });
}

/** Create or truncate, never through a symlink (no `O_NOFOLLOW` on Windows, where `/tmp` isn't allowed). */
const WRITE_NO_FOLLOW = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0);

/** The temp folders: the OS's, and on macOS and Linux `/tmp` too (`/private/tmp` on macOS, its real path). */
const tempRoots = (): string[] => (process.platform === "win32" ? [os.tmpdir()] : [...new Set([os.tmpdir(), "/tmp"])]);

/**
 * Where a capture or a build log is saved (`fallback`, a file name in the
 * temp folder, when none is asked for). Like the local simulator, which
 * refuses an out path outside its build root, only inside the calling project
 * or a temp folder; a relative path resolves under the project. Both sides are
 * compared as real paths, so `/tmp` and `/private/tmp` match, and a symlink
 * inside an allowed folder that points out of it is caught.
 */
export function outputTarget(requested: string | undefined, projectRoot: string | null, fallback: string): string {
  const temp = os.tmpdir();
  if (!requested) return path.join(temp, fallback);
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
export function cloudPhoneProjectName(root: string): string {
  const base = path.basename(root).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "project";
  return `${base}-${createHash("sha256").update(path.resolve(root).toLowerCase()).digest("hex").slice(0, 12)}`;
}

/**
 * Writes a capture or a log to `outputTarget`'s answer, checked again first
 * (a link planted while the phone worked is refused), creating its folder and
 * never following a symlink.
 */
export function writeOutput(target: string, requested: string | undefined, projectRoot: string | null, data: Buffer | string): void {
  if (requested) outputTarget(requested, projectRoot, path.basename(target));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, WRITE_NO_FOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}
