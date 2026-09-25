import SwiftUI
import UIKit

// MARK: - Frames

/// One decoded App Control frame. The host sends JPEG screencast frames, each
/// a whole picture, so there is no decoder state: the newest frame wins.
struct AppControlStreamFrame {
  var subscriptionId: String
  var seq: Int
  var sessionId: String?
  var width: Int
  var height: Int
  var image: UIImage

  /// Ceiling on one frame's bytes. The host caps the screencast at 1600×1000
  /// JPEG, which lands far under this; the cap bounds a malformed payload.
  static let maxBytes = 8 * 1024 * 1024

  /// Base64 to a display-ready image. Runs off the main actor.
  static func decode(_ envelope: AppControlStreamFrameEnvelope) -> AppControlStreamFrame? {
    guard envelope.base64Data.utf8.count <= maxBytes * 4 / 3 + 4,
          let data = Data(base64Encoded: envelope.base64Data),
          let image = UIImage(data: data)
    else { return nil }
    return AppControlStreamFrame(
      subscriptionId: envelope.subscriptionId,
      seq: envelope.seq,
      sessionId: envelope.sessionId,
      width: envelope.width > 0 ? envelope.width : Int(image.size.width * image.scale),
      height: envelope.height > 0 ? envelope.height : Int(image.size.height * image.scale),
      image: image.preparingForDisplay() ?? image
    )
  }
}

// MARK: - Session

/// One lane's App Control subscription. Frames arrive through
/// `SyncService.registerAppControlStream`; when to start and stop is the
/// view's decision (on screen, foreground, connected, app attached).
@MainActor
final class AppControlLiveSession: ObservableObject {
  enum Phase: Equatable {
    case idle
    case connecting
    /// Subscribed, no frame yet. The app may simply not have repainted.
    case waitingForFrame
    case live
    case ended(reason: String, message: String?)
    case failed(String)
  }

  let laneId: String
  let subscriptionId: String
  let viewerLabel: String?

  @Published private(set) var phase: Phase = .idle
  @Published private(set) var image: UIImage?
  @Published private(set) var pictureWidth: Int?
  @Published private(set) var pictureHeight: Int?

  private var lastSeq = -1
  private var isStarting = false
  /// Bumped by every stop so a subscribe in flight cannot land on a session
  /// that was torn down while it waited.
  private var generation = 0

  init(laneId: String, subscriptionId: String, viewerLabel: String?) {
    self.laneId = laneId
    self.subscriptionId = subscriptionId
    self.viewerLabel = viewerLabel
  }

  /// The picture's shape. A desktop app window is usually wider than tall, so
  /// 16:10 stands in until the first frame says otherwise.
  var aspectRatio: CGFloat {
    guard let width = pictureWidth, let height = pictureHeight, width > 0, height > 0 else {
      return 16.0 / 10.0
    }
    return CGFloat(width) / CGFloat(height)
  }

  var hasFrame: Bool { image != nil }

  func start(using service: SyncService) async {
    guard !isStarting else { return }
    isStarting = true
    defer { isStarting = false }
    generation += 1
    let token = generation
    lastSeq = -1
    if image == nil { phase = .connecting }
    do {
      let reply = try await service.appControlStreamSubscribe(
        laneId: laneId,
        subscriptionId: subscriptionId,
        viewerLabel: viewerLabel
      )
      guard token == generation else {
        // Stopped while the subscribe was in flight. The unsubscribe sent then
        // reached the host before this subscription existed there, so it
        // would stream to nobody. Release it, unless a newer view already
        // registered the same id and now shares it.
        if !service.isAppControlStreamRegistered(subscriptionId: subscriptionId),
           service.connectionState == .connected {
          let id = subscriptionId
          Task { try? await service.appControlStreamUnsubscribe(subscriptionId: id) }
        }
        return
      }
      if let width = reply.width, let height = reply.height, width > 0, height > 0 {
        pictureWidth = width
        pictureHeight = height
      }
      if phase != .live { phase = .waitingForFrame }
    } catch {
      guard token == generation else { return }
      phase = .failed(Self.message(for: error))
    }
  }

