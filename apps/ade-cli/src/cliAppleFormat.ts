/**
 * `ade apple` text output: the window, install, lease and test formatters,
 * and the lease answer shapers the plan builder uses.
 *
 * Split from `cli.ts`, which keeps the plan builder and the formatter switch.
 * The import cycle rule of `cliMacDesktopFormat.ts` applies to `./cli`:
 *
 *   NEITHER FILE MAY USE THE OTHER'S IMPORTS AS A VALUE AT MODULE SCOPE.
 */
import { asString, isRecord, renderKeyValues, unwrapActionEnvelope } from "./cli";
import { describeAppleWindowOffScreen } from "../../desktop/src/main/services/ios/appleWindowLayout";

/** The answer inside an `ade apple lease` result, however it was wrapped. */
export function appleLeaseAnswer(result: unknown): unknown {
  let value = unwrapActionEnvelope(result);
  if (
    isRecord(value)
    && !["acquired", "released", "held"].some((key) => Object.prototype.hasOwnProperty.call(value, key))
    && isRecord(value.result)
  ) {
    value = unwrapActionEnvelope(value.result);
  }
  return value;
}

/** True when an `ade apple lease` answer says the lease was not granted. */
export function appleLeaseNotAcquired(result: unknown): boolean {
  const value = appleLeaseAnswer(result);
  return isRecord(value) && value.acquired === false;
}

/**
 * An `ade apple lease` answer, checked against an older brain (before
 * per-device, token-only turns; every current brain names the `device`).
 * Such a brain ignores `--device` and leases the lane's own device, and it
 * renews by holder name, so a second agent of one chat would be told "renewed"
 * and handed the first one's token. Neither is ever shown as a turn: the
 * shared one hides that token and exits 1.
 */
export function shapeAppleLeaseAnswer(result: unknown, sent: { askedDevice: boolean; tokenSent: boolean }): unknown {
  const value = appleLeaseAnswer(result);
  if (!isRecord(value) || Object.prototype.hasOwnProperty.call(value, "device")) return value;
  const upgrade = "Update the ADE brain on that machine (ade brain update, or update ADE.app) for per-device leases.";
  if (value.acquired === true && value.renewed === true && !sent.tokenSent) {
    const { token: _othersToken, ...rest } = value;
    return {
      ...rest,
      acquired: false,
      olderBrain: true,
      message: `This ADE brain is older: it renews a lease by holder name, so this call matched the turn of ${asString(value.holder) ?? "another agent"} `
        + "(another agent of this chat, or your own earlier call) instead of queueing. That turn is not yours; its token is not shown. "
        + `Pass a distinct --holder <name>, or renew your own with --token <t>. ${upgrade}`,
    };
  }
  if (sent.askedDevice) {
    return {
      ...value,
      ...(value.acquired === true ? { acquired: false } : {}),
      olderBrain: true,
      message: "This ADE brain is older and has one lease per lane: it ignored --device and answered for the lane's own device. "
        + (value.acquired === true && asString(value.token)
          ? `It gave you that lease; release it with ade apple lease release --token ${asString(value.token)}. `
          : "")
        + upgrade,
    };
  }
  return value;
}

/** `apple window`: where the front app's window is, and whether the layout landed. */
export function formatAppleWindow(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const frame = (raw: unknown) => {
    if (!isRecord(raw)) return null;
    const n = (field: unknown) => (typeof field === "number" ? Math.round(field) : "?");
    return `${n(raw.width)}x${n(raw.height)} at ${n(raw.x)},${n(raw.y)}`;
  };
  const screen = isRecord(result.screen) ? `${result.screen.width}x${result.screen.height}` : "?";
  const app = asString(result.appName) ?? asString(result.bundleId) ?? "the front app";
  const action = asString(result.action) ?? "status";
  const lines: string[] = [];
  if (action === "status") {
    const off = isRecord(result.offScreen) ? result.offScreen : null;
    const side = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
    const offText = off
      ? describeAppleWindowOffScreen({ left: side(off.left), top: side(off.top), right: side(off.right), bottom: side(off.bottom) })
      : "";
    lines.push(result.before
      ? `${app}'s window is ${frame(result.before)} on a ${screen} screen${offText ? `, partly off it (${offText})` : ""}.`
      : `${app} is not in a resizable window (an iPhone, or an iPad set to Full Screen Apps).`);
  } else if (result.applied === true) {
    lines.push(`${action}: ${app}'s window is now ${frame(result.after)} (was ${frame(result.before) ?? "?"}) on a ${screen} screen.`);
    if (asString(result.note)) lines.push(asString(result.note)!);
  } else {
    lines.push(`${action} did not land: ${asString(result.reason) ?? `the window is ${frame(result.after) ?? "unreadable"}`}`);
  }
  lines.push("", renderKeyValues("ADE Apple window", [
    ["action", action],
    ["applied", result.applied === true ? "yes" : "no"],
    ["app", result.bundleId],
    ["before", frame(result.before)],
    ["after", frame(result.after)],
    ["screen", screen],
    ["tolerance pt", result.tolerance],
    ["attempts", result.attempts],
    ["frame from", result.frameSource],
    ["device", result.deviceUdid],
  ]));
  return lines.join("\n");
}

