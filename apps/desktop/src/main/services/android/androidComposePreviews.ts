import { AdeExpectedError } from "../../../shared/expectedError";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  ANDROID_COMPOSE_PREVIEW_RENDER_MAX,
  type AndroidComposePreview,
  type AndroidComposePreviewImage,
  type AndroidEmulatorPreviewServiceApi,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { isPathInside } from "../shared/pathCompare";
import { terminateProcessTree } from "../shared/processExecution";
import { getErrorMessage, isPathEscapeError, isRecord, resolvePathWithinRoot } from "../shared/utils";
import { androidCliArgs, locateAndroidCli } from "./androidCli";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import { androidJdkMissingMessage, locateAndroidJdk } from "./androidJdk";
import { createAndroidLaneQueue } from "./androidLaneQueue";
import { fileAndroidCaptureAsProof, type AndroidArtifactFiler } from "./androidProof";
import type { AndroidEnv } from "./androidSdk";
import { androidLaneFolderName } from "./androidScreenshot";

/*
 * Compose previews (P3): Google's Android CLI builds a Gradle module and
 * renders its `@Preview` functions to PNG with layoutlib, with no emulator
 * (`android preview list|render`). The lane's own worktree is the project; the
 * images go under ADE's data folder and are filed as proof.
 *
 * Measured on macOS with a small module: `list` 18 s cold, `render` of two
 * previews 18 s (the first render also downloads the CLI's preview pack).
 * One preview command runs per lane at a time: they share the Gradle build.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/**
 * A first run builds the module and downloads the preview pack. A render of
 * every preview runs `list` first, so two runs fit in the action's 22 minutes
 * (ANDROID_EMULATOR_BUILD_TIMEOUT_MS).
 */
const PREVIEW_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MODULE = "app";
/** `inline`: a PNG larger than this comes back with a path only. A preview is ~30 KB. */
const INLINE_MAX_BYTES = 1024 * 1024;

export type AndroidComposePreviewDeps = {
  laneRoot: (laneId: string) => string | null;
  sdkRoot: () => Promise<string | null>;
  env: AndroidEnv;
  platform: NodeJS.Platform;
  dataDir: string;
  artifactFiler: AndroidArtifactFiler | null;
  callerRoot: string | null;
  signal: AbortSignal;
  logger?: Logger | null;
  now: () => Date;
  /** One coarse fact for each render that wrote at least one image. */
  captureAnalytics?: (outcome: "previews_rendered") => void;
};

/**
 * The JSON the CLI prints for `--format json`: the last top-level object on
 * stdout. Each line that starts with `{` is tried from the last one back, to
 * the end of its object (the closing `}` at the start of a line).
 */
export function parsePreviewJson(stdout: string): Record<string, unknown> | null {
  const starts = [...stdout.matchAll(/^\{/gmu)].map((match) => match.index ?? 0).reverse();
  for (const start of starts) {
    const rest = stdout.slice(start);
    const end = rest.search(/^\}/mu);
    try {
      const parsed: unknown = JSON.parse(end < 0 ? rest : rest.slice(0, end + 1));
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not the JSON answer (a log line that starts with a brace); try the one before.
    }
  }
  return null;
}

/** `preview list` entries as ADE's type; entries with no name are dropped. */
export function readPreviewList(json: Record<string, unknown>): AndroidComposePreview[] {
  const list = Array.isArray(json.previews) ? json.previews : [];
  return list.filter(isRecord).flatMap((record) => {
    const fqn = typeof record.methodFqn === "string" ? record.methodFqn : null;
    if (!fqn) return [];
    const raw = isRecord(record.previewParams) ? record.previewParams : {};
    const params = Object.fromEntries(Object.entries(raw).filter(([key, value]) => key !== "name" && typeof value === "string")) as Record<string, string>;
    return [{ fqn, name: typeof record.name === "string" && record.name ? record.name : null, params }];
  });
}

/** A preview's fully qualified name: dotted Java/Kotlin identifiers, nothing a shell or the CLI could read as a flag. */
function assertPreviewFqn(fqn: unknown): string {
  const value = typeof fqn === "string" ? fqn.trim() : "";
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/u.test(value)) {
    throw new Error(`"${String(fqn)}" is not a preview's fully qualified name (dev.app.ui.GreetingKt.GreetingPreview). \`ade android preview list\` lists them.`);
  }
  return value;
}

/** A result's `error`: a string, or `{ status, message }` (a class not on the classpath). */
function previewError(error: unknown): string | null {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return null;
}

