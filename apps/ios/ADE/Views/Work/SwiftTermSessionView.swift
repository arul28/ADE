import SwiftUI
import SwiftTerm
import UIKit

/// SwiftTerm's iOS view snaps the viewport to the bottom on every emitted
/// scroll event (i.e. each new output line). While the user is reading
/// scrollback we suppress that snap so streaming output cannot yank the view;
/// `resumeAutoScroll()` re-enables following and performs one snap-to-bottom.
final class ADESwiftTermView: TerminalView {
  var holdScrollOnOutput = false
  var onLayout: (() -> Void)?

  override func scrolled(source terminal: Terminal, yDisp: Int) {
    guard !holdScrollOnOutput else { return }
    super.scrolled(source: terminal, yDisp: yDisp)
  }

  func resumeAutoScroll() {
    holdScrollOnOutput = false
    // super's implementation ignores yDisp: it re-syncs contentSize and pins
    // the viewport to the bottom of the scrollback.
    super.scrolled(source: getTerminal(), yDisp: 0)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }
}

/// Owns the SwiftTerm view, its delegate wiring, the loaded transcript byte
/// window (for history paging), input coalescing, and scroll-pinning state for
/// the full-screen terminal session.
@MainActor
final class TerminalSessionController: NSObject, ObservableObject {
  @Published private(set) var isPinnedToBottom = true
  /// Live chunks received since the user scrolled up; drives "↓ Live N".
  @Published private(set) var liveChunksWhileScrolledUp = 0
  @Published private(set) var isLoadingHistory = false
  @Published private(set) var hasExited = false
  @Published private(set) var isSubscribed = false
  @Published private(set) var ctrlArmed = false
  @Published private(set) var bellPulse = 0
  /// Bumped when typed input is dropped because the host is unreachable.
  @Published private(set) var blockedInputPulse = 0
  @Published private(set) var fontSize: CGFloat = TerminalSessionController.defaultFontSize

  static let defaultFontSize: CGFloat = 12
  private static let minFontSize: CGFloat = 8
  private static let maxFontSize: CGFloat = 20
  private static let transcriptByteCap = 4 * 1024 * 1024
  private static let scrollbackLines = 10_000

  private(set) var sessionId = ""
  private weak var syncService: SyncService?
  private var terminalView: ADESwiftTermView?

  // Loaded transcript window as raw bytes plus its host byte offsets. The
  // window is what gets re-fed into SwiftTerm on rebuilds (history prepends,
  // full-replace hydrations).
  private var transcript = Data()
  private var transcriptStartOffset: Int?
  private var transcriptEndOffset: Int?
  private var historyAtStart = false

  // Never feed bytes before the PTY has our real cols/rows: the hydrate
  // snapshot would wrap at the desktop width. Events queue until first layout.
  private var readyToFeed = false
  private var queuedEvents: [TerminalStreamEvent] = []

  // ~16ms input coalescing so rapid keystrokes ride a single envelope.
  private var pendingInput = ""
  private var inputFlushTask: Task<Void, Never>?

  private var lastSentSize: (cols: Int, rows: Int)?
  private var pinchBaseFontSize: CGFloat = TerminalSessionController.defaultFontSize
  private var ctrlResetObserver: NSObjectProtocol?

  deinit {
    if let ctrlResetObserver {
      NotificationCenter.default.removeObserver(ctrlResetObserver)
    }
  }

  // MARK: - Lifecycle