/** `apple install`: which device has the app now, and whether it was built, installed and started. */
export function formatAppleInstall(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const name = asString(result.deviceName) ?? asString(result.deviceUdid) ?? "the device";
  const where = result.extra === true ? `${name} (an extra device)` : `${name} (the lane's device)`;
  const verb = result.built === true ? `Built (${asString(result.configuration) ?? "Debug"}) and installed` : "Installed the lane's last build of";
  const lines = [
    `${verb} ${asString(result.bundleId) ?? "the app"} on ${where}.`,
    result.launched === true
      ? `Started it${typeof result.pid === "number" ? ` (pid ${result.pid})` : ""}. Check it with: ade apple foreground --device ${asString(result.deviceUdid) ?? "<udid>"} --text`
      : `Start it with: ade apple relaunch --bundle-id ${asString(result.bundleId) ?? "<id>"} --device ${asString(result.deviceUdid) ?? "<udid>"} --text`,
    "",
    renderKeyValues("ADE Apple app install", [
      ["device", result.deviceName],
      ["udid", result.deviceUdid],
      ["extra", result.extra === true ? "yes" : "no"],
      ["bundle id", result.bundleId],
      ["configuration", result.configuration],
      ["built", result.built === true ? "yes" : "no"],
      ["launched", result.launched === true ? "yes" : "no"],
      ["app", result.appBundlePath],
    ]),
  ];
  return lines.join("\n");
}

/**
 * `apple lease`: the token to keep (it alone renews and releases), or who has
 * the device. "Held under your own name" is another agent of this chat, or a
 * turn of yours whose token was lost: the token, not the chat, is the turn.
 */
