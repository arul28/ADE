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
    GeometryReader { proxy in
      let insets = chromeInsets ?? proxy.safeAreaInsets
      ZStack(alignment: .topLeading) {
        // A tap around the picture opens the menu too.
        LiveStageBackdrop(presentation: presentation)
          .contentShape(Rectangle())
          .onTapGesture { toggleMenu() }
        stage(size: proxy.size, insets: EdgeInsets())
          .frame(width: proxy.size.width, height: proxy.size.height)
        if let hint {
          VStack {
            Spacer(minLength: 0)
            LiveStageHintChip(text: hint)
              .padding(.bottom, insets.bottom + 20)
          }
          .frame(width: proxy.size.width, height: proxy.size.height)
          .allowsHitTesting(false)
        }
        LiveStageMenuButton(
          container: proxy.size,
          insets: insets,
          storageKey: "ade.liveStage.button.\(presentation.isPane ? "pane" : "full").\(proxy.size.width > proxy.size.height ? "wide" : "tall")",
          symbolName: controlling ? "cursorarrow.rays" : "ellipsis",
          alert: controlling,
          isOpen: $menuOpen
        ) {
          menuPanel
        }
        .frame(width: proxy.size.width, height: proxy.size.height)
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .animation(.easeOut(duration: 0.18), value: hint)
    }
    // Over the pane it runs top to bottom but never sideways under the edge
    // bar; full screen it runs edge to edge.
    .ignoresSafeArea(.container, edges: presentation.isPane ? .vertical : .all)
    .environment(\.colorScheme, .dark)
    .statusBarHidden(hidesStatusBar || presentation.isFullScreen)
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
      stopSeat.map { "\(windowsDesktopStopCopy(seat: $0).action)?" } ?? "",
      isPresented: $confirmingStop,
      titleVisibility: .visible
    ) {
      if let seat = stopSeat { stopDialogActions(seat: seat) }
    } message: {
      if let seat = stopSeat { Text(windowsDesktopStopCopy(seat: seat).consequence) }
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

  /// `insets` is what of the stage is the system's: the picture stays out of
  /// it and the black runs under it.
  @ViewBuilder
  private func stage(size: CGSize, insets: EdgeInsets) -> some View {
    // Over the pane the picture keeps a little room and its own corners;
    // full screen it runs edge to edge.
    let gap = presentation.pictureGap
    let container = CGSize(
      width: max(0, size.width - insets.leading - insets.trailing - gap * 2),
      height: max(0, size.height - insets.top - insets.bottom - gap * 2)
    )
    let inner = turned ? CGSize(width: container.height, height: container.width) : container
    stageContent
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
        canStart: syncService.supportsMacDesktopStart,
        hostIsWindows: desktop?.windowsDesktop != nil,
        pcOperation: desktop?.windowsDesktop?.operation?.kind
      ))
      if !starting && syncService.supportsMacDesktopStart && desktop?.windowsDesktop?.operation == nil {
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
          title: stopping ? "Stopping…" : windowsDesktopStopCopy(seat: seat).action,
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
    isPreview || syncService.supportsMacDesktopControl
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
    windowsDesktopSeatLabel(windowsDesktopSeat(desktop?.windowsDesktop, display: desktop?.display))
      ?? (desktop?.windowsDesktop == nil ? "macOS" : "Windows")
  }

  /// The Windows seat Stop acts on, when this host can stop it.
  private var stopSeat: String? {
    guard let seat = windowsDesktopSeat(desktop?.windowsDesktop, display: desktop?.display),
          syncService.canStopWindowsDesktop(seat: seat) else { return nil }
    return seat
  }

  @ViewBuilder
  private func stopDialogActions(seat: String) -> some View {
    Button(windowsDesktopStopCopy(seat: seat).action, role: .destructive) {
      Task {
        stopping = true
        defer { stopping = false }
        do {
          try await syncService.windowsDesktopStop(laneId: laneId, seat: seat)
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
      let request = orientation.beginControl(current: MacDesktopViewerRotation.currentOrientation())
      MacDesktopViewerRotation.apply(lockLandscape: orientation.locksLandscape, request: request)
    } else {
      guard orientation.locksLandscape else { return }
      let request = orientation.endControl()
      MacDesktopViewerRotation.apply(lockLandscape: false, request: turnsPhone ? request : nil)
    }
  }

  private var turnKey: String { LiveStageTurns.key("macDesktop", context: stageContext, layout: duo) }
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
    : "The macOS desktop could not complete the request. Try again.")
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
  pcOperation: String? = nil
) -> String {
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
