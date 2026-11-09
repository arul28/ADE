import SwiftUI
import UIKit

// The Mac Desktop viewer's pure rules (host error copy, the phone's
// orientation during Control) and its fixture seam. The view is
// `MacDesktopViewer.swift`.

// MARK: - Pure helpers

/// Turns host errors into phone copy. Mac Desktop driver errors cross the
/// runtime boundary as `CODE: message`, while sync commands can also carry the
/// code separately in `ADEErrorCode`. Strip either form before displaying it.
func macDesktopVisibleMessage(_ rawMessage: String?, code explicitCode: String? = nil) -> String? {
  guard let message = rawMessage?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty else {
    return nil
  }

  let prefixedError: (code: String, message: String)? = {
    guard let colon = message.firstIndex(of: ":") else { return nil }
    let candidate = String(message[..<colon])
    guard
      !candidate.isEmpty,
      candidate.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }),
      candidate.contains("_") || candidate == candidate.uppercased()
    else { return nil }
    let detail = String(message[message.index(after: colon)...])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return (candidate, detail)
  }()
  let standaloneCode = message.contains("_")
    && message.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" })
    ? message
    : nil
  let code = explicitCode?.trimmingCharacters(in: .whitespacesAndNewlines)
  let resolvedCode = (code?.isEmpty == false ? code : nil) ?? prefixedError?.code ?? standaloneCode

  switch resolvedCode?.lowercased() {
  case "mac_desktop_no_window":
    return "No windows are open on this desktop yet."
  case "lane_stopping":
    return "This lane is stopping. Try again when it is ready."
  default:
    if let prefixedError {
      return prefixedError.message.isEmpty ? "The Mac Desktop request failed. Try again." : prefixedError.message
    }
    if standaloneCode != nil { return "The Mac Desktop request failed. Try again." }
    return message
  }
}

/// The phone's Stop for a Windows screen, in the desktop's words
/// (`STOP_CONFIRM_COPY` in `MacDesktopStopConfirm.tsx`), per seat.
let windowsPrivateStopAction = "Stop the private Windows screen"
let windowsPrivateStopConsequence = "The private screen signs out, and apps this lane opened there close, even with unsaved work."
let windowsSharedStopAction = "Stop using your main Windows desktop"
let windowsSharedStopConsequence = "The agent stops working on your desktop, and windows it moved off-screen come back."

/// The confirm title and consequence for stopping a seat (`private` | `shared`).
func windowsDesktopStopCopy(seat: String?) -> (action: String, consequence: String) {
  seat == "shared"
    ? (windowsSharedStopAction, windowsSharedStopConsequence)
    : (windowsPrivateStopAction, windowsPrivateStopConsequence)
}

func macDesktopVisibleMessage(for error: Error, hostIsWindows: Bool = false) -> String {
  let nsError = error as NSError
  return macDesktopVisibleMessage(
    nsError.localizedDescription,
    code: nsError.userInfo["ADEErrorCode"] as? String
  ) ?? (hostIsWindows
    ? "The Windows desktop could not complete the request. Try again."
    : "The lane screen could not complete the request. Try again.")
}

/// The Off card's one line: the start in flight, why the last one failed, or
/// that the display is off. `pcOperation` is the Windows host's own in-flight
/// step (`windowsDesktop.operation.kind`), so a start begun on the PC reads as
/// under way here too instead of offering a second one.
func macDesktopOffCardMessage(
  starting: Bool,
  error: String?,
  canStart: Bool,
  hostIsWindows: Bool = false,
  hostIsLinux: Bool = false,
  pcOperation: String? = nil
) -> String {
  if hostIsLinux {
    if starting { return "Starting the Linux screen…" }
    if let error = macDesktopVisibleMessage(error) { return error }
    return canStart ? "The Linux screen is off." : "Start this lane's Linux screen on its machine."
  }
  if hostIsWindows {
    if starting { return "Waiting for Windows sign-in…" }
    switch pcOperation {
    case "start_private": return "The private Windows screen is starting on the PC…"
    case "setup", "save_password", "forget_password": return "Windows Desktop setup is in progress on the PC…"
    default: break
    }
    if let error = macDesktopVisibleMessage(error) { return error }
    return canStart ? "The Windows desktop is off." : "Start this lane’s Windows desktop in ADE on the PC."
  }
  if starting { return "Starting the macOS desktop…" }
  if let error = macDesktopVisibleMessage(error) {
    return error
  }
  return canStart
    ? "The macOS desktop is off."
    : "The macOS desktop is off. Start it in ADE on your Mac."
}

