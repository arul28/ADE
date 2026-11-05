import type {
  AndroidElementActionResult,
  AndroidElementQuery,
  AndroidElementQueryArgs,
  AndroidSdkStatus,
  AndroidUiSnapshot,
  AndroidUiTreeSource,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage, sleep } from "../shared/utils";
import { dumpWithAndroidCli, locateAndroidCli } from "./androidCli";
import { readAndroidForeground } from "./androidDeviceSettings";
import { runAdbOutput, runDeviceScript, type BootedDevice } from "./androidDeviceShell";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import {
  describeElementQuery,
  hasElementQuery,
  parseUiautomatorXml,
  pickElement,
  type ParsedUiTree,
} from "./androidUiTree";

/*
 * The lane's UI tree: read with Google's Android CLI (`android layout`) when
 * it is installed, else with `uiautomator dump`, cached for a moment, and
 * searched by the element verbs.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** A cached UI tree serves this long, while no input came and the focused window is the same. */
const UI_CACHE_TTL_MS = 5_000;
const UI_DUMP_TIMEOUT_MS = 30_000;
/** After a failed `android layout`, uiautomator serves for this long before the CLI is tried again. */
const ANDROID_CLI_RETRY_MS = 10 * 60_000;
/** The package of the server `android layout` installs and leaves running on the device. */
const ANDROID_CLI_LAYOUT_PACKAGE = "com.android.cli.interact.instrumentation";

/** `uiautomator dump` prints a bare "Killed" when it cannot get UI automation. */
function isKilled(text: string): boolean {
  return /^\s*Killed\s*$/mu.test(text);
}

/** The XML a `uiautomator dump /dev/tty` printed, without its trailing status line. */
function extractUiXml(text: string): string | null {
  const start = text.indexOf("<?xml");
  const end = text.lastIndexOf("</hierarchy>");
  if (start < 0 || end < start) return null;
  return text.slice(start, end + "</hierarchy>".length);
}

type UiCacheEntry = { at: number; window: string | null; snapshot: AndroidUiSnapshot };

export type AndroidUiSnapshotDeps = {
  requireBooted: (laneId: string) => Promise<BootedDevice>;
  /** The SDK root, or a throw when there is none. */
  sdkRoot: () => Promise<string>;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  logger: Logger | null;
  now: () => Date;
};

type AndroidElementFound = {
  snapshot: AndroidUiSnapshot;
  picked: ReturnType<typeof pickElement>;
  element: NonNullable<ReturnType<typeof pickElement>["match"]>["element"];
};