  /// Safe to call twice and before a start completed.
  func stop(using service: SyncService) {
    generation += 1
    isStarting = false
    service.unregisterAppControlStream(subscriptionId: subscriptionId)
    if service.connectionState == .connected, service.supportsAppControlStream {
      let id = subscriptionId
      Task { try? await service.appControlStreamUnsubscribe(subscriptionId: id) }
    }
    phase = .idle
    image = nil
    lastSeq = -1
  }

  func consume(_ frame: AppControlStreamFrame) {
    // Decodes finish out of order; an older frame never replaces a newer one.
    guard frame.subscriptionId == subscriptionId, frame.seq > lastSeq else { return }
    switch phase {
    case .idle, .failed, .ended: return
    default: break
    }
    lastSeq = frame.seq
    image = frame.image
    if frame.width > 0, frame.height > 0 {
      pictureWidth = frame.width
      pictureHeight = frame.height
    }
    phase = .live
  }

  func noteEnded(_ ended: AppControlStreamEnded) {
    guard ended.subscriptionId == subscriptionId else { return }
    if ended.reason == "unsubscribed" { return }
    phase = .ended(reason: ended.reason, message: ended.message)
  }

  private static func message(for error: Error) -> String {
    let nsError = error as NSError
    if (nsError.userInfo["ADEErrorCode"] as? String) == "unsupported_action" {
      return "Live App Control isn't available from this machine."
    }
    return macDesktopVisibleMessage(nsError.localizedDescription, code: nsError.userInfo["ADEErrorCode"] as? String)
      ?? "Couldn't reach App Control on your Mac. Try again."
  }
}

/// A session registered for frames and end notices. The caller's id keeps the
/// card and the full-screen viewer from unsubscribing each other.
@MainActor
func mountAppControlLiveSession(
  laneId: String,
  subscriptionId: String,
  using syncService: SyncService
) -> AppControlLiveSession {
  let session = AppControlLiveSession(
    laneId: laneId,
    subscriptionId: subscriptionId,
    viewerLabel: MacDesktopLiveSession.defaultViewerLabel()
  )
  syncService.registerAppControlStream(
    subscriptionId: session.subscriptionId,
    onFrame: { [weak session] frame in session?.consume(frame) },
    onEnded: { [weak session] ended in session?.noteEnded(ended) }
  )
  return session
}

/// Frames flow only while the app is attached over CDP.
func appControlIsLive(_ appControl: WorkToolsAppControlState?) -> Bool {
  appControl?.status == "connected"
}

// MARK: - Picture

/// The live picture: the newest frame, aspect fit, with an optional pinch,
/// pan and double-tap zoom (the macOS picture's `livePictureZoom`).
struct AppControlLivePicture: View {
  @ObservedObject var session: AppControlLiveSession
  /// The app is attached; drives the Live/Off tag.
  var live: Bool
  var zoomable: Bool = false
  /// Card style (rounded, tinted slot, Live tag on the picture) or viewer
  /// style (bare, on black; the viewer's footer carries the tag, like macOS).
  var inCard: Bool = true

