import AVFoundation
import OSLog
import SwiftUI
import UIKit

private let appleViewerLog = Logger(subsystem: "com.ade.ios", category: "apple-stream")

/// Full-screen live view of the Mac's simulator, with an opt-in Control mode.
///
/// Watching is the default and the state everything falls back to. Control is
/// a press-and-hold away, never a tap: the device belongs to someone's Mac, and
/// a touch that reached it from a pocket would be worse than useless. While
/// controlling, the picture wears an orange frame and the bar says so; Done,
/// leaving the app, losing the stream, or an agent claiming the device all put
/// the viewer back to watching.
///
/// Video never rides the JSON sync envelope. The host mints a ticket over sync,
/// and this opens a second WebSocket to the address that ticket names —
/// directly to the brain when the phone can reach it, through the tunnel relay
/// when it cannot. The relay forwards binary frames verbatim, so the same
/// socket, parser and decoder serve both. Touches go the other way as
/// `apple.input` commands, in device points, to the machine that owns the lane.
struct AppleDeviceViewer: View {
  let laneId: String
  /// The chat the viewer was opened from; its own claim does not block it.
  var chatSessionId: String?
  /// The card's last status, so the ribbon and the aspect are right on the
  /// first frame rather than after the viewer's own first poll.
  var initialStatus: AppleDeviceStatus?
  #if DEBUG
  /// Fixture seam (`-adePreviewScreen apple-viewer`): a seeded model and a
  /// drawn stand-in for the picture, with no sync and no socket.
  var preview: AppleDeviceViewerPreview?
  #endif

  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase

  @StateObject private var model = AppleDeviceViewerModel()
  @State private var hint: String?
  @State private var hintTask: Task<Void, Never>?
  @State private var rotation: AppleDisplayRotation = .upright
  @State private var showsChrome = true
  @State private var holdProgress: CGFloat = 0
  @State private var gesture: AppleDeviceGesture?
  @State private var gestureIgnored = false
  @State private var touchMarks: [AppleTouchMark] = []
  @State private var showsKeyboard = false
  @State private var typed = ""
  @FocusState private var keyboardFocused: Bool
  @AppStorage("ade.appleViewer.showsSpeed") private var showsSpeed = false
  /// Where the bars end, so a controlling picture can sit between them.
  @State private var topBarBottom: CGFloat = 0
  @State private var bottomBarHeight: CGFloat = 0

