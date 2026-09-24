import SwiftUI
import UIKit

/// Full-screen view of the lane's private macOS screen.
///
/// Built like `AppleDeviceViewer` — black stage, Close and Reconnect on top, one
/// sentence underneath — with one difference: the macOS desktop takes a finger
/// when the host advertises takeover, so the picture here is the same
/// `MacDesktopControlPicture` the tools sheet uses, Take control and Return
/// included.
///
/// While watching, the picture zooms (pinch, pan, double-tap) and the phone
/// can turn to landscape, with the device or with Rotate. Take control forces
/// landscape and holds it; Return puts back the orientation from before.
///
/// It runs its own live subscription under its own id. The tools sheet pauses
/// its inline picture while this is up, and even if both were live, two ids
/// cannot unsubscribe each other on the host.
struct MacDesktopViewer: View {
  let laneId: String

  /// Poll cadence for the lease, recording and stream summary. Same as the
  /// tools sheet: this is a surface the user opened to watch.
  private static let refreshInterval: Duration = .seconds(3)

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  /// Seeded with the caller's last snapshot so the ribbon and the picture's
  /// geometry are right on the first frame rather than after the first poll.
  @State private var desktop: WorkToolsMacDesktopState?
  @State private var session: MacDesktopLiveSession?
  @State private var controlling = false
  /// The Off card's Start is in flight. Opening this viewer never starts a
  /// display; only that button does.
  @State private var starting = false
  @State private var startError: String?
  @State private var orientation = MacDesktopViewerOrientation()
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  init(laneId: String, initialState: WorkToolsMacDesktopState?) {
    self.laneId = laneId
    _desktop = State(initialValue: initialState)
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      // One tree in both orientations. A branch per orientation would rebuild
      // the picture on rotation and drop the control lease it holds.
      VStack(spacing: 0) {
        controls
        Spacer(minLength: 0)
        stage
        Spacer(minLength: 0)
        if !compactHeight {
          footer
        }
      }
    }
    .preferredColorScheme(.dark)
    .task(id: laneId) {
      await refresh()
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.refreshInterval)
        guard !Task.isCancelled else { return }
        await refresh()
      }
    }
    .onAppear {
      orientation.openedIn = MacDesktopViewerRotation.currentOrientation()
      updateLifecycle()
    }
    .onDisappear {
      stopSession()
      restoreOrientationOnClose()
    }
    .onChange(of: controlling) { _, next in controlOrientationChanged(next) }
    .onChange(of: scenePhase) { _, _ in updateLifecycle() }
    .onChange(of: syncService.connectionState) { _, _ in updateLifecycle() }
    .onChange(of: isLiveCapable) { _, _ in updateLifecycle() }
  }

  // MARK: - Pieces

  private var controls: some View {
    HStack(spacing: 14) {
      controlButton(systemName: "xmark", label: "Close") {
        stopSession()
        dismiss()
      }
      Spacer(minLength: 0)
      if let session {
        MacDesktopViewerReconnectButton(session: session) { reconnect() }
      }
      if rotates && !controlling {
        controlButton(systemName: "rotate.right", label: "Rotate") { rotate() }
      }
    }
    .overlay { title }
    .padding(.horizontal, 18)
    .padding(.vertical, compactHeight ? 6 : 12)
  }

  private var title: some View {
    Label("macOS", systemImage: "desktopcomputer")
      .font(.footnote.weight(.semibold))
      .foregroundStyle(.white.opacity(0.85))
      .accessibilityAddTraits(.isHeader)
  }

  /// Landscape on a phone. The ribbon under the picture goes, so the picture
  /// keeps the height.
  private var compactHeight: Bool { verticalSizeClass == .compact }

  /// Only a phone turns. An iPad keeps whatever its window is doing.
  private var rotates: Bool { UIDevice.current.userInterfaceIdiom == .phone }

  private func controlButton(systemName: String, label: String, action: @escaping () -> Void) -> some View {
    Button {
      ADEHaptics.light()
      action()
    } label: {
      macDesktopViewerControlLabel(systemName: systemName)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  @ViewBuilder
  private var stage: some View {
    if !syncService.supportsMacDesktopStream {
      stageMessage("Live video isn't available from this machine.")
    } else if desktop?.supported == false {
      stageMessage("This Mac can't host a desktop.")
    } else if let display = desktop?.display {
      if let session {
        ZStack {
          MacDesktopControlPicture(
            laneId: laneId,
            display: display,
            session: session,
            placeholder: nil,
            showsPictureStatus: false,
            zoomable: true,
            onControlChange: { controlling = $0 }
          )
          MacDesktopViewerStatusOverlay(
            session: session,
            hostError: desktop?.stream?.lastError,
            onReconnect: { reconnect() }
          )
        }
        .padding(.horizontal, 12)
      } else if syncService.connectionState != .connected {
        stageMessage("Waiting for the connection to your Mac…")
      } else {
        ProgressView().tint(.white)
      }
    } else if desktop == nil {
      ProgressView().tint(.white)
    } else {
      offCard
    }
  }

  /// "The macOS desktop is off." and Start, like the Apple Off card. The poll brings
  /// the display in once the host has made it.
  private var offCard: some View {
    VStack(spacing: 12) {
      if starting {
        ProgressView().tint(.white)
      }
      stageMessage(macDesktopOffCardMessage(
        starting: starting,
        error: startError,
        canStart: syncService.supportsMacDesktopStart
      ))
      if !starting && syncService.supportsMacDesktopStart {
        Button {
          ADEHaptics.light()
          startDesktop()
        } label: {
          Text("Start")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
            .background(Color.white.opacity(0.16), in: Capsule())
        }
        .buttonStyle(.plain)
        .disabled(syncService.connectionState != .connected)
        .accessibilityHint("Starts this lane's macOS desktop on your Mac")
      }
    }
  }

  private func stageMessage(_ text: String) -> some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(.white.opacity(0.85))
      .multilineTextAlignment(.center)
      .padding(.horizontal, 32)
  }

  private var footer: some View {
    VStack(spacing: 6) {
      Text(macDesktopViewerRibbon(
        controlling: controlling,
        lease: desktop?.lease,
        displayName: desktop?.display?.name
      ))
      .font(.caption)
      .foregroundStyle(.white.opacity(0.7))
      .lineLimit(2)
      .multilineTextAlignment(.center)
      if desktop?.recording?.running == true {
        Label("Recording", systemImage: "record.circle")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.danger)
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }

  // MARK: - Data

  private var isLiveCapable: Bool {
    syncService.supportsMacDesktopStream
      && desktop?.supported == true
      && desktop?.display != nil
  }

  /// Keeps the last good snapshot on a failed read, like the Apple viewer: a
  /// timeout must not blank the ribbon or tear down the picture.
  private func refresh() async {
    guard syncService.supportsWorkToolsState else { return }
    guard let next = try? await syncService.fetchWorkToolsLaneState(laneId: laneId) else { return }
    guard !Task.isCancelled else { return }
    desktop = next.macDesktop
    retryStoppedSessionIfNeeded()
  }

  private func startDesktop() {
    macDesktopStartDisplay(
      using: syncService,
      laneId: laneId,
      starting: $starting,
      errorText: $startError,
      refresh: { await refresh() }
    )
  }

  // MARK: - Orientation

  /// Take control turns the phone to landscape and holds it there. Return
  /// turns it back to the orientation from before Take control.
  private func controlOrientationChanged(_ controlling: Bool) {
    guard rotates else { return }
    let request = controlling
      ? orientation.beginControl(current: MacDesktopViewerRotation.currentOrientation())
      : orientation.endControl()
    MacDesktopViewerRotation.apply(lockLandscape: orientation.locksLandscape, request: request)
  }

  private func rotate() {
    let request = orientation.toggleRotation(current: MacDesktopViewerRotation.currentOrientation())
    MacDesktopViewerRotation.apply(lockLandscape: orientation.locksLandscape, request: request)
  }

  /// The lock always goes. A turn this viewer made is undone; a turn the
  /// person made with the device stays.
  private func restoreOrientationOnClose() {
    guard rotates else { return }
    let request = orientation.close()
    MacDesktopViewerRotation.apply(lockLandscape: false, request: request)
  }

  // MARK: - Live stream lifecycle

  /// Same rule as the tools sheet: on screen, foreground, connected, and the
  /// lane has a display.
  private func updateLifecycle() {
    let shouldRun = isLiveCapable
      && scenePhase == .active
      && syncService.connectionState == .connected
    if shouldRun {
      startSessionIfNeeded()
    } else {
      stopSession()
    }
  }

  private func startSessionIfNeeded() {
    guard session == nil else { return }
    // Distinct from the sheet's id so the two can never unsubscribe each other.
    let next = mountMacDesktopLiveSession(
      laneId: laneId,
      subscriptionId: "ios-\(syncService.deviceId)-mac-desktop-viewer-\(laneId)",
      using: syncService
    )
    session = next
    Task { await next.start(using: syncService) }
  }

  private func stopSession() {
    guard let current = session else { return }
    current.stop(using: syncService)
    session = nil
    controlling = false
  }

  /// Re-subscribes on the same session rather than tearing it down: a stop
  /// sends an unsubscribe that could land after the new subscribe under the
  /// same id and cancel it.
  private func reconnect() {
    guard isLiveCapable, syncService.connectionState == .connected else { return }
    guard let current = session else {
      startSessionIfNeeded()
      return
    }
    Task { await current.start(using: syncService) }
  }

  /// A `stopped` stream is the encoder pausing, not the subscription dying.
  /// Same as the sheet: the next poll re-subscribes while the lane still has a
  /// display, which is what restarts the encoder.
  private func retryStoppedSessionIfNeeded() {
    guard let current = session else { return }
    guard case .ended(let reason, _) = current.phase, reason == "stopped" else { return }
    guard isLiveCapable,
          scenePhase == .active,
          syncService.connectionState == .connected
    else { return }
    Task { await current.start(using: syncService) }
  }
}

private func macDesktopViewerControlLabel(systemName: String) -> some View {
  Image(systemName: systemName)
    .font(.system(size: 15, weight: .semibold))
    .foregroundStyle(.white)
    .frame(width: 44, height: 44)
    .background(Color.white.opacity(0.12), in: Circle())
}

/// The top-right Reconnect, shown only when the overlay offers one. Its own
/// view so it observes the session's phase.
private struct MacDesktopViewerReconnectButton: View {
  @ObservedObject var session: MacDesktopLiveSession
  let onReconnect: () -> Void

  var body: some View {
    if macDesktopViewerOverlay(phase: session.phase, hasFrame: session.hasFrame, hostError: nil)?.offersReconnect == true {
      Button {
        ADEHaptics.light()
        onReconnect()
      } label: {
        macDesktopViewerControlLabel(systemName: "arrow.clockwise")
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Reconnect")
    }
  }
}

/// The status card over the picture: connecting, stopped, or failed.
private struct MacDesktopViewerStatusOverlay: View {
  @ObservedObject var session: MacDesktopLiveSession
  let hostError: String?
  let onReconnect: () -> Void

  var body: some View {
    if let overlay = macDesktopViewerOverlay(phase: session.phase, hasFrame: session.hasFrame, hostError: hostError) {
      VStack(spacing: 12) {
        if overlay.busy {
          ProgressView().tint(.white)
        }
        Text(overlay.message)
          .font(.footnote)
          .foregroundStyle(.white.opacity(0.85))
          .multilineTextAlignment(.center)
          .padding(.horizontal, 32)
        if overlay.offersReconnect {
          Button {
            ADEHaptics.light()
            onReconnect()
          } label: {
            Text("Reconnect")
              .font(.footnote.weight(.semibold))
              .foregroundStyle(.white)
              .padding(.horizontal, 18)
              .padding(.vertical, 9)
              .background(Color.white.opacity(0.16), in: Capsule())
          }
          .buttonStyle(.plain)
        }
      }
      .padding(.vertical, 18)
      .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      .padding(.horizontal, 24)
    }
  }
}

// MARK: - Pure helpers

/// The Off card's one line: the start in flight, why the last one failed, or
/// that the display is off.
func macDesktopOffCardMessage(starting: Bool, error: String?, canStart: Bool) -> String {
  if starting { return "Starting the macOS desktop…" }
  if let error = error?.trimmingCharacters(in: .whitespacesAndNewlines), !error.isEmpty {
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
  let hostMessage = hostError.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
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
    let text = hostMessage ?? message.flatMap { $0.isEmpty ? nil : $0 } ?? fallback
    return MacDesktopViewerOverlay(message: text, busy: false, offersReconnect: true)
  case .failed(let message):
    return MacDesktopViewerOverlay(message: message, busy: false, offersReconnect: true)
  }
}

/// "Watching · <who drives> · <display>" — the sentence that tells a viewer
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
  var parts = ["Watching"]
  if controlling {
    parts.append("you have control")
  } else if let lease {
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
  /// True after Rotate or Take control turned the phone.
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

  /// Rotate: landscape from portrait, portrait from landscape. Nothing while
  /// Take control holds landscape.
  mutating func toggleRotation(current: UIInterfaceOrientation) -> UIInterfaceOrientationMask? {
    guard restoreAfterControl == nil else { return nil }
    turnedByViewer = true
    return current.isLandscape ? .portrait : .landscape
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
