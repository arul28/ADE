/**
 * The sentence a Mac Desktop failure should show a person.
 *
 * Two layers add machine-readable noise to every error that crosses the
 * daemon boundary, and neither is meant for a panel:
 *
 *   1. The service tags its errors `MAC_DESKTOP_NO_DISPLAY: …` so the CLI can
 *      look up a recovery hint from a flattened `message` string.
 *   2. Electron wraps anything thrown inside an IPC handler as
 *      `Error invoking remote method 'ade.localRuntime.callAction': Error: …`.
 *
 * Both are useful in a log and useless in a chip that is 180px wide, so this
 * is the one place that peels them off. Pure and string-in/string-out: the
 * renderer has no business deciding what a code means, only that the person
 * reading the panel should not have to.
 *
 * The third kind of noise is the lane id. Service messages name the lane to be
 * unambiguous in a transcript (`Lane <uuid> is not recording its desktop.`),
 * and a UUID is not something a person can act on. Callers that know the lane
 * pass its id here; the id becomes the lane's name when one is known and is
 * dropped (with the sentence tidied) otherwise.
 */

import type { WindowsDesktopOperationKind } from "../../../shared/types/macDesktop";

/** `MAC_DESKTOP_NO_DISPLAY: `, and the driver's lowercase `window_not_ready: `. */
const CODE_PREFIX = /^(?:(?:MAC|WINDOWS)_DESKTOP_[A-Z0-9_]+|[a-z][a-z0-9_]*(?:_[a-z0-9_]+)+):\s*/;

/** Electron's IPC wrapper, however many `Error:` hops it stacked up. */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*/;
const ERROR_LABEL = /^(?:[A-Za-z]*Error):\s*/;

export type MacDesktopErrorTextOptions = {
  /** The lane the failure is about, when the caller knows it. */
  laneId?: string | null;
  /** The lane's own name, when the caller has one. */
  laneName?: string | null;
  /** The machine the lane's runtime lives on, when the caller knows it. */
  machineName?: string | null;
  /** That machine's ADE version, when the caller knows it. */
  machineVersion?: string | null;
};

/** `The desktop driver did not answer windows.setup in 160000ms.` */
const DRIVER_TIMEOUT = /^The desktop driver did not answer \S+ in \d+ms\.?$/i;
/** `The desktop driver stopped (code 1).` */
const DRIVER_STOPPED = /^The desktop driver stopped \([^)]*\)\.?$/i;

const MAC_DESKTOP_MISSING_DOMAIN = /Domain ['"]mac_desktop['"] is unavailable in this runtime/i;

/**
 * The one error that means "update ADE on that machine".
 *
 * A brain older than this app has no `mac_desktop` action domain, so every call
 * comes back as an RPC refusal whose message is `Domain 'mac_desktop' is
 * unavailable in this runtime.` — sometimes behind the remote client's own
 * `Remote ADE service method ade/actions/call failed (code -32602): ` prefix.
 * That sentence names an action domain, which is a fact about the protocol and
 * not about the screen the user just opened — so it becomes a sentence naming
 * the machine and the version, which is the one thing they can act on.
 */
function macDesktopMissingDomainText(options?: MacDesktopErrorTextOptions): string {
  const machine = options?.machineName?.trim() || "That machine";
  const version = options?.machineVersion?.trim();
  // Not "an older ADE". The host is whatever build owns that lane, and it can
  // easily be NEWER than the one reading this: a released 1.2.76 has no Mac
  // Desktop, while an unreleased 1.2.75-alpha built from the feature branch
  // does. Saying "older" states a fact the code has not checked and that was
  // false the first time a person hit this. The version, when known, is the
  // fact worth printing; the remedy stays the same either way.
  return version
    ? `${machine} runs ADE ${version}, which has no Mac Desktop. Update ADE there.`
    : `${machine} runs an ADE without Mac Desktop. Update ADE there.`;
}

/**
 * Replaces a lane id with the lane's name, or drops it.
 *
 * `Lane <id> is not recording its desktop.` becomes
 * `Lane docs-fix is not recording its desktop.` when the name is known, and
 * `This lane is not recording its desktop.` when it is not — the leading
 * `Lane` the id leaves behind is what keeps the sentence a sentence. A bare id
 * elsewhere in the message is replaced by the name or removed.
 */
export function stripMacDesktopLaneId(
  text: string,
  laneId: string | null | undefined,
  laneName: string | null | undefined,
): string {
  const id = laneId?.trim();
  if (!id || !text.includes(id)) return text;
  const name = laneName?.trim() || null;
  let next = text.split(id).join(name ?? "");
  if (!name) {
    next = next
      .replace(/(^|[.!?]\s+)Lane\s+/g, "$1This lane ")
      .replace(/\bLane\s+(?=[.,;:!?]|$)/g, "This lane");
  }
  return next.replace(/\s{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
}

export function macDesktopErrorText(
  raw: string | null | undefined,
  options?: MacDesktopErrorTextOptions,
): string | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text.length) return null;
  // Order matters: the wrapper sits outside the `Error:` labels, which sit
  // outside the service's own code prefix.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text.replace(IPC_WRAPPER, "").replace(ERROR_LABEL, "").replace(CODE_PREFIX, "").trim();
    if (text === before) break;
  }
  // A brain with no domain at all is the one failure the panel answers with the
  // machine's own name and version rather than with the refusal itself.
  if (MAC_DESKTOP_MISSING_DOMAIN.test(text)) return macDesktopMissingDomainText(options);
  // The driver client's own sentences name an op and a millisecond count,
  // which mean nothing in a pane. Said as what happened to the helper.
  if (DRIVER_TIMEOUT.test(text)) return "The desktop helper stopped responding, so ADE restarted it.";
  if (DRIVER_STOPPED.test(text)) return "The desktop helper stopped unexpectedly. ADE is restarting it.";
  if (options?.laneId) text = stripMacDesktopLaneId(text, options.laneId, options.laneName);
  return text.length ? text : null;
}

