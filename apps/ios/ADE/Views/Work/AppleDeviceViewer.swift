import SwiftUI
import UIKit


/// The live view of the Mac's simulator, with an opt-in Control mode.
///
/// The picture is the whole surface: full screen on a phone (and the Duo's
/// front screen), or the whole tools pane beside or above the chat on a large
/// display (see `LiveStage`). The one control over it is a floating menu
/// button the person can drag out of the way; the rest is passing (a hint,
/// the speed readout, a status card while the stream is down, the keyboard
/// bar while controlling). A tap on the picture opens the menu; holding the
/// picture takes control.
///
/// Watching is the default and the state everything falls back to. Control is
/// a deliberate act, never a single tap: the device belongs to someone's Mac,
/// and a touch that reached it from a pocket would be worse than useless.
/// While controlling, every touch on the picture goes to the simulator, the
/// menu button wears an orange ring, and the menu hands control back. Leaving
/// the app, losing the stream, or an agent claiming the device also hand it
/// back. On an iPhone Duo controlling a Duo simulator, folding the phone folds
/// the simulator.
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
  /// Where the stage draws it. Changes without re-creating the viewer.
  var presentation: LiveStagePresentation = .fullScreen
  /// What the menu button keeps clear of; nil reads this view's safe area.
  var chromeInsets: EdgeInsets?
  #if DEBUG
  /// Fixture seam (`-adePreviewScreen apple-viewer`): a seeded model and a
  /// drawn stand-in for the picture, with no sync and no socket.
  var preview: AppleDeviceViewerPreview?
  #endif

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.liveStageClose) private var stageClose
  @Environment(\.liveStageContext) private var stageContext
  @Environment(\.duoLayout) private var duo
  @Environment(\.liveStageHidesStatusBar) private var hidesStatusBar

  @StateObject private var model = AppleDeviceViewerModel()
  @State private var hint: String?
  @ObservedObject private var turns = LiveStageTurns.shared
  @State private var menuOpen = false
  /// A finger held on the picture while watching, filling toward Control.
  @State private var holdLocation: CGPoint?
  @State private var holdProgress: CGFloat = 0
  @State private var touchMarks: [AppleTouchMark] = []
  @State private var tracker = LiveStageTouchTracker()
  @State private var showsKeyboard = false
  @State private var typed = ""
  @FocusState private var keyboardFocused: Bool
  @AppStorage("ade.appleViewer.showsSpeed") private var showsSpeed = false
  /// The frozen inspect view, over everything, until its Close resumes the
  /// stream.
  @State private var inspect: LiveInspectMarkupModel?

  private static let keyboardBarHeight: CGFloat = 60

  var body: some View {
    lifecycleModifiers(viewerBody)
  }

  private var controlling: Bool { model.mode == .controlling }
  private var rotation: AppleDisplayRotation { model.guestRotation.adding(userTurn) }
  private var turnKey: String { LiveStageTurns.key("simulator", context: stageContext, layout: duo) }
  /// The person's own quarter turn, on top of the guest's, remembered per place.
  private var userTurn: AppleDisplayRotation { turns.isTurned(turnKey) ? .clockwise : .upright }
  private var showsKeyboardBar: Bool { showsKeyboard && controlling }

  /// The hold-to-control, tap-for-menu rules and the passing hint, shared
  /// with the emulator's viewer.
  private var stageTouch: LiveStageTouch {
    LiveStageTouch(
      hint: $hint,
      holdLocation: $holdLocation,
      holdProgress: $holdProgress,
      touchMarks: $touchMarks,
      menuOpen: $menuOpen,
      tracker: tracker,
      model: model
    )
  }

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
      // A phone in a wide pane: the button and its hint go in the empty
      // space beside it, off the picture.
      let hintBesideButton = LiveStageButtonSpot.besidePicture(
        container: stageSize,
        insets: buttonInsets,
        aspect: drawnAspect,
        gap: presentation.pictureGap
      ) != nil
      ZStack(alignment: .topLeading) {
        LiveStageBackdrop(presentation: presentation)
        stageView(size: stageSize, insets: EdgeInsets())
          .frame(width: stageSize.width, height: stageSize.height)
        overlays(size: proxy.size, insets: insets, drawsHint: !hintBesideButton)
        if showsKeyboardBar {
          LiveStageKeyboardBar(
            placeholder: "Type on the simulator",
            text: $typed,
            shown: $showsKeyboard,
            focused: $keyboardFocused,
            onType: { model.type($0) }
          )
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
    // Over the pane it runs top to bottom but never sideways under the edge
    // bar; full screen it runs edge to edge.
    .ignoresSafeArea(.container, edges: presentation.isPane ? .vertical : .all)
    .environment(\.colorScheme, .dark)
    .animation(.easeOut(duration: 0.18), value: inspect != nil)
    // The whole display belongs to the device: no clock, no home bar while
    // controlling, and a swipe up from the bottom reaches the simulator, not
    // this app. A second swipe up still leaves (iOS never gives that away).
    .statusBarHidden(hidesStatusBar || presentation.isFullScreen)
    .liveStageReportsAspect(drawnAspect)
    .defersSystemGestures(on: controlling ? .all : [])
    .persistentSystemOverlays(presentation.isFullScreen && controlling ? .hidden : .automatic)
    .fullScreenCover(isPresented: Binding(
      get: { inspect != nil },
      set: { presented in if !presented, inspect != nil { exitInspect() } }
    )) {
      if let inspect {
        LiveInspectStage(model: inspect, onClose: exitInspect)
      }
    }
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
        // Two timers in one loop: the health watchdogs, and the status poll that
        // keeps the owner ribbon and the recording dot honest. 1s is fast enough
        // for a 3s watchdog to fire on time and cheap enough to leave running
        // behind a view the user is actively watching.
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
      .onAppear {
        stageTouch.flashHint("Tap for the menu · Hold to control", haptic: nil, seconds: 2.6)
        updateIdleTimer()
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
        updateIdleTimer()
        if mode == .watching {
          showsKeyboard = false
          keyboardFocused = false
          // Control ended under a held finger: lift it, never leave it down.
          if let held = tracker.gesture, held.isLive {
            model.touch(.end, at: held.last)
          }
          tracker.gesture = nil
        } else if let target = foldTarget {
          model.mirrorFold(target)
        }
      }
      .onChange(of: presentation) { _, _ in updateIdleTimer() }
      // The phone in the hand folds: mirror it into a Duo simulator while
      // controlling.
      .onChange(of: duo.hasFold || duo.hingeAngle != nil, initial: true) { _, folds in
        if folds { PhoneInHand.folds = true }
      }
      .onChange(of: foldTarget) { _, target in
        if let target { model.mirrorFold(target) }
      }
      .onChange(of: model.deviceFolds) { _, folds in
        if folds, let target = foldTarget { model.mirrorFold(target) }
      }
      .onChange(of: model.notice) { _, notice in
        if let notice { stageTouch.flashHint(notice, haptic: .warning) }
      }
      .onDisappear {
        tracker.cancelTasks()
        model.stop()
        UIApplication.shared.isIdleTimerDisabled = false
      }
  }

  /// The screen stays awake while the device has it: full screen, or while
  /// controlling.
  private func updateIdleTimer() {
    #if DEBUG
    if preview != nil { return }
    #endif
    UIApplication.shared.isIdleTimerDisabled = presentation.isFullScreen || controlling
  }

  private var foldTarget: AppleFoldTarget? {
    AppleFoldTarget.mirroring(
      isInnerDisplay: duo.hasFold,
      isLandscape: duo.isLandscape,
      hingeAngle: duo.hingeAngle,
      phoneFolds: PhoneInHand.folds || duo.hasFold || duo.hingeAngle != nil
    )
  }

  // MARK: - Stage

  /// `insets` is what of the stage is the system's: the picture stays out of
  /// it and the page (or full screen, black) runs under it.
  private func stageView(size: CGSize, insets: EdgeInsets) -> some View {
    // Over the pane the device keeps a little room and its own corners; full
    // screen it runs edge to edge.
    let gap = presentation.pictureGap
    let container = CGSize(
      width: max(0, size.width - insets.leading - insets.trailing - gap * 2),
      height: max(0, size.height - insets.top - insets.bottom - gap * 2)
    )
    let turn = rotation
    let rect = AppleDeviceTouchMapping.pictureRect(
      container: container,
      content: model.contentPixelSize,
      rotation: turn
    )?.offsetBy(dx: insets.leading + gap, dy: insets.top + gap)
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
        ? "The simulator's screen. Your touches drive it."
        : "The simulator's screen. View only."
    )
    .accessibilityHint(controlling ? "" : "Double-tap for the menu.")
    .accessibilityAddTraits(controlling ? .allowsDirectInteraction : .isButton)
    .accessibilityAction { if !controlling { menuOpen = true } }
    .accessibilityAction(named: "Take control") { stageTouch.takeControl() }
  }

  /// The layer, laid out at the picture's own (unturned) size and turned
  /// about its centre. Turning an aspect-fit view instead of laying it out
  /// turned leaves it overflowing the stage sideways.
  private func picture(in rect: CGRect, rotation: AppleDisplayRotation) -> some View {
    let size = rotation.isSideways ? CGSize(width: rect.height, height: rect.width) : rect.size
    return pictureContent
      .frame(width: size.width, height: size.height)
      // Over the pane the picture is a device with its screen's corners.
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
      AppleViewerPreviewPicture()
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
        guard !tracker.holdFired else { return }
        guard model.mode == .controlling else {
          stageTouch.watchingChanged(value)
          return
        }
        guard let rect, !tracker.gestureIgnored else { return }
        if tracker.gesture == nil {
          // A touch that starts outside the picture is a touch on the black
          // bars, not on the device: the whole gesture is ignored rather
          // than clamped onto the screen's edge.
          guard rect.contains(value.startLocation),
                let start = model.devicePoint(for: value.startLocation, in: rect, rotation: rotation)
          else {
            tracker.gestureIgnored = true
            return
          }
          tracker.gesture = AppleDeviceGesture(start: start, at: Date())
          stageTouch.addTouchMark(at: value.startLocation)
          // A host that takes a live finger gets it as it lands, so the
          // device moves under the finger instead of once it lifts.
          if model.usesLiveTouch {
            tracker.gesture?.isLive = true
            model.touch(.begin, at: start)
          }
        }
        if let point = model.devicePoint(for: value.location, in: rect, rotation: rotation),
           point != tracker.gesture?.last {
          tracker.gesture?.move(to: point)
          if tracker.gesture?.isLive == true { model.touch(.move, at: point) }
        }
      }
      .onEnded { value in
        defer {
          tracker.gesture = nil
          tracker.gestureIgnored = false
        }
        // The finger that took control lifts: it is not a touch on the device.
        if stageTouch.liftAfterHold() { return }
        guard model.mode == .controlling else {
          stageTouch.watchingEnded(value)
          return
        }
        guard let started = tracker.gesture else { return }
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

  // MARK: - Overlays

  /// The few things ever drawn on the picture: the speed readout when asked
  /// for, the stream's status while it is not live, and a passing hint.
  private func overlays(size: CGSize, insets: EdgeInsets, drawsHint: Bool) -> some View {
    ZStack {
      VStack(spacing: 0) {
        if showsSpeed {
          LiveStageSpeedReadout(speed: model.speed)
            .padding(.top, insets.top + 10)
            .transition(.opacity)
        }
        Spacer(minLength: 0)
        if let message = model.overlayMessage {
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
    .allowsHitTesting(model.overlayMessage != nil && model.health.offersReconnect)
  }

  // MARK: - Menu

  private var menuPanel: some View {
    LiveStageMenuPanel {
      LiveStageMenuHeader(
        title: model.status?.device?.name ?? "Simulator",
        detail: ribbon,
        recording: model.status?.recording?.active == true
      )

      if controlling {
        LiveStageMenuRow(title: "Stop controlling", systemImage: "eye") {
          model.endControl()
          menuOpen = false
        }
        .accessibilityIdentifier("AppleViewer.StopControl")
        HStack(spacing: 6) {
          LiveStageMenuTile(title: "Keyboard", systemImage: "keyboard", isOn: showsKeyboard) {
            showsKeyboard.toggle()
            keyboardFocused = showsKeyboard
            menuOpen = false
          }
          LiveStageMenuTile(title: "Home", systemImage: "house") { model.press("home") }
          Menu {
            hardwareButtonsMenuContent
          } label: {
            LiveStageMenuTileLabel(title: "Buttons", systemImage: "iphone.gen3")
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
          stageTouch.takeControl()
        }
        .accessibilityIdentifier("AppleViewer.TakeControl")
        if let blocker = model.controlBlocker {
          Text(blocker)
            .font(.caption)
            .foregroundStyle(.white.opacity(0.55))
            .padding(.horizontal, 10)
            .padding(.bottom, 4)
        }
      }

      HStack(spacing: 6) {
        LiveStageMenuTile(title: userTurn == .upright ? "Turn" : "Upright", systemImage: userTurn == .upright ? "rotate.right" : "rotate.left") {
          withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
            turns.toggle(turnKey)
          }
        }
        LiveStageMenuTile(title: "Speed", systemImage: "speedometer", isOn: showsSpeed) {
          showsSpeed.toggle()
        }
        if canInspect {
          LiveStageMenuTile(title: "Inspect", systemImage: "viewfinder") {
            menuOpen = false
            beginInspect()
          }
          .accessibilityHint("Freezes the picture so you can pick an element and add it to the chat")
          .accessibilityIdentifier("AppleViewer.Inspect")
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
      .accessibilityIdentifier("AppleViewer.Close")
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

  /// Inspect freezes the picture and hands it to the markup model. Kept apart
  /// from Control: inspecting is not a way to drive the device.
  private var canInspect: Bool {
    inspect == nil
      && model.health.phase == .streaming
      && syncService.supportsAppleDeviceControl(laneId: laneId)
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

  /// Leaves inspect and reconnects the stream with a fresh ticket. Something
  /// added to the chat from full screen goes back to the chat, where it is
  /// waiting in the draft; over the pane the chat is already beside it.
  private func exitInspect() {
    guard let finished = inspect else { return }
    inspect = nil
    if finished.attachedCount > 0, presentation.isFullScreen, let stageClose {
      stageClose()
      return
    }
    Task { await model.start() }
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

  private func statusOverlay(_ message: String) -> some View {
    LiveStageStatusCard(message: message, health: model.health, onReconnect: { Task { await model.reconnect() } }) {
      EmptyView()
    }
  }

  /// "Watching · owned by <chat>" — the one sentence that stops a viewer from
  /// mistaking a device an agent is driving for one that is idle.
  ///
  /// The host resolves the title, and hands back null rather than a fabricated
  /// name when it cannot, so a missing title costs the ribbon its name and
  /// never the claim itself.
  private var ribbon: String {
    var parts = [controlling ? "Controlling" : "Watching"]
    if let owner = appleDeviceOwnerLabel(model.status?.owner) {
      parts.append("owned by \(owner)")
    }
    if let machine = model.machineName {
      parts.append("on \(machine)")
    }
    return parts.joined(separator: " · ")
  }
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
