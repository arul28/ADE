/**
 * Builds on Revyl's runners for an ADE account (`phoneRevyl.ts` has the
 * phone). A build belongs to the account, not to a phone: it runs with or
 * without one up, one at a time per account (`cloud_phone_builds`), on the
 * Xcode image ADE picks, with the project's dependency caches.
 */

import { fail, json } from "./http";
import { SLOW_REQUEST_TIMEOUT_MS, knownWorkspace, sha256Hex, workspaceApp, workspaceJson, workspaceOf, type WorkspaceRow } from "./phoneRevylWorkspace";
import { logCloud, type CloudEnv } from "./store";

/**
 * A build runs at most this long on Revyl's runners (they bill by the
 * second): it is also the most one build counts in the paid plan's Revyl
 * limit (`revylSpentMicros`), however long its claim stays open.
 */
export const REVYL_BUILD_MAX_SECONDS = 900;
/** A build's claim whose start never got Revyl's answer (the Worker stopped mid-start) lapses after this; the start's own calls take at most about 5 minutes. */
const BUILD_START_LAPSE_MS = 6 * 60_000;
/** A start whose answer was lost may have a build running: its claim holds this long (the build's limit plus a wait for a runner), then lapses. */
const BUILD_UNKNOWN_HOLD_MS = 30 * 60_000;
/** A build Revyl took holds its claim until Revyl says it ended, or this long at most (a job Revyl lost, or one nobody asks after). */
const BUILD_JOB_HOLD_MS = 2 * 60 * 60_000;

/**
 * The Xcode image a build runs on unless it names another: Revyl's newest
 * stable one (docs.revyl.com/remote-builds/toolchains; Revyl's own default is
 * older). The Worker var `CLOUD_PHONE_REVYL_IMAGE` moves it without a release.
 */
const REVYL_BUILD_IMAGE = "ios-macos-26-xcode-27.2";
/** The Xcode versions a build may name (`xcode`), as Revyl's images. */
const REVYL_XCODE_IMAGES: Readonly<Record<string, string>> = {
  "26.2": "ios-macos-26-xcode-26.2",
  "26.5": "ios-macos-26-xcode-26.5",
  "26.6": "ios-macos-26-xcode-26.6",
  "27.0": "ios-macos-26-xcode-27.0",
  "27.1": "ios-macos-26-xcode-27.1",
  "27.2": "ios-macos-26-xcode-27.2",
};
const IMAGE_NAME = /^ios-[a-z0-9.-]{1,60}$/;

/** The image a build runs on unless it names one: the Worker's (`CLOUD_PHONE_REVYL_IMAGE`), else `REVYL_BUILD_IMAGE`. */
export function revylDefaultImage(env: Pick<CloudEnv, "CLOUD_PHONE_REVYL_IMAGE">): string {
  const set = env.CLOUD_PHONE_REVYL_IMAGE?.trim();
  return set && IMAGE_NAME.test(set) ? set : REVYL_BUILD_IMAGE;
}

/** The image a build runs on: the Xcode version it names (`REVYL_XCODE_IMAGES`), else the default. */
function revylBuildImage(env: Pick<CloudEnv, "CLOUD_PHONE_REVYL_IMAGE">, xcode: string | null): string | Response {
  if (!xcode) return revylDefaultImage(env);
  const named = Object.hasOwn(REVYL_XCODE_IMAGES, xcode) ? REVYL_XCODE_IMAGES[xcode] : undefined;
  return named ?? fail("bad_request", `xcode is one of ${Object.keys(REVYL_XCODE_IMAGES).join(", ")}.`, 400);
}

/** The Xcode and iOS SDK an image builds with (its name says; each image's SDK matches its Xcode). */
export function revylToolchainOf(image: string): { xcode: string; sdk: string } {
  const version = /xcode-(\d+(?:\.\d+)*)$/.exec(image)?.[1] ?? "?";
  return { xcode: version, sdk: `iOS ${version}` };
}

/**
 * A build's own steps in the account's workspace, with or without a phone up
 * (`routeRevylBuild`). `build.install` is the phone's (`routeRevylCall`).
 */