  var body: some View {
    ZStack {
      if let image = session.image {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .opacity(live ? 1 : 0.55)
      } else {
        waitingSurface
      }
    }
    .frame(maxWidth: .infinity)
    .aspectRatio(session.aspectRatio, contentMode: .fit)
    .livePictureZoom(enabled: zoomable)
    .background(
      Color.black.opacity(inCard ? 0.12 : 0),
      in: RoundedRectangle(cornerRadius: inCard ? 12 : 0, style: .continuous)
    )
    .clipShape(RoundedRectangle(cornerRadius: inCard ? 12 : 0, style: .continuous))
    .overlay(alignment: .topTrailing) {
      if inCard {
        AppControlLiveTag(live: live && session.phase != .idle)
          .padding(8)
          .allowsHitTesting(false)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(live ? "App, live" : "App, off")
  }

  @ViewBuilder
  private var waitingSurface: some View {
    VStack(spacing: 6) {
      switch session.phase {
      case .connecting:
        ProgressView()
        Text("Connecting to the Mac…")
      case .waitingForFrame:
        if live {
          ProgressView()
          Text("Waiting for the app to draw…")
        } else {
          Image(systemName: "macwindow")
            .foregroundStyle(ADEColor.textMuted)
          Text("The app isn't attached.")
        }
      case .ended:
        Image(systemName: "pause.circle")
          .foregroundStyle(ADEColor.textMuted)
        Text("The stream stopped.")
      case .failed(let message):
        Image(systemName: "exclamationmark.triangle")
          .foregroundStyle(ADEColor.warning)
        Text(message)
      case .idle, .live:
        Color.clear
      }
    }
    .font(.caption)
    .foregroundStyle(inCard ? ADEColor.textSecondary : .white.opacity(0.85))
    .multilineTextAlignment(.center)
    .padding(8)
  }
}

/// "Live" or "Off", white on dark like the macOS stage tag.
struct AppControlLiveTag: View {
  let live: Bool

  var body: some View {
    Label(live ? "Live" : "Off", systemImage: live ? "dot.radiowaves.left.and.right" : "pause.circle")
      .font(.caption2.weight(.semibold))
      .foregroundStyle(.white)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(.black.opacity(0.55), in: Capsule())
  }
}

// MARK: - Card

/// The App Control card in the Work tools sheet. Shaped like the macOS card:
/// chips, the live picture (which carries its own error line), and Watch.
struct AppControlCard: View {
  let laneId: String
  let appControl: WorkToolsAppControlState?
  /// Bumped after each tools poll; a stopped stream retries on it.
  let refreshTick: Int
  @Binding var viewerPresented: Bool

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.scenePhase) private var scenePhase

  @State private var liveSession: AppControlLiveSession?

  var body: some View {
    ADEGlassSection(title: "App Control", subtitle: subtitle) {
      if let appControl {
        VStack(alignment: .leading, spacing: 10) {
          chips(appControl)
          stage
          watchButton
        }
        .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        Text("No app is attached in this lane.")
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .onAppear { updateLiveLifecycle() }
    .onDisappear { stopLiveSession() }
    .onChange(of: scenePhase) { _, _ in updateLiveLifecycle() }
    .onChange(of: syncService.connectionState) { _, _ in updateLiveLifecycle() }
    .onChange(of: isLiveCapable) { _, _ in updateLiveLifecycle() }
    .onChange(of: viewerPresented) { _, _ in updateLiveLifecycle() }
    .onChange(of: refreshTick) { _, _ in retryEndedSessionIfNeeded() }
    .fullScreenCover(isPresented: $viewerPresented) {
      AppControlViewer(laneId: laneId, initialState: appControl)
    }
  }

  /// "cdp · Live", the driver and the session's state in a word.
  private var subtitle: String? {
    guard let appControl else { return nil }
    return "\(appControl.driver) · \(appControlStatusLabel(appControl.status))"
  }

  /// One "App" chip. The host's app name is often the launch command
  /// ("npm start"), which is not a name, so the phone never shows it.
  private func chips(_ appControl: WorkToolsAppControlState) -> some View {
    HStack(spacing: 6) {
      appControlChip(text: appControlTagLabel, systemImage: "macwindow")
      Spacer(minLength: 0)
    }
  }

  private func appControlChip(text: String, systemImage: String) -> some View {
    Label(text, systemImage: systemImage)
      .font(.caption)
      .foregroundStyle(ADEColor.textSecondary)
      .lineLimit(1)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(Capsule().fill(ADEColor.textPrimary.opacity(0.08)))
      .overlay(Capsule().stroke(ADEColor.textMuted.opacity(0.25), lineWidth: 1))
  }

  @ViewBuilder
  private var stage: some View {
    if !viewerPresented, let liveSession {
      AppControlLivePicture(session: liveSession, live: appControlIsLive(appControl))
        .onTapGesture {
          ADEHaptics.light()
          viewerPresented = true
        }
    } else {
      placeholder
    }
  }

  /// Same dark slot the macOS card draws when it has no picture.
  private var placeholder: some View {
    let canWatch = syncService.supportsAppControlStream
    let caption = viewerPresented
      ? "Watching full screen"
      : canWatch ? "Tap to watch" : "Live view isn't available from this machine."
    return Button {
      ADEHaptics.light()
      viewerPresented = true
    } label: {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(Color.black.opacity(0.35))
        VStack(spacing: 6) {
          Image(systemName: "macwindow")
            .font(.title3)
            .foregroundStyle(ADEColor.textMuted)
          Text(caption)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 12)
        VStack {
          HStack {
            Spacer(minLength: 0)
            AppControlLiveTag(live: appControlIsLive(appControl))
          }
          Spacer(minLength: 0)
        }
        .padding(8)
      }
      .frame(height: 140)
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .buttonStyle(.plain)
    .disabled(!canWatch)
    .accessibilityLabel("Watch this lane's App Control app")
    .accessibilityHint("Opens the app full screen")
  }

  @ViewBuilder
  private var watchButton: some View {
    if syncService.supportsAppControlStream {
      Button {
        ADEHaptics.light()
        viewerPresented = true
      } label: {
        Label("Watch", systemImage: "play.fill")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .frame(minHeight: 44)
          .background(Capsule().fill(ADEColor.textPrimary.opacity(0.1)))
      }
      .buttonStyle(.plain)
      .accessibilityHint("Opens the app full screen")
    }
  }

  // MARK: Live lifecycle

  private var isLiveCapable: Bool {
    syncService.supportsAppControlStream && appControl != nil
  }

  private func updateLiveLifecycle() {
    let shouldRun = isLiveCapable
      && !viewerPresented
      && scenePhase == .active
      && syncService.connectionState == .connected
    if shouldRun {
      startLiveSessionIfNeeded()
    } else {
      stopLiveSession()
    }
  }

  private func startLiveSessionIfNeeded() {
    guard liveSession == nil else { return }
    let session = mountAppControlLiveSession(
      laneId: laneId,
      subscriptionId: "ios-\(syncService.deviceId)-app-control-\(laneId)",
      using: syncService
    )
    liveSession = session
    Task { await session.start(using: syncService) }
  }

  private func stopLiveSession() {
    guard let session = liveSession else { return }
    session.stop(using: syncService)
    liveSession = nil
  }

  /// The host ended the subscription (it restarted, or its fan-out went away).
  /// Subscribe again on the next poll while the card is still up.
  private func retryEndedSessionIfNeeded() {
    guard let session = liveSession else { return }
    switch session.phase {
    case .ended, .failed: break
    default: return
    }
    guard isLiveCapable, !viewerPresented, scenePhase == .active,
          syncService.connectionState == .connected else { return }
    Task { await session.start(using: syncService) }
  }
}

/// What every App Control tag on the phone says: the card chip, the lane chip
/// and the viewer's title. Just "App"; the status goes in its own tag.
let appControlTagLabel = "App"

/// The app's session status in a word, for the chip when it is not live.
func appControlStatusLabel(_ status: String) -> String {
  switch status {
  case "connected": return "Live"
  case "starting", "running": return "Starting"
  case "stopping": return "Stopping"
  case "exited", "stopped": return "Off"
  case "failed": return "Failed"
  default: return status.isEmpty ? "Off" : status.capitalized
  }
}

// MARK: - Viewer

/// Full-screen view of the lane's App Control app. Built like the macOS
/// viewer: black stage, Close and Rotate on top with the title between, one
/// line underneath. Watch only.
///
/// The picture zooms (pinch, pan, double-tap) and the phone can turn to
/// landscape, with the device or with Rotate, on the macOS viewer's rules
/// (`MacDesktopViewerOrientation`, `livePictureZoom`).
struct AppControlViewer: View {
  let laneId: String

  private static let refreshInterval: Duration = .seconds(3)

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  @State private var appControl: WorkToolsAppControlState?
  @State private var loaded: Bool
  @State private var session: AppControlLiveSession?
  @State private var orientation = MacDesktopViewerOrientation()
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  init(laneId: String, initialState: WorkToolsAppControlState?) {
    self.laneId = laneId
    _appControl = State(initialValue: initialState)
    _loaded = State(initialValue: initialState != nil)
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
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
    .onChange(of: scenePhase) { _, _ in updateLifecycle() }
    .onChange(of: syncService.connectionState) { _, _ in updateLifecycle() }
    .onChange(of: isLiveCapable) { _, _ in updateLifecycle() }
  }

  private var controls: some View {
    HStack(spacing: 14) {
      controlButton(systemName: "xmark", label: "Close") {
        stopSession()
        dismiss()
      }
      Spacer(minLength: 0)
      if rotates {
        controlButton(systemName: "rotate.right", label: "Rotate") { rotate() }
      }
    }
    .overlay {
      Label(appControlTagLabel, systemImage: "macwindow")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.white.opacity(0.85))
        .accessibilityAddTraits(.isHeader)
    }
    .padding(.horizontal, 18)
    .padding(.vertical, compactHeight ? 6 : 12)
  }

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

  /// Landscape on a phone. The line under the picture goes, so the picture
  /// keeps the height.
  private var compactHeight: Bool { verticalSizeClass == .compact }

  /// Only a phone turns. An iPad keeps whatever its window is doing.
  private var rotates: Bool { UIDevice.current.userInterfaceIdiom == .phone }

  private func rotate() {
    let request = orientation.toggleRotation(current: MacDesktopViewerRotation.currentOrientation())
    MacDesktopViewerRotation.apply(lockLandscape: false, request: request)
  }

  /// A turn this viewer made is undone; a turn the person made with the
  /// device stays.
  private func restoreOrientationOnClose() {
    guard rotates else { return }
    MacDesktopViewerRotation.apply(lockLandscape: false, request: orientation.close())
  }

  @ViewBuilder
  private var stage: some View {
    if !syncService.supportsAppControlStream {
      stageMessage("Live App Control isn't available from this machine.")
    } else if appControl == nil {
      if loaded {
        stageMessage("No app is attached in this lane.")
      } else {
        ProgressView().tint(.white)
      }
    } else if let session {
      AppControlLivePicture(session: session, live: appControlIsLive(appControl), zoomable: true, inCard: false)
        .padding(.horizontal, 12)
    } else if syncService.connectionState != .connected {
      stageMessage("Waiting for the connection to your Mac…")
    } else {
      ProgressView().tint(.white)
    }
  }

  private func stageMessage(_ text: String) -> some View {
    Text(text)
      .font(.footnote)
      .foregroundStyle(.white.opacity(0.85))
      .multilineTextAlignment(.center)
      .padding(.horizontal, 32)
  }

  /// "Watching" and the Live/Off tag, where the macOS viewer puts its
  /// ribbon. Never the host's app name: that is often the launch command.
  private var footer: some View {
    HStack(spacing: 8) {
      if let appControl {
        Text("Watching")
          .font(.caption)
          .foregroundStyle(.white.opacity(0.7))
          .lineLimit(1)
        AppControlLiveTag(live: appControlIsLive(appControl))
      }
    }
    .padding(.horizontal, 24)
    .padding(.bottom, 18)
    .frame(maxWidth: .infinity)
    .accessibilityElement(children: .combine)
  }

  private var isLiveCapable: Bool {
    syncService.supportsAppControlStream && appControl != nil
  }

  /// Keeps the last good state on a failed read.
  private func refresh() async {
    guard syncService.supportsWorkToolsState else {
      loaded = true
      return
    }
    guard let next = try? await syncService.fetchWorkToolsLaneState(laneId: laneId) else { return }
    guard !Task.isCancelled else { return }
    appControl = next.appControl
    loaded = true
    if let session {
      switch session.phase {
      case .ended, .failed:
        if isLiveCapable, scenePhase == .active, syncService.connectionState == .connected {
          Task { await session.start(using: syncService) }
        }
      default: break
      }
    }
  }

  private func updateLifecycle() {
    let shouldRun = isLiveCapable
      && scenePhase == .active
      && syncService.connectionState == .connected
    if shouldRun {
      guard session == nil else { return }
      // Distinct from the card's id so the two cannot unsubscribe each other.
      let next = mountAppControlLiveSession(
        laneId: laneId,
        subscriptionId: "ios-\(syncService.deviceId)-app-control-viewer-\(laneId)",
        using: syncService
      )
      session = next
      Task { await next.start(using: syncService) }
    } else {
      stopSession()
    }
  }

  private func stopSession() {
    guard let current = session else { return }
    current.stop(using: syncService)
    session = nil
  }
}
