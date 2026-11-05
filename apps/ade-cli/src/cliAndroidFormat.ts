/**
 * `ade android` text output: the formatters `cli.ts`'s output switch calls.
 *
 * Split from `cliAndroid.ts`, which keeps the plan builder and the error
 * hints. The import cycle rule of `cliMacDesktopFormat.ts` applies to `./cli`:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 */
import { asString, isRecord, renderKeyValues, renderTable, unwrapActionEnvelope, type JsonObject } from "./cli";
import { appleLeaseAnswer, leaseAcquiredLines, leaseHeldLine, leaseReleasedLine } from "./cliAppleFormat";

/* ── Text output ──────────────────────────────────────────────────────────── */

/** The action's answer as an object, out of its envelope. */
export function record(value: unknown): JsonObject {
  const unwrapped = unwrapActionEnvelope(value);
  return isRecord(unwrapped) ? unwrapped : {};
}

export function records(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function yesNo(value: unknown): string | null {
  return value === true ? "yes" : value === false ? "no" : null;
}

/** The lane device block, shared by `status` and the lifecycle verbs. */
function laneDeviceLines(lane: JsonObject): string[] {
  const device = isRecord(lane.device) ? lane.device : null;
  const avd = isRecord(lane.avd) ? lane.avd : null;
  const running = avd && isRecord(avd.running) ? avd.running : null;
  const error = isRecord(lane.error) ? lane.error : null;
  const lines = [
    renderKeyValues("ADE Android emulator (lane)", [
      ["lane", lane.laneId],
      ["state", lane.state],
      ["avd", device?.avdName ?? avd?.name ?? null],
      ["origin", device?.origin],
      ["profile", device?.profileId ?? avd?.profileId ?? null],
      ["image", device?.systemImage],
      ["api", avd?.apiLevel],
      ["screen", avd?.lcdWidth && avd?.lcdHeight ? `${avd.lcdWidth}x${avd.lcdHeight}` : null],
      ["serial", running?.serial],
      ["booted", yesNo(running?.booted)],
    ]),
  ];
  if (error) {
    lines.push("", `error: ${asString(error.code) ?? "?"}: ${asString(error.message) ?? ""}`.trimEnd());
    const logPath = asString(error.logPath);
    if (logPath) lines.push(`log: ${logPath}`);
  }
  // P2 crash pin: the lane's app crashed while the emulator runs.
  const crash = isRecord(lane.appCrash) ? lane.appCrash : null;
  if (crash) {
    const app = asString(crash.packageName) ?? "the app";
    lines.push("", `app crash: ${app}: ${asString(crash.summary) ?? ""}`.trimEnd());
    lines.push(`next: ade android log${asString(crash.packageName) ? ` --package ${asString(crash.packageName)}` : ""} --level error`);
  }
  if (!device) {
    lines.push("", "next: ade android device-create --profile <id> (ade android devices --profiles lists them), or ade android device-attach --avd <name>");
  } else if (lane.state === "off" || lane.state === "crashed") {
    lines.push("", "next: ade android start");
  }
  return lines;
}

export function formatAndroidStatus(value: unknown): string {
  const status = record(value);
  const sdk = isRecord(status.sdk) ? status.sdk : {};
  const acceleration = isRecord(sdk.acceleration) ? sdk.acceleration : {};
  const tools = records(sdk.tools);
  const lines = [
    renderKeyValues("ADE Android emulator", [
      ["supported", yesNo(status.platformSupported)],
      ["unsupported", status.unsupportedReason],
      ["sdk", sdk.found === true ? asString(sdk.root) ?? "found" : "not found"],
      ["sdk source", sdk.source],
      ["acceleration", acceleration.kind
        ? `${String(acceleration.kind)} (${acceleration.usable === true ? "usable" : "not usable"})`
        : acceleration.usable === true ? "usable" : "none"],
      ["acceleration detail", acceleration.detail],
      ["host abi", sdk.hostAbi],
      ["avd home", sdk.avdHome],
    ], ["unsupported", "acceleration detail"]),
  ];
  if (tools.length) {
    lines.push("", renderTable(
      ["tool", "available", "version", "path / detail"],
      tools.map((tool) => [
        tool.id,
        yesNo(tool.available),
        tool.version,
        tool.available === true ? tool.path : tool.detail ?? tool.path,
      ]),
      "No SDK tools reported.",
    ));
  }
  const capabilities = isRecord(status.capabilities) ? status.capabilities : null;
  if (capabilities) {
    const can = [
      capabilities.record === true ? "record" : null,
      capabilities.uiTree ? `ui tree (${String(capabilities.uiTree)})` : null,
      capabilities.logcat === true ? "logcat" : null,
      capabilities.gradle === true ? "gradle" : null,
    ].filter(Boolean);
    lines.push("", `can: ${can.length ? can.join(", ") : "nothing yet (set up the SDK: ade android sdk status --text)"}`);
    if ("jdk" in capabilities) {
      const jdk = isRecord(capabilities.jdk) ? capabilities.jdk : null;
      lines.push(jdk
        ? `jdk: ${asString(jdk.version) ?? "version unknown"} (${asString(jdk.source) ?? "found"}) ${asString(jdk.home) ?? ""}`.trimEnd()
        : "jdk: none found, so Gradle builds cannot run. Install Android Studio or a JDK 17+, or set JAVA_HOME for ADE.");
    }
  }
  if (isRecord(status.lane)) lines.push("", ...laneDeviceLines(status.lane));
  return lines.join("\n");
}

function formatAvdTable(avds: JsonObject[]): string {
  return renderTable(
    ["avd", "api", "abi", "profile", "running", "lane", "ade"],
    avds.map((avd) => {
      const running = isRecord(avd.running) ? avd.running : null;
      return [
        avd.name,
        avd.apiLevel,
        avd.abi,
        avd.profileId,
        running ? `${asString(running.serial) ?? "?"}${running.booted === true ? " (booted)" : " (booting)"}` : null,
        avd.heldByLaneId,
        yesNo(avd.adeCreated),
      ];
    }),
    "No AVDs on this machine. Make one: ade android device-create --profile <id>.",
    { fullColumns: ["avd", "lane"] },
  );
}

export function formatAndroidDevices(value: unknown, options: { profiles?: boolean } = {}): string {
  const inventory = record(value);
  const avds = records(inventory.avds);
  const profiles = records(inventory.profiles);
  const images = records(inventory.images);
  const lines = [`AVDs  ${avds.length}`, formatAvdTable(avds), "", `System images  ${images.length}`];
  lines.push(renderTable(
    ["package", "api", "tag", "abi"],
    images.map((image) => [image.packageId, image.apiLevel, image.tag, image.abi]),
    "No system images installed. Install one with sdkmanager.",
    { fullColumns: ["package"] },
  ));
  lines.push("");
  if (options.profiles) {
    lines.push(`Hardware profiles  ${profiles.length}`, renderTable(
      ["id", "name", "kind", "screen", "origin"],
      profiles.map((profile) => [
        profile.id,
        profile.name,
        profile.formFactor,
        profile.widthPx && profile.heightPx ? `${profile.widthPx}x${profile.heightPx}` : null,
        profile.origin,
      ]),
      "No hardware profiles reported.",
      { fullColumns: ["id"] },
    ));
  } else {
    lines.push(`Hardware profiles  ${profiles.length} (list them: ade android devices --profiles --text)`);
  }
  return lines.join("\n");
}

export function formatAndroidDevice(value: unknown): string {
  return laneDeviceLines(record(value)).join("\n");
}

export function formatAndroidRelease(value: unknown): string {
  const result = record(value);
  return renderKeyValues("ADE Android emulator release", [
    ["released", yesNo(result.released)],
    ["deleted avd", result.deletedAvd ?? (result.released === true ? "(kept)" : null)],
  ]);
}

export function formatAndroidScreenshot(value: unknown): string {
  const shot = record(value);
  const filePath = asString(shot.path);
  return [
    renderKeyValues("ADE Android screenshot", [
      ["size", shot.width && shot.height ? `${shot.width}x${shot.height}` : null],
      ["bytes", shot.bytes],
      ["captured", shot.capturedAt],
      ["caption", shot.caption],
      ["proof", asString(shot.proofArtifactId) ? "filed (ade proof list)" : null],
    ]),
    // Printed raw rather than as a table cell: agents Read this path back,
    // and the key/value renderer truncates long values.
    filePath ? `file: ${filePath}` : "",
  ].filter(Boolean).join("\n");
}

/** What each `android-action` verb says it did, after `android <verb>`. */
const ANDROID_ACTION_DETAIL: Readonly<Record<string, (result: JsonObject) => string>> = {
  tap: (result) => `(${result.x}, ${result.y})`,
  "long-press": (result) => `(${result.x}, ${result.y})${typeof result.durationMs === "number" ? ` for ${result.durationMs} ms` : ""}`,
  swipe: (result) => `(${result.fromX}, ${result.fromY}) -> (${result.toX}, ${result.toY})`,
  drag: (result) => `(${result.fromX}, ${result.fromY}) -> (${result.toX}, ${result.toY})`,
  button: (result) => String(result.button),
  rotate: (result) => String(result.orientation),
  type: (result) => `${result.characters} characters`,
  scroll: (result) => String(result.direction),
  terminate: (result) => String(result.packageName),
  uninstall: (result) => String(result.packageName),
  "open-url": (result) => String(result.url),
  location: (result) => `${result.latitude}, ${result.longitude}`,
  appearance: (result) => String(result.appearance),
  permission: (result) => `${String(result.grant)} ${String(result.permission ?? "")} for ${String(result.packageName)}`,
  "record-delete": (result) => String(result.id),
  "sdk remove": (result) => `${String(result.id)}${formatBytes(result.freedBytes) ? ` (${formatBytes(result.freedBytes)} freed)` : ""}`,
};

export function formatAndroidAction(value: unknown): string {
  const result = record(value);
  const action = asString(result.action) ?? "action";
  if (action === "uninstall" && result.uninstalled === false) return `android uninstall: ${String(result.packageName)} was not installed`;
  if (action === "record-delete" && result.deleted === false) return `android record-delete: no recording ${String(result.id)}`;
  const detail = Object.hasOwn(ANDROID_ACTION_DETAIL, action) ? ANDROID_ACTION_DETAIL[action]!(result) : "";
  return `android ${action} ${detail}`.trimEnd() + " done";
}

/** `settings`: what the emulator reports after the read or the change. */
export function formatAndroidSettings(value: unknown): string {
  const settings = record(value);
  const battery = record(settings.battery);
  const network = record(settings.network);
  const density = record(settings.density);
  const onOff = (flag: unknown) => (flag === true ? "on" : flag === false ? "off" : null);
  return renderKeyValues("ADE Android emulator settings", [
    ["changed", settings.changed],
    ["appearance", settings.appearance],
    ["text size", settings.textSize ?? (typeof settings.fontScale === "number" ? `${settings.fontScale}x` : null)],
    ["display size", settings.displaySize ?? (typeof density.override === "number" ? `${density.override} dpi` : null)],
    ["animations", settings.animationsOff === true ? "off" : settings.animationsOff === false ? "on" : null],
    ["show taps", onOff(settings.showTaps)],
    ["layout bounds", onOff(settings.layoutBounds)],
    ["battery", typeof battery.level === "number" ? `${battery.level}%${battery.charging === true ? ", charging" : battery.charging === false ? ", on battery" : ""}` : null],
    ["wifi", onOff(network.wifi)],
    ["mobile data", onOff(network.mobileData)],
    ["airplane", onOff(network.airplane)],
    ["in front", settings.foregroundPackage ?? "home screen"],
  ]);
}

/** `fold` and `posture`: the hinge, what Android made of it, and the screen in front. */
export function formatAndroidPosture(value: unknown): string {
  const posture = record(value);
  if (posture.supported === false) return "android posture: this emulator has no hinge (fold works on a foldable AVD).";
  const screen = record(posture.screen);
  return renderKeyValues("ADE Android emulator posture", [
    ["hinge", typeof posture.angle === "number" ? `${posture.angle}°` : null],
    ["state", posture.state ?? "changing"],
    ["screen", typeof screen.width === "number" ? `${screen.width}x${screen.height}` : null],
    ["settled", posture.settled === false ? "no: Android was still changing; read posture again" : null],
  ]);
}

/** `preview list` (a table of previews) and `preview` (a line per image, and whether it is filed as proof). */
export function formatAndroidPreviews(value: unknown): string {
  const result = record(value);
  if (Array.isArray(result.previews)) {
    const previews = result.previews.filter(isRecord);
    if (previews.length === 0) return `android preview list: ${asString(result.module) ?? "the module"} has no @Preview functions.`;
    return [
      `ADE Compose previews in ${asString(result.module) ?? "the module"} (${previews.length})`,
      // The fqn is what `--fqn` takes: never shortened.
      renderTable(["name", "fqn"], previews.map((preview) => [preview.name, preview.fqn]), "No previews.", { fullColumns: ["fqn"] }),
    ].join("\n");
  }
  const images = Array.isArray(result.images) ? result.images.filter(isRecord) : [];
  const drawn = images.filter((image) => asString(image.path));
  const seconds = typeof result.durationMs === "number" ? `${(result.durationMs / 1000).toFixed(1)} s` : null;
  return [
    renderKeyValues("ADE Compose preview render", [
      ["module", result.module],
      ["rendered", `${drawn.length} of ${images.length}${seconds ? ` in ${seconds}` : ""}`],
      ["skipped", typeof result.skipped === "number" && result.skipped > 0 ? `${result.skipped} more (name them with --fqn)` : null],
      ["folder", result.outDir],
    ]),
    ...images.map((image) => {
      const label = asString(image.name) ?? asString(image.fqn) ?? "preview";
      if (!asString(image.path)) return `failed: ${label}: ${asString(image.error) ?? "no image"}`;
      // Raw, not a table cell: agents Read this path back.
      return `image: ${label}: ${asString(image.path)}${asString(image.proofArtifactId) ? " (filed as proof)" : ""}`;
    }),
  ].join("\n");
}

/** `render`: how many files, where they went, and a citation per proof row. */
export function formatAndroidRender(value: unknown): string {
  const result = record(value);
  const ids = Array.isArray(result.proofArtifactIds)
    ? result.proofArtifactIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  const paths = Array.isArray(result.paths) ? result.paths.filter((entry): entry is string => typeof entry === "string") : [];
  return [
    renderKeyValues("ADE Android device render", [
      ["filed", result.filed],
      ["error", result.error],
      ["proof", ids.length ? `${ids.length} row${ids.length === 1 ? "" : "s"} (ade proof list)` : null],
    ]),
    ...paths.map((entry) => `file: ${entry}`),
  ].join("\n");
}

/* ── P1 agent suite text output ───────────────────────────────────────────── */

function seconds(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? `${Math.round(ms / 100) / 10} s` : null;
}

function formatBytes(bytes: unknown): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
  if (bytes <= 0) return "0 MB";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function formatAndroidApps(value: unknown): string {
  const apps = records(record(value).apps);
  return renderTable(
    ["package", "launch activity", "ade installed"],
    apps.map((app) => [app.packageName, app.launchActivity, yesNo(app.adeInstalled)]),
    "No apps found on the emulator.",
    { fullColumns: ["package", "launch activity"] },
  );
}

function installLine(install: JsonObject): string {
  const how = install.method === "gradle" ? `Gradle ${asString(install.gradleTask) ?? ""}`.trimEnd() : `APK ${asString(install.apkPath) ?? ""}`.trimEnd();
  return `Installed ${asString(install.packageName) ?? "the app"} (${how}) in ${seconds(install.durationMs) ?? "?"}.`;
}

export function formatAndroidInstall(value: unknown): string {
  const install = record(value);
  return [
    installLine(install),
    `Open it: ade android launch --package ${asString(install.packageName) ?? "<name>"} --text`,
  ].join("\n");
}

export function formatAndroidLaunch(value: unknown): string {
  const launch = record(value);
  const install = isRecord(launch.install) ? launch.install : null;
  return [
    ...(install ? [installLine(install)] : []),
    // `activity` is the component (`pkg/.Main`) when the app's launcher named it.
    `Opened ${asString(launch.activity)?.includes("/") ? asString(launch.activity) : `${asString(launch.packageName) ?? "?"}/${asString(launch.activity) ?? "?"}`}`
      + `${typeof launch.totalTimeMs === "number" ? ` (started in ${launch.totalTimeMs} ms)` : ""}.`,
    "Check the screen: ade android snapshot --text",
  ].join("\n");
}

/** The element's name for a reader: its label, text or id. */
function elementName(element: JsonObject): string {
  const name = asString(element.label) ?? asString(element.text) ?? asString(element.identifier);
  return name ? JSON.stringify(name.length > 60 ? `${name.slice(0, 57)}...` : name) : "";
}

function elementFlags(element: JsonObject): string {
  return [
    element.clickable === true ? "tap" : null,
    element.longClickable === true ? "long-press" : null,
    element.scrollable === true ? "scroll" : null,
    element.focused === true ? "focused" : null,
    element.checked === true ? "checked" : null,
    element.selected === true ? "selected" : null,
    element.enabled === false ? "disabled" : null,
  ].filter(Boolean).join(",");
}

/**
 * `snapshot`: one row per element worth aiming at (named, or one that takes a
 * tap or a scroll). Layout-only containers are counted, not listed; `--json`
 * has them all.
 */
export function formatAndroidSnapshot(value: unknown): string {
  const snapshot = record(value);
  const elements = records(snapshot.elements);
  const shown = elements.filter((element) =>
    elementName(element) || element.clickable === true || element.scrollable === true || element.longClickable === true);
  const center = (element: JsonObject) => (isRecord(element.center) ? `${element.center.x},${element.center.y}` : null);
  const lines = [
    `${elements.length} elements on screen${asString(snapshot.foregroundPackage) ? ` (${asString(snapshot.foregroundPackage)})` : ""}, `
      + `read by ${asString(snapshot.source) ?? "?"} in ${snapshot.durationMs ?? "?"} ms${snapshot.cached === true ? " (cached; --fresh reads again)" : ""}.`,
    renderTable(
      ["ref", "role", "name", "center", "does"],
      shown.map((element) => [element.ref, element.role, elementName(element), center(element), elementFlags(element)]),
      "No elements to aim at.",
      { fullColumns: ["ref", "name"] },
    ),
  ];
  if (shown.length < elements.length) lines.push(`${elements.length - shown.length} layout elements with no name are not listed (--json lists every element).`);
  lines.push("Aim with --ref <ref> (or --label, --text, --identifier): ade android tap-element --ref <ref> --text");
  return lines.join("\n");
}

export function formatAndroidElement(value: unknown): string {
  const result = record(value);
  const match = isRecord(result.match) ? result.match : null;
  const element = match && isRecord(match.element) ? match.element : {};
  const where = isRecord(element.center) ? ` at (${element.center.x}, ${element.center.y})` : "";
  const ref = asString(match?.ref) ?? "?";
  const named = `${ref}${elementName(element) ? ` ${elementName(element)}` : ""}`;
  const action = asString(result.action) ?? "find";
  const lines: string[] = [];
  if (action === "tap") lines.push(`Tapped ${named}${where}.`);
  else if (action === "fill") {
    const typed = asString(result.typed);
    lines.push(`Filled ${named}: ${typed === "verified" ? "the field shows the text" : typed === "not-seen" ? "the field does NOT show the text" : "could not check the field"}.`);
    if (asString(result.typedDetail)) lines.push(asString(result.typedDetail)!);
  } else if (action === "wait") {
    lines.push(match ? `${named} is on screen${where} (waited ${seconds(result.waitedMs) ?? "?"}).` : `Gone from the screen (waited ${seconds(result.waitedMs) ?? "?"}).`);
  } else if (action === "assert") lines.push(`Visible: ${named}${where}.`);
  else lines.push(`Found ${named}${where}.`);
  if (typeof result.matchCount === "number" && result.matchCount > 1) {
    const others = records(result.others).map((other) => `${String(other.ref)} (--index ${String(other.index)})`);
    lines.push(`${result.matchCount} elements match; this is the first.${others.length ? ` Others: ${others.join(", ")}.` : ""}`);
  }
  if (asString(result.message)) lines.push(asString(result.message)!);
  return lines.join("\n");
}

export function formatAndroidLog(value: unknown): string {
  const log = record(value);
  // logcat's epoch seconds, read as the local time of day; the cursor stays epoch.
  const clock = (time: unknown): string => {
    const seconds = Number(time);
    if (!Number.isFinite(seconds)) return String(time);
    const date = new Date(seconds * 1000);
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  };
  const lines = records(log.lines).map((line) =>
    `${clock(line.time)} ${String(line.level)} ${String(line.tag)}(${String(line.pid)}): ${String(line.message)}`);
  return [
    ...(lines.length ? lines : [`No log lines${asString(log.packageName) ? ` from ${asString(log.packageName)}` : ""}.`]),
    ...(log.truncated === true ? ["(older lines left out; --lines <n> reads more)"] : []),
    ...(asString(log.cursor) ? [`next: ade android log --since ${asString(log.cursor)}${asString(log.packageName) ? ` --package ${asString(log.packageName)}` : ""} --text reads only newer lines`] : []),
  ].join("\n");
}

export function formatAndroidRecording(value: unknown): string {
  const recording = record(value);
  if (recording.active === true) {
    return [
      `Recording ${String(recording.id)} started${asString(recording.label) ? ` (${asString(recording.label)})` : ""}.`,
      "Stop it, and file it as proof: ade android record-stop --text",
    ].join("\n");
  }
  const segments = records(recording.segments);
  const ids = Array.isArray(recording.proofArtifactIds) ? recording.proofArtifactIds.filter((id) => typeof id === "string") : [];
  return [
    renderKeyValues("ADE Android recording", [
      ["id", recording.id],
      ["label", recording.label],
      ["length", seconds(recording.durationMs)],
      ["size", formatBytes(recording.bytes)],
      ["parts", segments.length > 1 ? `${segments.length} (the screen turned)` : null],
      ["stopped by", recording.stopReason === "requested" ? null : recording.stopReason],
      ["proof", ids.length ? `${ids.length} row${ids.length === 1 ? "" : "s"}` : null],
      ["error", recording.lastError],
    ]),
    // Printed raw: agents read these paths back, and the table shortens long values.
    ...segments.map((segment) => `file: ${String(segment.path)}`),
  ].join("\n");
}

export function formatAndroidRecordings(value: unknown): string {
  const recordings = records(record(value).recordings);
  return renderTable(
    ["id", "started", "length", "parts", "active", "label"],
    recordings.map((entry) => [
      entry.id,
      entry.startedAt,
      seconds(entry.durationMs),
      records(entry.segments).length || null,
      yesNo(entry.active),
      entry.label,
    ]),
    "No recordings in this lane. Start one: ade android record-start --text",
    { fullColumns: ["id"] },
  );
}

export function formatAndroidProofBundle(value: unknown): string {
  const bundle = record(value);
  return [
    `Proof bundle in ${String(bundle.dir)}${asString(bundle.proofArtifactId) ? ", filed as proof" : ""}.`,
    ...[bundle.screenshotPath, bundle.elementsPath, bundle.logPath, bundle.metaPath]
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => `file: ${entry}`),
  ].join("\n");
}