const WORKSPACE_BUILD_ACTIONS = new Set(["build.upload_url", "build.start", "build.status", "build.logs"]);
/** A build action that runs in the account's workspace, whether or not a phone is up. */
export const isRevylBuildAction = (action: unknown): boolean => typeof action === "string" && WORKSPACE_BUILD_ACTIONS.has(action);
/** Revyl's words for a build that finished, whichever way (`build.status`'s `status`). */
const BUILD_ENDED = new Set(["success", "succeeded", "completed", "failed", "error", "cancelled", "canceled", "timeout"]);

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEME = /^[A-Za-z0-9 _.+()-]{1,200}$/;
/**
 * A folder inside the uploaded project: no `..`, no absolute path, no control
 * character or backslash. Any other name is fine (`buildCommand` single-quotes
 * it), so whatever folder the brain finds or a person names, the build takes.
 */
const SUB_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\u0000-\u001f\u007f\\]{1,500}$/;
/** A build's cache name from the brain: its project, never a path. */
const CACHE_KEY = /^[a-z0-9-]{1,64}$/;

/** Single-quoted for sh. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** How long the runner may spend fetching Apple's Metal Toolchain (about 870 MB for Xcode 27.2) inside the build's own limit. */
const METAL_DOWNLOAD_SECONDS = 420;

/** What one build is: chosen by the brain's arguments only, never a command it sends. */
type RevylBuildInput = {
  /** The folder inside the upload to build (`.` for the top), or the project or workspace it names. */
  sub: string;
  scheme: string | null;
  configuration: "Debug" | "Release";
  clean: boolean;
  /** The source is one Simulator `.app` built elsewhere: the runner only hands it back as the build's app. */
  prebuilt: boolean;
  /** Revyl's Xcode image (`revylBuildImage`). */
  image: string;
  /** The project's cache name (`CACHE_KEY`), so two projects of one account never trade dependency folders. */
  cacheKey: string;
  /** The lockfiles in the build folder (Package.resolved, Podfile.lock): a cache is saved again only when one changed. */
  lockfiles: string[];
};

/** The folder a build runs xcodebuild in: `sub`, or the folder of the project or workspace it names. */
function buildFolderOf(sub: string): { folder: string; named: string | null } {
  const named = /\.(xcodeproj|xcworkspace)\/?$/i.test(sub) ? sub.replace(/\/+$/, "") : null;
  return { folder: named ? (named.includes("/") ? named.slice(0, named.lastIndexOf("/")) : ".") : sub, named };
}

/**
 * The build step ADE runs on Revyl's runner, from the brain's choices only
 * (never a command it sends): find the workspace or project in `path` (or
 * take the one `path` names), the scheme (the first, unless named), then
 * build for the Simulator into `build/` at the project's top, where the
 * artifact is collected. Its output is passed on a line at a time, so the
 * log's timestamps say when each line came. Xcode 26 and later ship the
 * Metal compiler as a separate download: a build that failed for want of it
 * (a `.metal` file in the app or a Swift package) fetches it, time-bound, and
 * builds once more, so a project without Metal never pays for the download.
 */
