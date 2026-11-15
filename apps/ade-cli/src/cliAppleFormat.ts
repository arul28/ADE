/**
 * `ade apple` text output: the window, install, lease, test, device start,
 * stop and delete formatters, the lease answer shapers and the element-miss
 * exit code the plan builder uses.
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

/** "Made the Xcode project from apps/Demo/project.yml with XcodeGen." for a build that ran XcodeGen first; null otherwise. */
export function xcodeGenNote(value: unknown): string | null {
  const folders = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  if (!folders.length) return null;
  const specs = folders.map((folder) => (folder === "." ? "project.yml" : `${folder.replace(/\\/g, "/")}/project.yml`));
  return `Made the Xcode project from ${specs.join(", ")} with XcodeGen.`;
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
  const generated = xcodeGenNote(result.generatedXcodeProjects);
  if (generated) lines.unshift(generated);
  return lines.join("\n");
}

/*
 * The lease sentences `ade apple lease` and `ade android lease` share. Each
 * caller passes its device's name (`deviceName` in a sentence, `DeviceName`
 * at its start) and, for a grant, its own renew and release commands.
 */

/** `lease release`: which device was let go, or why nothing was. */
export function leaseReleasedLine(result: Record<string, unknown>, deviceName: string): string {
  return result.released === true
    ? `Released the lease on ${deviceName}. The next agent in line, if any, has it now.`
    : asString(result.reason) ?? "Nothing was released: this token holds no lease (released already, lapsed, or not this lane's).";
}

/** `lease status`: who has the device, never their token. */
export function leaseHeldLine(result: Record<string, unknown>, DeviceName: string): string {
  const current = isRecord(result.current) ? result.current : {};
  return result.held === true
    ? `${DeviceName} is leased to ${asString(current.holder) ?? "another holder"} until ${asString(current.expiresAt) ?? "?"}; ${String(result.queued ?? 0)} waiting.`
    : `${DeviceName} is free: nobody holds its lease.`;
}

/** A granted lease: until when, the token, and the commands that renew and release it. */
export function leaseAcquiredLines(
  result: Record<string, unknown>,
  deviceName: string,
  commands: { renew: string; release: string },
): string[] {
  const token = asString(result.token) ?? "<token>";
  return [
    `${result.renewed === true ? "Renewed" : "Got"} the lease on ${deviceName} until ${asString(result.expiresAt) ?? "?"}.`,
    `token: ${token}`,
    `Keep the token. Renew: ${commands.renew} --token ${token}. Release: ${commands.release} --token ${token}.`,
  ];
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
  if (typeof result.released === "boolean") return leaseReleasedLine(result, deviceName);
  if (typeof result.held === "boolean") {
    // `lease status`: who has it, never their token.
    const current = isRecord(result.current) ? result.current : {};
    return [
      leaseHeldLine(result, DeviceName),
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
      ...leaseAcquiredLines(result, deviceName, { renew: `ade apple lease${deviceFlag}`, release: `ade apple lease release${deviceFlag}` }),
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
  const generated = xcodeGenNote(result.generatedXcodeProjects);
  const lines: string[] = [
    ...(generated ? [generated] : []),
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

/** `device-delete`: which device went, or that the lane had none. */
export function formatAppleDeviceDelete(value: unknown): string {
  // An ADE from before the answer named the device sends nothing back.
  if (!isRecord(value)) return "Done. Run ade apple device-list --text to see the devices this lane holds now.";
  const deleted = isRecord(value.deleted) ? value.deleted : null;
  if (!deleted) {
    const notFound = asString(value.notFound);
    return notFound
      ? `This lane holds no device ${notFound}, so nothing was deleted. ade apple device-list --text shows the ones it holds.`
      : "This lane had no Apple device, so nothing was deleted.";
  }
  const name = asString(deleted.name) ?? asString(deleted.udid) ?? "The device";
  const summary = value.detached === true
    ? `Released ${name} from this lane; the user attached it, so the simulator stays installed.`
    : deleted.extra === true
    ? `Deleted the extra device ${name}; the lane's own device is unchanged.`
    : `Deleted ${name}, this lane's device; the lane has no device now. ade apple start gives it a new one.`;
  return [
    summary,
    "",
    renderKeyValues("ADE Apple device delete", [
      ["udid", deleted.udid],
      ["device", deleted.name],
      ["extra", deleted.extra === true],
    ]),
  ].join("\n");
}

/**
 * `ade apple start --text`: which device the lane drives and whether ADE made
 * it (the Mac's sentence, `note`), then the live view. An older Mac sends no
 * note; its answer names the device only.
 */
export function formatAppleDeviceStart(value: unknown): string {
  const record = unwrapActionEnvelope(value);
  const status = isRecord(record) ? record : {};
  const device = asString(status.deviceUdid);
  const note = asString(status.note) ?? (device ? `This lane's simulator (${device}) is booted.` : "Started.");
  const lastError = asString(status.lastError);
  let live: string | null = null;
  if (status.running === true) live = `Live view: ${asString(status.backend) ?? "on"}.`;
  else if (lastError) live = `Live view: ${lastError}`;
  return [note, live].filter(Boolean).join("\n");
}

/** `ade apple stop --text`: powered off, and what happens to the device (it stays registered there). */
export function formatAppleDeviceStop(value: unknown): string {
  const record = unwrapActionEnvelope(value);
  const result = isRecord(record) ? record : {};
  const udid = asString(result.udid);
  if (!udid) return "This lane has no Apple device, so nothing was powered off.";
  const power = result.poweredOff === true ? "powered off" : "off";
  const kept = result.stillRegistered === true ? " and stays this lane's device: the next ade apple start boots it again" : "";
  return asString(result.note) ?? `${udid} is ${power}${kept}.`;
}

/** An Apple element wait or assert that missed (`ok: false`) exits 1. */
export function appleElementMissExitCode(result: unknown): number {
  const value = unwrapActionEnvelope(result);
  return isRecord(value) && value.ok === false ? 1 : 0;
}