/** `lease`: the token to keep (it alone renews and releases), or who has the device. */
export function formatAndroidLease(value: unknown): string {
  const result = record(appleLeaseAnswer(value));
  const device = isRecord(result.device) ? result.device : {};
  const name = asString(device.avdName) ? `the emulator ${asString(device.avdName)}` : "the lane's emulator";
  const Name = `${name[0]!.toUpperCase()}${name.slice(1)}`;
  if (typeof result.released === "boolean") return leaseReleasedLine(result, name);
  if (typeof result.held === "boolean") return leaseHeldLine(result, Name);
  if (result.acquired === true) {
    return leaseAcquiredLines(result, name, { renew: "ade android lease renew", release: "ade android lease release" }).join("\n");
  }
  const current = isRecord(result.current) ? result.current : {};
  return result.sameHolder === true
    ? `Not granted: ${name} is leased under your own name (another agent of this chat, or a turn whose token you lost). Wait for it with --wait <seconds>.`
    : `Not granted: ${name} is leased to ${asString(current.holder) ?? "another holder"} until ${asString(current.expiresAt) ?? "?"}; ${String(result.queued ?? 0)} waiting. Wait for it with --wait <seconds>.`;
}

/* ── P1 setup text output ─────────────────────────────────────────────────── */

/** One line for a running install, for `sdk install --wait` and `sdk cancel`. */
export function formatAndroidSdkInstallLine(state: JsonObject): string | null {
  if (state.state !== "running") return null;
  const done = typeof state.overallDone === "number" ? state.overallDone : 0;
  const total = typeof state.overallTotal === "number" && state.overallTotal > 0 ? state.overallTotal : null;
  const percent = total ? `${Math.floor((done / total) * 100)}%` : "?";
  const eta = typeof state.etaSeconds === "number" ? `, about ${Math.max(1, Math.round(state.etaSeconds))} s left` : "";
  const partNumber = typeof state.partIndex === "number" ? state.partIndex + 1 : "?";
  return `${state.cancelling === true ? "cancelling: " : ""}${percent} · ${String(state.partLabel)} (${partNumber} of ${String(state.partCount)}): ${String(state.step)} `
    + `${formatBytes(state.bytesDone) ?? "?"} of ${formatBytes(state.bytesTotal) ?? "?"}${eta}`;
}

