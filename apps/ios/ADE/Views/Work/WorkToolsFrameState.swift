import Foundation

/// What the "open tool" card should draw where the last captured frame goes.
///
/// A separate type because one of its cases is otherwise unreachable in the
/// app: a brain can advertise `workTools.getLaneState` without
/// `workTools.readObservationPreview` (the two are feature-detected apart, see
/// `SyncService.supportsWorkToolsObservationPreview`), and in that state the
/// lane state still names an observation the phone can never fetch. Deciding
/// this inside the view meant "frame is nil but an observation exists" fell to
/// the loading branch, so that host showed a spinner that could not finish.
enum WorkToolsFrameState: Equatable {
  case image
  case loading
  /// There is a frame on the Mac and no way to get it. Carries the sentence.
  case unavailable(String)
  case empty
}

/// The host cannot send bytes at all — it is missing the preview command.
/// Worded like the sheet's other absences: what is true, not what to do, since
/// the fix is to update ADE on the Mac and this sheet cannot say that usefully
/// about a version it is only inferring.
let workToolsFramesUnsupportedMessage = "Frames aren't available from this machine."

/// The host answered about this specific frame and had nothing to give.
let workToolsFrameUnreadableMessage = "Couldn't load the last frame."

/// Pure resolution of the four inputs the card has.
///
/// `loadedFramePath` is the path the currently held image was decoded from —
/// pass nil when there is no image, so a stale path can never claim a frame the
/// view does not have. `unreadableFramePath` is only ever set from a definitive
/// answer, never from a transport failure, so a timeout keeps the spinner and
/// retries rather than declaring the frame gone.
func workToolsFrameState(
  observationPath: String?,
  loadedFramePath: String?,
  unreadableFramePath: String?,
  supportsObservationPreview: Bool
) -> WorkToolsFrameState {
  guard let observationPath else { return .empty }
  if loadedFramePath == observationPath { return .image }
  guard supportsObservationPreview else { return .unavailable(workToolsFramesUnsupportedMessage) }
  if unreadableFramePath == observationPath { return .unavailable(workToolsFrameUnreadableMessage) }
  return .loading
}

/// Why there is no browser to show. The desktop distinguishes five cases
/// (`WorkToolsUnavailableReason`) and only one of them is "open ADE on your
/// Mac" — telling a user to open an app that is already open, because the read
/// failed, sends them chasing the wrong thing. An unknown or absent reason
/// falls back to the common case rather than inventing a diagnosis.
///
/// Keep these sentences byte-identical to `workToolsUnavailableMessage` in
/// `apps/desktop/src/shared/types/workTools.ts`: this switch cannot import it,
/// so a reason worded there and not here silently reads as the default. It is a
/// free function rather than a view-private computed property so the parity
/// test can hold the two wordings against each other.
func workToolsBrowserUnavailableMessage(_ reason: String?) -> String {
  switch reason {
  case "unsupported":
    return "The browser isn't available on this machine."
  case "error":
    return "Couldn't read the browser's state."
  case "desktop_not_attached_for_project":
    // Distinct from the default on purpose: ADE Desktop *is* running, it just
    // doesn't have this project open, so "open ADE on your Mac" would send the
    // user to look at an app that is already in front of them.
    return "ADE Desktop doesn't have this project open. Open it on your Mac to see its tabs."
  case "browser_pane_not_opened":
    // Narrower still: the project IS open on the desktop, only the Browser pane
    // is unused, so the instruction is one click — not "open the project",
    // which would be a lie about something already in front of them.
    return "Open the Browser tool on the desktop to see tabs here."
  default:
    return "The browser runs in ADE Desktop. Open ADE on your Mac to see its tabs."
  }
}

/// Who has the lane's screen, in the sheet's one line.
///
/// Worded identically to the desktop's takeover strip so the two surfaces
/// cannot describe one lease two ways. An unknown holder from a newer host
/// falls back to the neutral sentence rather than guessing which side it is.
func macDesktopLeaseLine(_ lease: WorkToolsMacDesktopLease?) -> String {
  guard let lease else { return "Nobody has taken control." }
  let label = lease.holderLabel.flatMap { $0.isEmpty ? nil : " · \($0)" } ?? ""
  switch lease.holder {
  case "user": return "You have control\(label)"
  case "agent": return "Agent driving\(label)"
  default: return "Nobody has taken control."
  }
}