/** The `CODE` an error text carries, after Electron's wrapper. */
export function macDesktopErrorCode(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let text = String(raw).trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const before = text;
    text = text.replace(IPC_WRAPPER, "").replace(ERROR_LABEL, "").trim();
    if (text === before) break;
  }
  const match = /^((?:MAC|WINDOWS)_DESKTOP_[A-Z0-9_]+):/.exec(text);
  return match ? match[1]! : null;
}

/** A Windows step that can fail: the host's own operations, plus take over and the shared desktop. */
export type WindowsDesktopOperationFailureKind = WindowsDesktopOperationKind | "takeover" | "shared";

/**
 * What a failed Windows sign-in, setup or start should say: a title naming
 * what did not happen, and a detail that says why and whether anything was
 * saved. Every Windows code the driver can return during these steps has its
 * own sentence; anything else keeps the host's own words.
 */
export function windowsDesktopOperationFailureText(
  kind: WindowsDesktopOperationFailureKind,
  raw: string | null | undefined,
  options?: MacDesktopErrorTextOptions & { passwordSaved?: boolean },
): { title: string; detail: string } {
  const code = macDesktopErrorCode(raw);
  const text = macDesktopErrorText(raw, options) ?? "";
  const savingPassword = kind === "save_password";
  const title = {
    setup: "Setup didn't finish",
    save_password: "Your password wasn't saved",
    forget_password: "The saved password wasn't removed",
    start_private: "The private screen didn't start",
    takeover: "The private screen didn't start",
    shared: "Your main desktop couldn't be used",
  }[kind];
  const nothingSaved = savingPassword ? " Nothing was saved." : "";
  let detail: string;
  switch (code) {
    case "WINDOWS_DESKTOP_WRONG_PASSWORD":
      detail = savingPassword
        ? "Windows didn't accept that password. Nothing was saved. Use your Windows account password, not your PIN."
        : options?.passwordSaved === false
          ? "Windows didn't accept the saved password, so ADE forgot it. Save your current Windows password again."
          : "Windows didn't accept the password. Use your Windows account password, not your PIN.";
      break;
    case "WINDOWS_DESKTOP_CANCELLED":
      detail = kind === "setup"
        ? "The Windows admin prompt was closed, so nothing changed on this PC."
        : `The sign-in window was closed.${nothingSaved}`;
      break;
    case "WINDOWS_DESKTOP_SIGN_IN_FAILED":
      detail = `Windows couldn't sign in to the private session.${nothingSaved}${text ? ` ${text}` : ""}`;
      break;
    case "WINDOWS_DESKTOP_LOCKED":
      detail = `This PC is locked.${nothingSaved} Unlock it, then try again.`;
      break;
    case "WINDOWS_DESKTOP_HELD":
      detail = `${text || "Another lane is using the private screen."}${nothingSaved} Password checks need the private screen to be free.`;
      break;
    case "WINDOWS_DESKTOP_NOT_CONSOLE_SESSION":
    case "WINDOWS_DESKTOP_SETUP_REQUIRED":
    case "WINDOWS_DESKTOP_CONSENT_REQUIRED":
      detail = `${text}${nothingSaved}`;
      break;
    case "MAC_DESKTOP_DRIVER_UNAVAILABLE":
      detail = `${text || "The desktop helper stopped responding."}${nothingSaved} You can try again now.`;
      break;
    default:
      detail = `${text || "Windows didn't say why."}${nothingSaved}`;
  }
  return { title, detail: detail.trim() };
}