export function formatAndroidSdkInstall(value: unknown): string {
  const state = record(value);
  const installed = Array.isArray(state.installed) && state.installed.length ? state.installed.join(", ") : "none";
  switch (state.state) {
    case "running":
      return [
        formatAndroidSdkInstallLine(state) ?? "Installing.",
        `Into ${String(state.sdkRoot)}. Follow it: ade android sdk status --text. Stop it: ade android sdk cancel.`,
      ].join("\n");
    case "done":
      return `Installed ${installed} into ${String(state.sdkRoot)}.\nnext: ade android status --text`;
    case "failed": {
      const error = isRecord(state.error) ? state.error : {};
      return `The install failed${asString(state.partId) ? ` at ${asString(state.partId)}` : ""}: ${String(error.code ?? "?")}: ${String(error.message ?? "")}\n`
        + `Finished parts stay: ${installed}. Run ade android sdk status --text, then install again.`;
    }
    case "cancelled":
      return `The install was cancelled. Finished parts stay: ${installed}.`;
    default:
      return "No Android SDK install runs on this machine.";
  }
}

export function formatAndroidSdkStatus(value: unknown): string {
  const plan = record(value);
  if (plan.hostSupported === false) return `This machine cannot run the Android emulator: ${asString(plan.unsupportedReason) ?? "unsupported"}.`;
  const parts = records(plan.parts);
  const missing = parts.filter((part) => part.missing === true);
  const missingIds = new Set(missing.map((part) => String(part.id)));
  const acceleration = isRecord(plan.acceleration) ? plan.acceleration : {};
  const lines = [
    renderTable(
      ["part", "found", "id"],
      parts.map((part) => [
        `${String(part.label)}${part.optional === true ? " (optional)" : ""}`,
        part.missing === true
          ? `missing · ${formatBytes(part.downloadBytes) ?? "?"}`
          : asString(part.installedVersion)
            ?? (part.optional === true ? "not asked for (--with-cli)" : "found"),
        part.id,
      ]),
      "No parts reported.",
      { fullColumns: ["part", "found"] },
    ),
    "",
    `install folder: ${String(plan.sdkRoot)} (${String(plan.sdkRootSource)})${plan.writable === false ? ` — not writable: ${asString(plan.writableDetail) ?? ""}` : ""}`,
    `space: needs ${formatBytes(plan.diskBytesNeeded) ?? "?"}, free ${formatBytes(plan.diskBytesFree) ?? "unknown"}`,
    `avd folder: ${asString(plan.avdHome) ?? "?"}${plan.avdHomeFreeBytes != null ? ` (free ${formatBytes(plan.avdHomeFreeBytes)})` : ""}`,
    `acceleration: ${acceleration.kind ? `${String(acceleration.kind)} (${acceleration.usable === true ? "usable" : "not usable"})` : acceleration.usable === true ? "usable" : "none"}`
      + `${asString(acceleration.detail) && acceleration.usable !== true ? ` — ${asString(acceleration.detail)}` : ""}`,
  ];
  if (asString(plan.repositoryError)) lines.push(`repository: ${asString(plan.repositoryError)} (sizes and versions may be missing)`);
  const licenses = records(plan.licenses).filter((license) =>
    Array.isArray(license.partIds) && license.partIds.some((id) => missingIds.has(String(id))));
  if (!missing.length) {
    lines.push("", "Every part is installed. Nothing to install.");
  } else {
    lines.push("", "licences the missing parts need:");
    lines.push(...(licenses.length
      ? licenses.map((license) => `  ${String(license.id)}  ${String(license.title)}${license.accepted === true ? "  (accepted before)" : ""}`)
      : ["  none"]));
    lines.push(
      "",
      "Read them: ade android sdk licenses --text. Only the user installs the SDK and accepts the licences, "
        + "in the ADE desktop app: the setup card in the Android tool, or Settings › Android devices.",
    );
  }
  const install = isRecord(plan.install) ? plan.install : null;
  if (install && install.state === "running") lines.push("", `install running: ${formatAndroidSdkInstallLine(install) ?? ""}`);
  return lines.join("\n");
}

