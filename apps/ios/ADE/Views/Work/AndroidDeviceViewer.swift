import SwiftUI
import UIKit

/// The live view of the lane's Android emulator, with an opt-in Control mode.
///
/// The Apple simulator viewer's layout and rules (`AppleDeviceViewer`): the
/// picture is the whole surface, full screen on a phone or over the tools pane
/// on a large display (see `LiveStage`); one floating menu button holds the
/// controls; a tap on the picture opens the menu; holding the picture takes
/// control. Watching is the default, and Control is a deliberate act that the
/// viewer hands back when the app leaves the screen, the picture stops, or the
/// emulator goes down.
///
/// While controlling, every touch goes to the emulator as a live finger (down,
/// moves, up), and the menu has Back, Home, Recents, Power and volume. The
/// video is the brain's stream relay, on the same socket as the simulator's;
/// input goes the other way as `android.input` commands to the machine that
/// owns the lane.
///
/// Watching never boots the emulator. When it is off, the viewer says so and
/// offers Start (only to a phone that may drive it), then connects once it is
/// booted.
struct AndroidDeviceViewer: View {
  let laneId: String
  /// The chat the viewer was opened from.
  var chatSessionId: String?
  /// The chip's last status, so the name and the aspect are right on the
  /// first frame.
  var initialStatus: AndroidDeviceStatus?
  /// Where the stage draws it. Changes without re-creating the viewer.
  var presentation: LiveStagePresentation = .fullScreen
  /// What the menu button keeps clear of; nil reads this view's safe area.
  var chromeInsets: EdgeInsets?
  #if DEBUG
  /// Fixture seam: a seeded model and a drawn stand-in for the picture, with
  /// no sync and no socket.
  var preview: AndroidDeviceViewerPreview?
  #endif

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.liveStageClose) private var stageClose
  @Environment(\.liveStageContext) private var stageContext
  @Environment(\.duoLayout) private var duo
  @Environment(\.liveStageHidesStatusBar) private var hidesStatusBar

  @StateObject private var model = AndroidDeviceViewerModel()
  @State private var hint: String?
  @State private var hintTask: Task<Void, Never>?
  @ObservedObject private var turns = LiveStageTurns.shared
  @State private var menuOpen = false
  /// A finger held on the picture while watching, filling toward Control.
  @State private var holdLocation: CGPoint?
  @State private var holdProgress: CGFloat = 0
  @State private var holdTask: Task<Void, Never>?
  @State private var holdFired = false
  @State private var holdCancelled = false
  @State private var gesture: AppleDeviceGesture?
  @State private var gestureIgnored = false
  @State private var touchMarks: [AppleTouchMark] = []
  @State private var showsKeyboard = false
  @State private var typed = ""
  @FocusState private var keyboardFocused: Bool
  /// One switch for both viewers: the person asked for the readout, not for
  /// one kind of device.
  @AppStorage("ade.appleViewer.showsSpeed") private var showsSpeed = false

  /// Long enough that a thumb resting on the picture does not take control.
  private static let holdToControl: Double = 0.6
  /// How long a finger rests before the ring shows: a tap never flashes it.
  private static let holdRingDelay: Double = 0.15
  private static let keyboardBarHeight: CGFloat = 60

  var body: some View {
    lifecycleModifiers(viewerBody)
  }

  private var controlling: Bool { model.mode == .controlling }
  private var turnKey: String { LiveStageTurns.key("android", context: stageContext, layout: duo) }
  /// The person's own quarter turn, remembered per place. The video arrives
  /// the right way up, so there is no turn of the device's own.
  private var rotation: AppleDisplayRotation { turns.isTurned(turnKey) ? .clockwise : .upright }
  private var showsKeyboardBar: Bool { showsKeyboard && controlling }
  private var deviceName: String { androidDeviceDisplayName(model.status) }

  /// The picture's shape as drawn, turned included.
  private var drawnAspect: CGFloat? {
    let size = model.contentPixelSize
    guard size.width > 0, size.height > 0 else { return nil }
    return rotation.isSideways ? size.height / size.width : size.width / size.height
  }

  private var viewerBody: some View {
    GeometryReader { proxy in
      let insets = chromeInsets ?? proxy.safeAreaInsets
      let keyboardSpace = showsKeyboardBar ? Self.keyboardBarHeight + insets.bottom : 0
      let stageSize = CGSize(width: proxy.size.width, height: max(0, proxy.size.height - keyboardSpace))
      let buttonInsets = EdgeInsets(top: insets.top, leading: insets.leading, bottom: showsKeyboardBar ? 0 : insets.bottom, trailing: insets.trailing)
      let hintBesideButton = LiveStageButtonSpot.besidePicture(
        container: stageSize,
        insets: buttonInsets,
        aspect: drawnAspect,
        gap: presentation.pictureGap
      ) != nil
      ZStack(alignment: .topLeading) {
        LiveStageBackdrop(presentation: presentation)
        stageView(size: stageSize)
          .frame(width: stageSize.width, height: stageSize.height)
        overlays(size: proxy.size, insets: insets, drawsHint: !hintBesideButton)
        if showsKeyboardBar {
          keyboardBar
            .frame(width: proxy.size.width, height: Self.keyboardBarHeight)
            .position(x: proxy.size.width / 2, y: proxy.size.height - insets.bottom - Self.keyboardBarHeight / 2)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
        LiveStageMenuButton(
          container: stageSize,
          insets: buttonInsets,
          storageKey: LiveStageButtonSpot.storageKey(presentation: presentation, size: proxy.size),
          symbolName: controlling ? "hand.point.up.left.fill" : "ellipsis",
          alert: controlling,
          pictureAspect: drawnAspect,
          pictureGap: presentation.pictureGap,
          note: hintBesideButton ? hint : nil,
          isOpen: $menuOpen
        ) {
          menuPanel
        }
        .frame(width: stageSize.width, height: stageSize.height)
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .animation(.easeOut(duration: 0.18), value: hint)
      .animation(.easeOut(duration: 0.18), value: showsSpeed)
      .animation(.easeOut(duration: 0.2), value: showsKeyboardBar)
    }
    .ignoresSafeArea(.container, edges: presentation.isPane ? .vertical : .all)
    .environment(\.colorScheme, .dark)
    .statusBarHidden(hidesStatusBar || presentation.isFullScreen)
    .liveStageReportsAspect(drawnAspect)
    // While controlling, a swipe up from the bottom edge reaches the
    // emulator (its own gesture navigation), not this app.
    .defersSystemGestures(on: controlling ? .all : [])
    .persistentSystemOverlays(presentation.isFullScreen && controlling ? .hidden : .automatic)
  }

  /// The stream's lifetime.
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
        // The first-frame watchdog every second, and the status read every
        // 5 s (every 2 s while the emulator is off or starting, so the
        // picture comes as soon as it boots).
        var tickCount = 0
        while !Task.isCancelled {
          try? await Task.sleep(for: .seconds(1))
          guard !Task.isCancelled else { return }
          model.tick()
          tickCount += 1
          let waiting = model.deviceOff || model.starting
          if tickCount % (waiting ? 2 : 5) == 0 {
            await model.refreshStatus()
          }
        }
      }
      .onAppear {
        flashHint("Tap for the menu · Hold to control", haptic: nil, seconds: 2.6)
        updateIdleTimer()
      }
      .onChange(of: scenePhase) { _, phase in
        // `.inactive` counts as away, as on the simulator viewer: nobody is
        // looking, so the stream pauses and Control ends.
        model.setVisible(phase == .active)
      }
      .onChange(of: model.mode) { _, mode in
        updateIdleTimer()
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
      .onChange(of: presentation) { _, _ in updateIdleTimer() }
      .onChange(of: model.notice) { _, notice in
        if let notice { flashHint(notice, haptic: .warning) }
      }
      .onDisappear {
        hintTask?.cancel()
        holdTask?.cancel()
        model.stop()
        UIApplication.shared.isIdleTimerDisabled = false
      }
  }

  /// The screen stays awake while the emulator has it: full screen, or while
  /// controlling.
  private func updateIdleTimer() {
    #if DEBUG
    if preview != nil { return }
    #endif
    UIApplication.shared.isIdleTimerDisabled = presentation.isFullScreen || controlling
  }

  // MARK: - Stage

  private func stageView(size: CGSize) -> some View {
    // Over the pane the device keeps a little room and its own corners; full
    // screen it runs edge to edge.
    let gap = presentation.pictureGap
    let container = CGSize(width: max(0, size.width - gap * 2), height: max(0, size.height - gap * 2))
    let turn = rotation
    let rect = AppleDeviceTouchMapping.pictureRect(
      container: container,
      content: model.contentPixelSize,
      rotation: turn
    )?.offsetBy(dx: gap, dy: gap)
    return ZStack(alignment: .topLeading) {
      if let rect {
        picture(in: rect, rotation: turn)
        if controlling, presentation.isPane {
          RoundedRectangle(cornerRadius: presentation.cornerRadius(for: rect.size) + 3, style: .continuous)
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
      if let holdLocation {
        LiveStageHoldRing(progress: holdProgress)
          .position(holdLocation)
          .transition(.scale(scale: 0.6).combined(with: .opacity))
      }
    }
    .frame(width: size.width, height: size.height)
    .contentShape(Rectangle())
    .gesture(stageGesture(picture: rect, rotation: turn))
    .accessibilityElement()
    .accessibilityLabel(
      controlling
        ? "The Android emulator's screen. Your touches drive it."
        : "The Android emulator's screen. View only."
    )
    .accessibilityHint(controlling ? "" : "Double-tap for the menu.")
    .accessibilityAddTraits(controlling ? .allowsDirectInteraction : .isButton)
    .accessibilityAction { if !controlling { menuOpen = true } }
    .accessibilityAction(named: "Take control") { takeControl() }
  }

  /// The layer, laid out at the picture's own (unturned) size and turned
  /// about its centre.
  private func picture(in rect: CGRect, rotation: AppleDisplayRotation) -> some View {
    let size = rotation.isSideways ? CGSize(width: rect.height, height: rect.width) : rect.size
    return pictureContent
      .frame(width: size.width, height: size.height)
      .clipShape(RoundedRectangle(cornerRadius: presentation.cornerRadius(for: size), style: .continuous))
      .rotationEffect(.degrees(rotation.degrees))
      .position(x: rect.midX, y: rect.midY)
      .opacity(model.health.phase == .streaming ? 1 : 0.35)
      .allowsHitTesting(false)
  }

  @ViewBuilder
  private var pictureContent: some View {
    #if DEBUG
    if preview != nil {
      AndroidViewerPreviewPicture()
    } else {
      AppleStreamLayerView(layer: model.decoder.layer)
        .adeReplayMasked()
    }
    #else
    AppleStreamLayerView(layer: model.decoder.layer)
      .adeReplayMasked()
    #endif
  }

  private func stageGesture(picture rect: CGRect?, rotation: AppleDisplayRotation) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .local)
      .onChanged { value in
        guard !holdFired else { return }
        guard model.mode == .controlling else {
          watchingChanged(value)
          return
        }
        guard let rect, !gestureIgnored else { return }
        if gesture == nil {
          // A touch that starts outside the picture is not on the device:
          // the whole gesture is ignored rather than clamped onto its edge.
          guard rect.contains(value.startLocation),
                let start = model.devicePoint(for: value.startLocation, in: rect, rotation: rotation)
          else {
            gestureIgnored = true
            return
          }
          var next = AppleDeviceGesture(start: start, at: Date())
          next.isLive = true
          gesture = next
          addTouchMark(at: value.startLocation)
          model.touch(.begin, at: start)
        }
        if let point = model.devicePoint(for: value.location, in: rect, rotation: rotation),
           point != gesture?.last {
          gesture?.move(to: point)
          model.touch(.move, at: point)
        }
      }
      .onEnded { value in
        defer {
          gesture = nil
          gestureIgnored = false
        }
        // The finger that took control lifts: it is not a touch on the device.
        if holdFired {
          holdFired = false
          holdCancelled = false
          return
        }
        guard model.mode == .controlling else {
          watchingEnded(value)
          return
        }
        guard let started = gesture else { return }
        let end = rect.flatMap { model.devicePoint(for: value.location, in: $0, rotation: rotation) }
        // Even with nothing left to map against, the finger comes up where it
        // last was.
        model.touch(.end, at: end ?? started.last)
      }
  }

  /// A finger on the picture while watching: held still, it takes control
  /// after `holdToControl`; moved, it is nothing.
  private func watchingChanged(_ value: DragGesture.Value) {
    let travel = hypot(value.translation.width, value.translation.height)
    if holdTask == nil, !holdCancelled {
      guard model.controlBlocker == nil else {
        holdCancelled = true
        return
      }
      let location = value.startLocation
      holdTask = Task { @MainActor in
        try? await Task.sleep(for: .seconds(Self.holdRingDelay))
        guard !Task.isCancelled else { return }
        ADEHaptics.light()
        holdProgress = 0
        withAnimation(.easeOut(duration: 0.12)) { holdLocation = location }
        withAnimation(.linear(duration: Self.holdToControl - Self.holdRingDelay)) { holdProgress = 1 }
        try? await Task.sleep(for: .seconds(Self.holdToControl - Self.holdRingDelay))
        guard !Task.isCancelled else { return }
        holdFired = true
        withAnimation(.easeOut(duration: 0.15)) { holdLocation = nil }
        takeControl()
      }
    } else if travel > 20, !holdCancelled {
      cancelHold()
    }
  }

  private func watchingEnded(_ value: DragGesture.Value) {
    let travel = hypot(value.translation.width, value.translation.height)
    let wasCancelled = holdCancelled
    let ringShown = holdLocation != nil
    cancelHold()
    holdCancelled = false
    guard travel < 12, !wasCancelled || model.controlBlocker != nil else { return }
    if ringShown {
      flashHint("Hold a little longer to take control", haptic: nil)
      return
    }
    // A tap: the menu, which also says why Control is unavailable.
    ADEHaptics.light()
    withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { menuOpen.toggle() }
  }

  private func cancelHold() {
    holdTask?.cancel()
    holdTask = nil
    holdCancelled = true
    if holdLocation != nil {
      withAnimation(.easeOut(duration: 0.15)) {
        holdLocation = nil
        holdProgress = 0
      }
    }
  }

  private func takeControl() {
    guard !controlling else { return }
    if let blocker = model.controlBlocker {
      flashHint(blocker, haptic: .warning)
      return
    }
    ADEHaptics.success()
    model.beginControl()
    if controlling {
      menuOpen = false
      flashHint("Controlling. The orange button hands it back.", haptic: nil)
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

  // MARK: - Overlays

  /// The speed readout when asked for, the stream's status while it is not
  /// live (or the emulator's, while it is off), and a passing hint.
  private func overlays(size: CGSize, insets: EdgeInsets, drawsHint: Bool) -> some View {
    ZStack {
      VStack(spacing: 0) {
        if showsSpeed {
          speedReadout
            .padding(.top, insets.top + 10)
            .transition(.opacity)
        }
        Spacer(minLength: 0)
        if model.deviceOff {
          offCard
        } else if let message = model.overlayMessage {
          statusOverlay(message)
        }
        Spacer(minLength: 0)
        if let hint, drawsHint {
          LiveStageHintChip(text: hint)
            .padding(.bottom, insets.bottom + (showsKeyboardBar ? Self.keyboardBarHeight + 8 : 20))
        }
      }
      .frame(width: size.width, height: size.height)
    }
    .allowsHitTesting(model.deviceOff || (model.overlayMessage != nil && model.health.offersReconnect))
  }

  /// What the person can do while the emulator is not running.
  private var offCard: some View {
    let status = model.status
    let state = androidDeviceState(status)
    let busy = model.starting || state == "starting"
    let canStart = model.canStart && status?.device != nil && status?.unavailable == nil && state != "stopping"
    return VStack(spacing: 12) {
      if busy || state == "stopping" {
        ProgressView().tint(.white)
      }
      Text(offTitle(status: status, state: state, busy: busy))
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.white)
        .multilineTextAlignment(.center)
      if let detail = offDetail(status: status, state: state, busy: busy, canStart: canStart) {
        Text(detail)
          .font(.footnote)
          .foregroundStyle(.white.opacity(0.75))
          .multilineTextAlignment(.center)
      }
      if canStart, !busy {
        Button {
          ADEHaptics.light()
          Task { await model.startDevice() }
        } label: {
          Label("Start", systemImage: "play.fill")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
            .background(Color.white.opacity(0.16), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("AndroidViewer.Start")
      }
    }
    .padding(.horizontal, 32)
    .padding(.vertical, 18)
    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .padding(.horizontal, 24)
  }

  private func offTitle(status: AndroidDeviceStatus?, state: String?, busy: Bool) -> String {
    if let unavailable = status?.unavailable, !unavailable.isEmpty { return unavailable }
    guard status?.device != nil else { return "No Android emulator in this lane" }
    if busy { return "Starting \(deviceName)…" }
    if state == "stopping" { return "\(deviceName) is stopping…" }
    if state == "crashed" { return "\(deviceName) stopped unexpectedly" }
    return "\(deviceName) is off"
  }

  private func offDetail(status: AndroidDeviceStatus?, state: String?, busy: Bool, canStart: Bool) -> String? {
    if status?.unavailable?.isEmpty == false { return nil }
    guard status?.device != nil else {
      return "Set one up in ADE on the computer to watch it here."
    }
    if busy { return "The picture comes when it has booted." }
    if let message = status?.error?.message, !message.isEmpty { return message }
    return canStart ? "Watching never starts it." : "Start it in ADE on the computer to watch it here."
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
      if model.liveViewMissing, model.status?.device != nil {
        // Status only: what the brain can say without a picture.
        Text("\(deviceName) · \(androidDeviceStateLabel(androidDeviceState(model.status)))")
          .font(.caption)
          .foregroundStyle(.white.opacity(0.6))
      }
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

  // MARK: - Menu

  private var menuPanel: some View {
    LiveStageMenuPanel {
      LiveStageMenuHeader(title: deviceName, detail: ribbon)

      if let crash = model.status?.appCrash, crash.id != nil {
        Text(crashLine(crash))
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .lineLimit(2)
          .padding(.horizontal, 10)
          .padding(.bottom, 4)
      }

      if controlling {
        LiveStageMenuRow(title: "Stop controlling", systemImage: "eye") {
          model.endControl()
          menuOpen = false
        }
        .accessibilityIdentifier("AndroidViewer.StopControl")
        HStack(spacing: 6) {
          LiveStageMenuTile(title: "Back", systemImage: "chevron.backward") { model.press(.back) }
          LiveStageMenuTile(title: "Home", systemImage: "circle") { model.press(.home) }
          LiveStageMenuTile(title: "Recents", systemImage: "square.on.square") { model.press(.recents) }
        }
        .padding(.vertical, 2)
        HStack(spacing: 6) {
          LiveStageMenuTile(title: "Keyboard", systemImage: "keyboard", isOn: showsKeyboard) {
            showsKeyboard.toggle()
            keyboardFocused = showsKeyboard
            menuOpen = false
          }
          Menu {
            hardwareButtonsMenuContent
          } label: {
            LiveStageMenuTileLabel(title: "Buttons", systemImage: "smartphone")
          }
          .accessibilityLabel("Hardware buttons")
        }
        .padding(.vertical, 2)
      } else {
        LiveStageMenuRow(
          title: "Take control",
          systemImage: "hand.point.up.left",
          tint: ADEColor.warning,
          disabled: model.controlBlocker != nil
        ) {
          takeControl()
        }
        .accessibilityIdentifier("AndroidViewer.TakeControl")
        if let blocker = model.controlBlocker {
          Text(blocker)
            .font(.caption)
            .foregroundStyle(.white.opacity(0.55))
            .padding(.horizontal, 10)
            .padding(.bottom, 4)
        }
      }

      HStack(spacing: 6) {
        LiveStageMenuTile(title: rotation == .upright ? "Turn" : "Upright", systemImage: rotation == .upright ? "rotate.right" : "rotate.left") {
          withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
            turns.toggle(turnKey)
          }
        }
        LiveStageMenuTile(title: "Speed", systemImage: "speedometer", isOn: showsSpeed) {
          showsSpeed.toggle()
        }
      }
      .padding(.vertical, 2)

      if stageClose != nil, stageContext.choices.count > 1 {
        LiveStagePlacementMenu(context: stageContext) { menuOpen = false }
      }
      if model.health.offersReconnect {
        LiveStageMenuRow(title: "Reconnect", systemImage: "arrow.clockwise") {
          menuOpen = false
          Task { await model.reconnect() }
        }
      }
      Divider()
        .overlay(Color.white.opacity(0.1))
        .padding(.vertical, 2)
      LiveStageMenuRow(title: "Close", systemImage: "xmark", tint: ADEColor.danger) {
        close()
      }
      .accessibilityIdentifier("AndroidViewer.Close")
    }
  }

  private func close() {
    menuOpen = false
    if let stageClose {
      stageClose()
    } else {
      model.stop()
      dismiss()
    }
  }

  /// The keys a finger on the screen cannot press, the same set as the
  /// desktop rail.
  private var hardwareButtonsMenuContent: some View {
    Section("Hardware buttons") {
      Button { model.press(.power) } label: { Label("Power", systemImage: "power") }
      Button { model.press(.volumeUp) } label: { Label("Volume up", systemImage: "speaker.wave.2") }
      Button { model.press(.volumeDown) } label: { Label("Volume down", systemImage: "speaker.wave.1") }
      Button { model.press(.back) } label: { Label("Back", systemImage: "chevron.backward") }
      Button { model.press(.home) } label: { Label("Home", systemImage: "circle") }
      Button { model.press(.recents) } label: { Label("Recents", systemImage: "square.on.square") }
    }
  }

  private func crashLine(_ crash: AndroidDeviceStatusCrash) -> String {
    let app = crash.packageName?.trimmingCharacters(in: .whitespacesAndNewlines)
    let name = (app?.isEmpty == false) ? app! : "The app"
    if let summary = crash.summary?.trimmingCharacters(in: .whitespacesAndNewlines), !summary.isEmpty {
      return "\(name) crashed: \(summary)"
    }
    return "\(name) crashed."
  }

  private func hideKeyboard() {
    keyboardFocused = false
    showsKeyboard = false
  }

  private var keyboardBar: some View {
    HStack(spacing: 8) {
      TextField("Type on the emulator", text: $typed)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused($keyboardFocused)
        .submitLabel(.send)
        .onSubmit {
          model.type(typed)
          typed = ""
          keyboardFocused = true
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 42)
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
    .frame(maxWidth: 560)
    .frame(maxWidth: .infinity)
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
    .allowsHitTesting(false)
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
    action: @escaping () -> Void
  ) -> some View {
    Button {
      ADEHaptics.light()
      action()
    } label: {
      Image(systemName: systemName)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: 42, height: 42)
        .background(Color.white.opacity(0.12), in: Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }

  /// "Watching · Running · on <machine>".
  private var ribbon: String {
    var parts = [controlling ? "Controlling" : "Watching"]
    if let state = androidDeviceState(model.status), state != "booted" {
      parts.append(androidDeviceStateLabel(state))
    }
    if let machine = model.machineName {
      parts.append("on \(machine)")
    }
    return parts.joined(separator: " · ")
  }

  private enum HintHaptic { case warning }

  /// One line at a time, restarted on each call rather than queued.
  private func flashHint(_ text: String, haptic: HintHaptic?, seconds: Double = 2) {
    if haptic == .warning { ADEHaptics.warning() }
    hint = text
    hintTask?.cancel()
    hintTask = Task { @MainActor in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled else { return }
      hint = nil
      model.clearNotice()
    }
  }
}

#if DEBUG
/// What the fixture screen seeds the Android viewer with.
struct AndroidDeviceViewerPreview {
  var status: AndroidDeviceStatus
  var mode: AppleDeviceViewerMode
  var speed = AppleViewerSpeed(fps: 60, kbps: 1640, rttMs: 41, tapToFrameMs: 120, skipped: 0)

  /// A running Pixel in a fixture chat's lane.
  static let running = AndroidDeviceViewerPreview(
    status: AndroidDeviceStatus(
      laneId: "lane-preview",
      unavailable: nil,
      sdkFound: true,
      device: AndroidDeviceStatusDevice(
        avdName: "Pixel_9_API_36",
        origin: "created",
        profileId: "pixel_9",
        state: "booted",
        serial: "emulator-5554",
        width: 1080,
        height: 2424
      ),
      error: nil,
      appCrash: nil,
      liveView: true
    ),
    mode: .watching
  )
}

/// A drawn stand-in for the emulator's picture: a home screen with an app
/// grid, so a screenshot shows where the picture sits.
struct AndroidViewerPreviewPicture: View {
  var body: some View {
    GeometryReader { proxy in
      let unit = proxy.size.width / 412
      VStack(spacing: 24 * unit) {
        Text("12:30")
          .font(.system(size: 64 * unit, weight: .light))
          .padding(.top, 90 * unit)
        Spacer()
        LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 24 * unit) {
          ForEach(0..<8, id: \.self) { index in
            Circle()
              .fill(Color(hue: Double(index) / 8, saturation: 0.45, brightness: 0.85))
              .frame(width: 56 * unit, height: 56 * unit)
          }
        }
        .padding(.horizontal, 24 * unit)
        Capsule()
          .fill(Color.white.opacity(0.85))
          .frame(width: 120 * unit, height: 5 * unit)
          .padding(.bottom, 14 * unit)
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .background(LinearGradient(colors: [Color(red: 0.12, green: 0.2, blue: 0.35), Color(red: 0.05, green: 0.08, blue: 0.16)], startPoint: .top, endPoint: .bottom))
      .foregroundStyle(.white)
    }
  }
}
#endif
