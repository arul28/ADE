/**
 * What a lane's screen is, in words: the product name, the seat kind, the seat
 * sentences, and the next step when something blocks.
 *
 * Logic only; the types stay in `types/macDesktop.ts`, which re-exports
 * everything here so existing imports keep working. Every text surface (the
 * status JSON's `seat`, the CLI, the TUI, the RPC refusals) reads this one
 * module, so they cannot say different things.
 */

import type {
  DesktopSeatKind,
  DesktopSeatSummary,
  MacDesktopDisplayMode,
  MacDesktopStatus,
  WindowsDesktopPrivateUnavailableReason,
  WindowsDesktopSeatMode,
} from "./types/macDesktop";

/** The product name a host's lane screen goes by. */
export function desktopProductName(platform: string | null | undefined): string {
  return platform === "win32" ? "Windows Desktop" : "Mac Desktop";
}

/**
 * The one rule for {@link DesktopSeatKind}. Any non-Windows host is `mac`. On
 * Windows the display's own `seatMode` wins; when it is absent (an older
 * runtime), the host's seat mode or an `offscreen-region` display means shared.
 */
export function desktopSeatKind(input: {
  platform: string | null | undefined;
  display?: { seatMode?: WindowsDesktopSeatMode | null; mode?: MacDesktopDisplayMode | null } | null;
  windowsDesktop?: { seatMode?: WindowsDesktopSeatMode | null } | null;
}): DesktopSeatKind {
  if (input.platform !== "win32") return "mac";
  const displaySeat = input.display?.seatMode ?? null;
  if (displaySeat) return displaySeat === "shared" ? "windows-shared" : "windows-private";
  if (input.windowsDesktop?.seatMode === "shared" || input.display?.mode === "offscreen-region") {
    return "windows-shared";
  }
  return "windows-private";
}

export const WINDOWS_DESKTOP_PRIVATE_SEAT_DESCRIPTION =
  "private — a separate Windows session of the user's account. It shows the same wallpaper and taskbar, but it has its own pointer and keyboard and is NOT the user's screen.";
export const WINDOWS_DESKTOP_SHARED_SEAT_DESCRIPTION =
  "shared — the user's main Windows desktop. Actions take over the window the user is using.";

/**
 * What an agent does next when the private Windows screen is out, or when the
 * main desktop needs the user's consent. One table: the status `next` line,
 * the CLI error hints and the RPC refusals all read it, and service errors
 * state only the fact, so no surface prints the same advice twice.
 */
export const WINDOWS_DESKTOP_NEXT_STEP: Record<WindowsDesktopPrivateUnavailableReason | "consent", string> = {
  setup_required:
    "Ask the user to set up Windows Desktop once (the setup card in the Windows Desktop pane, or `ade screen setup --allow-prompt` from a trusted ADE client). An agent cannot do this step.",
  locked: "Ask the user to unlock the PC, then retry the same command (ade screen start --text when the lane has no screen yet).",
  held:
    "Ask the user to take over the private screen (Take over in the Windows Desktop pane), or ask for their main desktop: ade screen start --shared --reason \"<what for>\" --text",
  not_console_session:
    "The private screen needs ADE's brain in the PC's console session, and it is running in another one (Remote Desktop or SSH). Ask the user to sign in at the PC, or ask for the main desktop instead: ade screen start --shared --reason \"<what for>\" --text",
  unsupported_platform:
    "This Windows edition has no private screens. Ask for the main desktop instead: ade screen start --shared --reason \"<what for>\" --text",
  consent:
    "Only the user can allow the main desktop. Ask in this chat with: ade screen start --shared --reason \"<what for>\" --text",
};

/**
 * Why the private screen is unavailable, as one short sentence.
 *
 * One map, read by the pane and the ask card, so the two describe the same code
 * the same way. An unknown reason falls through to a generic sentence.
 */
