import Combine
import SwiftUI
import UIKit

/// The live view of the lane's private macOS (or Windows) screen, on the live
/// stage like the simulator (`LiveStage`).
///
/// The picture is the whole surface: full screen on a phone (and the Duo's
/// front screen), or the whole tools pane beside or above the chat on a large
/// display. Nothing is drawn over it but one floating menu button, which the
/// person can drag out of the way; every control is in its menu: Take control
/// and Return to agent, Inspect, Turn, Stop (Windows), Placement,
/// Reconnect, Close. Turn draws the picture a quarter turn round, so a wide
/// screen can fill a tall page; it is remembered per place (`LiveStageTurns`).
///
/// While watching, the picture zooms (pinch, pan, double-tap) and a single
/// tap opens the menu. Take control hands the finger to the screen through
/// the same `MacDesktopControlPicture` the tools sheet uses, with this view's
/// lease, so the menu can return it (or Esc on a hardware keyboard). On a
/// phone shown full screen, Take control turns the phone to landscape and
/// holds it (unless the picture is already turned); Return puts back the
/// orientation from before. Over a pane the phone never turns.
///
/// It runs its own live subscription under its own id. The tools sheet pauses
/// its inline picture while a viewer it opened is up, and even if both were
/// live, two ids cannot unsubscribe each other on the host.
struct MacDesktopViewer: View {
  let laneId: String
  /// The chat this viewer was opened from, so an inspect handoff goes back to
  /// the right composer. Nil for a viewer opened without a chat.
  var chatSessionId: String?
  /// Where the stage draws it. Changes without re-creating the viewer.
  var presentation: LiveStagePresentation = .fullScreen
  /// What the menu button keeps clear of; nil reads this view's safe area.
  var chromeInsets: EdgeInsets?
  #if DEBUG
  /// Fixture seam (`-adePreviewScreen mac-desktop-viewer`): a seeded state and
  /// a drawn stand-in for the picture, with no sync and no subscription.
  var preview: MacDesktopViewerPreview?
  #endif

