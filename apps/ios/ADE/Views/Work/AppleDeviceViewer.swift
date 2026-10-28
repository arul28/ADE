import SwiftUI
import UIKit


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
  /// The viewer is a column in a split, not a full-screen cover: it keeps the
  /// device name and status (small) and gives up its own close button, the
  /// dark window preference and the status-bar hiding, because it shares the
  /// window with a chat that must keep its appearance.
  var embedded = false
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
  /// The frozen inspect view, over everything, until its Close resumes the
  /// stream.
  @State private var inspect: LiveInspectMarkupModel?

  /// Long enough that a thumb resting on the bar does not take control.
  private static let holdToControl: Double = 0.6

  var body: some View {
    lifecycleModifiers(viewerChrome)
  }

  private var viewerChrome: some View {
    viewerContent
      .animation(.easeOut(duration: 0.18), value: inspect != nil)
      // Only a full-screen viewer owns the window's appearance. In a pane the
      // pane scopes dark itself; a preferredColorScheme here would turn the whole
      // app dark around the chat.
      .preferredColorScheme(embedded ? nil : .dark)
      .statusBarHidden(!embedded && (model.mode == .controlling || !showsChrome))
      // A swipe up from the bottom of the simulator must reach the simulator,
      // not close this app.
      .defersSystemGestures(on: model.mode == .controlling ? .all : [])
      .persistentSystemOverlays(embedded ? .automatic : (model.mode == .controlling ? .hidden : .automatic))
  }

  @ViewBuilder
  private var viewerContent: some View {
    if embedded {
      paneContent
    } else {
      fullScreenContent
    }
  }

  /// The pane form (the Work tools pane on the Duo): the device picture, as
  /// large as the column allows, on the pane's own background with a device's
  /// corners and a soft shadow; every control sits in the pane's own header
  /// row (never the toolbar, which is the chat's rail). Nothing is drawn over
  /// the picture but the transient hint and status, and the speed readout
  /// when asked for.
  private var paneContent: some View {
    ZStack {
      ADEColor.pageBackground
        .ignoresSafeArea()
      stage
        .padding(16)
      VStack(spacing: 0) {
        if showsSpeed {
          speedReadout
            .padding(.top, 10)
            .transition(.opacity)
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
        if showsKeyboard, model.mode == .controlling {
          keyboardBar
            .padding(.bottom, 8)
        }
      }
      .animation(.easeOut(duration: 0.18), value: hint)
      .animation(.easeOut(duration: 0.18), value: showsSpeed)
    }
    .duoPaneHeader(status: paneSubtitle) { paneActions }
    // In the Duo's tools pane the frozen inspector takes the whole screen: it
    // has its own bar and a picture | inspector split across the fold, and
    // drawn inside the pane its stack would take over the chat's title and
    // rail.
    .fullScreenCover(isPresented: Binding(
      get: { embedded && inspect != nil },
      set: { presented in if !presented, inspect != nil { exitInspect() } }
    )) {
      if let inspect {
        LiveInspectStage(model: inspect, onClose: exitInspect)
      }
    }
  }

  /// The device and what is happening to it, under the pane's title.
  private var paneSubtitle: String {
    var parts = [model.status?.device?.name ?? "Simulator", ribbon]
    if model.status?.recording?.active == true { parts.append("Recording") }
    return parts.joined(separator: " · ")
  }

  /// The tool's controls in the pane header: Inspect, Rotate, Speed, the
  /// controlling-only Type / Home / hardware buttons, then Watch | Control.
  @ViewBuilder
  private var paneActions: some View {
    if canInspect {
      DuoPaneActionButton(title: "Inspect", systemImage: "viewfinder") { beginInspect() }
        .accessibilityHint("Freezes the picture so you can pick an element and mark it up")
        .accessibilityIdentifier("AppleViewer.Inspect")
    }
    if model.health.offersReconnect {
      DuoPaneActionButton(title: "Reconnect", systemImage: "arrow.clockwise") {
        Task { await model.reconnect() }
      }
    }
    DuoPaneActionButton(
      title: rotation.isSideways ? "Show upright" : "Turn the picture",
      systemImage: rotation.isSideways ? "rotate.left" : "rotate.right"
    ) {
      withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
        rotation = rotation.isSideways ? .upright : .clockwise
      }
    }
    DuoPaneActionButton(title: "Speed", systemImage: "speedometer", isOn: showsSpeed) {
      showsSpeed.toggle()
    }
    if model.mode == .controlling {
      DuoPaneActionButton(title: "Type", systemImage: "keyboard", isOn: showsKeyboard) {
        showsKeyboard.toggle()
        keyboardFocused = showsKeyboard
      }
      DuoPaneActionButton(title: "Home", systemImage: "house") { model.press("home") }
      DuoPaneActionMenu(title: "Hardware buttons", systemImage: "iphone.gen3") {
        hardwareButtonsMenuContent
      }
    }
    DuoWatchControlSwitch(
      controlling: model.mode == .controlling,
      controlBlocker: model.controlBlocker,
      holdDuration: Self.holdToControl,
      holdProgress: $holdProgress,
      onBeginControl: {
        model.beginControl()
        if model.mode == .controlling {
          flashHint("You're driving the simulator. The eye hands it back.", haptic: nil)
        }
      },
      onEndControl: { model.endControl() },
      onBlocked: {
        if let blocker = model.controlBlocker { flashHint(blocker, haptic: .warning) }
      },
      onEarlyRelease: {
        if model.mode == .watching { flashHint("Hold to take control.", haptic: nil) }
      }
    )
  }

  /// The full-screen form: the picture fills the screen and the bars float
  /// over it.
  private var fullScreenContent: some View {
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
      if let inspect {
        LiveInspectStage(model: inspect, onClose: exitInspect)
          .transition(.opacity)
          .zIndex(2)
      }
    }
  }

  /// The stream's lifetime, shared by both forms.
  private func lifecycleModifiers<Content: View>(_ content: Content) -> some View {
    content
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
        // While inspecting the stream is already stopped: returning must not
        // quietly restart it behind the frozen picture.
        guard inspect == nil else { return }
        model.setVisible(phase == .active)
      }
      .onChange(of: model.mode) { _, mode in
        if mode == .watching {
          showsKeyboard = false
          keyboardFocused = false
          // Control ended under a held finger: lift it, never leave it down.
          if let held = gesture, held.isLive {
            model.touch(.end, at: held.last)
          }
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
            RoundedRectangle(
              cornerRadius: embedded ? min(rect.width, rect.height) * 0.11 + 3 : 6,
              style: .continuous
            )
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
      // In a pane the picture is a device: its screen's own rounded corners,
      // lifted off the pane by a soft shadow.
      .clipShape(RoundedRectangle(cornerRadius: embedded ? min(size.width, size.height) * 0.11 : 0, style: .continuous))
      .shadow(color: .black.opacity(embedded ? 0.18 : 0), radius: 18, y: 8)
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
          // A host that takes a live finger gets it as it lands, so the
          // device moves under the finger instead of once it lifts.
          if model.usesLiveTouch {
            gesture?.isLive = true
            model.touch(.begin, at: start)
          }
        }
        if let point = model.devicePoint(for: value.location, in: rect, rotation: rotation),
           point != gesture?.last {
          gesture?.move(to: point)
          if gesture?.isLive == true { model.touch(.move, at: point) }
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
        guard let started = gesture else { return }
        let end = rect.flatMap { model.devicePoint(for: value.location, in: $0, rotation: rotation) }
        if started.isLive {
          // Even with nothing left to map against (a reconnect mid-gesture),
          // the finger comes up where it last was.
          model.touch(.end, at: end ?? started.last)
        } else if let end {
          model.send(gesture: started, endingAt: end)
        }
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
    HStack(spacing: embedded ? 8 : 12) {
      // The pane's own close button is the way out of an embedded viewer.
      if !embedded {
        roundButton(systemName: "xmark", label: "Close") {
          model.stop()
          dismiss()
        }
      }
      VStack(alignment: .leading, spacing: embedded ? 0 : 2) {
        Text(model.status?.device?.name ?? "Simulator")
          .shadow(color: .black.opacity(0.6), radius: 3)
          .font(embedded ? .caption.weight(.semibold) : .subheadline.weight(.semibold))
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
      if canInspect {
        inspectButton
      }
    }
  }

  /// Inspect freezes the picture and hands it to the markup model. Kept apart
  /// from the View|Control switch: inspecting is not a way to drive the device,
  /// and the 0.6 s hold that takes control is untouched.
  private var canInspect: Bool {
    inspect == nil
      && model.health.phase == .streaming
      && syncService.supportsAppleDeviceControl(laneId: laneId)
  }

  private var inspectButton: some View {
    Button {
      beginInspect()
    } label: {
      Label("Inspect", systemImage: "viewfinder")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .frame(height: 38)
        .background(Color.white.opacity(0.14), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
    }
    .buttonStyle(.plain)
    .accessibilityHint("Freezes the picture so you can pick an element and mark it up")
    .accessibilityIdentifier("AppleViewer.Inspect")
  }

  /// Freezes the live picture, then stops the stream: one still and the element
  /// list come from `getScreenSnapshot`, and no frame moves under the finger
  /// while it is being inspected.
  private func beginInspect() {
    guard canInspect else { return }
    ADEHaptics.light()
    let next = LiveInspectMarkupModel(
      surface: .simulator,
      laneId: laneId,
      chatSessionId: chatSessionId
    )
    next.begin(plan: .simulator, using: syncService)
    inspect = next
    model.endControl()
    model.stop()
  }

  /// Leaves inspect and reconnects the stream with a fresh ticket.
  private func exitInspect() {
    guard inspect != nil else { return }
    inspect = nil
    Task { await model.start() }
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
      roundButton(systemName: "keyboard", label: showsKeyboard ? "Hide keyboard" : "Type", highlighted: showsKeyboard) {
        showsKeyboard.toggle()
        keyboardFocused = showsKeyboard
      }
      roundButton(systemName: "house", label: "Home") {
        model.press("home")
      }
      hardwareButtonsMenu
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

  /// The buttons a finger on the screen cannot press, the same set as the
  /// desktop rail's Hardware buttons menu.
  private var hardwareButtonsMenuContent: some View {
    Section("Hardware buttons") {
      Button { model.press("home") } label: { Label("Home", systemImage: "house") }
      Button { model.press("lock") } label: { Label("Lock", systemImage: "lock") }
      Button { model.press("volume-up") } label: { Label("Volume up", systemImage: "speaker.wave.2") }
      Button { model.press("volume-down") } label: { Label("Volume down", systemImage: "speaker.wave.1") }
      Button { model.press("siri") } label: { Label("Siri", systemImage: "mic") }
      Button { model.press("app-switcher") } label: { Label("App switcher", systemImage: "square.grid.2x2") }
    }
  }

  private var hardwareButtonsMenu: some View {
    Menu {
      hardwareButtonsMenuContent
    } label: {
      Image(systemName: "iphone.gen3")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: 44, height: 44)
        .background(Color.black.opacity(0.68), in: Circle())
        .overlay(Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
    }
    .accessibilityLabel("Hardware buttons")
  }

  private func hideKeyboard() {
    keyboardFocused = false
    showsKeyboard = false
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
      roundButton(systemName: "keyboard.chevron.compact.down", label: "Hide keyboard") {
        hideKeyboard()
      }
    }
    .padding(.horizontal, 14)
    .padding(.bottom, 6)
    .frame(maxWidth: 520)
    .toolbar {
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Done") { hideKeyboard() }
      }
    }
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
      if model.health.phase == .connecting || model.health.phase == .requestingTicket
        || model.health.phase == .reconnecting {
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
