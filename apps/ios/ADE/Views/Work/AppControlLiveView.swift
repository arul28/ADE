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
      guard token == generation else { return }
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
/// pan and double-tap zoom (the same zoom rules as the macOS picture).
struct AppControlLivePicture: View {
  @ObservedObject var session: AppControlLiveSession
  /// The app is attached; drives the Live/Off tag.
  var live: Bool
  var zoomable: Bool = false
  /// Card style (rounded, tinted slot) or viewer style (bare, on black).
  var inCard: Bool = true

  @State private var zoom = MacDesktopZoom.identity
  @State private var lastMagnification: CGFloat = 1
  @State private var lastPanTranslation: CGSize = .zero
  @State private var pictureSize: CGSize = .zero

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
    .background(
      GeometryReader { proxy in
        Color.clear
          .onAppear { pictureSize = proxy.size }
          .onChange(of: proxy.size) { _, size in
            pictureSize = size
            resetZoom()
          }
      }
    )
    .scaleEffect(zoom.scale)
    .offset(zoom.offset)
    .clipped()
    .contentShape(Rectangle())
    .gesture(zoomGesture, including: zoomable ? .all : .subviews)
    .background(
      Color.black.opacity(inCard ? 0.12 : 0),
      in: RoundedRectangle(cornerRadius: inCard ? 12 : 0, style: .continuous)
    )
    .clipShape(RoundedRectangle(cornerRadius: inCard ? 12 : 0, style: .continuous))
    .overlay(alignment: .topTrailing) {
      AppControlLiveTag(live: live && session.phase != .idle)
        .padding(8)
        .allowsHitTesting(false)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(live ? "App Control, live" : "App Control, off")
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

  private var zoomGesture: some Gesture {
    MagnifyGesture()
      .onChanged { value in
        guard zoomable, lastMagnification > 0 else { return }
        let factor = value.magnification / lastMagnification
        lastMagnification = value.magnification
        zoom = zoom.magnified(by: factor, around: value.startLocation, in: pictureSize)
      }
      .onEnded { _ in lastMagnification = 1 }
      .simultaneously(with: DragGesture(minimumDistance: 8, coordinateSpace: .local)
        .onChanged { value in
          guard zoomable else { return }
          let delta = CGSize(
            width: value.translation.width - lastPanTranslation.width,
            height: value.translation.height - lastPanTranslation.height
          )
          lastPanTranslation = value.translation
          zoom = zoom.panned(by: delta, in: pictureSize)
        }
        .onEnded { _ in lastPanTranslation = .zero })
      .simultaneously(with: SpatialTapGesture(count: 2, coordinateSpace: .local)
        .onEnded { value in
          guard zoomable else { return }
          withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) {
            zoom = zoom.toggled(at: value.location, in: pictureSize)
          }
        })
  }

  private func resetZoom() {
    zoom = .identity
    lastMagnification = 1
    lastPanTranslation = .zero
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

  private func chips(_ appControl: WorkToolsAppControlState) -> some View {
    HStack(spacing: 6) {
      appControlChip(text: "App Control", systemImage: "macwindow")
      appControlChip(text: appControl.appName, systemImage: "app.dashed")
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
/// viewer: black stage, Close on top, one line underneath. Watch only.
struct AppControlViewer: View {
  let laneId: String

  private static let refreshInterval: Duration = .seconds(3)

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  @State private var appControl: WorkToolsAppControlState?
  @State private var loaded: Bool
  @State private var session: AppControlLiveSession?

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
        footer
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
    .onAppear { updateLifecycle() }
    .onDisappear { stopSession() }
    .onChange(of: scenePhase) { _, _ in updateLifecycle() }
    .onChange(of: syncService.connectionState) { _, _ in updateLifecycle() }
    .onChange(of: isLiveCapable) { _, _ in updateLifecycle() }
  }

  private var controls: some View {
    HStack(spacing: 14) {
      Button {
        ADEHaptics.light()
        stopSession()
        dismiss()
      } label: {
        Image(systemName: "xmark")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(.white)
          .frame(width: 44, height: 44)
          .background(Color.white.opacity(0.12), in: Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Close")
      Spacer(minLength: 0)
    }
    .overlay {
      Label("App Control", systemImage: "macwindow")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.white.opacity(0.85))
        .accessibilityAddTraits(.isHeader)
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 12)
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

  private var footer: some View {
    HStack(spacing: 8) {
      if let appControl {
        Text(appControl.appName)
          .font(.caption.weight(.semibold))
          .foregroundStyle(.white.opacity(0.85))
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