function inlinePng(filePath: string, logger: Logger | null | undefined): string | null {
  try {
    if (fs.statSync(filePath).size > INLINE_MAX_BYTES) return null;
    return `data:image/png;base64,${fs.readFileSync(filePath).toString("base64")}`;
  } catch (error) {
    // The path stays in the answer; the drawer shows the row with no picture.
    logger?.warn("android.compose_preview_inline_failed", { error: getErrorMessage(error) });
    return null;
  }
}

export function createAndroidComposePreviews(deps: AndroidComposePreviewDeps): AndroidEmulatorPreviewServiceApi {
  const { platform, signal, logger } = deps;
  /** One preview command per lane: a second waits for the first. */
  const perLane = createAndroidLaneQueue();

  /** The lane's folder and the module in it, checked: a module is a folder inside the lane with a Gradle build file. */
  const resolveModule = (laneId: string, requested: string | null | undefined) => {
    const root = deps.laneRoot(laneId);
    if (!root) throw new Error("ADE cannot find this lane's worktree, so it has no project to render previews from.");
    const module = (requested?.trim() || DEFAULT_MODULE).replace(/\\/gu, "/").replace(/^:+|\/+$/gu, "").replace(/:/gu, "/");
    if (!module || path.isAbsolute(module) || module.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error(`The module must be a module folder inside the lane, such as app or feature/home, not the project's root (got "${requested}").`);
    }
    let dir: string;
    try {
      dir = resolvePathWithinRoot(root, path.join(root, module));
    } catch (error) {
      if (isPathEscapeError(error)) throw new Error(`${module} is outside the lane's worktree.`);
      // The caller's module name (often the default `app`) is not a folder in
      // this lane; the message names the flag that fixes it.
      throw new AdeExpectedError(`The lane has no module folder ${module}. Pass --module <folder> (the Gradle module with the @Preview functions).`, "user");
    }
    if (!["build.gradle", "build.gradle.kts"].some((name) => fs.existsSync(path.join(dir, name)))) {
      throw new Error(`${module} has no build.gradle or build.gradle.kts. Pass --module <folder> (the Gradle module with the @Preview functions).`);
    }
    return { root, module };
  };

  /**
   * Runs `android preview …` in the lane's folder and answers its JSON. A
   * render where only some previews failed answers too (`success: false`
   * with a `results` entry per preview); the caller reads each one.
   */
  const runPreview = async (laneId: string, root: string, args: string[]): Promise<Record<string, unknown>> => {
    const sdkRoot = await deps.sdkRoot();
    const cli = await locateAndroidCli({ sdkRoot, env: deps.env, platform });
    if (!cli) {
      throw new AndroidEmulatorFailure(
        "ANDROID_TOOL_MISSING",
        "Compose previews need Google's Android CLI. Install it from the Android setup card (Android CLI), or run `ade android sdk install --with-cli`.",
      );
    }
    const { jdk, looked } = await locateAndroidJdk({ env: deps.env, platform });
    if (!jdk) throw new AndroidEmulatorFailure("ANDROID_BUILD_FAILED", androidJdkMissingMessage(looked));
    const env: NodeJS.ProcessEnv = { ...deps.env };
    const overrides: Record<string, string> = { JAVA_HOME: jdk.home, ...(sdkRoot ? { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot } : {}) };
    if (platform === "win32") {
      // Windows names have no case: drop `Java_Home` so only ours is passed.
      const names = new Set(Object.keys(overrides).map((name) => name.toLowerCase()));
      for (const key of Object.keys(env)) if (names.has(key.toLowerCase())) delete env[key];
    }
    Object.assign(env, overrides);
    const startedAt = Date.now();
    const output = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(cli.path, androidCliArgs(sdkRoot, args), { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < 8 * 1024 * 1024) stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < 256 * 1024) stderr += chunk; });
      let ended = false;
      const finish = () => {
        ended = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      // The CLI starts Gradle and a JVM: stop the whole tree, as the Gradle runner does.
      const stop = (reason: string) => {
        if (ended) return;
        finish();
        terminateProcessTree(child);
        reject(new AndroidEmulatorFailure("ANDROID_BUILD_FAILED", `android preview ${args[1]} ${reason}.`));
      };
      const timer = setTimeout(() => stop(`ran longer than ${PREVIEW_TIMEOUT_MS / 60_000} minutes and was stopped`), PREVIEW_TIMEOUT_MS);
      const onAbort = () => stop("was stopped because ADE is shutting down");
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", (error) => {
        if (ended) return;
        finish();
        reject(new AndroidEmulatorFailure("ANDROID_TOOL_MISSING", `The Android CLI could not start: ${getErrorMessage(error)}`));
      });
      child.on("close", (exitCode) => {
        if (ended) return;
        finish();
        resolve({ exitCode, stdout, stderr });
      });
    });
    const json = parsePreviewJson(output.stdout);
    logger?.info("android.compose_preview_ran", { laneId, command: args[1], exitCode: output.exitCode, ms: Date.now() - startedAt, ok: json?.success === true });
    const partial = json?.success === false && typeof json.globalError !== "string" && Array.isArray(json.results) && json.results.length > 0;
    if (!json || (json.success !== true && !partial)) {
      const reason = typeof json?.globalError === "string" ? json.globalError : (output.stderr || output.stdout).trim().split(/\r?\n/u).slice(-12).join("\n");
      const gradle = /Gradle|task|compil|Could not resolve/iu.test(output.stderr) ? ` Build output:\n${output.stderr.trim().split(/\r?\n/u).slice(-12).join("\n")}` : "";
      throw new AndroidEmulatorFailure("ANDROID_BUILD_FAILED", `android preview ${args[1]} failed: ${reason || `exit ${output.exitCode}`}${gradle && !reason.includes("\n") ? gradle : ""}`);
    }
    return json;
  };

  const list = async (laneId: string, root: string, module: string, all: boolean) =>
    readPreviewList(await runPreview(laneId, root, ["preview", "list", "--format", "json", ...(all ? ["--all"] : []), module]));

  return {
    async listComposePreviews(args) {
      const laneId = requireLaneId(args?.laneId);
      const { root, module } = resolveModule(laneId, args.module);
      return perLane(laneId, async () => ({ laneId, module, previews: await list(laneId, root, module, args.all === true) }));
    },

    async renderComposePreviews(args) {
      const laneId = requireLaneId(args?.laneId);
      const { root, module } = resolveModule(laneId, args.module);
      const named = (args.fqns ?? []).map(assertPreviewFqn);
      return perLane(laneId, async () => {
        const startedAt = Date.now();
        const known = named.length ? null : await list(laneId, root, module, false);
        if (known && known.length === 0) throw new Error(`${module} has no @Preview functions.`);
        const wanted = named.length ? [...new Set(named)] : known!.map((preview) => preview.fqn);
        const fqns = wanted.slice(0, ANDROID_COMPOSE_PREVIEW_RENDER_MAX);
        const names = new Map((known ?? []).map((preview) => [preview.fqn, preview.name]));
        const stamp = deps.now().toISOString().replace(/[:.]/gu, "-");
        const outDir = path.join(deps.dataDir, "compose-previews", androidLaneFolderName(laneId), stamp);
        fs.mkdirSync(outDir, { recursive: true });
        const json = await runPreview(laneId, root, ["preview", "render", "--format", "json", "--output", outDir, ...fqns.flatMap((fqn) => ["--fqn", fqn]), module]);
        const results = Array.isArray(json.results) ? json.results.filter(isRecord) : [];
        // Compared after symlinks (`/var` is `/private/var` on macOS) and by path segments.
        const realOutDir = fs.realpathSync(outDir);
        const fileProof = args.proof !== false;
        const images: AndroidComposePreviewImage[] = fqns.map((fqn) => {
          const result = results.find((entry) => entry.methodFqn === fqn);
          const imagePath = typeof result?.imagePath === "string" && fs.existsSync(result.imagePath) ? fs.realpathSync(result.imagePath) : null;
          // Only a file the CLI wrote into this render's folder is filed.
          const inside = imagePath !== null && isPathInside(imagePath, realOutDir, platform);
          const name = names.get(fqn) ?? null;
          const error = inside ? null : previewError(result?.error) ?? "The CLI wrote no image for this preview.";
          const proofArtifactId = inside && fileProof
            ? fileAndroidCaptureAsProof(deps.artifactFiler, {
              laneId,
              chatSessionId: args.chatSessionId ?? null,
              kind: "screenshot",
              path: imagePath!,
              mimeType: "image/png",
              title: `Compose preview: ${name ?? fqn.split(".").pop()}`,
              description: `${fqn}, rendered from ${module} with no emulator.`,
              toolName: "android_preview",
              source: "ade-capture",
              callerRoot: deps.callerRoot,
              metadata: { fqn, module },
            }, (failure) => logger?.warn("android.compose_preview_proof_failed", { laneId, error: getErrorMessage(failure) }))
            : null;
          const dataUrl = inside && args.inline === true ? inlinePng(imagePath!, logger) : null;
          return { fqn, name, path: inside ? imagePath : null, proofArtifactId, ...(args.inline === true ? { dataUrl } : {}), error };
        });
        if (images.some((image) => image.path)) deps.captureAnalytics?.("previews_rendered");
        return { laneId, module, outDir, images, skipped: wanted.length - fqns.length, durationMs: Date.now() - startedAt };
      });
    },
  };
}