  func activate(syncService: SyncService, sessionId: String, sessionStatus: String) {
    self.syncService = syncService
    self.sessionId = sessionId
    let status = sessionStatus.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if status == "ended" || status == "exited" || status == "stopped" {
      hasExited = true
    }
    syncService.attachTerminalStream(sessionId: sessionId) { [weak self] event in
      self?.handleStreamEvent(event)
    }
    let resumeOffset = transcriptEndOffset
    Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        try await syncService.subscribeTerminalStream(sessionId: sessionId, sinceOffset: resumeOffset)
        self.isSubscribed = true
      } catch {
        self.isSubscribed = false
      }
    }
  }

  func deactivate() {
    inputFlushTask?.cancel()
    inputFlushTask = nil
    pendingInput = ""
    guard let syncService, !sessionId.isEmpty else { return }
    syncService.detachTerminalStream(sessionId: sessionId)
    isSubscribed = false
    let id = sessionId
    Task { try? await syncService.unsubscribeTerminal(sessionId: id) }
  }

  func handleConnectionChange(isConnected: Bool) {
    if isConnected {
      // The sync layer re-subscribes with sinceOffset on reconnect; we only
      // need to re-assert the phone's PTY size.
      isSubscribed = true
      lastSentSize = nil
      if let terminal = terminalView?.getTerminal() {
        sendResizeIfNeeded(cols: terminal.cols, rows: terminal.rows)
      }
    } else {
      isSubscribed = false
    }
  }

  // MARK: - Terminal view

  func makeTerminalView() -> ADESwiftTermView {
    if let terminalView {
      return terminalView
    }
    let view = ADESwiftTermView(
      frame: CGRect(x: 0, y: 0, width: 390, height: 640),
      font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    )
    view.terminalDelegate = self
    view.delegate = self
    // The SwiftUI key bar replaces SwiftTerm's stock accessory strip.
    view.inputAccessoryView = nil
    view.backgroundColor = .black
    view.nativeBackgroundColor = .black
    view.nativeForegroundColor = UIColor(white: 0.92, alpha: 1)
    view.keyboardAppearance = .dark
    view.changeScrollback(Self.scrollbackLines)
    view.onLayout = { [weak self] in
      self?.handleTerminalLayout()
    }
    view.addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:))))
    // SwiftTerm auto-resets controlModifier after the next key; mirror that
    // into the latched-Ctrl chip.
    ctrlResetObserver = NotificationCenter.default.addObserver(
      forName: Notification.Name("SwiftTerm.TerminalView.controlModifierReset"),
      object: view,
      queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.ctrlArmed = false
      }
    }
    terminalView = view
    return view
  }

  private func handleTerminalLayout() {
    guard let view = terminalView, view.bounds.width > 10, view.bounds.height > 10 else { return }
    let terminal = view.getTerminal()
    guard terminal.cols > 1, terminal.rows > 1 else { return }
    // Resize the PTY BEFORE the first feed so hydrated content wraps for the
    // phone's viewport, not the desktop's.
    sendResizeIfNeeded(cols: terminal.cols, rows: terminal.rows)
    if !readyToFeed {
      readyToFeed = true
      let queued = queuedEvents
      queuedEvents = []
      queued.forEach(applyStreamEvent)
    }
  }

  // MARK: - Stream events

  private func handleStreamEvent(_ event: TerminalStreamEvent) {
    guard readyToFeed else {
      queuedEvents.append(event)
      return
    }
    applyStreamEvent(event)
  }

  private func applyStreamEvent(_ event: TerminalStreamEvent) {
    switch event {
    case .hydrate(let text, let replacing, let startOffset, let endOffset):
      if replacing {
        transcript = Data(text.utf8)
        transcriptStartOffset = startOffset
        transcriptEndOffset = endOffset
        historyAtStart = startOffset == 0
        rebuildTerminal()
      } else {
        appendBytes(Data(text.utf8), endOffset: endOffset, countsAsLive: false)
      }
    case .chunk(let text, let endOffset):
      appendBytes(Data(text.utf8), endOffset: endOffset, countsAsLive: true)
    case .exit:
      hasExited = true
    }
  }

  private func appendBytes(_ bytes: Data, endOffset: Int?, countsAsLive: Bool) {
    if let endOffset {
      transcriptEndOffset = endOffset
    }
    guard !bytes.isEmpty else { return }
    transcript.append(bytes)
    enforceTranscriptCap()
    terminalView?.feed(byteArray: [UInt8](bytes)[...])
    if countsAsLive, !isPinnedToBottom {
      liveChunksWhileScrolledUp += 1
    }
  }

  private func enforceTranscriptCap() {
    guard transcript.count > Self.transcriptByteCap else { return }
    // Drop well below the cap so steady output doesn't re-trim every chunk.
    let target = Self.transcriptByteCap - 512 * 1024
    let dropCount = transcript.count - target
    transcript.removeFirst(dropCount)
    if let start = transcriptStartOffset {
      transcriptStartOffset = start + dropCount
    }
    historyAtStart = false
  }

  private func rebuildTerminal() {
    guard let view = terminalView else { return }
    view.holdScrollOnOutput = false
    view.getTerminal().resetToInitialState()
    if !transcript.isEmpty {
      view.feed(byteArray: [UInt8](transcript)[...])
    }
    isPinnedToBottom = true
    liveChunksWhileScrolledUp = 0
    view.resumeAutoScroll()
  }

  // MARK: - History paging

  func loadOlderHistoryIfNeeded() {
    guard !isLoadingHistory, !historyAtStart else { return }
    guard let syncService else { return }
    guard let startOffset = transcriptStartOffset, startOffset > 0 else { return }
    guard transcript.count < Self.transcriptByteCap else { return }
    isLoadingHistory = true
    let id = sessionId
    Task { @MainActor [weak self] in
      defer { self?.isLoadingHistory = false }
      guard let self else { return }
      do {
        let slice = try await syncService.fetchTerminalHistory(sessionId: id, beforeOffset: startOffset)
        // A replace-hydration may have landed while the fetch was in flight;
        // prepending stale bytes would corrupt the window.
        guard self.transcriptStartOffset == startOffset, slice.endOffset <= startOffset else { return }
        if !slice.data.isEmpty {
          self.transcript = Data(slice.data.utf8) + self.transcript
          self.transcriptStartOffset = slice.startOffset
          self.rebuildPreservingViewport()
        }
        self.historyAtStart = slice.atStart
      } catch {
        // Older host (no terminal_history) or transient failure: stop paging
        // for this screen session instead of hammering the socket.
        self.historyAtStart = true
      }
    }
  }

  /// SwiftTerm has no prepend; after splicing older bytes in front we reset
  /// and re-feed the whole window (it parses MBs in milliseconds), then shift
  /// the content offset by the growth so the previously-topmost content stays
  /// visible.
  private func rebuildPreservingViewport() {
    guard let view = terminalView else { return }
    let oldHeight = view.contentSize.height
    let oldOffsetY = view.contentOffset.y
    view.holdScrollOnOutput = false
    view.getTerminal().resetToInitialState()
    if !transcript.isEmpty {
      view.feed(byteArray: [UInt8](transcript)[...])
    }
    DispatchQueue.main.async { [weak self] in
      guard let self, let view = self.terminalView else { return }
      let grown = max(0, view.contentSize.height - oldHeight)
      view.holdScrollOnOutput = true
      self.isPinnedToBottom = false
      view.contentOffset = CGPoint(x: 0, y: max(0, oldOffsetY + grown))
    }
  }

  // MARK: - Input

  var canSendInput: Bool {
    guard let syncService else { return false }
    return (syncService.connectionState == .connected || syncService.connectionState == .syncing) && !hasExited
  }

  func enqueueInput(_ text: String) {
    guard !text.isEmpty else { return }
    guard canSendInput else {
      if !hasExited {
        blockedInputPulse += 1
      }
      return
    }
    pendingInput += text
    scheduleInputFlush()
    if !isPinnedToBottom {
      scrollToLive()
    }
  }

  func sendKeySequence(_ data: String) {
    ADEHaptics.light()
    enqueueInput(data)
  }

  func toggleCtrl() {
    guard let view = terminalView else { return }
    view.controlModifier.toggle()
    ctrlArmed = view.controlModifier
    ADEHaptics.medium()
    if ctrlArmed {
      _ = view.becomeFirstResponder()
    }
  }

  var pasteboardHasStrings: Bool {
    UIPasteboard.general.hasStrings
  }

  func pasteFromClipboard() {
    guard canSendInput else {
      blockedInputPulse += 1
      return
    }
    ADEHaptics.light()
    // Routes through SwiftTerm, which wraps in ESC[200~ … ESC[201~ whenever
    // the host application enabled bracketed paste.
    terminalView?.paste(nil)
  }

  private func scheduleInputFlush() {
    guard inputFlushTask == nil else { return }
    inputFlushTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 16_000_000)
      guard let self, !Task.isCancelled else { return }
      self.inputFlushTask = nil
      let buffered = self.pendingInput
      self.pendingInput = ""
      guard !buffered.isEmpty else { return }
      self.syncService?.sendTerminalInput(sessionId: self.sessionId, data: buffered)
    }
  }

  private func sendResizeIfNeeded(cols: Int, rows: Int) {
    guard cols > 1, rows > 1 else { return }
    if let lastSentSize, lastSentSize.cols == cols, lastSentSize.rows == rows {
      return
    }
    lastSentSize = (cols, rows)
    syncService?.sendTerminalResize(sessionId: sessionId, cols: cols, rows: rows)
  }

  // MARK: - Scroll pinning

  func scrollToLive() {
    liveChunksWhileScrolledUp = 0
    isPinnedToBottom = true
    terminalView?.resumeAutoScroll()
  }

  private func updatePinState() {
    guard let view = terminalView else { return }
    let nearBottom = view.contentOffset.y + view.bounds.height >= view.contentSize.height - 32
    if nearBottom {
      if !isPinnedToBottom {
        isPinnedToBottom = true
        liveChunksWhileScrolledUp = 0
      }
      view.holdScrollOnOutput = false
    } else {
      if isPinnedToBottom {
        isPinnedToBottom = false
      }
      view.holdScrollOnOutput = true
    }
  }

  private func settleScroll() {
    updatePinState()
    if isPinnedToBottom {
      terminalView?.resumeAutoScroll()
    }
  }

  // MARK: - Pinch zoom

  @objc private func handlePinch(_ gesture: UIPinchGestureRecognizer) {
    switch gesture.state {
    case .began:
      pinchBaseFontSize = fontSize
    case .changed:
      let next = min(max(pinchBaseFontSize * gesture.scale, Self.minFontSize), Self.maxFontSize)
      if abs(next - fontSize) >= 0.5 {
        fontSize = next
        // Font change recomputes cell metrics + cols/rows inside SwiftTerm,
        // which fires sizeChanged → sendTerminalResize.
        terminalView?.font = UIFont.monospacedSystemFont(ofSize: next, weight: .regular)
      }
    default:
      break
    }
  }

  fileprivate func handleBell() {
    UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
    bellPulse += 1
  }
}