/// What the viewer's status card says, or nil while the picture is live.
struct MacDesktopViewerOverlay: Equatable {
  var message: String
  var busy: Bool
  var offersReconnect: Bool
}

/// The status card for a session phase. The host's own capture error wins over
/// a generic "stopped", because the Mac knows why its encoder quit.
func macDesktopViewerOverlay(
  phase: MacDesktopLiveSession.Phase,
  hasFrame: Bool,
  hostError: String?
) -> MacDesktopViewerOverlay? {
  let hostMessage = macDesktopVisibleMessage(hostError)
  switch phase {
  case .live:
    return nil
  case .idle:
    // Nothing is subscribed yet (or any more). With no picture there is
    // nothing to look at, so offer the way back.
    return hasFrame ? nil : MacDesktopViewerOverlay(message: "Not connected.", busy: false, offersReconnect: true)
  case .connecting:
    return MacDesktopViewerOverlay(
      message: hasFrame ? "Reconnecting…" : "Connecting to the Mac…",
      busy: true,
      offersReconnect: false
    )
  case .waitingForKeyframe:
    return MacDesktopViewerOverlay(message: "Starting the picture…", busy: true, offersReconnect: false)
  case .ended(let reason, let message):
    let fallback = reason == "display_destroyed" ? "This lane's desktop closed." : "The stream stopped."
    let text = hostMessage ?? macDesktopVisibleMessage(message) ?? fallback
    return MacDesktopViewerOverlay(message: text, busy: false, offersReconnect: true)
  case .failed(let message):
    return MacDesktopViewerOverlay(
      message: macDesktopVisibleMessage(message) ?? "The desktop stream stopped.",
      busy: false,
      offersReconnect: true)
  }
}

/// "Watching · <who drives> · <display>", or "Controlling · <display>" while
/// this phone has it — the sentence that tells a viewer
/// whether the screen is theirs, an agent's, or someone else's right now.
///
/// This phone's own control wins over the snapshot, which lags the take by up
/// to one poll. A lease held by a user that is not this picture is someone
/// else — the desktop, or another phone.
func macDesktopViewerRibbon(
  controlling: Bool,
  lease: WorkToolsMacDesktopLease?,
  displayName: String?
) -> String {
  var parts = [controlling ? "Controlling" : "Watching"]
  if !controlling, let lease {
    switch lease.holder {
    case "agent": parts.append("agent driving")
    case "user": parts.append("someone else has control")
    default: break
    }
  }
  if let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
    parts.append(name)
  }
  return parts.joined(separator: " · ")
}

// MARK: - Orientation

/// What the viewer asks of the phone's orientation, and what it gives back.
///
/// Pure, so the rules are testable without a window scene. Each call returns
/// the orientations to request, or nil when nothing has to turn.
struct MacDesktopViewerOrientation: Equatable {
  /// The orientation when the viewer opened. A turn the viewer made itself
  /// goes back to this on close.
  var openedIn: UIInterfaceOrientation = .portrait
  /// Where the phone was when Take control forced landscape. Nil while not
  /// in control.
  private(set) var restoreAfterControl: UIInterfaceOrientation?
  /// True after Take control turned the phone.
  private(set) var turnedByViewer = false

  /// Take control holds landscape until Return.
  var locksLandscape: Bool { restoreAfterControl != nil }

  /// Take control: remember the orientation, then ask for landscape. A phone
  /// that is already in landscape stays on the side it is on.
  mutating func beginControl(current: UIInterfaceOrientation) -> UIInterfaceOrientationMask? {
    guard restoreAfterControl == nil else { return nil }
    restoreAfterControl = current
    guard !current.isLandscape else { return nil }
    turnedByViewer = true
    return .landscape
  }

  /// Return: the orientation from before Take control.
  mutating func endControl() -> UIInterfaceOrientationMask? {
    guard let previous = restoreAfterControl else { return nil }
    restoreAfterControl = nil
    return previous.isLandscape ? nil : macDesktopOrientationMask(previous)
  }

  /// Close: the lock goes, and a turn the viewer made goes back to the
  /// orientation the viewer opened in.
  mutating func close() -> UIInterfaceOrientationMask? {
    let turned = turnedByViewer
    restoreAfterControl = nil
    turnedByViewer = false
    return turned ? macDesktopOrientationMask(openedIn) : nil
  }
}