export function createAndroidUiSnapshots(deps: AndroidUiSnapshotDeps) {
  const { signal, logger, now } = deps;
  const cache = new Map<string, UiCacheEntry>();
  let androidCliFailedAt = 0;

  /**
   * Stops the Android CLI's layout server (`android layout` leaves it running
   * on the device). It holds the device's one UiAutomation connection, so
   * `uiautomator dump` cannot run next to it ("Killed"). The next
   * `android layout` starts it again.
   */
  const stopAndroidCliServer = async (booted: BootedDevice) => {
    await runDeviceScript(booted, `am force-stop ${ANDROID_CLI_LAYOUT_PACKAGE}`, { timeoutMs: 10_000, signal }).catch(() => null);
  };

  const dumpWithUiautomator = async (booted: BootedDevice): Promise<ParsedUiTree> => {
    let lastText = "";
    let freedCliServer = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(500);
      const direct = await runAdbOutput(booted, ["exec-out", "uiautomator", "dump", "/dev/tty"], { timeoutMs: UI_DUMP_TIMEOUT_MS, signal });
      lastText = direct.text;
      let xml = extractUiXml(lastText);
      if (!xml && !/idle state/iu.test(lastText) && !isKilled(lastText)) {
        // Some images cannot write to /dev/tty: write a file and read it back.
        const viaFile = await runDeviceScript(
          booted,
          "uiautomator dump /data/local/tmp/ade-ui.xml >/dev/null && cat /data/local/tmp/ade-ui.xml",
          { timeoutMs: UI_DUMP_TIMEOUT_MS, signal },
        );
        lastText = viaFile.text;
        xml = extractUiXml(viaFile.stdout);
      }
      if (xml) return parseUiautomatorXml(xml);
      if (isKilled(lastText) && !freedCliServer) {
        // Another UiAutomation client holds the device: most often the CLI's layout server.
        freedCliServer = true;
        await stopAndroidCliServer(booted);
      }
    }
    const busy = /idle state/iu.test(lastText);
    throw new AndroidEmulatorFailure(
      "ANDROID_UI_TREE_FAILED",
      busy
        ? "The screen kept changing (an animation or a video), so uiautomator could not read it. Wait for the screen to settle and try again, or use a screenshot."
        : isKilled(lastText)
          ? "uiautomator could not connect to the device's UI automation (\"Killed\"): another client holds it. "
            + "ADE stopped the Android CLI's layout server and tried again, and the connection was still taken: "
            + "an instrumentation test (`am instrument`, a Gradle connectedCheck) or another tool can hold it. "
            + "Stop that run and try again, or use a screenshot."
          : `uiautomator could not read the screen: ${lastText.slice(0, 300) || "no output"}.`,
    );
  };

  const snapshot = async (laneId: string, options: { fresh: boolean }): Promise<AndroidUiSnapshot> => {
    const booted = await deps.requireBooted(laneId);
    const foreground = await readAndroidForeground(booted, signal);
    const cached = cache.get(laneId);
    if (!options.fresh && cached && Date.now() - cached.at < UI_CACHE_TTL_MS && cached.window === foreground.window) {
      return { ...cached.snapshot, cached: true };
    }
    const startedAt = Date.now();
    let tree: ParsedUiTree | null = null;
    let source: AndroidUiTreeSource = "uiautomator";
    if (Date.now() - androidCliFailedAt > ANDROID_CLI_RETRY_MS) {
      const root = await deps.sdkRoot().catch(() => null);
      const cli = root ? await locateAndroidCli({ sdkRoot: root, env: deps.env, platform: deps.platform }) : null;
      if (cli && root) {
        try {
          tree = await dumpWithAndroidCli(booted, cli.path, root, { env: deps.env, signal });
          source = "android-cli";
        } catch (error) {
          androidCliFailedAt = Date.now();
          logger?.warn("android.ui_tree_cli_failed", { laneId, error: getErrorMessage(error) });
          // Its server can still hold UI automation; free it for uiautomator.
          await stopAndroidCliServer(booted);
        }
      }
    }
    tree ??= await dumpWithUiautomator(booted);
    const result: AndroidUiSnapshot = {
      laneId,
      source,
      capturedAt: now().toISOString(),
      durationMs: Date.now() - startedAt,
      cached: false,
      width: tree.width,
      height: tree.height,
      foregroundPackage: foreground.foregroundPackage,
      elements: tree.elements,
    };
    cache.set(laneId, { at: Date.now(), window: foreground.window, snapshot: result });
    return result;
  };

  /** A refusal that lists a few elements that are on screen, so the next try can aim better. */
  const notFound = (query: AndroidElementQuery, found: AndroidUiSnapshot, matchCount: number): AndroidEmulatorFailure => {
    const named = found.elements
      .filter((element) => element.label || element.text || element.identifier)
      .slice(0, 12)
      .map((element) => element.ref);
    const detail = matchCount > 0 && typeof query.index === "number"
      ? `${matchCount} element(s) match ${describeElementQuery({ ...query, index: null })}, so there is no --index ${query.index}.`
      : `No element on screen matches ${describeElementQuery(query)}.`;
    return new AndroidEmulatorFailure(
      "ANDROID_ELEMENT_NOT_FOUND",
      `${detail}${named.length ? ` On screen: ${named.join(", ")}.` : " The screen has no named elements."} Run ade android snapshot to see every element.`,
    );
  };

  const find = async (laneId: string, query: AndroidElementQuery, fresh: boolean): Promise<AndroidElementFound> => {
    const found = await snapshot(laneId, { fresh });
    const picked = pickElement(found.elements, query);
    if (!picked.match) {
      // A cached tree may be older than the screen: read it again before refusing.
      if (found.cached) return find(laneId, query, true);
      throw notFound(query, found, picked.matches.length);
    }
    return { snapshot: found, picked, element: picked.match.element };
  };

  return {
    snapshot,
    find,

    /** Anything that changes the screen ends the lane's cached tree. */
    invalidate(laneId: string): void {
      cache.delete(laneId);
    },

    /** The size of the lane's cached tree, when there is one. */
    cachedSize(laneId: string): { width: number; height: number } | null {
      const cached = cache.get(laneId)?.snapshot;
      return cached?.width && cached.height ? { width: cached.width, height: cached.height } : null;
    },

    /** The tree source `snapshot` would use now, for `status`. Cheap: never runs the CLI. */
    async source(sdk: AndroidSdkStatus, adb: boolean): Promise<{
      uiTree: AndroidUiTreeSource | null;
      androidCli: { path: string; version: string | null } | null;
    }> {
      const cli = sdk.root
        ? await locateAndroidCli({ sdkRoot: sdk.root, env: deps.env, platform: deps.platform, wait: false }).catch(() => null)
        : null;
      return {
        uiTree: adb ? (cli && Date.now() - androidCliFailedAt > ANDROID_CLI_RETRY_MS ? "android-cli" : "uiautomator") : null,
        androidCli: cli ? { path: cli.path, version: cli.version } : null,
      };
    },

    clear(): void {
      cache.clear();
    },
  };
}

/** The element query of an element verb, checked. */
export function readElementQuery(args: AndroidElementQueryArgs): AndroidElementQuery {
  const query = args.query ?? {};
  if (!hasElementQuery(query)) throw new Error("Name the element: --ref, --identifier, --label, --text or --role.");
  if (query.index != null && (!Number.isInteger(query.index) || query.index < 0)) throw new Error("index must be a whole number, 0 or more.");
  return query;
}

/** The answer of an element verb: the match, how many matched, and up to five others. */
export function elementActionResult(
  action: AndroidElementActionResult["action"],
  picked: ReturnType<typeof pickElement>,
  extra: Partial<AndroidElementActionResult> = {},
): AndroidElementActionResult {
  return {
    ok: true,
    action,
    match: picked.match,
    matchCount: picked.matches.length,
    others: picked.matches
      .map((element, index) => ({ index, ref: element.ref, center: element.center }))
      .filter((entry) => entry.ref !== picked.match?.ref)
      .slice(0, 5),
    message: picked.match?.note ?? null,
    waitedMs: null,
    ...extra,
  };
}
