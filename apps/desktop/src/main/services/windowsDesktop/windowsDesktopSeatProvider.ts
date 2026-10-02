/**
 * The Windows seat backend: the private child session and the shared desktop.
 *
 * A sibling of `macDesktop/macDesktopSeatProvider.ts`. Everything the service
 * and the Mac helper already share — lifecycle, ownership, the lease, proof,
 * streaming — is unchanged; this file adds only the two things Windows has
 * that macOS does not: the `windows.status` / `windows.setup` ops and the
 * `seatMode` + consent fields on `display.create`.
 *
 * The private create is the one call that can take a long time: the helper
 * raises the interactive Windows sign-in prompt (a native saved-password flow,
 * decided 2026-09-30) and the call resolves only when that prompt is answered
 * or refused. `PRIVATE_SIGN_IN_TIMEOUT_MS` is the ceiling the task fixed at
 * 160 seconds, so a helper that never answers cannot wedge `start` forever.
 */

import {
  MAC_DESKTOP_DRIVER_OPS,
  type MacDesktopDriverClient,
} from "../macDesktop/macDesktopDriverClient";
import {
  asNullableString,
  asRecord,
  createSeatProvider,
  type DesktopSeatAdapter,
  type SeatRequester,
} from "../macDesktop/macDesktopSeatProvider";
import { resolveWindowsDesktopDriverBinary } from "../native/nativeHelperPaths";
import { createWindowsDesktopDriverClient } from "./windowsDesktopDriverClient";
import type { Logger } from "../logging/logger";
import type { MacDesktopDriverHealth } from "../../../shared/types/macDesktop";
import {
  WINDOWS_DESKTOP_WINDOWS_ONLY_MESSAGE,
  macDesktopDisplayName,
  type WindowsDesktopPrivateUnavailableReason,
  type WindowsDesktopSeatMode,
  type WindowsDesktopSetupArgs,
  type WindowsDesktopSetupResult,
  type WindowsDesktopStatus,
  type WindowsDesktopHostState,
} from "../../../shared/types/macDesktop";

/**
 * How long a private `display.create` waits for the interactive Windows sign-in
 * (120s for the user to type a password) plus the child pipe connect (30s),
 * with margin. Past it the pane shows the sign-in failed card and the agent can
 * retry rather than hang forever.
 */
export const PRIVATE_SIGN_IN_TIMEOUT_MS = 160_000;

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : null;
}

function asSeatMode(value: unknown): WindowsDesktopSeatMode | null {
  return value === "private" || value === "shared" ? value : null;
}

const WINDOWS_STATES: ReadonlySet<string> = new Set<WindowsDesktopHostState>([
  "unavailable",
  "setup_required",
  "not_console_session",
  "ready",
  "signing_in",
  "locked",
  "held",
  "shared",
  "unknown",
]);

function asWindowsState(value: unknown): WindowsDesktopHostState | null {
  return typeof value === "string" && WINDOWS_STATES.has(value)
    ? value as WindowsDesktopHostState
    : null;
}

/**
 * The state to use when the driver omitted one (or named one this build does
 * not know): fall back to the booleans so an older helper still drives a card.
 */
function deriveWindowsState(record: Record<string, unknown>, onConsole: boolean): WindowsDesktopHostState {
  if (!onConsole) return "not_console_session";
  if (!asBoolean(record.childSessionsEnabled) || !asBoolean(record.remoteDesktopAllowed)) return "setup_required";
  if (asBoolean(record.locked)) return "locked";
  if (asNullableString(record.holderLaneId)) return "held";
  return "ready";
}

function privateUnavailableFor(state: WindowsDesktopHostState): WindowsDesktopPrivateUnavailableReason | null {
  switch (state) {
    case "ready":
      return null;
    case "unavailable":
      return "unsupported_platform";
    case "not_console_session":
      return "not_console_session";
    case "setup_required":
      return "setup_required";
    case "locked":
      return "locked";
    case "held":
      return "held";
    default:
      // `signing_in`, `shared` and `unknown` are not a "private is refused"
      // state to explain; the card shows the state itself.
      return null;
  }
}

/**
 * The `ping` / `windows.status` payload, normalized once.
 *
 * The helper answers the same shape from both ops and wraps it under
 * `windowsDesktop` on `ping`; a bare status object is accepted too so the two
 * ops cannot drift into two readers. `privateAvailable` and
 * `privateUnavailableReason` are derived from `state` here rather than trusted
 * from the wire, so the cards key off one boolean and one code.
 */