export function formatAndroidSdkLicenses(value: unknown): string {
  const licenses = records(record(value).licenses);
  if (!licenses.length) return "This setup needs no licences.";
  return licenses
    .map((license) => [
      `== ${String(license.id)}: ${String(license.title)}${license.accepted === true ? " (accepted before)" : ""} ==`,
      String(license.text ?? ""),
    ].join("\n"))
    .join("\n\n");
}

/* ── P3 system images and instrumentation tests ──────────────────────────── */

/** `sdk images`: the installed images, then the ones Google publishes for this ABI. */
export function formatAndroidSdkImages(value: unknown): string {
  const inventory = record(value);
  const images = records(inventory.images);
  const installed = images.filter((image) => image.installed === true);
  const available = images.filter((image) => image.installed !== true);
  const avdNames = (image: JsonObject) => records(image.avds).map((avd) => String(avd.name)).join(", ") || "none";
  const lines = [
    `system images in ${asString(inventory.sdkRoot) ?? "?"} (host ABI ${asString(inventory.hostAbi) ?? "?"}, free ${formatBytes(inventory.diskBytesFree) ?? "unknown"})`,
    "",
    "installed:",
    renderTable(
      ["image", "api", "size", "note", "avds", "id"],
      installed.map((image) => [
        image.name,
        image.apiLevel,
        formatBytes(image.sizeBytes) ?? "?",
        [image.newest === true ? "newest" : null, image.updateAvailable === true ? "update" : null].filter(Boolean).join(", ") || null,
        avdNames(image),
        image.id,
      ]),
      "No system images are installed.",
      { fullColumns: ["id", "image"] },
    ),
  ];
  if (asString(inventory.repositoryError)) {
    lines.push("", `repository: ${asString(inventory.repositoryError)} (the available list is missing)`);
  } else if (available.length) {
    lines.push(
      "",
      "available:",
      renderTable(
        ["image", "api", "download", "licence", "id"],
        available.map((image) => {
          const offer = record(image.available);
          return [
            `${String(image.name)}${image.emulatorTooOld === true ? " (needs a newer emulator)" : ""}`,
            image.apiLevel,
            formatBytes(offer.downloadBytes) ?? "?",
            offer.licenseId,
            image.id,
          ];
        }),
        "None.",
        { fullColumns: ["id", "image", "licence"] },
      ),
    );
  }
  const install = record(inventory.install);
  if (install.state === "running") lines.push("", `install running: ${formatAndroidSdkInstallLine(install) ?? ""}`);
  lines.push(
    "",
    "Only the user installs or removes system images, in the ADE desktop app: the device picker's System images.",
  );
  return lines.join("\n");
}