  /// Long enough that a thumb resting on the bar does not take control.
  private static let holdToControl: Double = 0.6

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      // Watching, the picture fills the screen and the bars float over it.
      // Controlling, it fits between them: a back button under the top bar
      // must still be tappable. One stage either way, so the layer is never
      // rebuilt by a mode change.
      stage
        .padding(.top, model.mode == .controlling ? topBarBottom : 0)
        .padding(.bottom, model.mode == .controlling ? bottomBarHeight : 0)
        .ignoresSafeArea()
      VStack(spacing: 0) {
        if showsChrome || model.mode == .controlling {
          VStack(spacing: 6) {
            topBar
            if showsSpeed {
              speedReadout
                .transition(.opacity)
            }
          }
          .padding(.bottom, 6)
          .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxY } action: { topBarBottom = $0 }
          .transition(.move(edge: .top).combined(with: .opacity))
        }
        Spacer(minLength: 0)
        if let message = model.overlayMessage {
          statusOverlay(message)
        }
        Spacer(minLength: 0)
        if let hint {
          hintChip(hint)
            .padding(.bottom, 10)
        }
        if showsChrome || model.mode == .controlling {
          VStack(spacing: 0) {
            if showsKeyboard, model.mode == .controlling {
              keyboardBar
            }
            bottomBar
          }
          .onGeometryChange(for: CGFloat.self) { proxy in
            // Height from the bar's top to the bottom of the screen, safe
            // area included, which is what the stage gives up.
            proxy.size.height + proxy.safeAreaInsets.bottom
          } action: { bottomBarHeight = $0 }
          .transition(.move(edge: .bottom).combined(with: .opacity))
        }
      }
      .animation(.easeOut(duration: 0.2), value: showsChrome)
      .animation(.easeOut(duration: 0.2), value: model.mode)
      .animation(.easeOut(duration: 0.18), value: hint)
    }
    .preferredColorScheme(.dark)
    .statusBarHidden(model.mode == .controlling || !showsChrome)
    // A swipe up from the bottom of the simulator must reach the simulator,
    // not close this app.
    .defersSystemGestures(on: model.mode == .controlling ? .all : [])
    .persistentSystemOverlays(model.mode == .controlling ? .hidden : .automatic)
    .task(id: laneId) {
      #if DEBUG
      if let preview {
        model.installPreview(preview)
        return
      }
      #endif
      model.attach(
        syncService: syncService,
        laneId: laneId,
        chatSessionId: chatSessionId,
        status: initialStatus
      )
      await model.start()
    }
    .task(id: laneId) {
      #if DEBUG
      if preview != nil { return }
      #endif
      // Two timers in one loop: the health watchdogs, and the status poll that
      // keeps the owner ribbon and the recording dot honest. 1s is fast enough
      // for a 3s watchdog to fire on time and cheap enough to leave running
      // behind a full-screen view the user is actively watching.
      var tickCount = 0
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled else { return }
        model.tick()
        tickCount += 1
        if tickCount % 5 == 0 {
          await model.refreshStatus()
        }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      // `.inactive` counts as away: the app switcher card is a screenshot, and
      // holding a capture open on someone's Mac to feed it is not worth the
      // battery on either machine. It also ends control: nobody is looking.
      model.setVisible(phase == .active)
    }
    .onChange(of: model.mode) { _, mode in
      if mode == .watching {
        showsKeyboard = false
        keyboardFocused = false
        gesture = nil
      }
    }
    .onChange(of: model.notice) { _, notice in
      if let notice { flashHint(notice, haptic: .warning) }
    }
    .onDisappear {
      hintTask?.cancel()
      model.stop()
    }
  }

  // MARK: - Stage

  private var stage: some View {
    GeometryReader { proxy in
      let container = proxy.size
      let rect = AppleDeviceTouchMapping.pictureRect(
        container: container,
        content: model.contentPixelSize,
        rotation: rotation
      )
      ZStack(alignment: .topLeading) {
        if let rect {
          picture(in: rect)
          if model.mode == .controlling {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
              .strokeBorder(ADEColor.warning, lineWidth: 3)
              .frame(width: rect.width + 6, height: rect.height + 6)
              .position(x: rect.midX, y: rect.midY)
              .allowsHitTesting(false)
          }
          ForEach(touchMarks) { mark in
            Circle()
              .fill(Color.white.opacity(0.35))
              .overlay(Circle().strokeBorder(Color.white.opacity(0.8), lineWidth: 1.5))
              .frame(width: 34, height: 34)
              .position(mark.location)
              .transition(.scale(scale: 0.4).combined(with: .opacity))
              .allowsHitTesting(false)
          }
        }
      }
      .frame(width: container.width, height: container.height)
      .contentShape(Rectangle())
      .gesture(stageGesture(picture: rect))
      .accessibilityElement()
      .accessibilityLabel(
        model.mode == .controlling
          ? "The simulator's screen. Your touches drive it."
          : "The simulator's screen. View only."
      )
      .accessibilityAddTraits(model.mode == .controlling ? .allowsDirectInteraction : [])
    }
  }

  /// The layer, laid out at the picture's own (unturned) size and turned
  /// about its centre. Turning an aspect-fit view instead of laying it out
  /// turned leaves it overflowing the stage sideways.
  private func picture(in rect: CGRect) -> some View {
    let size = rotation.isSideways ? CGSize(width: rect.height, height: rect.width) : rect.size
    return pictureContent
      .frame(width: size.width, height: size.height)
      .rotationEffect(.degrees(rotation.degrees))
      .position(x: rect.midX, y: rect.midY)
      .opacity(model.health.phase == .streaming ? 1 : 0.35)
      .allowsHitTesting(false)
  }

  @ViewBuilder
  private var pictureContent: some View {
    #if DEBUG
    if preview != nil {
      AppleViewerPreviewPicture()
    } else {
      AppleStreamLayerView(layer: model.decoder.layer)
    }
    #else
    AppleStreamLayerView(layer: model.decoder.layer)
    #endif
  }

  private func stageGesture(picture rect: CGRect?) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .local)
      .onChanged { value in
        guard model.mode == .controlling else { return }
        guard let rect, !gestureIgnored else { return }
        if gesture == nil {
          // A touch that starts outside the picture is a touch on the black
          // bars, not on the device: the whole gesture is ignored rather
          // than clamped onto the screen's edge.
          guard rect.contains(value.startLocation),
                let start = model.devicePoint(for: value.startLocation, in: rect, rotation: rotation)
          else {
            gestureIgnored = true
            return
          }
          gesture = AppleDeviceGesture(start: start, at: Date())
          addTouchMark(at: value.startLocation)
        }
        if let point = model.devicePoint(for: value.location, in: rect, rotation: rotation) {
          gesture?.move(to: point)
        }
      }
      .onEnded { value in
        defer {
          gesture = nil
          gestureIgnored = false
        }
        guard model.mode == .controlling else {
          watchingTap()
          return
        }
        guard let rect, let started = gesture,
              let end = model.devicePoint(for: value.location, in: rect, rotation: rotation)
        else { return }
        model.send(gesture: started, endingAt: end)
      }
  }

  /// What a touch on the picture does while watching: shows or hides the
  /// bars, and says once that touches are not sent.
  private func watchingTap() {
    withAnimation(.easeOut(duration: 0.2)) { showsChrome.toggle() }
    if showsChrome, model.controlBlocker == nil {
      flashHint("View only. Hold Control to drive it.", haptic: nil)
    }
  }

  private func addTouchMark(at location: CGPoint) {
    let mark = AppleTouchMark(location: location)
    withAnimation(.easeOut(duration: 0.12)) { touchMarks.append(mark) }
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(380))
      withAnimation(.easeOut(duration: 0.2)) { touchMarks.removeAll { $0.id == mark.id } }
    }
  }

  // MARK: - Bars

  private var topBar: some View {
    HStack(spacing: 12) {
      roundButton(systemName: "xmark", label: "Close") {
        model.stop()
        dismiss()
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(model.status?.device?.name ?? "Simulator")
          .shadow(color: .black.opacity(0.6), radius: 3)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.white)
          .lineLimit(1)
        Text(ribbon)
          .font(.caption2)
          .foregroundStyle(.white.opacity(0.8))
          .lineLimit(1)
          .shadow(color: .black.opacity(0.6), radius: 3)
      }
      Spacer(minLength: 0)
      if model.status?.recording?.active == true {
        Image(systemName: "record.circle")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.danger)
          .accessibilityLabel("Recording")
      }
      if model.health.offersReconnect {
        roundButton(systemName: "arrow.clockwise", label: "Reconnect") {
          Task { await model.reconnect() }
        }
      }
      roundButton(
        systemName: "speedometer",
        label: showsSpeed ? "Hide speed" : "Show speed",
        highlighted: showsSpeed
      ) {
        withAnimation(.easeOut(duration: 0.18)) { showsSpeed.toggle() }
      }
      roundButton(
        systemName: rotation.isSideways ? "rotate.left" : "rotate.right",
        label: rotation.isSideways ? "Show upright" : "Turn the picture"
      ) {
        withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
          rotation = rotation.isSideways ? .upright : .clockwise
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 8)
    .background(
      LinearGradient(colors: [.black.opacity(0.85), .black.opacity(0)], startPoint: .top, endPoint: .bottom)
        .ignoresSafeArea(edges: .top)
    )
  }

  @ViewBuilder
  private var bottomBar: some View {
    Group {
      switch model.mode {
      case .watching:
        modeSwitch
      case .controlling:
        controllingBar
      }
    }
    .padding(.horizontal, 14)
    .padding(.top, 10)
    .padding(.bottom, 8)
    .frame(maxWidth: .infinity)
    .background(
      LinearGradient(colors: [.black.opacity(0), .black.opacity(0.75)], startPoint: .top, endPoint: .bottom)
        .ignoresSafeArea(edges: .bottom)
    )
  }

  /// View | Control. View is where the viewer starts and the selected half;
  /// Control fills as it is held and only then takes over.
  private var modeSwitch: some View {
    let blocker = model.controlBlocker
    return VStack(spacing: 8) {
      HStack(spacing: 0) {
        Label("View only", systemImage: "eye")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.white)
          .frame(maxWidth: .infinity)
          .frame(height: 44)
          .background(Color.white.opacity(0.18), in: Capsule())
          .accessibilityAddTraits(.isSelected)
        controlHalf(enabled: blocker == nil)
      }
      .padding(4)
      .background(Color.black.opacity(0.55), in: Capsule())
      .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
      .frame(maxWidth: 420)
      if let blocker {
        Text(blocker)
          .font(.caption)
          .foregroundStyle(.white.opacity(0.7))
          .multilineTextAlignment(.center)
      }
    }
  }

  private func controlHalf(enabled: Bool) -> some View {
    Label("Control", systemImage: "hand.point.up.left")
      .font(.footnote.weight(.semibold))
      .foregroundStyle(enabled ? .white : .white.opacity(0.35))
      .frame(maxWidth: .infinity)
      .frame(height: 44)
      // The fill is a background so it can never size the half: it grows
      // left to right while the half is held.
      .background(alignment: .leading) {
        GeometryReader { proxy in
          Capsule()
            .fill(ADEColor.warning.opacity(0.85))
            .frame(width: proxy.size.width * holdProgress)
        }
      }
    .clipShape(Capsule())
    .contentShape(Capsule())
    .onLongPressGesture(
      minimumDuration: Self.holdToControl,
      maximumDistance: 24,
      perform: {
        guard enabled else { return }
        holdProgress = 0
        ADEHaptics.success()
        model.beginControl()
        if model.mode == .controlling {
          flashHint("You're driving the simulator. Done hands it back.", haptic: nil)
        }
      },
      onPressingChanged: { pressing in
        guard enabled else {
          if pressing, let blocker = model.controlBlocker { flashHint(blocker, haptic: .warning) }
          return
        }
        if pressing {
          ADEHaptics.light()
          withAnimation(.linear(duration: Self.holdToControl)) { holdProgress = 1 }
        } else {
          // Let go early: say how, and empty the fill.
          if model.mode == .watching {
            flashHint("Hold to take control.", haptic: nil)
          }
          withAnimation(.easeOut(duration: 0.15)) { holdProgress = 0 }
        }
      }
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Control")
    .accessibilityHint("Touch and hold to drive the simulator with your touches.")
    .accessibilityAction(named: "Take control") {
      guard enabled else { return }
      model.beginControl()
    }
  }

  private var controllingBar: some View {
    HStack(spacing: 10) {
      VStack(alignment: .leading, spacing: 2) {
        Label("Controlling", systemImage: "hand.point.up.left.fill")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(ADEColor.warning)
        Text("Touches go to \(model.status?.device?.name ?? "the simulator")")
          .font(.caption2)
          .foregroundStyle(.white.opacity(0.7))
          .lineLimit(1)
      }
      Spacer(minLength: 0)
      roundButton(systemName: "keyboard", label: "Type", highlighted: showsKeyboard) {
        showsKeyboard.toggle()
        keyboardFocused = showsKeyboard
      }
      roundButton(systemName: "circle.circle", label: "Home") {
        model.pressHome()
      }
      Button {
        ADEHaptics.light()
        model.endControl()
      } label: {
        Text("Done")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.black)
          .padding(.horizontal, 18)
          .frame(minHeight: 44)
          .background(ADEColor.warning, in: Capsule())
      }
      .buttonStyle(.plain)
      .accessibilityHint("Stop sending touches and go back to watching.")
    }
    .frame(maxWidth: 520)
  }

  private var keyboardBar: some View {
    HStack(spacing: 8) {
      TextField("Type on the simulator", text: $typed)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($keyboardFocused)
        .submitLabel(.send)
        .onSubmit {
          model.type(typed)
          typed = ""
          keyboardFocused = true
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 40)
        .background(Color.white.opacity(0.12), in: Capsule())
        .foregroundStyle(.white)
      roundButton(systemName: "return", label: "Return") {
        model.type("\n")
      }
    }
    .padding(.horizontal, 14)
    .padding(.bottom, 6)
    .frame(maxWidth: 520)
  }

  private var speedReadout: some View {
    let speed = model.speed
    return HStack(spacing: 12) {
      speedCell("fps", speed.fps.map { "\($0)" })
      speedCell("video", speed.kbps.map { appleStreamBitrateLabel(kbps: $0) })
      speedCell("round trip", speed.rttMs.map { "\(Int($0.rounded())) ms" })
      speedCell("tap → screen", speed.tapToFrameMs.map { "\(Int($0.rounded())) ms" })
      if let skipped = speed.skipped, skipped > 0 {
        speedCell("skipped", "\(skipped)")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(.black.opacity(0.6), in: Capsule())
    .accessibilityElement(children: .combine)
  }

  private func speedCell(_ label: String, _ value: String?) -> some View {
    VStack(spacing: 1) {
      Text(value ?? "–")
        .font(.caption.monospacedDigit().weight(.semibold))
        .foregroundStyle(.white)
      Text(label)
        .font(.system(size: 9))
        .foregroundStyle(.white.opacity(0.6))
    }
  }

  private func roundButton(
    systemName: String,
    label: String,
    highlighted: Bool = false,
    action: @escaping () -> Void
  ) -> some View {
    Button {
      ADEHaptics.light()
      action()
    } label: {
      Image(systemName: systemName)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(highlighted ? .black : .white)
        .frame(width: 44, height: 44)
        // Dark discs read over a light picture and a dark one alike.
        .background(highlighted ? Color.white.opacity(0.85) : Color.black.opacity(0.68), in: Circle())
        .overlay(Circle().strokeBorder(Color.white.opacity(highlighted ? 0 : 0.18), lineWidth: 1))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  private func statusOverlay(_ message: String) -> some View {
    VStack(spacing: 12) {
      if model.health.phase == .connecting || model.health.phase == .requestingTicket {
        ProgressView().tint(.white)
      }
      Text(message)
        .font(.footnote)
        .foregroundStyle(.white.opacity(0.85))
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
      if model.health.offersReconnect {
        Button {
          ADEHaptics.light()
          Task { await model.reconnect() }
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

  private func hintChip(_ text: String) -> some View {
    Text(text)
      .font(.caption.weight(.semibold))
      .foregroundStyle(.white)
      .multilineTextAlignment(.center)
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .background(.black.opacity(0.7), in: Capsule())
      .padding(.horizontal, 24)
      .transition(.opacity)
      .allowsHitTesting(false)
  }

  /// "Watching · owned by <chat>" — the one sentence that stops a viewer from
  /// mistaking a device an agent is driving for one that is idle.
  ///
  /// The host resolves the title, and hands back null rather than a fabricated
  /// name when it cannot, so a missing title costs the ribbon its name and
  /// never the claim itself.
  private var ribbon: String {
    var parts = [model.mode == .controlling ? "Controlling" : "Watching"]
    if let owner = appleDeviceOwnerLabel(model.status?.owner) {
      parts.append("owned by \(owner)")
    }
    if let machine = model.machineName {
      parts.append("on \(machine)")
    }
    return parts.joined(separator: " · ")
  }

  private enum HintHaptic { case warning }

  /// One line at a time, 2s, restarted on each call rather than queued, so
  /// hammering the screen does not stack timers.
  private func flashHint(_ text: String, haptic: HintHaptic?) {
    if haptic == .warning { ADEHaptics.warning() }
    hint = text
    hintTask?.cancel()
    hintTask = Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(2_000))
      guard !Task.isCancelled else { return }
      hint = nil
      model.clearNotice()
    }
  }
}

/// Where a finger touched the picture, drawn for a moment so the person sees
/// the touch land before the Mac's frame comes back.
struct AppleTouchMark: Identifiable, Equatable {
  let id = UUID()
  let location: CGPoint
}

/// The speed readout's numbers. Nil is "not measured yet", shown as a dash.
struct AppleViewerSpeed: Equatable {
  var fps: Int?
  var kbps: Double?
  var rttMs: Double?
  var tapToFrameMs: Double?
  var skipped: Int?
}

// MARK: - Model

/// Owns the ticket, the socket, the decoder, the health clock and the mode.
///
/// An `ObservableObject` rather than view state because all of it outlives a
/// SwiftUI body evaluation and must be torn down exactly once, on dismiss.
@MainActor
final class AppleDeviceViewerModel: ObservableObject {
  @Published private(set) var health = AppleStreamHealth()
  @Published private(set) var status: AppleDeviceStatus?
  @Published private(set) var mode: AppleDeviceViewerMode = .watching
  /// A sentence the view flashes once (control ended, a gesture refused).
  @Published private(set) var notice: String?
  @Published private(set) var speed = AppleViewerSpeed()
  /// The decoded picture's pixel size, published only when it changes: a
  /// rotation on the Mac or a Duo fold resizes the stage once, not per frame.
  @Published private(set) var contentPixelSize = CGSize(width: 9, height: 19.5)
  /// The machine the lane lives on, when it is not the focused one.
  @Published private(set) var machineName: String?

  let decoder = AppleStreamDecoder()

  private let socket = AppleStreamSocket()
  private weak var syncService: SyncService?
  private var laneId: String = ""
  private var chatSessionId: String?
  private(set) var ticket: AppleStreamTicket?
  /// The helper's metrics in pixels, from the stream's config record.
  private var configPixels: CGSize?
  private var visible = true
  private var started = false
  private var rateMeter = AppleStreamRateMeter()
  private var latency = AppleTapLatencyProbe()
  private var networkStats: AppleStreamNetworkStats?
  private var lastSpeedPublish = Date.distantPast
  /// When the person last touched the picture while controlling.
  private var lastControlActivity = Date()

  #if DEBUG
  private var isPreview = false

  func installPreview(_ preview: AppleDeviceViewerPreview) {
    isPreview = true
    status = preview.status
    contentPixelSize = CGSize(width: 1206, height: 2622)
    health.frameDecoded(at: Date())
    speed = preview.speed
    mode = preview.mode
  }
  #endif

  /// Control hands itself back after this long without a touch: a phone put
  /// down mid-session should not leave a live input path into someone's Mac.
  static let controlIdleTimeout: TimeInterval = 5 * 60

  func attach(syncService: SyncService, laneId: String, chatSessionId: String?, status: AppleDeviceStatus?) {
    self.syncService = syncService
    self.laneId = laneId
    self.chatSessionId = chatSessionId
    if self.status == nil { self.status = status }
    if let remote = workParseRemoteLaneId(laneId) {
      machineName = syncService.machineFleet?.connection(for: remote.machineKey)?.hostName
    }
    if let ticketSize = Self.ticketPixelSize(status: status, ticket: nil) {
      contentPixelSize = ticketSize
    }
    socket.onOpen = { [weak self] in
      self?.health.socketOpened(at: Date())
    }
    socket.onRecord = { [weak self] record in
      self?.handle(record)
    }
    socket.onStats = { [weak self] stats in
      self?.networkStats = stats
    }
    socket.onError = { [weak self] message in
      guard let self else { return }
      // A failure after frames were flowing is a stall the user can retry;
      // before any frame it is a connection that never worked. Both offer
      // Reconnect, but only the second names the host's own reason.
      self.health.fail(message)
      self.endControl(notice: nil)
    }
  }

  func start() async {
    guard !started else { return }
    started = true
    await connect()
  }

  func stop() {
    started = false
    mode = .watching
    socket.setVisible(false)
    socket.close()
    decoder.reset()
    health.reset()
  }

  func reconnect() async {
    // A fresh ticket, not a redial: tickets are short-lived and single-use by
    // design, so reusing one would fail in a way that reads like a broken Mac.
    socket.close()
    decoder.reset()
    ticket = nil
    configPixels = nil
    await connect()
  }

  func setVisible(_ nextVisible: Bool) {
    guard visible != nextVisible else { return }
    visible = nextVisible
    socket.setVisible(nextVisible)
    if !nextVisible {
      endControl(notice: nil)
      return
    }
    // Coming back: the brain stopped forwarding while we were away, and the
    // capture may have been stopped entirely, so a redial is the only way to
    // be sure of a keyframe.
    Task { await reconnect() }
  }

  func tick() {
    let now = Date()
    health.tick(now: now)
    if mode == .controlling {
      if health.phase != .streaming {
        endControl(notice: "Control ended: the picture stopped.")
      } else if now.timeIntervalSince(lastControlActivity) >= Self.controlIdleTimeout {
        endControl(notice: "Control ended after 5 idle minutes.")
      }
    }
    publishSpeed(now: now, force: true)
  }

  func clearNotice() {
    notice = nil
  }

  /// What the overlay says. The host's own capture error wins over the phone's
  /// "no frames arrived", because the Mac knows why its helper stopped and this
  /// end only knows that nothing showed up.
  var overlayMessage: String? {
    guard let message = health.statusMessage else { return nil }
    if case .stalled = health.phase, let hostError = status?.stream?.lastError, !hostError.isEmpty {
      return hostError
    }
    return message
  }

  func refreshStatus() async {
    guard let syncService, syncService.supportsAppleAction("apple.status", laneId: laneId) else { return }
    guard let next = try? await syncService.fetchAppleDeviceStatus(laneId: laneId) else { return }
    let previousUdid = status?.device?.udid
    status = next
    // Another device is behind the picture now: a touch aimed at the old one
    // must not land on it.
    if mode == .controlling, let previousUdid, next.device?.udid != previousUdid {
      endControl(notice: "The simulator changed. You're watching.")
      return
    }
    // An agent's chat claimed the device: the host refuses this phone's
    // touches from now on, so stop offering them before the next one fails.
    if mode == .controlling,
       let owner = appleDeviceOwnerLabel(appleDeviceForeignOwner(next.owner, viewerChatSessionId: chatSessionId)) {
      endControl(notice: "\(owner) took the simulator. You're watching.")
    }
  }

  // MARK: Control

  /// The helper's point metrics, or nil when this host cannot tell us (and
  /// so cannot be controlled from here).
  var pointMetrics: CGSize? {
    AppleDeviceTouchMapping.pointMetrics(
      configPixels: configPixels,
      ticketPixels: ticket.flatMap { ticket in
        guard let width = ticket.width, let height = ticket.height else { return nil }
        return CGSize(width: width, height: height)
      },
      ticketPoints: ticket.flatMap { ticket in
        guard let width = ticket.pointWidth, let height = ticket.pointHeight else { return nil }
        return CGSize(width: width, height: height)
      }
    )
  }

  /// Why Control cannot be offered, or nil when it can.
  var controlBlocker: String? {
    #if DEBUG
    if isPreview { return nil }
    #endif
    return appleDeviceControlBlocker(
      hostSupportsControl: syncService?.supportsAppleDeviceControl(laneId: laneId) ?? false,
      pointMetrics: pointMetrics,
      ownsDevice: appleStatusShowsLaneDevice(status),
      owner: appleDeviceForeignOwner(status?.owner, viewerChatSessionId: chatSessionId),
      streaming: health.phase == .streaming
    )
  }

  func beginControl() {
    guard controlBlocker == nil else {
      notice = controlBlocker
      return
    }
    lastControlActivity = Date()
    mode = .controlling
    appleViewerLog.notice("control on lane=\(self.laneId, privacy: .public)")
  }

  func endControl() {
    endControl(notice: nil)
  }

  private func endControl(notice: String?) {
    guard mode == .controlling else { return }
    mode = .watching
    if let notice { self.notice = notice }
    appleViewerLog.notice("control off lane=\(self.laneId, privacy: .public)")
  }

  /// A location on the stage, as device points, or nil when there is nothing
  /// to map against yet.
  func devicePoint(for location: CGPoint, in picture: CGRect, rotation: AppleDisplayRotation) -> CGPoint? {
    guard let metrics = pointMetrics,
          let fraction = AppleDeviceTouchMapping.frameFraction(of: location, in: picture, rotation: rotation)
    else { return nil }
    return AppleDeviceTouchMapping.devicePoint(frameFraction: fraction, metrics: metrics)
  }

  func send(gesture: AppleDeviceGesture, endingAt end: CGPoint) {
    guard mode == .controlling else { return }
    let sentAt = Date()
    lastControlActivity = sentAt
    latency.gestureSent(at: sentAt)
    sendInput(gesture.payload(endingAt: end, at: sentAt))
  }

  func type(_ text: String) {
    guard mode == .controlling, !text.isEmpty else { return }
    lastControlActivity = Date()
    latency.gestureSent(at: Date())
    sendInput(["kind": "type", "text": text])
  }

  func pressHome() {
    guard mode == .controlling, let syncService else { return }
    lastControlActivity = Date()
    latency.gestureSent(at: Date())
    let lane = laneId
    let chat = chatSessionId
    Task { [weak self] in
      do {
        try await syncService.pressAppleDeviceButton(laneId: lane, chatSessionId: chat, name: "home")
      } catch {
        self?.inputFailed(error)
      }
    }
  }

  /// Fired without waiting on the previous one, like the desktop pane: the
  /// host serialises device input in arrival order, and waiting here would
  /// add a round trip to every tap after the first.
  private func sendInput(_ payload: [String: Any]) {
    guard let syncService else { return }
    var payload = payload
    if let chatSessionId { payload["chatSessionId"] = chatSessionId }
    let lane = laneId
    let kind = payload["kind"] as? String ?? "?"
    let started = Date()
    Task { [weak self] in
      do {
        try await syncService.sendAppleDeviceInput(laneId: lane, payload: payload)
        let ms = Int(Date().timeIntervalSince(started) * 1_000)
        appleViewerLog.debug("input \(kind, privacy: .public) acked in \(ms)ms")
      } catch {
        self?.inputFailed(error)
      }
    }
  }

  private func inputFailed(_ error: Error) {
    let message = (error as NSError).localizedDescription
    appleViewerLog.error("input failed: \(message, privacy: .public)")
    if message.contains("APPLE_OWNED_BY_OTHER_SESSION") {
      endControl(notice: "An agent is driving this simulator now. You're watching.")
      Task { await refreshStatus() }
      return
    }
    notice = message
  }

  // MARK: Stream

  /// Aspect source before the first keyframe: the ticket's geometry, then the
  /// status's. The decoder's own size replaces it on the first frame.
  private static func ticketPixelSize(status: AppleDeviceStatus?, ticket: AppleStreamTicket?) -> CGSize? {
    if let ticket, let width = ticket.width, let height = ticket.height, width > 0, height > 0 {
      return CGSize(width: width, height: height)
    }
    if let stream = status?.stream, let width = stream.width, let height = stream.height, width > 0, height > 0 {
      return CGSize(width: width, height: height)
    }
    return nil
  }

  private func connect() async {
    guard started else { return }
    guard let syncService else { return }
    guard syncService.supportsAppleAction("apple.streamTicket", laneId: laneId) else {
      health.markUnsupported()
      return
    }
    health.requestTicket()
    let ticket: AppleStreamTicket
    do {
      ticket = try await syncService.requestAppleStreamTicket(laneId: laneId)
    } catch {
      health.fail(appleStreamTicketFailureMessage((error as NSError).localizedDescription))
      return
    }
    // The view may have been dismissed while the ticket round-trip was in
    // flight. Connecting now would reopen the socket `stop()` just closed and
    // leave a live WebSocket (and the Mac's capture) with no teardown.
    guard started, !Task.isCancelled else { return }
    self.ticket = ticket
    if let size = Self.ticketPixelSize(status: status, ticket: ticket) {
      contentPixelSize = size
    }
    // The machine that minted the ticket is the one to dial: a lane on another
    // Mac answers on that Mac's address, not the focused one's.
    let endpoint = syncService.appleStreamEndpoint(laneId: laneId)
    guard
      let url = appleStreamSocketURL(
        ticketURL: ticket.url,
        path: ticket.path,
        token: ticket.token,
        connectedAddress: endpoint.address,
        fallbackPort: endpoint.fallbackPort
      )
    else {
      health.fail("Your Mac sent an address this phone can't reach.")
      return
    }
    health.connecting()
    decoder.reset()
    socket.connect(url: url, token: ticket.token)
    socket.setVisible(visible)
  }

  private func handle(_ record: AppleStreamRecord) {
    switch record {
    case .config(_, let width, let height, let annexB):
      guard annexB else {
        // The decoder is built from inline SPS/PPS, so a stream that is not
        // Annex-B would configure cleanly and then show nothing. Saying so is
        // better than a blank rectangle.
        health.fail("This Mac is sending video this phone can't decode.")
        socket.close()
        return
      }
      if let width, let height, width > 0, height > 0 {
        configPixels = CGSize(width: width, height: height)
      }
    case .accessUnit(let keyframe, let bytes):
      let now = Date()
      rateMeter.record(bytes: bytes.count, at: now)
      guard decoder.decode(accessUnit: bytes, keyframe: keyframe) else { return }
      health.frameDecoded(at: now)
      if let size = decoder.presentedSize, size != contentPixelSize, size.width > 0, size.height > 0 {
        contentPixelSize = size
      }
      if let ms = latency.frame(bytes: bytes.count, keyframe: keyframe, at: now) {
        appleViewerLog.notice(
          "tap→frame \(Int(ms.rounded()))ms rtt=\(Int(self.networkStats?.rttMs ?? -1))ms"
        )
        publishSpeed(now: now, force: true)
      } else {
        publishSpeed(now: now, force: false)
      }
    }
  }

  /// At most four times a second: the readout is for people, and publishing
  /// per frame would re-render the whole viewer at the stream's frame rate.
  private func publishSpeed(now: Date, force: Bool) {
    guard force || now.timeIntervalSince(lastSpeedPublish) >= 0.25 else { return }
    lastSpeedPublish = now
    rateMeter.trim(now: now)
    let next = AppleViewerSpeed(
      fps: health.phase == .streaming ? rateMeter.framesPerSecond : nil,
      kbps: health.phase == .streaming ? rateMeter.kilobitsPerSecond : nil,
      rttMs: networkStats?.rttMs,
      tapToFrameMs: latency.medianMs,
      skipped: networkStats?.skipped
    )
    if next != speed { speed = next }
  }
}

// MARK: - Layer host

/// Hosts the decoder's `AVSampleBufferDisplayLayer`.
///
/// The layer belongs to the decoder, not to this view: SwiftUI rebuilds a
/// representable freely, and a layer recreated on a rebuild would drop the
/// format description and stall until the next keyframe.
struct AppleStreamLayerView: UIViewRepresentable {
  let layer: AVSampleBufferDisplayLayer

  func makeUIView(context: Context) -> AppleStreamLayerHostView {
    let view = AppleStreamLayerHostView()
    view.install(layer)
    return view
  }

  func updateUIView(_ uiView: AppleStreamLayerHostView, context: Context) {
    uiView.install(layer)
  }
}

final class AppleStreamLayerHostView: UIView {
  private weak var installed: AVSampleBufferDisplayLayer?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    isUserInteractionEnabled = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func install(_ next: AVSampleBufferDisplayLayer) {
    guard installed !== next else { return }
    installed?.removeFromSuperlayer()
    layer.addSublayer(next)
    installed = next
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // No implicit animation: the layer is resized on rotation and on the first
    // frame, and an animated bounds change makes the picture visibly swim.
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    installed?.frame = bounds
    CATransaction.commit()
  }
}

/// Bitrate as the stream stats say it. Sub-megabit reads in kb/s because "0.8 Mb/s"
/// is a worse answer than "800 kb/s" for the number people are watching drop.
func appleStreamBitrateLabel(kbps: Double) -> String {
  guard kbps > 0 else { return "0 kb/s" }
  if kbps < 1000 { return "\(Int(kbps.rounded())) kb/s" }
  return String(format: "%.1f Mb/s", kbps / 1000)
}

#if DEBUG
/// What the fixture screen seeds the viewer with.
struct AppleDeviceViewerPreview {
  var status: AppleDeviceStatus
  var mode: AppleDeviceViewerMode
  var speed = AppleViewerSpeed(fps: 60, kbps: 1840, rttMs: 38, tapToFrameMs: 142, skipped: 0)
}

/// A drawn stand-in for the simulator's picture: a Settings-like list, so a
/// screenshot shows where the picture sits and how the bars cover it.
struct AppleViewerPreviewPicture: View {
  var body: some View {
    GeometryReader { proxy in
      let unit = proxy.size.width / 402
      VStack(alignment: .leading, spacing: 10 * unit) {
        Text("Settings")
          .font(.system(size: 34 * unit, weight: .bold))
          .padding(.top, 70 * unit)
        ForEach(["General", "Accessibility", "Appearance", "Camera", "Control Center", "Display"], id: \.self) { row in
          HStack {
            RoundedRectangle(cornerRadius: 7 * unit)
              .fill(Color.gray.opacity(0.5))
              .frame(width: 30 * unit, height: 30 * unit)
            Text(row).font(.system(size: 17 * unit))
            Spacer()
            Image(systemName: "chevron.right")
              .font(.system(size: 13 * unit))
              .foregroundStyle(.secondary)
          }
          .padding(.horizontal, 16 * unit)
          .frame(height: 44 * unit)
          .background(Color.white, in: RoundedRectangle(cornerRadius: 12 * unit))
        }
        Spacer()
      }
      .padding(.horizontal, 16 * unit)
      .frame(width: proxy.size.width, height: proxy.size.height, alignment: .top)
      .background(Color(white: 0.95))
      .foregroundStyle(.black)
    }
  }
}
#endif
