/**
 * `ade android`: the P1 agent suite, P3 and `sdk` verbs (`buildAndroidSuitePlan`),
 * split out of `cliAndroid.ts`, which keeps the flag tables, the error hints
 * and the P0 verbs.
 *
 * This module and cliAndroid.ts import each other, as cliAndroid.ts and
 * cli.ts do. The cycle is safe under the same rule:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 */
import path from "node:path";
import {
  ANDROID_DISPLAY_SIZES,
  ANDROID_FOLD_POSES,
  ANDROID_LOG_LEVELS,
  ANDROID_PERMISSIONS,
  ANDROID_SCROLL_DIRECTIONS,
  ANDROID_SETTINGS_FLAGS,
  ANDROID_TEXT_SIZES,
  parseAndroidIntentExtra,
} from "../../desktop/src/shared/types/androidEmulator";
import {
  CliUsageError,
  asString,
  isRecord,
  readFlag,
  readNumberOption,
  readOptionalNumberOption,
  readRepeatedValues,
  readValue,
  requireTypedText,
  requireValue,
  type CliPlan,
  type FormatterId,
  type JsonObject,
  type ValueCarrierFlags,
} from "./cli";
import {
  androidFlagNames,
  androidOutPath,
  finiteNumber,
  readPoint,
  readStroke,
} from "./cliAndroid";
import { formatAndroidSdkInstallLine, record, records, withAsked } from "./cliAndroidFormat";
import { appleLeaseAnswer, appleLeaseNotAcquired } from "./cliAppleFormat";

/** `ade android sdk <verb>`: the only flags each takes. */
const ANDROID_SDK_VERB_FLAGS: Readonly<Record<string, readonly string[]>> = {
  status: ["--folder", "--with-cli"],
  licenses: ["--folder", "--with-cli", "--id"],
  install: ["--folder", "--with-cli", "--accept-license", "--wait", "--image"],
  use: ["--clear"],
  cancel: [],
  // P3 system images.
  images: ["--installed"],
  remove: ["--image"],
};

type AndroidActionBuilder = (
  label: string,
  method: string,
  payload: JsonObject,
  formatter: FormatterId,
  extra?: { shapeResult?: (values: JsonObject) => unknown; progressNotice?: string },
) => CliPlan & { kind: "execute" };

/** A local path as an absolute one; sent as typed with `--machine`, where the other machine resolves it. */
function localPath(value: string, remote: boolean): string {
  return remote || path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}