export function asWindowsDesktopStatus(raw: unknown): WindowsDesktopStatus {
  const record = asRecord(asRecord(raw).windowsDesktop ?? raw);
  const onConsole = asBoolean(record.inConsoleSession ?? record.hostIsConsoleSession, true);
  const state = asWindowsState(record.state) ?? deriveWindowsState(record, onConsole);
  return {
    state,
    locked: asBoolean(record.locked),
    childSessionsEnabled: asBoolean(record.childSessionsEnabled),
    remoteDesktopAllowed: asBoolean(record.remoteDesktopAllowed),
    passwordSaved: asBoolean(record.passwordSaved),
    ...(typeof record.signInWaiting === "boolean" ? { signInWaiting: record.signInWaiting } : {}),
    consoleSessionId: asNullableNumber(record.consoleSessionId),
    driverSessionId: asNullableNumber(record.sessionId ?? record.driverSessionId),
    hostIsConsoleSession: onConsole,
    childSessionId: asNullableNumber(record.childSessionId),
    edition: asNullableString(record.edition),
    heldByLaneId: asNullableString(record.holderLaneId ?? record.heldByLaneId),
    heldByLaneName: asNullableString(record.heldByLaneName),
    seatMode: asSeatMode(record.seatMode),
    privateAvailable: state === "ready",
    privateUnavailableReason: privateUnavailableFor(state),
  };
}

function asSetupResult(raw: unknown, fallbackStatus: WindowsDesktopStatus): WindowsDesktopSetupResult {
  const record = asRecord(raw);
  const status = record.status && typeof record.status === "object"
    ? asWindowsDesktopStatus(record.status)
    : asWindowsDesktopStatus(record.windowsDesktop ?? fallbackStatus);
  return {
    requiresAdmin: asBoolean(record.requiresAdmin),
    status,
  };
}

/** The `windows.status` and `windows.setup` op hooks, bound to one requester. */
function windowsSeatHooks(): {
  status: (request: SeatRequester) => Promise<WindowsDesktopStatus>;
  setup: (request: SeatRequester, args: WindowsDesktopSetupArgs) => Promise<WindowsDesktopSetupResult>;
} {
  let lastStatus: WindowsDesktopStatus = asWindowsDesktopStatus({});
  return {
    async status(request) {
      lastStatus = asWindowsDesktopStatus(await request(MAC_DESKTOP_DRIVER_OPS.windowsStatus, {}));
      return lastStatus;
    },
    async setup(request, args) {
      const reply = asRecord(
        await request(MAC_DESKTOP_DRIVER_OPS.setupWindows, { allowPrompt: args.allowPrompt, savePassword: args.savePassword, forgetPassword: args.forgetPassword }, { timeoutMs: PRIVATE_SIGN_IN_TIMEOUT_MS }),
      );
      return asSetupResult(reply, lastStatus);
    },
  };
}

/**
 * The Windows provider. A private `display.create` is given the long sign-in
 * timeout; a shared one is not, because the driver refuses it synchronously
 * without consent and parking needs no sign-in.
 */
export function createWindowsSeatProvider(client: MacDesktopDriverClient): ReturnType<typeof createSeatProvider> {
  return createSeatProvider(client, {
    id: "windows-child-session",
    createArgs: (args) => ({
      seatMode: args.seatMode,
      ...(args.sharedDesktopConsent ? { sharedDesktopConsent: true } : {}),
    }),
    // A private create waits on the interactive Windows sign-in prompt; a
    // shared create is refused synchronously without consent and needs none.
    createTimeoutMs: (args) => (args.seatMode === "private" ? PRIVATE_SIGN_IN_TIMEOUT_MS : undefined),
    windows: windowsSeatHooks(),
  });
}

/**
 * The Windows `DesktopSeatAdapter`, for the service's `seat` dep.
 *
 * `adeHome` is the actual ADE home this brain runs against; the helper's host
 * mode takes it as `--ade-home` so the child launcher it writes lands beside
 * the same runtime the console session uses.
 */
export function createWindowsDesktopSeatAdapter(args: {
  logger: Logger;
  adeHome: string;
}): DesktopSeatAdapter {
  return {
    id: "windows-child-session",
    platform: "win32",
    unsupportedMessage: WINDOWS_DESKTOP_WINDOWS_ONLY_MESSAGE,
    unsupportedTitle: "Windows Desktop needs a Windows host",
    driverLabel: "Windows Desktop",
    resolveExecutablePath: () => resolveWindowsDesktopDriverBinary({ platform: "win32", logger: args.logger }),
    createProvider: (client) => createWindowsSeatProvider(client),
    createDriverClient: (clientArgs: {
      logger: Logger;
      platform: NodeJS.Platform;
      onHealthChanged: (health: MacDesktopDriverHealth) => void;
      onDriverLost: (reason: string) => void;
    }) => createWindowsDesktopDriverClient({ ...clientArgs, adeHome: args.adeHome }),
    // Windows has no Screen Recording / Accessibility grants; the service
    // reports both as granted and never probes or prompts.
    permissionsSupported: false,
    displayName: macDesktopDisplayName,
  };
}