// MARK: - TerminalViewDelegate

extension TerminalSessionController: TerminalViewDelegate {
  nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
    let text = String(decoding: data, as: UTF8.self)
    MainActor.assumeIsolated {
      enqueueInput(text)
    }
  }

  nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    MainActor.assumeIsolated {
      sendResizeIfNeeded(cols: newCols, rows: newRows)
    }
  }

  nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
    guard let url = URL(string: link), url.scheme?.lowercased().hasPrefix("http") == true else { return }
    MainActor.assumeIsolated {
      UIApplication.shared.open(url)
    }
  }

  nonisolated func bell(source: TerminalView) {
    MainActor.assumeIsolated {
      handleBell()
    }
  }

  nonisolated func clipboardCopy(source: TerminalView, content: Data) {
    let text = String(decoding: content, as: UTF8.self)
    MainActor.assumeIsolated {
      UIPasteboard.general.string = text
    }
  }

  nonisolated func setTerminalTitle(source: TerminalView, title: String) {}
  nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  nonisolated func scrolled(source: TerminalView, position: Double) {}
  nonisolated func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
  nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

// MARK: - UIScrollViewDelegate (TerminalView is a UIScrollView)

extension TerminalSessionController: UIScrollViewDelegate {
  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    guard scrollView === terminalView else { return }
    // Ignore programmatic offset changes (SwiftTerm's own bottom snaps).
    guard scrollView.isTracking || scrollView.isDecelerating else { return }
    updatePinState()
    if scrollView.contentOffset.y < 160 {
      loadOlderHistoryIfNeeded()
    }
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    guard scrollView === terminalView, !decelerate else { return }
    settleScroll()
  }

  func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    guard scrollView === terminalView else { return }
    settleScroll()
  }
}

// MARK: - SwiftUI wrapper

struct SwiftTermSessionView: UIViewRepresentable {
  @ObservedObject var controller: TerminalSessionController

  func makeUIView(context: Context) -> ADESwiftTermView {
    controller.makeTerminalView()
  }

  func updateUIView(_ uiView: ADESwiftTermView, context: Context) {}
}