function buildCommand(input: Pick<RevylBuildInput, "sub" | "scheme" | "configuration" | "clean">): string {
  // A `path` that names the project or workspace itself builds that one, from its folder.
  const { folder, named } = buildFolderOf(input.sub);
  // Pods come from the cache when its Podfile.lock matched (`buildCaches`); otherwise (none, or a changed lockfile) they are installed.
  const pods = "if [ -f Podfile ] && command -v pod >/dev/null 2>&1 && { [ ! -d Pods ] || ! cmp -s Podfile.lock Pods/Manifest.lock; }; then pod install; fi";
  const find = named
    ? [pods, named.toLowerCase().endsWith(".xcworkspace") ? `WS=${shellQuote(`./${named.slice(named.lastIndexOf("/") + 1)}`)}; PJ=` : `WS=; PJ=${shellQuote(`./${named.slice(named.lastIndexOf("/") + 1)}`)}`]
    : [
      "WS=$(find . -maxdepth 1 -name '*.xcworkspace' ! -name 'project.xcworkspace' | head -n 1)",
      "PJ=$(find . -maxdepth 1 -name '*.xcodeproj' | head -n 1)",
      "if [ -z \"$WS$PJ\" ] && [ -f project.yml ] && command -v xcodegen >/dev/null 2>&1; then xcodegen generate; PJ=$(find . -maxdepth 1 -name '*.xcodeproj' | head -n 1); fi",
      `${pods.replace("{ [ ! -d Pods ] ||", "{ [ ! -d Pods ] || [ -z \"$WS\" ] ||").replace(/; fi$/, "")}; WS=$(find . -maxdepth 1 -name '*.xcworkspace' ! -name 'project.xcworkspace' | head -n 1); fi`,
    ];
  return [
    "set -eu",
    "ROOT=$(pwd)",
    `cd ${shellQuote(folder)}`,
    ...find,
    "if [ -n \"$WS\" ]; then set -- -workspace \"$WS\"; elif [ -n \"$PJ\" ]; then set -- -project \"$PJ\"; else echo 'No Xcode workspace or project found to build. Pass --path <folder>: the folder inside the project with the .xcodeproj or .xcworkspace.' >&2; exit 65; fi",
    `SCHEME=${shellQuote(input.scheme ?? "")}`,
    "if [ -z \"$SCHEME\" ]; then SCHEME=$(xcodebuild \"$@\" -list 2>/dev/null | awk '/Schemes:/{f=1;next} f&&NF{sub(/^ +/,\"\");print;exit}'); fi",
    "if [ -z \"$SCHEME\" ]; then echo 'No scheme found to build.' >&2; exit 65; fi",
    "echo \"ADE: building $SCHEME (" + input.configuration + ")\"",
    "mkdir -p \"$ROOT/build\"",
    "LOG=\"$ROOT/build/ade-xcodebuild.log\"",
    "CODE_FILE=\"$ROOT/build/ade-xcodebuild.code\"",
    `ACTION=${shellQuote(input.clean ? "clean build" : "build")}`,
    // The log is kept to tell why it failed; the exit code goes through a file because a pipe answers tee's.
    `ade_xcodebuild() { if xcodebuild "$@" -scheme "$SCHEME" -configuration ${input.configuration} -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath "$ROOT/build" ARCHS=arm64 CODE_SIGNING_ALLOWED=NO $ACTION; then echo 0 > "$CODE_FILE"; else echo $? > "$CODE_FILE"; fi; }`,
    // The first build's toolchain line stays out of the build's output: a fetch follows it, and a failure there says so
    // itself, so a later error is never blamed on a toolchain that was fetched. Each line goes on as it comes (`fflush`).
    "{ ade_xcodebuild \"$@\"; } 2>&1 | tee \"$LOG\" | awk '!/missing Metal Toolchain/ { print; fflush() }'",
    "CODE=$(cat \"$CODE_FILE\")",
    "if [ \"$CODE\" = 0 ]; then exit 0; fi",
    "if ! grep -q 'missing Metal Toolchain' \"$LOG\"; then exit \"$CODE\"; fi",
    `echo "ADE: this project compiles Metal shaders and the runner's Xcode has no Metal Toolchain; fetching it (up to ${METAL_DOWNLOAD_SECONDS} s), then building again."`,
    // Bounded by the shell alone: the fetch is stopped at the limit, and its failure is the one error below.
    "xcodebuild -downloadComponent MetalToolchain & FETCH=$!",
    `WAITED=0; while kill -0 "$FETCH" 2>/dev/null; do if [ "$WAITED" -ge ${METAL_DOWNLOAD_SECONDS} ]; then kill "$FETCH" 2>/dev/null || true; break; fi; sleep 2; WAITED=$((WAITED + 2)); done`,
    "if ! wait \"$FETCH\"; then echo \"error: The build runner couldn't fetch Apple's Metal Toolchain, which this project needs for its .metal shaders (missing Metal Toolchain).\" >&2; exit \"$CODE\"; fi",
    "echo 'ADE: fetched the Metal Toolchain; building again.'",
    "ACTION=build",
    "{ ade_xcodebuild \"$@\"; } 2>&1 | tee \"$LOG\" | awk '{ print; fflush() }'",
    "exit \"$(cat \"$CODE_FILE\")\"",
  ].join("\n");
}

/**
 * The folders a build keeps between builds (Revyl's path caches, saved only
 * after a build that succeeded, restored before the next one, one archive per
 * key in the account's own workspace). Swift packages: their clones and
 * checkouts in `build/SourcePackages`, so a build doesn't fetch every package
 * again; CocoaPods: the build folder's `Pods`. Each is saved again only when
 * one of its lockfiles changed (`hash`), so an unchanged build uploads none.
 */