/** `test`: the counts, then each failure with the first lines of its message. */
export function formatAndroidTest(value: unknown): string {
  const result = record(value);
  const failures = records(result.failures);
  const counts = `${String(result.total ?? 0)} tests: ${String(result.passed ?? 0)} passed, ${String(result.failed ?? 0)} failed, ${String(result.skipped ?? 0)} skipped`;
  const lines = [
    `${result.ok === true ? "PASSED" : "FAILED"} ${asString(result.gradleTask) ?? ""}${asString(result.filter) ? ` (${asString(result.filter)})` : ""}`.replace(/\s+$/u, ""),
    `${counts} in ${seconds(result.durationMs) ?? "?"}${result.source === "gradle-output" ? " (read from Gradle's output)" : ""}.`,
  ];
  for (const failure of failures) {
    lines.push("", `FAIL ${String(failure.className)}#${String(failure.name)}`);
    const message = Array.isArray(failure.message) ? failure.message.map(String) : [];
    lines.push(...message.map((line) => `  ${line}`));
  }
  if (typeof result.failed === "number" && result.failed > failures.length) {
    const more = result.failed - failures.length;
    lines.push("", `${more} more ${more === 1 ? "failure is" : "failures are"} not shown.`);
  }
  if (asString(result.reportPath)) lines.push("", `report: ${asString(result.reportPath)}`);
  return lines.join("\n");
}