  /// Poll cadence for the lease, recording and stream summary. Same as the
  /// tools sheet: this is a surface the user opened to watch.
  private static let refreshInterval: Duration = .seconds(3)

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.liveStageClose) private var stageClose
  @Environment(\.liveStageContext) private var stageContext
  @Environment(\.duoLayout) private var duo

  /// Seeded with the caller's last snapshot so the ribbon and the picture's
  /// geometry are right on the first frame rather than after the first poll.
  @State private var desktop: WorkToolsMacDesktopState?
  @State private var session: MacDesktopLiveSession?
  @StateObject private var lease = MacDesktopControlHolder()
  /// The Off card's Start is in flight. Opening this viewer never starts a
  /// display; only that button does.
  @State private var starting = false
  @State private var startError: String?
  @State private var stopping = false
  @State private var confirmingStop = false
  @State private var orientation = MacDesktopViewerOrientation()
  @ObservedObject private var turns = LiveStageTurns.shared
  /// The Turn key from before Take control turned the phone; nil otherwise.
  @State private var controlTurnKey: String?
  @State private var menuOpen = false
  @State private var hint: String?
  @State private var hintTask: Task<Void, Never>?
  #if DEBUG
  @State private var previewControlling = false
  #endif
  /// The frozen inspect view, over everything, until its Close resumes the live
  /// subscription.
  @State private var inspect: LiveInspectMarkupModel?

  #if DEBUG
  init(
    laneId: String,
    initialState: WorkToolsMacDesktopState?,
    chatSessionId: String? = nil,
    presentation: LiveStagePresentation = .fullScreen,
    chromeInsets: EdgeInsets? = nil,
    preview: MacDesktopViewerPreview? = nil
  ) {
    self.laneId = laneId
    self.chatSessionId = chatSessionId
    self.presentation = presentation
    self.chromeInsets = chromeInsets
    self.preview = preview
    _desktop = State(initialValue: preview?.desktop ?? initialState)
    _previewControlling = State(initialValue: preview?.controlling ?? false)
  }
  #else
  init(
    laneId: String,
    initialState: WorkToolsMacDesktopState?,
    chatSessionId: String? = nil,
    presentation: LiveStagePresentation = .fullScreen,
    chromeInsets: EdgeInsets? = nil
  ) {
    self.laneId = laneId
    self.chatSessionId = chatSessionId
    self.presentation = presentation
    self.chromeInsets = chromeInsets
    _desktop = State(initialValue: initialState)
  }
  #endif

  private var isPreview: Bool {
    #if DEBUG
    preview != nil
    #else
    false
    #endif
  }

  private var controlling: Bool {
    #if DEBUG
    if preview != nil { return previewControlling }
    #endif
    return lease.controlling
  }

  var body: some View {
    lifecycleModifiers(viewerBody)
  }

  private var viewerBody: some View {
    LiveStageScreenFrame(
      presentation: presentation,
      chromeInsets: chromeInsets,
      turned: turned,
      hint: hint,
      symbolName: controlling ? "cursorarrow.rays" : "ellipsis",
      alert: controlling,
      menuOpen: $menuOpen,
      onBackdropTap: { toggleMenu() },
      picture: { stageContent },
      panel: { menuPanel }
    )
    .persistentSystemOverlays(presentation.isFullScreen && controlling ? .hidden : .automatic)
    .fullScreenCover(isPresented: Binding(
      get: { inspect != nil },
      set: { presented in if !presented, inspect != nil { exitInspect() } }
    )) {
      if let inspect {
        LiveInspectStage(model: inspect, onClose: exitInspect)
      }
    }
    // Asks first, like every Stop on the desktop: the private screen signs out
    // and closes the lane's apps; the main desktop is handed back.
    .confirmationDialog(
      stopSeat.map { "\(desktopStopCopy(seat: $0).action)?" } ?? "",
      isPresented: $confirmingStop,
      titleVisibility: .visible
    ) {
      if let seat = stopSeat { stopDialogActions(seat: seat) }
    } message: {
      if let seat = stopSeat { Text(desktopStopCopy(seat: seat).consequence) }
    }
  }

  /// The subscription's and the poll's lifetime.
  private func lifecycleModifiers<Content: View>(_ content: Content) -> some View {
    content
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
        orientation.openedIn = MacDesktopViewerRotation.currentOrientation()
        updateLifecycle()
        updateIdleTimer()
      }
      .onDisappear {
        hintTask?.cancel()
        stopSession()
        restoreOrientationOnClose()
        if !isPreview { UIApplication.shared.isIdleTimerDisabled = false }
      }
      .onChange(of: lease.controlling) { _, next in
        controlOrientationChanged(next)
        updateIdleTimer()
      }
      // Moved off the phone's whole screen (unfolded into the pane) while
      // holding landscape: let the display go where it wants.
      .onChange(of: turnsPhone) { _, turns in
        if !turns, orientation.locksLandscape {
          _ = orientation.endControl()
          MacDesktopViewerRotation.apply(lockLandscape: false, request: nil)
        }
      }
      .onChange(of: presentation) { _, _ in updateIdleTimer() }
      .onChange(of: lease.notice) { _, notice in
        if let notice { flashHint(notice, warning: true) }
      }
      .onChange(of: lease.errorText) { _, text in
        if let text { flashHint(text, warning: true) }
      }
      .onChange(of: scenePhase) { _, _ in updateLifecycle() }
      // Every transition, from the service itself: through the menu-safe
      // publisher a drop and reconnect under an open menu could coalesce
      // into no change, and the stream would not restart.
      .onReceive(syncService.$connectionState.removeDuplicates().receive(on: DispatchQueue.main)) { _ in updateLifecycle() }
      .onChange(of: isLiveCapable) { _, _ in updateLifecycle() }
  }

  // MARK: - Stage

  private var cornerRadius: CGFloat { presentation.screenCornerRadius }

  @ViewBuilder
  private var stageContent: some View {
    #if DEBUG
    if preview != nil {
      previewStage
    } else {
      liveStage
    }
    #else
    liveStage
    #endif
  }

  @ViewBuilder
  private var liveStage: some View {
    if !syncService.supportsMacDesktopStream(laneId: laneId) {
      stageMessage("Live video isn't available from this machine.")
    } else if desktop?.supported == false {
      stageMessage("This machine can't host a lane screen.")
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
            lease: lease,
            cornerRadius: cornerRadius,
            onTap: { toggleMenu() }
          )
          .overlay { controlRing }
          MacDesktopViewerStatusOverlay(
            session: session,
            hostError: desktop?.stream?.lastError,
            onReconnect: { reconnect() }
          )
        }
      } else if !syncService.isLaneMachineConnected(laneId: laneId) {
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

  /// Over the pane, an orange edge says the finger belongs to the screen.
  /// Full screen the menu button's ring says it.
  @ViewBuilder
  private var controlRing: some View {
    if controlling, presentation.isPane {
      RoundedRectangle(cornerRadius: cornerRadius + 3, style: .continuous)
        .strokeBorder(ADEColor.warning, lineWidth: 3)
        .padding(-3)
        .allowsHitTesting(false)
    }
  }

  #if DEBUG
  private var previewStage: some View {
    MacDesktopPreviewPicture()
      .frame(maxWidth: .infinity)
      .aspectRatio(16.0 / 10.0, contentMode: .fit)
        .liveStageReportsAspect(16.0 / 10.0)
      .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
      .overlay { controlRing }
      .onTapGesture { toggleMenu() }
  }
  #endif

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
        canStart: syncService.laneCommandDescriptor("macDesktop.start", laneId: laneId)?.policy.allowsPhone == true,
        hostIsWindows: desktop?.windowsDesktop != nil,
        hostIsLinux: desktop?.linuxDesktop != nil,
        pcOperation: desktop?.windowsDesktop?.operation?.kind
      ))
      if !starting && syncService.laneCommandDescriptor("macDesktop.start", laneId: laneId)?.policy.allowsPhone == true && desktop?.windowsDesktop?.operation == nil {
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
        .disabled(!syncService.isLaneMachineConnected(laneId: laneId))
        .accessibilityHint("Starts this lane's screen on its machine")
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

  // MARK: - Menu

  private var menuPanel: some View {
    LiveStageMenuPanel {
      LiveStageMenuHeader(
        title: screenTitle,
        detail: macDesktopViewerRibbon(
          controlling: controlling,
          lease: desktop?.lease,
          displayName: desktop?.display?.name
        ),
        recording: desktop?.recording?.running == true
      )

      controlRows

      HStack(spacing: 6) {
        if canInspect {
          LiveStageMenuTile(title: "Inspect", systemImage: "viewfinder") {
            menuOpen = false
            beginInspect()
          }
          .accessibilityHint("Freezes the picture so you can pick an element and mark it up")
          .accessibilityIdentifier("MacDesktopViewer.Inspect")
        }
        LiveStageMenuTile(title: turned ? "Upright" : "Turn", systemImage: turned ? "rotate.left" : "rotate.right") {
          withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) { turns.toggle(turnKey) }
        }
        .accessibilityHint("Turns the picture a quarter turn so it can fill the screen")
      }
      .padding(.vertical, 2)

      if let seat = stopSeat {
        LiveStageMenuRow(
          title: stopping ? "Stopping…" : desktopStopCopy(seat: seat).action,
          systemImage: "stop.fill",
          tint: ADEColor.danger,
          disabled: stopping
        ) {
          menuOpen = false
          confirmingStop = true
        }
      }
      if stageClose != nil, stageContext.choices.count > 1 {
        LiveStagePlacementMenu(context: stageContext) { menuOpen = false }
      }
      if let session {
        MacDesktopViewerReconnectRow(session: session) {
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
      .accessibilityIdentifier("MacDesktopViewer.Close")
    }
  }

  /// Take control, or Return to agent while this phone holds the screen.
  @ViewBuilder
  private var controlRows: some View {
    if controlling {
      LiveStageMenuRow(title: "Return to agent", systemImage: "arrow.uturn.backward", detail: "Esc") {
        menuOpen = false
        returnControl()
      }
      .accessibilityIdentifier("MacDesktopViewer.ReturnControl")
    } else if showsControl {
      LiveStageMenuRow(
        title: lease.busy ? "Taking control…" : "Take control",
        systemImage: "hand.point.up.left",
        tint: ADEColor.warning,
        disabled: controlBlocker != nil || lease.busy
      ) {
        takeControl()
      }
      .accessibilityIdentifier("MacDesktopViewer.TakeControl")
      if let blocker = controlBlocker {
        Text(blocker)
          .font(.caption)
          .foregroundStyle(.white.opacity(0.55))
          .padding(.horizontal, 10)
          .padding(.bottom, 4)
      }
    }
  }

  /// The host lets a phone drive the screen at all.
  private var showsControl: Bool {
    isPreview || syncService.supportsMacDesktopControl(laneId: laneId)
  }

  /// Why Take control is off right now, or nil when it is on.
  private var controlBlocker: String? {
    if isPreview { return nil }
    guard desktop?.display != nil, session != nil else { return "Waiting for the picture." }
    if macDesktopDisplayGeometry(desktop?.display) == nil { return macDesktopNoGeometryMessage }
    return nil
  }

  private func takeControl() {
    #if DEBUG
    if preview != nil {
      previewControlling = true
      menuOpen = false
      return
    }
    #endif
    guard controlBlocker == nil else { return }
    ADEHaptics.success()
    Task {
      await lease.take(laneId: laneId, using: syncService)
      if lease.controlling {
        menuOpen = false
        flashHint("You have control. The menu hands it back.", warning: false)
      }
    }
  }

  private func returnControl() {
    #if DEBUG
    if preview != nil {
      previewControlling = false
      return
    }
    #endif
    lease.release(laneId: laneId, using: syncService)
  }

  private var screenTitle: String {
    if desktop?.linuxDesktop != nil { return "Linux" }
    return windowsDesktopSeatLabel(windowsDesktopSeat(desktop?.windowsDesktop, display: desktop?.display))
      ?? (desktop?.windowsDesktop == nil ? "macOS" : "Windows")
  }

  /// The Windows seat Stop acts on, when this host can stop it.
  private var stopSeat: String? {
    if desktop?.linuxDesktop != nil, desktop?.display != nil,
       syncService.canManageLinuxDesktop("macDesktop.stopSeat", laneId: laneId) { return "linux" }
    guard let seat = windowsDesktopSeat(desktop?.windowsDesktop, display: desktop?.display),
          syncService.canStopWindowsDesktop(seat: seat) else { return nil }
    return seat
  }

  private func desktopStopCopy(seat: String) -> (action: String, consequence: String) {
    if seat == "linux" { return ("Stop screen", "This closes the lane's screen and its apps.") }
    return windowsDesktopStopCopy(seat: seat)
  }

  @ViewBuilder
  private func stopDialogActions(seat: String) -> some View {
    Button(desktopStopCopy(seat: seat).action, role: .destructive) {
      Task {
        stopping = true
        defer { stopping = false }
        do {
          if seat == "linux" {
            try await syncService.linuxDesktopStop(laneId: laneId)
          } else {
            try await syncService.windowsDesktopStop(laneId: laneId, seat: seat)
          }
          await refresh()
        } catch {
          flashHint(macDesktopVisibleMessage(for: error, hostIsWindows: true), warning: true)
        }
      }
    }
    Button("Keep running", role: .cancel) {}
  }

  private var canInspect: Bool {
    inspect == nil
      && !isPreview
      && syncService.supportsViewerRemoteAction("macDesktop.observe")
      && desktop?.display != nil
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

  private func flashHint(_ text: String, warning: Bool, seconds: Double = 2.4) {
    if warning { ADEHaptics.warning() }
    hint = text
    hintTask?.cancel()
    hintTask = Task { @MainActor in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled else { return }
      hint = nil
      lease.notice = nil
      lease.errorText = nil
    }
  }

  /// The screen stays awake while the desktop has it: full screen, or while
  /// controlling.
  private func updateIdleTimer() {
    guard !isPreview else { return }
    UIApplication.shared.isIdleTimerDisabled = presentation.isFullScreen || controlling
  }

  // MARK: - Data

  private var isLiveCapable: Bool {
    syncService.supportsMacDesktopStream(laneId: laneId)
      && desktop?.supported == true
      && desktop?.display != nil
  }

  /// Keeps the last good snapshot on a failed read, like the Apple viewer: a
  /// timeout must not blank the ribbon or tear down the picture.
  private func refresh() async {
    guard syncService.supportsWorkToolsState(laneId: laneId) else { return }
    guard let next = try? await syncService.fetchWorkToolsLaneState(laneId: laneId) else { return }
    guard !Task.isCancelled else { return }
    desktop = next.macDesktop
    retryStoppedSessionIfNeeded()
  }

  private func startDesktop() {
    macDesktopStartDisplay(
      using: syncService,
      laneId: laneId,
      hostIsWindows: desktop?.windowsDesktop != nil,
      starting: $starting,
      errorText: $startError,
      refresh: { await refresh() }
    )
  }

  // MARK: - Orientation

  /// Only a phone shown full screen turns: never an iPad, never the Duo's
  /// large display, never a viewer over a pane.
  private var turnsPhone: Bool {
    UIDevice.current.userInterfaceIdiom == .phone
      && presentation.isFullScreen
      && !duo.isWide
  }

  /// Take control turns the phone to landscape and holds it there. Return
  /// turns it back to the orientation from before Take control.
  private func controlOrientationChanged(_ controlling: Bool) {
    guard UIDevice.current.userInterfaceIdiom == .phone else { return }
    if controlling {
      // A turned picture already runs the long way: the phone stays put.
      guard turnsPhone, !turned else { return }
      // The phone turns for Control, not because the person turned it: Turn
      // stays the one remembered for how they were holding it.
      controlTurnKey = turnKey
      let request = orientation.beginControl(current: MacDesktopViewerRotation.currentOrientation())
      MacDesktopViewerRotation.apply(lockLandscape: orientation.locksLandscape, request: request)
    } else {
      // Also when the lock already went (unfolded to the pane mid-control).
      controlTurnKey = nil
      guard orientation.locksLandscape else { return }
      let request = orientation.endControl()
      MacDesktopViewerRotation.apply(lockLandscape: false, request: turnsPhone ? request : nil)
    }
  }

  private var turnKey: String {
    controlTurnKey ?? LiveStageTurns.key("macDesktop", context: stageContext, layout: duo)
  }
  private var turned: Bool { turns.isTurned(turnKey) }

  /// The lock always goes. A turn this viewer made is undone; a turn the
  /// person made with the device stays.
  private func restoreOrientationOnClose() {
    guard UIDevice.current.userInterfaceIdiom == .phone else { return }
    let request = orientation.close()
    MacDesktopViewerRotation.apply(lockLandscape: false, request: request)
  }

  // MARK: - Live stream lifecycle

  /// Same rule as the tools sheet: on screen, foreground, connected, and the
  /// lane has a display.
  private func updateLifecycle() {
    guard !isPreview else { return }
    let shouldRun = isLiveCapable
      && inspect == nil
      && scenePhase == .active
      && syncService.isLaneMachineConnected(laneId: laneId)
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

  /// Unmounting the picture hands back any control it held.
  private func stopSession() {
    guard let current = session else { return }
    current.stop(using: syncService)
    session = nil
    lease.release(laneId: laneId, using: syncService)
  }

  // MARK: - Inspect

  /// Freezes the desktop for inspect: stops the live subscription, then asks
  /// the host for one accessibility observation and its screenshot. The
  /// desktop itself keeps running.
  private func beginInspect() {
    guard inspect == nil, desktop?.display != nil else { return }
    ADEHaptics.light()
    let model = LiveInspectMarkupModel(surface: .macDesktop, laneId: laneId, chatSessionId: chatSessionId)
    model.begin(plan: .macDesktop, using: syncService)
    inspect = model
    stopSession()
  }

  private func exitInspect() {
    guard inspect != nil else { return }
    inspect = nil
    updateLifecycle()
  }

  /// Re-subscribes on the same session rather than tearing it down: a stop
  /// sends an unsubscribe that could land after the new subscribe under the
  /// same id and cancel it.
  private func reconnect() {
    guard isLiveCapable, syncService.isLaneMachineConnected(laneId: laneId) else { return }
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
          syncService.isLaneMachineConnected(laneId: laneId)
    else { return }
    Task { await current.start(using: syncService) }
  }
}

/// Reconnect in the menu, shown only when the status card offers one. Its own
/// view so it observes the session's phase.
private struct MacDesktopViewerReconnectRow: View {
  @ObservedObject var session: MacDesktopLiveSession
  let onReconnect: () -> Void

  var body: some View {
    if macDesktopViewerOverlay(phase: session.phase, hasFrame: session.hasFrame, hostError: nil)?.offersReconnect == true {
      LiveStageMenuRow(title: "Reconnect", systemImage: "arrow.clockwise", action: onReconnect)
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