function buildCaches(input: Pick<RevylBuildInput, "sub" | "cacheKey" | "lockfiles">): Array<{ key: string; paths: string[]; hash?: string[] }> {
  const { folder } = buildFolderOf(input.sub);
  const inFolder = (file: string): boolean => folder === "." || file.startsWith(`${folder}/`);
  const resolved = input.lockfiles.filter((file) => /(^|\/)Package\.resolved$/.test(file) && inFolder(file));
  const podfileLock = folder === "." ? "Podfile.lock" : `${folder}/Podfile.lock`;
  const caches: Array<{ key: string; paths: string[]; hash?: string[] }> = [
    { key: `spm-${input.cacheKey}`, paths: ["build/SourcePackages"], ...(resolved.length ? { hash: resolved } : {}) },
  ];
  if (input.lockfiles.includes(podfileLock)) caches.push({ key: `pods-${input.cacheKey}`, paths: [folder === "." ? "Pods" : `${folder}/Pods`], hash: [podfileLock] });
  return caches;
}

/** The recipe Revyl builds (`POST /apps/remote`): ADE's own step on the image it picked, with its path caches. */
function revylRecipe(app: string, input: RevylBuildInput): Record<string, unknown> {
  return {
    app_id: app,
    artifacts: [{ name: "app", path: input.prebuilt ? "*.app" : `build/Build/Products/${input.configuration}-iphonesimulator/*.app`, type: "app" }],
    build_steps: [input.prebuilt
      ? { name: "Hand back the app", command: "set -eu\nls -d ./*.app", type: "run" }
      : { name: "Build the app", command: buildCommand(input), type: "run" }],
    framework: "ios",
    platform: "ios",
    profile: "ade",
    image: input.image,
    ...(input.prebuilt ? {} : { caches: buildCaches(input) }),
  };
}

export const stringArg = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** A call's action, its body for Revyl and its query (short lowercase keys and values only). */
export function callParts(body: Record<string, unknown>): { action: string; args: Record<string, unknown>; query: Record<string, string> } {
  const action = typeof body.action === "string" ? body.action : "";
  const args = body.body && typeof body.body === "object" && !Array.isArray(body.body) ? body.body as Record<string, unknown> : {};
  const query = body.query && typeof body.query === "object" && !Array.isArray(body.query)
    ? Object.fromEntries(Object.entries(body.query as Record<string, unknown>).filter((entry): entry is [string, string] => /^[a-z_]{1,40}$/.test(entry[0]) && typeof entry[1] === "string" && entry[1].length <= 200))
    : {};
  return { action, args, query };
}

/* ---- Builds: the account's, with or without a phone (`cloud_phone_builds`) ---- */

/** What a finished build ran, in seconds: Revyl's own `duration_ms`, else since its claim; never past a build's longest. */
function buildSecondsOf(status: Record<string, unknown> | null, startedAt: number, now: number): number {
  const ms = Number(status?.duration_ms);
  return Math.min(REVYL_BUILD_MAX_SECONDS, Math.max(0, Math.ceil((Number.isFinite(ms) && ms > 0 ? ms : now - startedAt) / 1000)));
}

/** Revyl's answer for a build that ended, whichever way; a job Revyl no longer has (404) ended too. */
const buildEnded = (answer: { status: number; body: Record<string, unknown> | null }): boolean =>
  answer.status === 404 || (answer.status === 200 && BUILD_ENDED.has(String(answer.body?.status ?? "").toLowerCase()));

/** A build Revyl answers ended: its claim ends with what it ran (only that job's, never a newer build's). */
async function endBuild(env: Pick<CloudEnv, "DB">, userId: string, job: string, answer: { status: number; body: Record<string, unknown> | null }, now: number): Promise<void> {
  const row = await env.DB.prepare("select id, started_at from cloud_phone_builds where user_id = ? and job = ? and ended_at is null").bind(userId, job).first<{ id: string; started_at: number }>();
  if (!row) return;
  const status = answer.status === 404 ? "gone" : String(answer.body?.status ?? "ended").toLowerCase().slice(0, 40);
  await env.DB.prepare("update cloud_phone_builds set ended_at = ?, status = ?, seconds = ? where id = ? and ended_at is null")
    .bind(now, status, buildSecondsOf(answer.status === 404 ? null : answer.body, row.started_at, now), row.id).run();
}