/// The one-orientation mask for an interface orientation. An unknown
/// orientation reads as portrait, which is how the app opens on a phone.
func macDesktopOrientationMask(_ orientation: UIInterfaceOrientation) -> UIInterfaceOrientationMask {
  switch orientation {
  case .landscapeLeft: return .landscapeLeft
  case .landscapeRight: return .landscapeRight
  case .portraitUpsideDown: return .portraitUpsideDown
  default: return .portrait
  }
}

/// Applies `MacDesktopViewerOrientation` to the app's window scene.
@MainActor
enum MacDesktopViewerRotation {
  static func currentOrientation() -> UIInterfaceOrientation {
    activeScene()?.effectiveGeometry.interfaceOrientation ?? .portrait
  }

  /// Sets the app-wide lock first, tells every controller on screen to read
  /// it again, then asks the scene to turn. The order matters: a scene refuses
  /// a turn to an orientation that its controllers do not allow.
  static func apply(lockLandscape: Bool, request mask: UIInterfaceOrientationMask?) {
    ADEOrientationLock.mask = lockLandscape ? .landscape : .all
    guard let scene = activeScene() else { return }
    for window in scene.windows {
      var controller = window.rootViewController
      while let current = controller {
        current.setNeedsUpdateOfSupportedInterfaceOrientations()
        controller = current.presentedViewController
      }
    }
    guard let mask else { return }
    let preferences = UIWindowScene.GeometryPreferences.iOS(interfaceOrientations: mask)
    scene.requestGeometryUpdate(preferences, errorHandler: { _ in
      // A refused turn leaves the phone where it is. There is nothing to show.
    })
  }

  private static func activeScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
  }
}

#if DEBUG
/// What the fixture screen seeds the viewer with.
struct MacDesktopViewerPreview {
  var desktop: WorkToolsMacDesktopState
  var controlling = false

  static let watching = MacDesktopViewerPreview(desktop: WorkToolsMacDesktopState(
    supported: true,
    display: WorkToolsMacDesktopDisplay(
      name: "ADE Lane Display",
      width: 1728,
      height: 1080,
      mode: "virtual",
      origin: MacDesktopPoint(x: 4000, y: 0)
    ),
    windows: [WorkToolsMacDesktopWindow(id: 1, appName: "Safari", title: "ADE")],
    lease: WorkToolsMacDesktopLease(holder: "agent"),
    stream: WorkToolsMacDesktopStream(running: true, idle: false, fps: 30, bitrateKbps: 2100)
  ))
}

/// A drawn stand-in for the desktop's picture: a wallpaper, a menu bar and one
/// window, so a screenshot shows where the picture sits.
struct MacDesktopPreviewPicture: View {
  var body: some View {
    GeometryReader { proxy in
      let unit = proxy.size.width / 1000
      ZStack(alignment: .topLeading) {
        LinearGradient(
          colors: [Color(red: 0.16, green: 0.24, blue: 0.48), Color(red: 0.55, green: 0.3, blue: 0.55)],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
        Rectangle()
          .fill(Color.white.opacity(0.7))
          .frame(height: 22 * unit)
        RoundedRectangle(cornerRadius: 12 * unit)
          .fill(Color(white: 0.97))
          .overlay(alignment: .topLeading) {
            VStack(alignment: .leading, spacing: 14 * unit) {
              HStack(spacing: 7 * unit) {
                Circle().fill(Color.red.opacity(0.8)).frame(width: 12 * unit)
                Circle().fill(Color.yellow.opacity(0.8)).frame(width: 12 * unit)
                Circle().fill(Color.green.opacity(0.8)).frame(width: 12 * unit)
              }
              Text("Lane screen")
                .font(.system(size: 34 * unit, weight: .bold))
                .foregroundStyle(.black)
              ForEach(0..<5, id: \.self) { row in
                RoundedRectangle(cornerRadius: 5 * unit)
                  .fill(Color.gray.opacity(row == 0 ? 0.35 : 0.18))
                  .frame(width: (row % 2 == 0 ? 520 : 400) * unit, height: 22 * unit)
              }
            }
            .padding(22 * unit)
          }
          .frame(width: 640 * unit, height: 420 * unit)
          .offset(x: 120 * unit, y: 90 * unit)
          .shadow(color: .black.opacity(0.3), radius: 20 * unit, y: 8 * unit)
      }
    }
  }
}
#endif
