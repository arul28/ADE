import Combine
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
  /// What turns a point on this frame into a CSS viewport point for the host's
  /// hit-test. Present from a host that sends the frame's own geometry.
  var scaleX: Double?
  var viewportWidth: Double?
  var viewportHeight: Double?

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
      image: image.preparingForDisplay() ?? image,
      scaleX: envelope.scaleX,
      viewportWidth: envelope.viewportWidth,
      viewportHeight: envelope.viewportHeight
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
  /// The last frame's own geometry, kept with the picture so a frozen inspect
  /// view can turn a tap back into a CSS viewport point. Nil from older hosts.
  @Published private(set) var frameScaleX: Double?
  @Published private(set) var frameViewportWidth: Double?
  @Published private(set) var frameViewportHeight: Double?

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
    if let scaleX = frame.scaleX, scaleX > 0 { frameScaleX = scaleX }
    if let width = frame.viewportWidth, width > 0 { frameViewportWidth = width }
    if let height = frame.viewportHeight, height > 0 { frameViewportHeight = height }
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

/// Clips the card's picture to its rounded slot; the viewer's picture is
/// left unclipped so it can zoom across the whole stage.
private struct AppControlCardClip: ViewModifier {
  var enabled: Bool

  func body(content: Content) -> some View {
    if enabled {
      content.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    } else {
      content
    }
  }
}

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
  /// The viewer's corners (rounded over a pane, none full screen). The card
  /// always rounds its slot.
  var cornerRadius: CGFloat = 0
  /// A single tap on the picture while it zooms (the viewer's menu).
  var onTap: (() -> Void)?

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
    .liveStageReportsAspect(session.aspectRatio)
    // The viewer's corners go on the picture itself, so they zoom with it.
    .clipShape(RoundedRectangle(cornerRadius: inCard ? 0 : cornerRadius, style: .continuous))
    .livePictureZoom(enabled: zoomable, onTap: onTap)
    .background(
      Color.black.opacity(inCard ? 0.12 : 0),
      in: RoundedRectangle(cornerRadius: inCard ? 12 : 0, style: .continuous)
    )
    // The card clips to its rounded slot. The viewer does not: a zoomed
    // picture may fill the stage, and the stage clips it.
    .modifier(AppControlCardClip(enabled: inCard))
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

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.scenePhase) private var scenePhase

  @State private var liveSession: AppControlLiveSession?

  var body: some View {
    ADEKitCard(title: "App Control", hint: subtitle) {
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
    // Every transition, from the service itself: through the menu-safe
    // publisher a drop and reconnect under an open menu could coalesce
    // into no change, and the stream would not restart.
    .onReceive(syncService.$connectionState.removeDuplicates().receive(on: DispatchQueue.main)) { _ in updateLiveLifecycle() }
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

/// The live view of the lane's App Control app, on the live stage like the
/// simulator (`LiveStage`). Watch only.
///
/// The picture is the whole surface: full screen on a phone (and the Duo's
/// front screen), or the whole tools pane beside or above the chat on a large
/// display. Nothing is drawn over it but one floating menu button; its menu
/// holds Inspect, Turn, Placement, Reconnect and Close. The picture zooms
/// (pinch, pan, double-tap) and a single tap opens the menu. Turn draws the
/// picture a quarter turn round, remembered per place (`LiveStageTurns`).
struct AppControlViewer: View {
  let laneId: String
  /// The chat this viewer was opened from, so an inspect handoff goes back to
  /// the right composer. Nil for a viewer opened without a chat.
  var chatSessionId: String?
  /// Where the stage draws it. Changes without re-creating the viewer.
  var presentation: LiveStagePresentation = .fullScreen
  /// What the menu button keeps clear of; nil reads this view's safe area.
  var chromeInsets: EdgeInsets?
  #if DEBUG
  /// Fixture seam (`-adePreviewScreen app-control-viewer`): a seeded state and
  /// a drawn stand-in for the picture, with no sync and no subscription.
  var preview: AppControlViewerPreview?
  #endif

  private static let refreshInterval: Duration = .seconds(3)

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.liveStageClose) private var stageClose
  @Environment(\.liveStageContext) private var stageContext
  @Environment(\.duoLayout) private var duo

  @State private var appControl: WorkToolsAppControlState?
  @State private var loaded: Bool
  @State private var session: AppControlLiveSession?
  @ObservedObject private var turns = LiveStageTurns.shared
  @State private var menuOpen = false
  /// The frozen inspect view, over everything, until its Close resumes the
  /// live subscription.
  @State private var inspect: LiveInspectMarkupModel?

  #if DEBUG
  init(
    laneId: String,
    initialState: WorkToolsAppControlState?,
    chatSessionId: String? = nil,
    presentation: LiveStagePresentation = .fullScreen,
    chromeInsets: EdgeInsets? = nil,
    preview: AppControlViewerPreview? = nil
  ) {
    self.laneId = laneId
    self.chatSessionId = chatSessionId
    self.presentation = presentation
    self.chromeInsets = chromeInsets
    self.preview = preview
    let state = preview?.appControl ?? initialState
    _appControl = State(initialValue: state)
    _loaded = State(initialValue: state != nil)
  }
  #else
  init(
    laneId: String,
    initialState: WorkToolsAppControlState?,
    chatSessionId: String? = nil,
    presentation: LiveStagePresentation = .fullScreen,
    chromeInsets: EdgeInsets? = nil
  ) {
    self.laneId = laneId
    self.chatSessionId = chatSessionId
    self.presentation = presentation
    self.chromeInsets = chromeInsets
    _appControl = State(initialValue: initialState)
    _loaded = State(initialValue: initialState != nil)
  }
  #endif

  private var isPreview: Bool {
    #if DEBUG
    preview != nil
    #else
    false
    #endif
  }

  var body: some View {
    GeometryReader { proxy in
      let insets = chromeInsets ?? proxy.safeAreaInsets
      ZStack(alignment: .topLeading) {
        // A tap around the picture opens the menu too.
        LiveStageBackdrop(presentation: presentation)
          .contentShape(Rectangle())
          .onTapGesture { toggleMenu() }
        stage(size: proxy.size, insets: EdgeInsets())
          .frame(width: proxy.size.width, height: proxy.size.height)
        LiveStageMenuButton(
          container: proxy.size,
          insets: insets,
          storageKey: "ade.liveStage.button.\(presentation.isPane ? "pane" : "full").\(proxy.size.width > proxy.size.height ? "wide" : "tall")",
          symbolName: "ellipsis",
          isOpen: $menuOpen
        ) {
          menuPanel
        }
        .frame(width: proxy.size.width, height: proxy.size.height)
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
    }
    // Over the pane it runs top to bottom but never sideways under the edge
    // bar; full screen it runs edge to edge.
    .ignoresSafeArea(.container, edges: presentation.isPane ? .vertical : .all)
    .environment(\.colorScheme, .dark)
    .statusBarHidden(hidesStatusBar || presentation.isFullScreen)
    .fullScreenCover(isPresented: Binding(
      get: { inspect != nil },
      set: { presented in if !presented, inspect != nil { exitInspect() } }
    )) {
      if let inspect {
        LiveInspectStage(model: inspect, onClose: exitInspect)
      }
    }
    .task(id: laneId) {
      guard !isPreview else { return }
      await refresh()
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.refreshInterval)
        guard !Task.isCancelled else { return }
        await refresh()
      }
    }
    .onAppear {
      updateLifecycle()
      updateIdleTimer()
    }
    .onDisappear {
      stopSession()
      if !isPreview { UIApplication.shared.isIdleTimerDisabled = false }
    }
    .onChange(of: presentation) { _, _ in updateIdleTimer() }
    .onChange(of: scenePhase) { _, _ in updateLifecycle() }
    // Every transition, from the service itself: through the menu-safe
    // publisher a drop and reconnect under an open menu could coalesce
    // into no change, and the stream would not restart.
    .onReceive(syncService.$connectionState.removeDuplicates().receive(on: DispatchQueue.main)) { _ in updateLifecycle() }
    .onChange(of: isLiveCapable) { _, _ in updateLifecycle() }
  }

  // MARK: - Stage

  /// `insets` is what of the stage is the system's: the picture stays out of
  /// it and the black runs under it.
  private func stage(size: CGSize, insets: EdgeInsets) -> some View {
    // Over the pane the picture keeps a little room and its own corners;
    // full screen it runs edge to edge.
    let gap = presentation.pictureGap
    let container = CGSize(
      width: max(0, size.width - insets.leading - insets.trailing - gap * 2),
      height: max(0, size.height - insets.top - insets.bottom - gap * 2)
    )
    let inner = turned ? CGSize(width: container.height, height: container.width) : container
    return stageContent
      .frame(width: inner.width, height: inner.height)
      .livePictureViewport()
      .liveStageQuarterTurn(turned, in: container)
      .position(
        x: insets.leading + gap + container.width / 2,
        y: insets.top + gap + container.height / 2
      )
  }

  private var cornerRadius: CGFloat { presentation.isPane ? 18 : 0 }
  @Environment(\.liveStageHidesStatusBar) private var hidesStatusBar

  @ViewBuilder
  private var stageContent: some View {
    #if DEBUG
    if preview != nil {
      AppControlPreviewPicture()
        .frame(maxWidth: .infinity)
        .aspectRatio(16.0 / 10.0, contentMode: .fit)
        .liveStageReportsAspect(16.0 / 10.0)
        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .onTapGesture { toggleMenu() }
    } else {
      liveStage
    }
    #else
    liveStage
    #endif
  }

  @ViewBuilder
  private var liveStage: some View {
    if !syncService.supportsAppControlStream {
      stageMessage("Live App Control isn't available from this machine.")
    } else if appControl == nil {
      if loaded {
        stageMessage("No app is attached in this lane.")
      } else {
        ProgressView().tint(.white)
      }
    } else if let session {
      AppControlLivePicture(
        session: session,
        live: appControlIsLive(appControl),
        zoomable: true,
        inCard: false,
        cornerRadius: cornerRadius,
        onTap: { toggleMenu() }
      )
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

  // MARK: - Menu

  private var menuPanel: some View {
    LiveStageMenuPanel {
      LiveStageMenuHeader(
        title: appControlTagLabel,
        detail: appControl.map { appControlIsLive($0) ? "Watching · Live" : "Watching · Off" } ?? "Watching"
      )
      HStack(spacing: 6) {
        if offersInspect, let session {
          AppControlInspectTile(session: session) {
            menuOpen = false
            beginInspect()
          }
        }
        LiveStageMenuTile(title: turned ? "Upright" : "Turn", systemImage: turned ? "rotate.left" : "rotate.right") {
          withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { turns.toggle(turnKey) }
        }
        .accessibilityHint("Turns the picture a quarter turn so it can fill the screen")
      }
      .padding(.vertical, 2)
      if stageClose != nil, stageContext.choices.count > 1 {
        LiveStagePlacementMenu(context: stageContext) { menuOpen = false }
      }
      if let session {
        AppControlReconnectRow(session: session) {
          menuOpen = false
          reconnect()
        }
      }
      Divider()
        .overlay(Color.white.opacity(0.1))
        .padding(.vertical, 2)
      LiveStageMenuRow(title: "Close", systemImage: "xmark", tint: ADEColor.danger) {
        close()
      }
      .accessibilityIdentifier("AppControlViewer.Close")
    }
  }

  private var offersInspect: Bool {
    !isPreview && session != nil && syncService.supportsViewerRemoteAction("appControl.inspectPoint")
  }

  private func toggleMenu() {
    ADEHaptics.light()
    withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { menuOpen.toggle() }
  }

  private func close() {
    menuOpen = false
    if let stageClose {
      stageClose()
    } else {
      stopSession()
      dismiss()
    }
  }

  /// The screen stays awake while the app has the whole display.
  private func updateIdleTimer() {
    guard !isPreview else { return }
    UIApplication.shared.isIdleTimerDisabled = presentation.isFullScreen
  }

  // MARK: - Turn

  private var turnKey: String { LiveStageTurns.key("appControl", context: stageContext, layout: duo) }
  private var turned: Bool { turns.isTurned(turnKey) }

  // MARK: - Data

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
    guard !isPreview else { return }
    let shouldRun = isLiveCapable
      && inspect == nil
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

  /// Subscribes again on the same session, as the poll does after an end.
  private func reconnect() {
    guard isLiveCapable, syncService.connectionState == .connected else { return }
    guard let session else {
      updateLifecycle()
      return
    }
    Task { await session.start(using: syncService) }
  }

  // MARK: - Inspect

  /// Freezes the last frame, then stops the subscription. The app itself keeps
  /// running on the Mac — only the stream stops, which is what makes a hit-test
  /// a still picture rather than one that moves under the finger.
  private func beginInspect() {
    guard inspect == nil, let session, let image = session.image else { return }
    ADEHaptics.light()
    let model = LiveInspectMarkupModel(surface: .appControl, laneId: laneId, chatSessionId: chatSessionId)
    model.begin(
      plan: .appControl(
        image: image,
        scaleX: session.frameScaleX.map { CGFloat($0) },
        viewportWidth: session.frameViewportWidth.map { CGFloat($0) },
        viewportHeight: session.frameViewportHeight.map { CGFloat($0) }
      ),
      using: syncService
    )
    inspect = model
    stopSession()
  }

  private func exitInspect() {
    guard inspect != nil else { return }
    inspect = nil
    updateLifecycle()
  }
}

/// Inspect in the menu, once there is a frame to freeze. Its own view so the
/// frame's arrival re-renders the tile, not the viewer.
private struct AppControlInspectTile: View {
  @ObservedObject var session: AppControlLiveSession
  let action: () -> Void

  var body: some View {
    LiveStageMenuTile(title: "Inspect", systemImage: "viewfinder", disabled: session.image == nil, action: action)
      .accessibilityHint("Freezes the picture so you can pick an element and mark it up")
      .accessibilityIdentifier("AppControlViewer.Inspect")
  }
}

/// Reconnect in the menu while the subscription has ended or failed.
private struct AppControlReconnectRow: View {
  @ObservedObject var session: AppControlLiveSession
  let action: () -> Void

  var body: some View {
    switch session.phase {
    case .ended, .failed, .idle:
      LiveStageMenuRow(title: "Reconnect", systemImage: "arrow.clockwise", action: action)
    default:
      EmptyView()
    }
  }
}

#if DEBUG
/// What the fixture screen seeds the viewer with.
struct AppControlViewerPreview {
  var appControl = WorkToolsAppControlState(appName: "Ghost", status: "connected", driver: "cdp")
}

/// A drawn stand-in for an app window's picture.
struct AppControlPreviewPicture: View {
  var body: some View {
    GeometryReader { proxy in
      let unit = proxy.size.width / 1000
      HStack(spacing: 0) {
        VStack(alignment: .leading, spacing: 16 * unit) {
          ForEach(0..<6, id: \.self) { row in
            RoundedRectangle(cornerRadius: 6 * unit)
              .fill(Color.white.opacity(row == 1 ? 0.3 : 0.12))
              .frame(height: 26 * unit)
          }
          Spacer()
        }
        .padding(24 * unit)
        .frame(width: 240 * unit)
        .background(Color(red: 0.12, green: 0.13, blue: 0.17))
        VStack(alignment: .leading, spacing: 18 * unit) {
          Text("Dashboard")
            .font(.system(size: 40 * unit, weight: .bold))
            .foregroundStyle(.black)
          HStack(spacing: 18 * unit) {
            ForEach(0..<3, id: \.self) { _ in
              RoundedRectangle(cornerRadius: 12 * unit)
                .fill(Color(red: 0.36, green: 0.42, blue: 0.95).opacity(0.18))
                .frame(height: 140 * unit)
            }
          }
          RoundedRectangle(cornerRadius: 12 * unit)
            .fill(Color.gray.opacity(0.14))
          Spacer(minLength: 0)
        }
        .padding(32 * unit)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(white: 0.97))
      }
    }
  }
}
#endif