/**
 * The account's one build at a time (Revyl's runners bill ADE): claimed in
 * one write, so two starts can't both run. A claim whose start never got
 * Revyl's answer lapses (it ran nothing); one whose answer was lost lapses
 * later, counted as running till then (at most a build's longest); a build
 * Revyl took holds it until Revyl says it ended (asked once here when it's in
 * the way; a job Revyl no longer has ended too), or two hours at most. So no
 * claim holds an account's builds, or grows its Revyl spend, for good.
 * Answers the claim's id, or null while another build runs.
 */
async function claimBuild(env: CloudEnv, workspace: WorkspaceRow, phoneId: string | null, now: number): Promise<string | null> {
  const userId = workspace.user_id;
  await env.DB.prepare(`update cloud_phone_builds set ended_at = ?, status = 'lapsed',
      seconds = case when job is null then 0 else min(?, max(0, ? - started_at) / 1000) end
    where user_id = ? and ended_at is null
      and ((job is null and started_at <= ?) or (job = 'unknown' and started_at <= ?) or (job is not null and started_at <= ?))`)
    .bind(now, REVYL_BUILD_MAX_SECONDS, now, userId, now - BUILD_START_LAPSE_MS, now - BUILD_UNKNOWN_HOLD_MS, now - BUILD_JOB_HOLD_MS).run();
  const claim = async (): Promise<string | null> => {
    const id = crypto.randomUUID();
    const made = await env.DB.prepare(`insert into cloud_phone_builds (id, user_id, provider, job, started_at, phone_id)
      select ?, ?, 'revyl', null, ?, ? where not exists (select 1 from cloud_phone_builds where user_id = ? and ended_at is null)`)
      .bind(id, userId, now, phoneId, userId).run();
    return (made.meta?.changes ?? 0) === 1 ? id : null;
  };
  const claimed = await claim();
  if (claimed) return claimed;
  // The held build may have ended with nobody following it (ADE closed, a status read failed): asked once,
  // an ended one frees the claim. An unknown outcome stays held.
  const held = await env.DB.prepare("select job from cloud_phone_builds where user_id = ? and ended_at is null limit 1").bind(userId).first<{ job: string | null }>();
  if (!held?.job || !UUID.test(held.job)) return null;
  const status = await workspaceJson(env, workspace, "GET", `/apps/remote/${encodeURIComponent(held.job)}/status`);
  if (!buildEnded(status)) return null;
  await endBuild(env, userId, held.job, status, now);
  return await claim();
}

/**
 * `POST /cloud/phone/call` for a build action (`isRevylBuildAction`): a build
 * in the account's Revyl workspace, whether or not a phone is up. `phoneId`
 * is the account's live Revyl phone, or null. `mayBuild` answers why a build
 * that would spend may not run (`build.upload_url`, `build.start`), or null:
 * `phones.ts` holds it to what a phone start is held to, and to a route whose
 * first stop is Revyl. Reads (`build.status`, `build.logs`) need only the
 * workspace.
 */