export function formatAppleLease(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const device = isRecord(result.device) ? result.device : {};
  const deviceName = asString(device.name) ?? (device.extra === true ? "the extra device" : "the lane's device");
  // At the start of a sentence; a device's own name is kept as it is.
  const DeviceName = asString(device.name) ?? (device.extra === true ? "The extra device" : "The lane's device");
  const deviceFlag = device.extra === true && asString(device.udid) ? ` --device ${asString(device.udid)}` : "";
  if (result.olderBrain === true) {
    return [asString(result.message) ?? "This ADE brain is older and does not support per-device lease turns.", "", renderKeyValues("ADE Apple device lease", [
      ["acquired", "no"],
      ["holder", result.holder ?? (isRecord(result.current) ? result.current.holder : null)],
    ])].join("\n");
  }
  if (typeof result.released === "boolean") {
    // `lease release`: which device was let go, or why nothing was.
    return result.released
      ? `Released the lease on ${deviceName}. The next agent in line, if any, has it now.`
      : asString(result.reason) ?? "Nothing was released: this token holds no lease (released already, lapsed, or not this lane's).";
  }
  if (typeof result.held === "boolean") {
    // `lease status`: who has it, never their token.
    const current = isRecord(result.current) ? result.current : {};
    return [
      result.held
        ? `${DeviceName} is leased to ${asString(current.holder) ?? "another holder"} until ${asString(current.expiresAt) ?? "?"}; ${String(result.queued ?? 0)} waiting.`
        : `${DeviceName} is free: nobody holds its lease.`,
      "",
      renderKeyValues("ADE Apple device lease", [
        ["held", result.held ? "yes" : "no"],
        ["holder", current.holder],
        ["since", current.acquiredAt],
        ["expires", current.expiresAt],
        ["queued", result.queued],
        ["device", device.udid],
      ]),
    ].join("\n");
  }
  if (result.acquired === true && result.renewed === true && !asString(result.token)) {
    // Renewed by holder name (an older CLI's call): the token stays with the turn's holder.
    return `Renewed the lease on ${deviceName} until ${asString(result.expiresAt) ?? "?"}, by holder name. Use the token your lease first printed to release it.`;
  }
  if (result.acquired === true) {
    const token = asString(result.token) ?? "<token>";
    return [
      `${result.renewed === true ? "Renewed" : "Got"} the lease on ${deviceName} until ${asString(result.expiresAt) ?? "?"}.`,
      `token: ${token}`,
      `Keep the token. Renew: ade apple lease${deviceFlag} --token ${token}. Release: ade apple lease release${deviceFlag} --token ${token}.`,
      "",
      renderKeyValues("ADE Apple device lease", [
        ["acquired", "yes"],
        ["renewed", result.renewed === true ? "yes" : "no"],
        ["holder", result.holder],
        ["token", token],
        ["expires", result.expiresAt],
        ["waited ms", result.waitedMs],
        ["device", device.udid],
      ]),
    ].join("\n");
  }
  const current = isRecord(result.current) ? result.current : {};
  const lines = [
    `${DeviceName} is leased to ${asString(current.holder) ?? "another holder"} until ${asString(current.expiresAt) ?? "?"}; ${
      typeof result.queued === "number" ? `${result.queued} waiting` : "others may be waiting"
    }.`,
  ];
  if (result.sameHolder === true) {
    lines.push("It is held under your own holder name: another agent of this chat has it, or it is your own turn and this call had no token. "
      + "Renew your own with --token <t>; otherwise wait for it (lease --wait <seconds>).");
  }
  lines.push("", renderKeyValues("ADE Apple device lease", [
    ["acquired", "no"],
    ["holder", current.holder],
    ["expires", current.expiresAt],
    ["queued", result.queued],
    ["device", device.udid],
  ]));
  return lines.join("\n");
}

/**
 * `apple test`: the counts, each failing test on its own line, then
 * xcodebuild's own summary lines as it printed them, and where the log and the
 * result bundle are. The default renderer squashed the summary into one line
 * cut at 96 characters.
 */
export function formatAppleTests(value: unknown): string {
  const result = isRecord(value) ? value : {};
  const count = (field: unknown) => (typeof field === "number" ? String(field) : "?");
  const passed = result.passed === true;
  const executed = typeof result.testsExecuted === "number" ? result.testsExecuted : null;
  const head = result.timedOut === true
    ? "Tests timed out."
    : passed
      ? "Tests passed."
      : executed === null ? "Tests failed (the build may not have finished)." : "Tests failed.";
  const counts = executed === null
    ? "No test totals in the log."
    : `${count(result.testsExecuted)} run, ${count(result.testsFailed)} failed, ${count(result.testsSkipped ?? 0)} skipped`
      + (typeof result.durationMs === "number" ? ` in ${Math.round(result.durationMs / 1000)} s` : "")
      + ".";
  const lines: string[] = [
    `${head} ${counts}`,
    `${asString(result.scheme) ?? "?"} on ${asString(result.deviceName) ?? "the lane's device"} (${asString(result.deviceUdid) ?? "?"}).`,
  ];
  const failures = Array.isArray(result.failures) ? result.failures.filter(isRecord) : [];
  if (failures.length) {
    lines.push("", `Failing tests (${failures.length}):`);
    for (const failure of failures) {
      const where = asString(failure.file)
        ? ` (${asString(failure.file)}${typeof failure.line === "number" ? `:${failure.line}` : ""})`
        : "";
      const message = (asString(failure.message) ?? "").split(/\r?\n/).filter(Boolean);
      lines.push(`- ${asString(failure.test) ?? "?"}${where}`);
      for (const each of message) if (each !== "failed") lines.push(`    ${each}`);
    }
  }
  const summary = asString(result.summary);
  if (summary?.trim()) lines.push("", "Summary:", summary.trimEnd());
  lines.push("");
  if (asString(result.logPath)) lines.push(`log: ${asString(result.logPath)}`);
  if (asString(result.resultBundlePath)) lines.push(`result bundle: ${asString(result.resultBundlePath)}`);
  return lines.join("\n");
}