/** P1 agent suite verbs and `sdk`. Null for a verb that is not one of them. */
export function buildAndroidSuitePlan(
  sub: string,
  args: string[],
  ctx: {
    remote: boolean;
    positionals: () => string[];
    carriers: ValueCarrierFlags;
    laneClaim: () => JsonObject;
    chatSessionId: string | null;
    androidAction: AndroidActionBuilder;
    /** `launch`/`relaunch … -- <words>`, taken out of `args` before any flag was read. */
    launchPassthrough?: readonly string[];
  },
): CliPlan | null {
  const { remote, positionals, laneClaim, androidAction } = ctx;
  const usage = (message: string) => new CliUsageError(`android ${sub}: ${message}`);
  const readPackage = (required: boolean): string | null => {
    const value = readValue(args, ["--package"]);
    if (required && !value) throw usage("--package <name> is required (`ade android apps --text` lists them).");
    return value;
  };
  const readInstallSource = (required: boolean): JsonObject => {
    const apk = readValue(args, ["--apk"]);
    const gradle = readFlag(args, ["--gradle"]);
    const moduleName = readValue(args, ["--module"]);
    const variant = readValue(args, ["--variant"]);
    if (apk && gradle) throw usage("pass --apk <path> or --gradle, not both.");
    if ((moduleName || variant) && !gradle) throw usage("--module and --variant go with --gradle.");
    if (required && !apk && !gradle) throw usage("pass --apk <path>, or --gradle to build the lane's app (--module <name>, --variant <name>).");
    // Always from this shell's folder: the APK is a file here. With
    // `--machine` it is sent as a path inside this checkout (cliRemoteWork).
    if (apk) return { apkPath: path.resolve(process.cwd(), apk) };
    if (gradle) return { gradle: { ...(moduleName ? { module: moduleName } : {}), ...(variant ? { variant } : {}) } };
    return {};
  };
  const readQuery = (): JsonObject => {
    const query: JsonObject = {};
    for (const [flag, key] of [["--ref", "ref"], ["--identifier", "identifier"], ["--label", "label"], ["--text", "text"], ["--role", "role"]] as const) {
      const value = readValue(args, [flag]);
      if (value) query[key] = value;
    }
    if (Object.keys(query).length === 0) {
      throw usage("name the element with --ref, --identifier, --label, --text or --role (`ade android snapshot --text` lists them).");
    }
    const index = readNumberOption(args, ["--index"]);
    if (index != null) query.index = index;
    return query;
  };
  /** `--launch-arg <word>` and `-- <words>` (`am start` options), then `--extra`/`--extra-string key=value`. */
  const readLaunchExtras = (): JsonObject => {
    const words = [...readRepeatedValues(args, ["--launch-arg"]), ...(ctx.launchPassthrough ?? [])];
    const extras: JsonObject[] = [];
    for (const [flag, forceString] of [["--extra", false], ["--extra-string", true]] as const) {
      for (const raw of readRepeatedValues(args, [flag])) {
        try {
          extras.push(parseAndroidIntentExtra(raw, forceString));
        } catch (error) {
          throw usage(`${flag}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { ...(words.length ? { arguments: words } : {}), ...(extras.length ? { extras } : {}) };
  };
  const elementResult = { exitCodeFromResult: (result: unknown) => (record(result).ok === false ? 1 : 0) };

  if (sub === "apps") return androidAction("android apps", "listApps", laneClaim(), "android-apps");
  if (sub === "install") {
    const source = readInstallSource(true);
    return androidAction("android install", "installApp", { ...laneClaim(), ...source }, "android-install",
      source.gradle ? { progressNotice: "Building the lane's app with Gradle and installing it; a first build can take a few minutes…" } : {});
  }
  if (sub === "launch") {
    const packageName = readPackage(false);
    const activity = readValue(args, ["--activity"]);
    const source = readInstallSource(false);
    const launchExtras = readLaunchExtras();
    if (!packageName && !source.apkPath && !source.gradle) {
      throw usage("pass --package <name>, or --gradle / --apk <path> to install the app and open it.");
    }
    return androidAction("android launch", "launchApp", {
      ...laneClaim(),
      ...source,
      ...(packageName ? { packageName } : {}),
      ...(activity ? { activity } : {}),
      ...launchExtras,
    }, "android-launch", source.gradle ? { progressNotice: "Building the lane's app with Gradle, then opening it…" } : {});
  }
  // Parity with `ade apple`: relaunch, app-state, foreground, frame, inspect, select, device-cleanup.
  if (sub === "relaunch") {
    const packageName = readPackage(true)!;
    const activity = readValue(args, ["--activity"]);
    return androidAction("android relaunch", "relaunchApp", {
      ...laneClaim(),
      packageName,
      ...(activity ? { activity } : {}),
      ...readLaunchExtras(),
    }, "android-launch");
  }
  if (sub === "app-state") {
    const packageName = readValue(args, ["--package"]) ?? positionals()[0] ?? null;
    if (!packageName) throw usage("pass the package: `ade android app-state <package>` (`ade android apps --text` lists them).");
    return androidAction("android app-state", "getAppState", { ...laneClaim(), packageName }, "android-app-state");
  }
  if (sub === "foreground") {
    // `--wait [seconds]`: ask again until an app (or `--package`) is in front; bare is 10 s, as `ade apple`.
    const waitSeconds = readOptionalNumberOption(args, ["--wait"], 10);
    const packageName = readValue(args, ["--package"]);
    if (waitSeconds != null && (waitSeconds < 0 || waitSeconds > 30)) throw usage("--wait is 0 to 30 seconds.");
    return androidAction("android foreground", "getForegroundApp", {
      ...laneClaim(),
      ...(packageName ? { packageName } : {}),
      ...(waitSeconds ? { waitMs: Math.round(waitSeconds * 1000) } : {}),
    }, "android-foreground");
  }
  if (sub === "frame") {
    const outPath = androidOutPath(readValue(args, ["--out"]), remote);
    return androidAction("android frame", "frame", { ...laneClaim(), ...(outPath ? { outPath } : {}) }, "android-frame");
  }
  if (sub === "inspect" || sub === "select") {
    const { x, y } = readPoint(args, positionals(), sub);
    const ref = readValue(args, ["--ref"]);
    const includeScreenshot = sub === "inspect" && readFlag(args, ["--screenshot"]);
    return androidAction(`android ${sub}`, sub === "inspect" ? "inspectPoint" : "selectPoint", {
      ...laneClaim(),
      x,
      y,
      ...(ref ? { ref } : {}),
      ...(includeScreenshot ? { includeScreenshot: true } : {}),
    }, "android-inspect");
  }
  if (sub === "device-cleanup") {
    const powerOffIdle = readFlag(args, ["--power-off-idle"]);
    const dryRun = readFlag(args, ["--dry-run"]);
    return androidAction("android device-cleanup", "deviceCleanup", {
      ...laneClaim(),
      ...(powerOffIdle ? { powerOffIdle: true } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    }, "android-cleanup");
  }
  if (sub === "terminate" || sub === "uninstall") {
    const packageName = readPackage(true)!;
    return androidAction(`android ${sub}`, sub === "terminate" ? "terminateApp" : "uninstallApp", { ...laneClaim(), packageName }, "android-action", {
      shapeResult: withAsked({ action: sub, packageName }),
    });
  }
  if (sub === "open-url") {
    const url = requireValue(readValue(args, ["--url"]) ?? positionals()[0] ?? null, "the URL");
    return androidAction("android open-url", "openUrl", { ...laneClaim(), url }, "android-action", {
      shapeResult: withAsked({ action: "open-url", url }),
    });
  }
  if (sub === "long-press") {
    const { x, y } = readPoint(args, positionals(), sub);
    const durationMs = readNumberOption(args, ["--duration-ms"]);
    return androidAction("android long-press", "longPress", {
      ...laneClaim(), x, y, ...(durationMs == null ? {} : { durationMs }),
    }, "android-action", { shapeResult: withAsked({ action: "long-press", x, y, ...(durationMs == null ? {} : { durationMs }) }) });
  }
  if (sub === "drag") {
    const stroke = readStroke(positionals(), sub);
    const durationMs = readNumberOption(args, ["--duration-ms"]);
    return androidAction("android drag", "drag", {
      ...laneClaim(), ...stroke, ...(durationMs == null ? {} : { durationMs }),
    }, "android-action", { shapeResult: withAsked({ action: "drag", ...stroke }) });
  }
  if (sub === "scroll") {
    const direction = (readValue(args, ["--direction"]) ?? positionals()[0] ?? "").toLowerCase();
    if (!(ANDROID_SCROLL_DIRECTIONS as readonly string[]).includes(direction)) {
      throw usage(`--direction must be ${ANDROID_SCROLL_DIRECTIONS.join(", ")}.`);
    }
    const amount = readNumberOption(args, ["--amount"]);
    const anchorX = readNumberOption(args, ["--anchor-x"]);
    const anchorY = readNumberOption(args, ["--anchor-y"]);
    return androidAction("android scroll", "scroll", {
      ...laneClaim(),
      direction,
      ...(amount == null ? {} : { amount }),
      ...(anchorX == null ? {} : { anchorX }),
      ...(anchorY == null ? {} : { anchorY }),
    }, "android-action", { shapeResult: withAsked({ action: "scroll", direction }) });
  }
  if (sub === "snapshot") {
    const fresh = readFlag(args, ["--fresh"]);
    return androidAction("android snapshot", "getScreenSnapshot", { ...laneClaim(), ...(fresh ? { fresh: true } : {}) }, "android-snapshot");
  }
  if (sub === "find-element") {
    return { ...androidAction("android find-element", "findElement", { ...laneClaim(), query: readQuery() }, "android-element"), ...elementResult };
  }
  if (sub === "tap-element") {
    const holdMs = readNumberOption(args, ["--hold-ms"]);
    return {
      ...androidAction("android tap-element", "tapElement", { ...laneClaim(), query: readQuery(), ...(holdMs == null ? {} : { holdMs }) }, "android-element"),
      ...elementResult,
    };
  }
  if (sub === "fill-element") {
    const noFocus = readFlag(args, ["--no-focus"]);
    // The query first: it claims `--text <value>`, and the value is `--value` or the positional.
    const query = readQuery();
    const text = requireTypedText(readValue(args, ["--value"]) ?? positionals()[0] ?? null, "the text to type (--value <text>)");
    return {
      ...androidAction("android fill-element", "fillElement", { ...laneClaim(), query, text, ...(noFocus ? { focusFirst: false } : {}) }, "android-element"),
      ...elementResult,
    };
  }
  if (sub === "wait-for-element") {
    const timeoutMs = readNumberOption(args, ["--timeout-ms"]);
    const gone = readFlag(args, ["--gone"]);
    return {
      ...androidAction("android wait-for-element", "waitForElement", {
        ...laneClaim(),
        query: readQuery(),
        ...(timeoutMs == null ? {} : { timeoutMs }),
        ...(gone ? { state: "gone" } : {}),
      }, "android-element"),
      ...elementResult,
    };
  }
  if (sub === "assert-visible") {
    return { ...androidAction("android assert-visible", "assertVisible", { ...laneClaim(), query: readQuery() }, "android-element"), ...elementResult };
  }
  if (sub === "log") {
    const packageName = readPackage(false);
    const level = readValue(args, ["--level"])?.toLowerCase() ?? null;
    if (level && !(ANDROID_LOG_LEVELS as readonly string[]).includes(level)) throw usage(`--level must be ${ANDROID_LOG_LEVELS.join(", ")}.`);
    const since = readValue(args, ["--since"]);
    const lines = readNumberOption(args, ["--lines"]);
    return androidAction("android log", "readLog", {
      ...laneClaim(),
      ...(packageName ? { packageName } : {}),
      ...(level ? { level } : {}),
      ...(since ? { since } : {}),
      ...(lines == null ? {} : { lines }),
    }, "android-log");
  }
  if (sub === "record-start") {
    const label = readValue(args, ["--label"]);
    const maxSeconds = readNumberOption(args, ["--max-seconds"]);
    if (maxSeconds != null && maxSeconds <= 0) throw usage("--max-seconds must be greater than 0.");
    // `ade apple`'s flags: a plain recording is filed as recorded; zoom zooms in on each tap in the demo.
    const plain = readFlag(args, ["--plain", "--keep-idle"]);
    const zoom = readFlag(args, ["--zoom"]);
    if (plain && zoom) throw usage("takes --plain or --zoom, not both: a plain recording has no zoom.");
    return androidAction("android record-start", "recordStart", {
      ...laneClaim(),
      ...(label ? { label } : {}),
      ...(maxSeconds == null ? {} : { maxSeconds }),
      ...(plain ? { plain: true } : {}),
      ...(zoom ? { zoom: true } : {}),
    }, "android-recording");
  }
  if (sub === "record-stop") {
    const keep = readFlag(args, ["--keep"]);
    const discard = readFlag(args, ["--discard"]);
    if (keep && discard) throw usage("use --keep or --discard, not both.");
    return androidAction("android record-stop", "recordStop", {
      ...laneClaim(),
      ...(keep ? { keep: true } : {}),
      ...(discard ? { discard: true } : {}),
    }, "android-recording", discard ? {} : { progressNotice: "Stopping the recording and making its demo video…" });
  }
  if (sub === "auto-record") {
    // `ade apple auto-record`'s words: on, off, or status (the default).
    const word = (positionals()[0] ?? "status").toLowerCase();
    if (word === "status") return androidAction("android auto-record", "getAutoRecord", laneClaim(), "android-auto-record");
    if (word !== "on" && word !== "off") throw usage("takes on, off or status.");
    return androidAction("android auto-record", "setAutoRecord", { ...laneClaim(), enabled: word === "on" }, "android-auto-record");
  }
  if (sub === "record-list") return androidAction("android record-list", "recordList", laneClaim(), "android-recordings");
  if (sub === "record-delete") {
    const id = requireValue(readValue(args, ["--id"]) ?? positionals()[0] ?? null, "--id <recording id>");
    return androidAction("android record-delete", "recordDelete", { ...laneClaim(), id }, "android-action", {
      shapeResult: withAsked({ action: "record-delete", id }),
    });
  }
  if (sub === "lease") return buildAndroidLeasePlan(args, ctx);
  if (sub === "location") {
    const latitudeFlag = readNumberOption(args, ["--latitude"]);
    const longitudeFlag = readNumberOption(args, ["--longitude"]);
    // A longitude is often negative, which the positional reader takes for a
    // flag. The number after `--latitude` or `--longitude` is that flag's, so
    // it never fills the other coordinate.
    const flagValueAt = new Set(
      args.flatMap((value, index) => (value === "--latitude" || value === "--longitude" ? [index + 1] : [])),
    );
    const signed = args.filter((value, index) => !flagValueAt.has(index) && /^-?\d+(\.\d+)?$/u.test(value));
    const latitude = latitudeFlag ?? finiteNumber(signed.shift(), "latitude", sub);
    const longitude = longitudeFlag ?? finiteNumber(signed.shift(), "longitude", sub);
    return androidAction("android location", "setLocation", { ...laneClaim(), latitude, longitude }, "android-action", {
      shapeResult: withAsked({ action: "location", latitude, longitude }),
    });
  }
  if (sub === "appearance") {
    const appearance = (positionals()[0] ?? "").toLowerCase();
    if (appearance !== "light" && appearance !== "dark") throw usage("say light or dark.");
    return androidAction("android appearance", "setAppearance", { ...laneClaim(), appearance }, "android-action", {
      shapeResult: withAsked({ action: "appearance", appearance }),
    });
  }
  // `ade apple fold`'s words: a pose, or `--angle` in degrees (0 shut, 180 flat).
  if (sub === "posture") return androidAction("android posture", "getPosture", laneClaim(), "android-posture");
  if (sub === "fold") {
    const word = (readValue(args, ["--angle"]) ?? positionals()[0] ?? "").toLowerCase();
    const pose = (ANDROID_FOLD_POSES as readonly string[]).includes(word) ? word : null;
    const angle = pose ? null : Number(word);
    if (!pose && (!/^\d+(\.\d+)?$/u.test(word) || angle! > 180)) {
      throw usage(`say ${ANDROID_FOLD_POSES.join(", ")} or an angle from 0 (shut) to 180 (flat).`);
    }
    return androidAction("android fold", "setPosture", { ...laneClaim(), ...(pose ? { pose } : { angle }) }, "android-posture");
  }
  if (sub === "settings") {
    const onOff = (flag: string): boolean | null => {
      const raw = readValue(args, [flag]);
      if (raw == null) return null;
      const value = raw.toLowerCase();
      if (value === "on" || value === "true") return true;
      if (value === "off" || value === "false") return false;
      throw usage(`${flag} takes on or off.`);
    };
    const oneOf = (flag: string, allowed: readonly string[]): string | null => {
      const raw = readValue(args, [flag]);
      if (raw == null) return null;
      if (!allowed.includes(raw)) throw usage(`${flag} takes ${allowed.join(", ")}.`);
      return raw;
    };
    const textSize = oneOf("--text-size", ANDROID_TEXT_SIZES.map((size) => size.value));
    const displaySize = oneOf("--display-size", ANDROID_DISPLAY_SIZES.map((size) => size.value));
    const animations = onOff("--animations");
    const showTaps = onOff("--show-taps");
    const layoutBounds = onOff("--layout-bounds");
    const batteryRaw = readNumberOption(args, ["--battery"]);
    const charging = onOff("--charging");
    const wifi = onOff("--wifi");
    const data = onOff("--data");
    const airplane = onOff("--airplane");
    const settings: JsonObject[] = [];
    if (textSize) settings.push({ kind: "text-size", value: textSize });
    if (displaySize) settings.push({ kind: "display-size", value: displaySize });
    if (animations !== null) settings.push({ kind: "animations", off: !animations });
    if (showTaps !== null) settings.push({ kind: "show-taps", on: showTaps });
    if (layoutBounds !== null) settings.push({ kind: "layout-bounds", on: layoutBounds });
    if (batteryRaw != null || charging !== null) {
      settings.push({ kind: "battery", ...(batteryRaw != null ? { level: batteryRaw } : {}), ...(charging !== null ? { charging } : {}) });
    }
    if (wifi !== null) settings.push({ kind: "wifi", on: wifi });
    if (data !== null) settings.push({ kind: "mobile-data", on: data });
    if (airplane !== null) settings.push({ kind: "airplane", on: airplane });
    if (settings.length > 1) throw usage("change one setting per call (--battery and --charging go together).");
    if (settings.length === 0) return androidAction("android settings", "getDeviceSettings", laneClaim(), "android-settings");
    const changed = ANDROID_SETTINGS_FLAGS
      .map((flag) => [flag, readValue(args, [flag])] as const)
      .filter(([, value]) => value != null)
      .map(([flag, value]) => `${flag.slice(2)} ${value}`)
      .join(", ");
    return androidAction("android settings", "setDeviceSetting", { ...laneClaim(), setting: settings[0]! }, "android-settings", {
      shapeResult: withAsked({ changed }),
    });
  }
  if (sub === "permission") {
    const [verb, permission] = positionals();
    if (verb !== "grant" && verb !== "revoke") throw usage("say grant or revoke, then the permission: ade android permission grant camera --package <name>.");
    if (!permission) {
      throw usage(`name the permission (${ANDROID_PERMISSIONS.map((entry) => entry.short).join(", ")}, or android.permission.<NAME>).`);
    }
    const packageName = readPackage(true)!;
    return androidAction("android permission", "setPermission", { ...laneClaim(), action: verb, packageName, permission }, "android-action", {
      shapeResult: withAsked({ action: "permission", grant: verb, packageName }),
    });
  }
  if (sub === "proof-bundle") {
    const out = readValue(args, ["--out"]);
    const caption = readValue(args, ["--caption"]);
    const packageName = readPackage(false);
    const noElements = readFlag(args, ["--no-elements"]);
    return androidAction("android proof-bundle", "captureProofBundle", {
      ...laneClaim(),
      ...(out ? { outDir: androidOutPath(out, remote) } : {}),
      ...(caption ? { caption } : {}),
      ...(packageName ? { packageName } : {}),
      ...(noElements ? { includeElements: false } : {}),
    }, "android-proof-bundle");
  }
  if (sub === "preview") {
    // A Gradle build of the module, so `--machine` syncs this checkout first (cliRemoteWork).
    const listing = positionals()[0] === "list";
    if (!listing && positionals().length > 0) throw usage(`unknown word '${positionals()[0]}'. Use \`preview list\`, or \`preview\` to render.`);
    const moduleName = readValue(args, ["--module"]);
    const fqns = readRepeatedValues(args, ["--fqn"]);
    const all = readFlag(args, ["--all"]);
    const noProof = readFlag(args, ["--no-proof"]);
    if (listing && (fqns.length || noProof)) throw usage("preview list takes --module and --all only.");
    if (!listing && all) throw usage("--all goes with `preview list`.");
    const moduleArg = moduleName ? { module: moduleName } : {};
    const notice = `Building the module with Gradle${listing ? " to list" : " and rendering"} its previews; the first run also downloads the preview pack…`;
    return listing
      ? androidAction("android preview list", "listComposePreviews", { ...laneClaim(), ...moduleArg, ...(all ? { all: true } : {}) }, "android-previews", { progressNotice: notice })
      : {
        ...androidAction("android preview", "renderComposePreviews", {
          ...laneClaim(),
          ...moduleArg,
          ...(fqns.length ? { fqns } : {}),
          ...(noProof ? { proof: false } : {}),
        }, "android-previews", { progressNotice: notice }),
        // A preview with no image exits 1, so `ade android preview && …` stops there.
        exitCodeFromResult: (result: unknown) => {
          const images = record(result).images;
          return Array.isArray(images) && images.some((image) => !isRecord(image) || !asString(image.path)) ? 1 : 0;
        },
      };
  }
  if (sub === "test") {
    // Always a Gradle run, so `--machine` syncs this checkout first (cliRemoteWork).
    const moduleName = readValue(args, ["--module"]);
    const variant = readValue(args, ["--variant"]);
    const className = readValue(args, ["--class"]);
    const method = readValue(args, ["--method"]);
    if (method && !className) throw usage("--method needs --class <fully qualified class name>.");
    return {
      ...androidAction("android test", "runInstrumentationTests", {
        ...laneClaim(),
        gradle: { ...(moduleName ? { module: moduleName } : {}), ...(variant ? { variant } : {}) },
        ...(className ? { className } : {}),
        ...(method ? { method } : {}),
      }, "android-test", { progressNotice: "Building the lane's app and its tests with Gradle, then running them on the emulator; this can take a few minutes…" }),
      // A failed test exits 1, so `ade android test && …` stops there.
      exitCodeFromResult: (result: unknown) => (record(result).ok === false ? 1 : 0),
    };
  }
  if (sub === "sdk") return buildAndroidSdkPlan(args, ctx);
  return null;
}

/**
 * `ade android lease [--wait <s>] [--ttl <s>] [--holder <name>]`, then
 * `lease release --token <t>`, `lease renew --token <t>`, `lease status`:
 * `ade apple lease`'s verbs. Leases live in the brain, so these never fall
 * back to an in-process runtime.
 */
function buildAndroidLeasePlan(
  args: string[],
  ctx: { positionals: () => string[]; laneClaim: () => JsonObject; chatSessionId: string | null; androidAction: AndroidActionBuilder },
): CliPlan {
  // Every flag first: a flag's value must not be read as the verb.
  const waitSeconds = readNumberOption(args, ["--wait"]);
  const ttlSeconds = readNumberOption(args, ["--ttl"]);
  // A shell with no chat is its own holder (its parent, the shell), so two
  // terminals queue instead of both renewing one anonymous lease.
  const holder = readValue(args, ["--holder"]) ?? (ctx.chatSessionId ? null : `shell ${process.ppid}`);
  const tokenFlag = readValue(args, ["--token"]);
  const [verbRaw, tokenPositional] = ctx.positionals();
  const verb = verbRaw ?? "acquire";
  const leasePlan = { needsLiveRuntime: "Android device leases" };
  const scope = ctx.laneClaim();
  if (verb === "status") {
    return { ...ctx.androidAction("android lease status", "deviceLeaseStatus", scope, "android-lease"), ...leasePlan };
  }
  if (verb === "release") {
    const token = requireValue(tokenFlag ?? tokenPositional ?? null, "--token");
    return {
      ...ctx.androidAction("android lease release", "deviceLeaseRelease", { ...scope, token }, "android-lease"),
      ...leasePlan,
      // A token that held nothing exits 1: the caller did not have the turn it thought it had.
      exitCodeFromResult: (result: unknown) => {
        const value = appleLeaseAnswer(result);
        return isRecord(value) && value.released === false ? 1 : 0;
      },
    };
  }
  if (verb !== "acquire" && verb !== "renew") {
    throw new CliUsageError(`android lease: unknown action '${verb}'. Use acquire (the default), renew, release or status.`);
  }
  if (verb === "renew" && !tokenFlag) throw new CliUsageError("android lease renew needs --token <t>, the token your lease printed.");
  const plan = ctx.androidAction("android lease", "deviceLease", {
    ...scope,
    ...(holder ? { holder } : {}),
    // A turn is its token: subagents of one chat share the chat's id, so only the token renews.
    distinct: true,
    ...(tokenFlag ? { token: tokenFlag } : {}),
    ...(waitSeconds != null ? { waitMs: Math.round(waitSeconds * 1000) } : {}),
    ...(ttlSeconds != null ? { ttlMs: Math.round(ttlSeconds * 1000) } : {}),
  }, "android-lease");
  return {
    ...plan,
    ...leasePlan,
    // The call outlives the wait, so the answer arrives even under a short --timeout-ms.
    ...(waitSeconds != null && waitSeconds > 0
      ? { minTimeoutMs: Math.max(plan.minTimeoutMs ?? 0, Math.round(Math.min(waitSeconds, 540) * 1000) + 60_000) }
      : {}),
    // A lease that was not granted (busy, or the wait ran out) exits 1, so
    // `lease --wait N && install` never installs over another holder's turn.
    exitCodeFromResult: (result: unknown) => (appleLeaseNotAcquired(result) ? 1 : 0),
  };
}

const SDK_TERMINAL_STATES = new Set(["idle", "done", "failed", "cancelled"]);

/**
 * `ade android sdk status | licenses | install | use | cancel`: the guided
 * SDK install the setup card runs. An agent may read the plan; only a person
 * accepts a licence (the brain refuses an agent's install).
 */
function buildAndroidSdkPlan(
  args: string[],
  ctx: { remote: boolean; positionals: () => string[]; carriers: ValueCarrierFlags; androidAction: AndroidActionBuilder },
): CliPlan {
  const [verbRaw, folderPositional] = ctx.positionals();
  const verb = verbRaw ?? "status";
  const allowed = ANDROID_SDK_VERB_FLAGS[verb];
  if (!allowed) throw new CliUsageError(`android sdk: unknown verb '${verb}'. Use status, licenses, install, use, cancel, images or remove.`);
  const unknown = androidFlagNames(args, ctx.carriers).find((name) => name !== "--lane" && !allowed.includes(name));
  if (unknown) throw new CliUsageError(`android sdk ${verb} does not take ${unknown}. Run 'ade android --help'.`);
  const setupArgs = (): JsonObject => {
    const folder = readValue(args, ["--folder"]);
    const withCli = readFlag(args, ["--with-cli"]);
    return {
      ...(folder ? { sdkRoot: localPath(folder, ctx.remote) } : {}),
      ...(withCli ? { includeAndroidCli: true } : {}),
    };
  };
  if (verb === "status") return ctx.androidAction("android sdk status", "getSdkSetupPlan", setupArgs(), "android-sdk-status");
  if (verb === "licenses") {
    const id = readValue(args, ["--id"]);
    return ctx.androidAction("android sdk licenses", "getSdkSetupPlan", setupArgs(), "android-sdk-licenses", {
      shapeResult: (values) => {
        const licenses = records(record(values.result).licenses);
        if (!id) return { licenses };
        const picked = licenses.filter((license) => license.id === id);
        if (!picked.length) {
          throw new CliUsageError(`android sdk licenses: no licence '${id}'. This setup needs: ${licenses.map((license) => String(license.id)).join(", ") || "none"}.`);
        }
        return { licenses: picked };
      },
    });
  }
  if (verb === "images") {
    const installedOnly = readFlag(args, ["--installed"]);
    return ctx.androidAction("android sdk images", "listSystemImages", installedOnly ? { includeAvailable: false } : {}, "android-sdk-images");
  }
  if (verb === "remove") {
    // User-only: the brain refuses an agent and a terminal, and the hint says to ask the user.
    const id = requireValue(readValue(args, ["--image"]), "--image <system image id>");
    return ctx.androidAction("android sdk remove", "removeSystemImage", { id }, "android-action", {
      shapeResult: (values) => ({ ...record(values.result), action: "sdk remove" }),
    });
  }
  if (verb === "install") {
    const accepted = readRepeatedValues(args, ["--accept-license"]).map((value) => value.trim()).filter(Boolean);
    const wait = readFlag(args, ["--wait"]);
    const image = readValue(args, ["--image"]);
    if (image && (readValue(args, ["--folder"]) || readFlag(args, ["--with-cli"]))) {
      throw new CliUsageError("android sdk install --image installs into this machine's SDK; leave out --folder and --with-cli.");
    }
    const payload = setupArgs();
    if (!accepted.length) {
      // ADE never accepts a licence for the caller: the person names each one.
      throw new CliUsageError(
        "android sdk install needs --accept-license <id> for each licence the parts need. "
          + (image
            ? "Run `ade android sdk images --text` to see each image's licence."
            : "Run `ade android sdk status` to see them and `ade android sdk licenses` to read them."),
      );
    }
    const plan = image
      ? ctx.androidAction("android sdk install", "installSystemImage", { id: image, acceptedLicenseIds: accepted }, "android-sdk-install")
      : ctx.androidAction("android sdk install", "installSdk", { ...payload, acceptedLicenseIds: accepted }, "android-sdk-install");
    if (!wait) return plan;
    const poll = ctx.androidAction("android sdk install state", "getSdkInstallState", {}, "android-sdk-install");
    return {
      ...plan,
      followResult: {
        plan: poll,
        intervalMs: 2_000,
        done: (result: unknown) => SDK_TERMINAL_STATES.has(asString(record(result).state) ?? "idle"),
        progress: (result: unknown) => formatAndroidSdkInstallLine(record(result)),
      },
      exitCodeFromResult: (result: unknown) => (record(result).state === "failed" ? 1 : 0),
    };
  }
  if (verb === "use") {
    const clear = readFlag(args, ["--clear"]);
    const folder = folderPositional ?? null;
    if (clear === Boolean(folder)) throw new CliUsageError("android sdk use takes a folder, or --clear to go back to the SDK ADE finds.");
    return ctx.androidAction("android sdk use", "setSdkPath", { path: folder ? localPath(folder, ctx.remote) : null }, "android-status");
  }
  return ctx.androidAction("android sdk cancel", "cancelSdkInstall", {}, "android-sdk-install");
}