export async function routeRevylBuild(
  env: CloudEnv,
  userId: string,
  body: Record<string, unknown>,
  now: number,
  { phoneId, mayBuild }: { phoneId: string | null; mayBuild: () => Promise<Response | null> },
): Promise<Response> {
  const { action, args, query } = callParts(body);
  const job = stringArg(args.job);
  if (action === "build.status" || action === "build.logs") {
    if (!job || !UUID.test(job)) return fail("bad_request", "job is the build's id.", 400);
    const workspace = await knownWorkspace(env, userId);
    if (!workspace) return fail("build_not_found", "That build isn't one of this account's.", 404);
    const answer = await workspaceJson(env, workspace, "GET", `/apps/remote/${encodeURIComponent(job)}/${action === "build.status" ? "status" : "logs"}`, { query });
    // A finished build (whichever way) frees the account for the next one: only its own claim.
    if (action === "build.status" && buildEnded(answer)) await endBuild(env, userId, job, answer, now);
    return json(answer.body ?? {}, answer.status);
  }
  if (action !== "build.upload_url" && action !== "build.start") return fail("bad_request", `${action || "That"} isn't a cloud iPhone action.`, 400);
  const refused = await mayBuild();
  if (refused) return refused;
  // The route goes to Revyl: the account's workspace is made on its first build, as on its first phone.
  const workspace = await workspaceOf(env, userId, now);
  if (workspace instanceof Response) return workspace;
  const app = await workspaceApp(env, workspace, now);
  if (app instanceof Response) return app;

  if (action === "build.upload_url") {
    const size = Number(args.file_size);
    if (!Number.isInteger(size) || size <= 0 || size > 2 * 1024 ** 3) return fail("bad_request", "file_size is the archive's size in bytes, up to 2 GB.", 400);
    const answer = await workspaceJson(env, workspace, "POST", "/apps/remote/upload-url", { body: { app_id: app, file_size: size, filename: "source.tar.gz" } });
    return json(answer.body ?? {}, answer.status);
  }
  const key = stringArg(args.source_key);
  // Only a source this workspace's app uploaded to.
  if (!key || !key.includes(`/build-sources/${app}/`) || key.length > 500) return fail("bad_request", "source_key is the key build.upload_url answered.", 400);
  const sub = stringArg(args.path) ?? ".";
  if (sub !== "." && !SUB_PATH.test(sub)) return fail("bad_request", "path is a folder inside the project.", 400);
  const scheme = stringArg(args.scheme);
  if (scheme && !SCHEME.test(scheme)) return fail("bad_request", "That scheme name can't be built.", 400);
  const image = revylBuildImage(env, stringArg(args.xcode));
  if (image instanceof Response) return image;
  // The brain names its project's cache; an older one names none, and the folder it builds stands in.
  const named = stringArg(args.cache_key);
  if (named && !CACHE_KEY.test(named)) return fail("bad_request", "cache_key names the project's cache.", 400);
  const cacheKey = named ?? (await sha256Hex(`ade-cache:${sub}`)).slice(0, 16);
  const lockfiles = Array.isArray(args.lockfiles)
    ? args.lockfiles.filter((file): file is string => typeof file === "string" && SUB_PATH.test(file) && /(^|\/)(Package\.resolved|Podfile\.lock)$/.test(file)).slice(0, 20)
    : [];
  const recipe = revylRecipe(app, {
    sub,
    scheme,
    configuration: args.configuration === "Release" ? "Release" : "Debug",
    clean: args.clean === true,
    prebuilt: args.prebuilt === true,
    image,
    cacheKey,
    lockfiles,
  });
  const claim = await claimBuild(env, workspace, phoneId, now);
  if (!claim) return fail("build_running", "A build is already running for your ADE Cloud iPhone. Wait for it to finish, then try again.", 409);
  const answer = await workspaceJson(env, workspace, "POST", "/apps/remote", {
    body: { build_definition_hash: await sha256Hex(JSON.stringify(recipe)), git_branch_name: "ade", recipe, source: { key, type: "archive" }, timeout_seconds: REVYL_BUILD_MAX_SECONDS },
    timeoutMs: SLOW_REQUEST_TIMEOUT_MS,
  });
  const buildJob = typeof answer.body?.build_job_id === "string" ? answer.body.build_job_id : null;
  // A start Revyl refused runs nothing: the claim goes. A 5xx or a timeout may hide a build Revyl took:
  // the claim holds (`unknown`) a while, so a retry can't bill a second one. A claim that lapsed meanwhile
  // (a very slow start) stays lapsed: its job is never written onto it beside another build's.
  if (answer.status < 300) {
    await env.DB.prepare("update cloud_phone_builds set job = ? where id = ? and ended_at is null").bind(buildJob ?? "unknown", claim).run();
  } else if (answer.status < 500) {
    await env.DB.prepare("delete from cloud_phone_builds where id = ?").bind(claim).run();
  } else {
    await env.DB.prepare("update cloud_phone_builds set job = 'unknown' where id = ? and ended_at is null").bind(claim).run();
  }
  logCloud("cloud.phone_revyl_build", { userId, status: answer.status, withPhone: phoneId != null, image });
  return json(answer.body ?? {}, answer.status);
}