export function windowsDesktopPrivateUnavailableMessage(
  reason: WindowsDesktopPrivateUnavailableReason | string | null | undefined,
): string {
  switch (reason) {
    case "unsupported_platform":
      return "Private Windows screens need Windows Pro, Enterprise, or Education.";
    case "not_console_session":
      return "ADE is running in a Remote Desktop or other session, not on this PC's console, so it cannot start a private screen.";
    case "setup_required":
      return "Private screens are not set up on this PC yet.";
    case "held":
      return "Another lane is using the private screen.";
    case "locked":
      return "This PC is locked.";
    default:
      return "The private Windows screen is not available.";
  }
}

/**
 * The status summary every text surface leads with.
 *
 * Pure, and in the shared contract, so the service attaches it and an older
 * runtime's reply can still be summarized by the CLI the same way.
 */
export function describeDesktopSeat(
  status: Pick<MacDesktopStatus, "supported" | "display" | "windowsDesktop"> & {
    /** A host platform string; a reply from an older runtime carries it as plain text. */
    platform: string | null | undefined;
    displayMode?: MacDesktopDisplayMode;
  },
): DesktopSeatSummary {
  const product = desktopProductName(status.platform);
  const display = status.display ?? null;
  if (status.platform !== "win32") {
    const mode = display?.mode ?? null;
    return {
      product,
      seat: mode === "virtual" ? "virtual-display" : mode === "offscreen-region" ? "offscreen-region" : null,
      seatDescription: !display
        ? null
        : mode === "offscreen-region"
          ? "off-screen region of the user's main display (this Mac has no virtual display)"
          : "a private virtual display on this Mac; the user's screen and pointer are not touched by accessibility actions",
      realInputNeedsLease: true,
      realInputSentence: display ? "needs the user's lease (ade screen lease)" : null,
      privateAvailable: null,
      privateUnavailable: null,
      heldBy: null,
      setupDone: null,
      passwordSaved: null,
      locked: null,
      nextStep: !status.supported
        ? null
        : !display ? "ade screen start --text" : null,
    };
  }
  const windows = status.windowsDesktop ?? null;
  const seat: WindowsDesktopSeatMode | null = display
    ? desktopSeatKind({ platform: status.platform, display, windowsDesktop: windows }) === "windows-shared" ? "shared" : "private"
    : null;
  const setupDone = windows ? windows.childSessionsEnabled && windows.remoteDesktopAllowed : null;
  const heldBy = windows?.heldByLaneId
    ? (windows.heldByLaneName ? `${windows.heldByLaneName} (${windows.heldByLaneId})` : windows.heldByLaneId)
    : null;
  const nextStep = (() => {
    if (!status.supported) return null;
    if (display) return null;
    const reason = windows?.privateUnavailableReason ?? null;
    if (reason === "held") return `Lane ${heldBy ?? "another lane"} holds the private screen. ${WINDOWS_DESKTOP_NEXT_STEP.held}`;
    if (reason) return WINDOWS_DESKTOP_NEXT_STEP[reason];
    return windows && windows.passwordSaved === false
      ? "ade screen start --text (Windows asks the user to sign in on the PC; ask them to save their password in the Windows Desktop pane so later starts are automatic)"
      : "ade screen start --text";
  })();
  return {
    product,
    seat,
    seatDescription: seat === "shared"
      ? WINDOWS_DESKTOP_SHARED_SEAT_DESCRIPTION
      : seat === "private"
        ? WINDOWS_DESKTOP_PRIVATE_SEAT_DESCRIPTION
        : null,
    realInputNeedsLease: seat === "shared",
    realInputSentence: seat === "shared"
      ? "taken for you under the user's shared-seat consent; one shared lane at a time"
      : seat === "private"
        ? "allowed — no lease needed on a private seat"
        : null,
    privateAvailable: windows ? windows.privateAvailable : null,
    privateUnavailable: windows?.privateUnavailableReason
      ? windowsDesktopPrivateUnavailableMessage(windows.privateUnavailableReason)
      : null,
    heldBy,
    setupDone,
    passwordSaved: windows ? windows.passwordSaved : null,
    locked: windows ? windows.locked : null,
    nextStep,
  };
}
