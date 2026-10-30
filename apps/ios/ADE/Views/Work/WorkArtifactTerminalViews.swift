import SwiftUI
import UIKit
import AVKit

final class WorkArtifactVideoPlayerModel: ObservableObject {
  let player: AVPlayer
  @Published private(set) var isPlaying = false
  private var playingObservation: NSKeyValueObservation?
  private var endObserver: NSObjectProtocol?

  init(url: URL) {
    player = AVPlayer(url: url)
    playingObservation = player.observe(\.timeControlStatus, options: [.initial, .new]) { [weak self] player, _ in
      let playing = player.timeControlStatus != .paused
      DispatchQueue.main.async { self?.isPlaying = playing }
    }
    // A video that played to the end starts over on the next play.
    endObserver = NotificationCenter.default.addObserver(
      forName: .AVPlayerItemDidPlayToEndTime,
      object: nil,
      queue: .main
    ) { [weak self] note in
      guard let self, (note.object as? AVPlayerItem) === self.player.currentItem else { return }
      self.player.seek(to: .zero)
    }
  }

  deinit {
    if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
  }

  /// Sets `isPlaying` itself so the tap redraws at once; the observer only
  /// catches changes the player makes on its own (the end of the video).
  func togglePlayback() {
    if isPlaying { player.pause() } else { player.play() }
    isPlaying.toggle()
  }

  func update(url: URL) {
    if let currentURL = (player.currentItem?.asset as? AVURLAsset)?.url, currentURL == url {
      return
    }
    player.replaceCurrentItem(with: AVPlayerItem(url: url))
  }
}

/// AVKit's player, for full-screen proof pages. Never put it in a transcript
/// row: see `WorkArtifactInlineVideoView`.
struct WorkArtifactVideoPlayerView: View {
  let url: URL
  /// A chapter's start, in seconds: set it and the player seeks there, plays,
  /// and clears it.
  var seek: Binding<Double?>?
  @StateObject var model: WorkArtifactVideoPlayerModel

  init(url: URL, seek: Binding<Double?>? = nil) {
    self.url = url
    self.seek = seek
    _model = StateObject(wrappedValue: WorkArtifactVideoPlayerModel(url: url))
  }

  var body: some View {
    VideoPlayer(player: model.player)
      .onChange(of: url) { _, newValue in
        model.update(url: newValue)
      }
      .onChange(of: seek?.wrappedValue) { _, requested in
        guard let requested else { return }
        model.player.seek(to: CMTime(seconds: requested, preferredTimescale: 600))
        model.player.play()
        seek?.wrappedValue = nil
      }
  }
}

/// A video inside an answer. A transcript row is a `UIHostingConfiguration`
/// cell, and such a cell cannot host a view controller: AVKit's `VideoPlayer`
/// there draws SwiftUI's yellow "unsupported view" box instead of the video.
/// This is a bare `AVPlayerLayer` with a play button; Expand opens the
/// full-screen viewer, which has AVKit's controls.
struct WorkArtifactInlineVideoView: View {
  let url: URL
  /// A chapter's start, in seconds: set it and the player seeks there, plays,
  /// and clears it.
  var seek: Binding<Double?>?
  let onExpand: () -> Void
  @StateObject private var model: WorkArtifactVideoPlayerModel

  init(url: URL, seek: Binding<Double?>? = nil, onExpand: @escaping () -> Void) {
    self.url = url
    self.seek = seek
    self.onExpand = onExpand
    _model = StateObject(wrappedValue: WorkArtifactVideoPlayerModel(url: url))
  }

  var body: some View {
    WorkPlayerLayerView(player: model.player)
      .background(Color.black)
      .overlay {
        if !model.isPlaying {
          Image(systemName: "play.fill")
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 56, height: 56)
            .background(Color.black.opacity(0.55), in: Circle())
            .allowsHitTesting(false)
        }
      }
      .contentShape(Rectangle())
      .onTapGesture { model.togglePlayback() }
      .accessibilityElement()
      .accessibilityLabel(model.isPlaying ? "Pause video" : "Play video")
      .accessibilityAddTraits(.isButton)
      .accessibilityAction { model.togglePlayback() }
      .overlay(alignment: .topTrailing) {
        Button {
          model.player.pause()
          onExpand()
        } label: {
          Image(systemName: "arrow.up.left.and.arrow.down.right")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 32, height: 32)
            .background(Color.black.opacity(0.55), in: Circle())
        }
        .buttonStyle(.plain)
        .padding(8)
        .accessibilityLabel("Open the video full screen")
      }
      .onChange(of: url) { _, newValue in
        model.update(url: newValue)
      }
      .onChange(of: seek?.wrappedValue) { _, requested in
        guard let requested else { return }
        model.player.seek(to: CMTime(seconds: requested, preferredTimescale: 600))
        model.player.play()
        seek?.wrappedValue = nil
      }
      // A row scrolled away (or reused for another) stops its sound.
      .onDisappear { model.player.pause() }
  }
}

private struct WorkPlayerLayerView: UIViewRepresentable {
  let player: AVPlayer

  final class LayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
  }

  func makeUIView(context: Context) -> LayerView {
    let view = LayerView()
    view.playerLayer.videoGravity = .resizeAspect
    view.playerLayer.player = player
    return view
  }

  func updateUIView(_ view: LayerView, context: Context) {
    if view.playerLayer.player !== player { view.playerLayer.player = player }
  }
}

/// One step caption of a demo video (`metadata.demo.steps`): where it starts
/// in the video, and what the agent called the step.
struct WorkDemoChapter: Equatable {
  let seconds: Double
  let text: String
}

/// The chapters a filed demo lists, or none. The desktop's `readDemoChapters`
/// reads the same field the same way.
func workDemoChapters(_ metadataJson: String?) -> [WorkDemoChapter] {
  guard
    let data = metadataJson?.data(using: .utf8),
    let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
    let demo = root["demo"] as? [String: Any],
    let steps = demo["steps"] as? [[String: Any]]
  else { return [] }
  return steps.compactMap { step in
    guard
      let seconds = (step["t"] as? NSNumber)?.doubleValue, seconds.isFinite, seconds >= 0,
      let text = (step["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty
    else { return nil }
    return WorkDemoChapter(seconds: seconds, text: text)
  }
}

/// A demo's step captions as a row of chapters under its player. A tap seeks
/// the video to the step and plays it.
struct WorkDemoChaptersRow: View {
  let chapters: [WorkDemoChapter]
  let onSelect: (Double) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        ForEach(Array(chapters.enumerated()), id: \.offset) { _, chapter in
          Button {
            onSelect(chapter.seconds)
          } label: {
            HStack(spacing: 5) {
              Text(Self.clock(chapter.seconds))
                .monospacedDigit()
                .foregroundStyle(ADEColor.textSecondary)
              Text(chapter.text)
                .lineLimit(1)
            }
            .font(.caption)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(ADEColor.recessedBackground.opacity(0.6), in: Capsule())
          }
          .buttonStyle(.plain)
          .accessibilityLabel("Play from \(chapter.text)")
        }
      }
    }
  }

  private static func clock(_ seconds: Double) -> String {
    let whole = max(0, Int(seconds.rounded(.down)))
    return String(format: "%d:%02d", whole / 60, whole % 60)
  }
}

/// A stored video that is not on the phone yet: a play button and its size.
/// Tapping starts the download; the caller swaps in the player when it lands.
struct WorkArtifactPlayPlaceholder: View {
  let sizeBytes: Int
  let tint: Color
  let onPlay: () -> Void
  @State private var started = false

  var body: some View {
    Button {
      guard !started else { return }
      started = true
      onPlay()
    } label: {
      VStack(spacing: 8) {
        if started {
          ProgressView()
            .tint(tint)
        } else {
          Image(systemName: "play.circle.fill")
            .font(.system(size: 34, weight: .semibold))
        }
        Text(started ? "Downloading \(workArtifactSizeLabel(sizeBytes))…" : "Play · \(workArtifactSizeLabel(sizeBytes))")
          .font(.subheadline)
      }
      .foregroundStyle(tint)
      .frame(minWidth: 44, minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(started)
    .accessibilityLabel(started ? "Downloading video" : "Play video, \(workArtifactSizeLabel(sizeBytes))")
  }
}

/// Terminal session view. Subscribes to the host PTY for `session.id`, streams
/// output through the terminal emulator, and forwards typed bytes back to the
/// host as `terminal_input`.
struct WorkTerminalSessionView: View {
  @EnvironmentObject var syncService: SyncService
  let session: TerminalSessionSummary
  let transitionNamespace: Namespace.ID?
  let onOpenLane: (() -> Void)?

  /// Phone-friendly terminal input: keep the text visible while the user types,
  /// then send the whole buffer on Return. The shortcut bar still sends raw
  /// bytes immediately for shell/TUI controls like Esc, Tab, arrows, and ^C.
  @State private var sendingFeedback = 0
  @State private var lastSentTerminalSize: WorkTerminalViewport?
  @State private var currentTerminalViewport: WorkTerminalViewport?
  @StateObject private var subscriptionLifecycle = WorkTerminalSubscriptionLifecycle()

  private var rawBuffer: String {
    syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? ""
  }

  private var canSendInput: Bool {
    syncService.canAcceptTerminalInput(sessionId: session.id)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      laneStrip

      GeometryReader { proxy in
        WorkTerminalEmulatorView(
          rawText: rawBuffer,
          revision: syncService.terminalBufferRevision,
          onViewportChange: handleTerminalViewportChange
        )
        .frame(width: proxy.size.width, height: proxy.size.height)
        .background(Color.black)
      }

      terminalKeyBar
      terminalInputBar
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .sensoryFeedback(.impact(weight: .light), trigger: sendingFeedback)
    .task(id: session.id) {
      subscriptionLifecycle.markVisible()
      try? await syncService.subscribeTerminal(sessionId: session.id)
      if let currentTerminalViewport {
        lastSentTerminalSize = nil
        sendTerminalResize(currentTerminalViewport)
      }
    }
    .task(id: terminalSnapshotBackstopKey) {
      await runTerminalSnapshotBackstop()
    }
    .onDisappear {
      subscriptionLifecycle.scheduleUnsubscribe(sessionId: session.id, syncService: syncService)
    }
    .onChange(of: syncService.connectionState) { _, _ in
      lastSentTerminalSize = nil
      if let currentTerminalViewport {
        sendTerminalResize(currentTerminalViewport)
      }
    }
  }

  /// Slim, transparent context strip — no material backplate, no padding bloat.
  /// Keeps the lane + relative time visible without stealing rows from the
  /// terminal scrollback.
  private var laneStrip: some View {
    HStack(spacing: 8) {
      WorkSessionHeader(
        session: session,
        chatSummary: nil,
        transitionNamespace: transitionNamespace,
        onOpenLane: onOpenLane
      )
    }
    .padding(.horizontal, 12)
    .padding(.top, 4)
    .padding(.bottom, 6)
  }

  /// Termius-style modifier/key strip. Horizontal scroll so we can grow it
  /// without crowding the input row. Tapping any chip sends the matching
  /// raw bytes through the existing terminal input channel.
  private var terminalKeyBar: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        keyChip("Esc", send: "\u{1B}")
        keyChip("Tab", send: "\t")
        keyChip("↑", send: "\u{1B}[A")
        keyChip("↓", send: "\u{1B}[B")
        keyChip("←", send: "\u{1B}[D")
        keyChip("→", send: "\u{1B}[C")
        keyChip("^C", send: "\u{03}", tint: ADEColor.danger)
        keyChip("^D", send: "\u{04}")
        keyChip("^Z", send: "\u{1A}")
        keyChip("^L", send: "\u{0C}")
        keyChip("^R", send: "\u{12}")
        keyChip("^U", send: "\u{15}")
        keyChip("^A", send: "\u{01}")
        keyChip("^E", send: "\u{05}")
        keyChip("^K", send: "\u{0B}")
        keyChip("|", send: "|")
        keyChip("~", send: "~")
        keyChip("/", send: "/")
        keyChip("-", send: "-")
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
    }
    .background(ADEColor.recessedBackground.opacity(0.85))
    .overlay(alignment: .top) {
      Rectangle().fill(ADEColor.glassBorder).frame(height: 0.5)
    }
    .disabled(!canSendInput)
    .opacity(canSendInput ? 1 : 0.4)
  }

  @ViewBuilder
  private func keyChip(_ label: String, send data: String, tint: Color? = nil) -> some View {
    Button {
      syncService.sendTerminalInput(sessionId: session.id, data: data)
      sendingFeedback &+= 1
    } label: {
      Text(label)
        .font(.system(size: 12, weight: .semibold, design: .monospaced))
        .foregroundStyle(tint ?? ADEColor.textPrimary)
        .frame(minWidth: 32, minHeight: 28)
        .padding(.horizontal, 8)
        .background(
          (tint ?? ADEColor.textPrimary).opacity(tint == nil ? 0.06 : 0.12),
          in: RoundedRectangle(cornerRadius: 6, style: .continuous)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 6, style: .continuous)
            .stroke((tint ?? ADEColor.border).opacity(0.28), lineWidth: 0.6)
        )
    }
    .buttonStyle(.plain)
  }

  /// Slim composer. The `↵` button and keyboard Return send any visible buffer,
  /// then `\r`, so the remote shell/TUI submits exactly what the phone shows.
  private var terminalInputBar: some View {
    TerminalInputComposer(
        placeholder: "Type to send keystrokes",
        isEnabled: canSendInput,
        accentColor: UIColor(ADEColor.accent),
        disabledColor: UIColor(ADEColor.textMuted),
        surfaceColor: UIColor(ADEColor.surfaceBackground),
        borderColor: UIColor(ADEColor.glassBorder),
        onSubmit: submitReturn(input:)
      )
      .frame(height: 32)
      .frame(maxWidth: .infinity)
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(.ultraThinMaterial)
    .overlay(alignment: .top) {
      Rectangle().fill(ADEColor.glassBorder).frame(height: 0.5)
    }
  }

  private func submitReturn(input: String) {
    guard canSendInput else { return }
    let sessionId = session.id
    // Send buffered text + Return as a single write so the carriage return
    // can't arrive after later keystrokes (or be dropped entirely if the
    // connection state flips during a delay).
    syncService.sendTerminalInput(sessionId: sessionId, data: input + "\r")
    sendingFeedback &+= 1
  }

  private var terminalSnapshotBackstopKey: String {
    "\(session.id)-\(session.status)-\(session.runtimeState)-\(canSendInput)-\(syncService.prefersReducedSyncLoad)"
  }

  private var shouldBackstopTerminalSnapshots: Bool {
    guard canSendInput else { return false }
    let status = session.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return status != "ended" && status != "exited" && status != "stopped"
  }

  @MainActor
  private func runTerminalSnapshotBackstop() async {
    guard shouldBackstopTerminalSnapshots else { return }
    let initialDelay: UInt64 = 650_000_000
    let pollDelay: UInt64 = syncService.prefersReducedSyncLoad ? 2_500_000_000 : 1_250_000_000
    let staleInterval: TimeInterval = syncService.prefersReducedSyncLoad ? 4.5 : 2.0
    let snapshotBytes = syncService.prefersReducedSyncLoad ? 80_000 : 140_000

    try? await Task.sleep(nanoseconds: initialDelay)
    guard !Task.isCancelled, shouldBackstopTerminalSnapshots else { return }
    if terminalVisibleBufferIsEmpty() {
      try? await syncService.refreshTerminalSnapshot(sessionId: session.id, maxBytes: snapshotBytes)
    }

    while !Task.isCancelled, shouldBackstopTerminalSnapshots {
      try? await Task.sleep(nanoseconds: pollDelay)
      guard !Task.isCancelled, shouldBackstopTerminalSnapshots else { return }
      let lastUpdate = syncService.terminalBufferUpdatedAt[session.id] ?? Date.distantPast
      if terminalVisibleBufferIsEmpty() || Date().timeIntervalSince(lastUpdate) >= staleInterval {
        try? await syncService.refreshTerminalSnapshot(sessionId: session.id, maxBytes: snapshotBytes)
      }
    }
  }

  private func terminalVisibleBufferIsEmpty() -> Bool {
    let buffered = syncService.terminalBuffers[session.id] ?? ""
    let fallback = session.lastOutputPreview ?? ""
    return buffered.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && fallback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private func handleTerminalViewportChange(_ viewport: WorkTerminalViewport) {
    currentTerminalViewport = viewport
    sendTerminalResize(viewport)
  }

  private func sendTerminalResize(_ viewport: WorkTerminalViewport) {
    guard canSendInput else { return }
    guard viewport != lastSentTerminalSize else { return }
    lastSentTerminalSize = viewport
    syncService.sendTerminalResize(sessionId: session.id, cols: viewport.cols, rows: viewport.rows)
  }
}

private struct TerminalInputComposer: UIViewRepresentable {
  let placeholder: String
  let isEnabled: Bool
  let accentColor: UIColor
  let disabledColor: UIColor
  let surfaceColor: UIColor
  let borderColor: UIColor
  let onSubmit: (String) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(parent: self)
  }

  func makeUIView(context: Context) -> TerminalInputComposerView {
    let view = TerminalInputComposerView()
    view.textField.delegate = context.coordinator
    return view
  }

  func updateUIView(_ view: TerminalInputComposerView, context: Context) {
    context.coordinator.parent = self
    view.onSubmit = { [weak view] in
      let text = view?.textField.text ?? ""
      view?.textField.text = ""
      onSubmit(text)
      view?.textField.becomeFirstResponder()
    }
    view.configure(
      placeholder: placeholder,
      isEnabled: isEnabled,
      accentColor: accentColor,
      disabledColor: disabledColor,
      surfaceColor: surfaceColor,
      borderColor: borderColor
    )
  }

  final class Coordinator: NSObject, UITextFieldDelegate {
    var parent: TerminalInputComposer

    init(parent: TerminalInputComposer) {
      self.parent = parent
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
      let text = textField.text ?? ""
      textField.text = ""
      parent.onSubmit(text)
      return false
    }
  }
}

private final class TerminalInputComposerView: UIView {
  let textField = UITextField()
  private let returnButton = UIButton(type: .system)
  var onSubmit: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)

    textField.borderStyle = .none
    textField.backgroundColor = .clear
    textField.font = UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    textField.textColor = UIColor.label
    textField.returnKeyType = .default
    textField.keyboardType = .asciiCapable
    textField.autocorrectionType = .no
    textField.autocapitalizationType = .none
    textField.spellCheckingType = .no
    textField.smartQuotesType = .no
    textField.smartDashesType = .no
    textField.smartInsertDeleteType = .no
    textField.textContentType = .none
    textField.accessibilityLabel = "Terminal input"

    returnButton.setImage(UIImage(systemName: "return"), for: .normal)
    returnButton.accessibilityLabel = "Send Return"
    returnButton.layer.cornerRadius = 9
    returnButton.addTarget(self, action: #selector(submit), for: .touchUpInside)

    let fieldContainer = UIView()
    fieldContainer.layer.cornerRadius = 9
    fieldContainer.layer.borderWidth = 0.5
    fieldContainer.translatesAutoresizingMaskIntoConstraints = false
    textField.translatesAutoresizingMaskIntoConstraints = false
    fieldContainer.addSubview(textField)

    returnButton.translatesAutoresizingMaskIntoConstraints = false
    addSubview(fieldContainer)
    addSubview(returnButton)

    NSLayoutConstraint.activate([
      fieldContainer.leadingAnchor.constraint(equalTo: leadingAnchor),
      fieldContainer.topAnchor.constraint(equalTo: topAnchor),
      fieldContainer.bottomAnchor.constraint(equalTo: bottomAnchor),
      returnButton.leadingAnchor.constraint(equalTo: fieldContainer.trailingAnchor, constant: 8),
      returnButton.trailingAnchor.constraint(equalTo: trailingAnchor),
      returnButton.topAnchor.constraint(equalTo: topAnchor),
      returnButton.bottomAnchor.constraint(equalTo: bottomAnchor),
      returnButton.widthAnchor.constraint(equalToConstant: 36),

      textField.leadingAnchor.constraint(equalTo: fieldContainer.leadingAnchor, constant: 10),
      textField.trailingAnchor.constraint(equalTo: fieldContainer.trailingAnchor, constant: -10),
      textField.topAnchor.constraint(equalTo: fieldContainer.topAnchor),
      textField.bottomAnchor.constraint(equalTo: fieldContainer.bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) {
    return nil
  }

  override var intrinsicContentSize: CGSize {
    CGSize(width: UIView.noIntrinsicMetric, height: 32)
  }

  func configure(
    placeholder: String,
    isEnabled: Bool,
    accentColor: UIColor,
    disabledColor: UIColor,
    surfaceColor: UIColor,
    borderColor: UIColor
  ) {
    textField.placeholder = placeholder
    textField.tintColor = accentColor
    textField.isEnabled = isEnabled
    textField.alpha = isEnabled ? 1 : 0.55

    if let fieldContainer = textField.superview {
      fieldContainer.backgroundColor = surfaceColor.withAlphaComponent(isEnabled ? 0.55 : 0.38)
      fieldContainer.layer.borderColor = borderColor.cgColor
    }

    returnButton.isEnabled = isEnabled
    returnButton.tintColor = isEnabled ? accentColor : disabledColor
    returnButton.backgroundColor = (isEnabled ? accentColor : surfaceColor).withAlphaComponent(isEnabled ? 0.14 : 0.50)
    returnButton.layer.borderWidth = 0.5
    returnButton.layer.borderColor = borderColor.cgColor
  }

  @objc private func submit() {
    onSubmit?()
  }
}

@MainActor
private final class WorkTerminalSubscriptionLifecycle: ObservableObject {
  private var generation = 0
  private var unsubscribeTask: Task<Void, Never>?

  func markVisible() {
    generation += 1
    unsubscribeTask?.cancel()
    unsubscribeTask = nil
  }

  func scheduleUnsubscribe(sessionId: String, syncService: SyncService) {
    let generationAtDisappear = generation
    unsubscribeTask?.cancel()
    unsubscribeTask = Task {
      await Task.yield()
      guard !Task.isCancelled else { return }
      let shouldUnsubscribe = await MainActor.run { generation == generationAtDisappear }
      guard shouldUnsubscribe else { return }
      try? await syncService.unsubscribeTerminal(sessionId: sessionId)
    }
  }
}

/// Single-image fullscreen viewer used by the inline transcript artifact card.
/// Shares the Proof viewer's zoom surface so pinch, pan, and double-tap behave
/// identically wherever proof is opened.
struct WorkFullscreenImageView: View {
  @Environment(\.dismiss) var dismiss
  let image: WorkFullscreenImage

  var body: some View {
    NavigationStack {
      // Fitted inside the safe area: the bar's controls (and, held landscape
      // on the Duo, the edge bar) never sit over the picture.
      WorkProofZoomableImage(image: image.image)
        .accessibilityLabel(image.title)
        .workMediaViewerChrome(
          caption: image.title,
          detail: nil,
          onDone: { dismiss() }
        ) {
          ShareLink(
            item: Image(uiImage: image.image),
            preview: SharePreview(image.title, image: Image(uiImage: image.image))
          )
        }
    }
  }
}

extension View {
  /// The full-screen media viewer's chrome, shared by the transcript image
  /// viewer and the Proof viewer: black on every edge, Done at the top-left
  /// (kept in the top row, never moved into an edge bar), Share as a plain
  /// bar item (the Duo's edge bar held landscape), and the caption readable at
  /// the bottom on its own glass, clear of the picture's controls.
  func workMediaViewerChrome<Share: View>(
    caption: String,
    detail: String?,
    onDone: @escaping () -> Void,
    @ViewBuilder share: () -> Share
  ) -> some View {
    modifier(WorkMediaViewerChrome(caption: caption, detail: detail, onDone: onDone, share: share()))
  }
}

private struct WorkMediaViewerChrome<Share: View>: ViewModifier {
  let caption: String
  let detail: String?
  let onDone: () -> Void
  let share: Share

  func body(content: Content) -> some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .safeAreaInset(edge: .bottom, spacing: 0) { captionBar }
      .background(Color.black.ignoresSafeArea())
      .toolbarBackground(.hidden, for: .navigationBar)
      .navigationTitle(caption)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(removing: .title)
      .toolbarColorScheme(.dark, for: .navigationBar)
      .preferredColorScheme(.dark)
      .modifier(WorkMediaViewerBar(onDone: onDone, share: share))
  }

  private var captionBar: some View {
    VStack(spacing: 1) {
      Text(caption)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Color.white)
        .lineLimit(2)
        .multilineTextAlignment(.center)
      if let detail {
        Text(detail)
          .font(.caption)
          .foregroundStyle(Color.white.opacity(0.7))
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 8)
    .glassEffect(.regular, in: Capsule(style: .continuous))
    .padding(.horizontal, 24)
    .padding(.top, 8)
    .padding(.bottom, 10)
    .accessibilityElement(children: .combine)
  }
}

private struct WorkMediaViewerBar<Share: View>: ViewModifier {
  let onDone: () -> Void
  let share: Share

  func body(content: Content) -> some View {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      content.toolbar {
        ToolbarItem(placement: .topBarLeading) { doneButton }
          .axisBehavior(.horizontalOnly)
        ToolbarItem(placement: .topBarTrailing) { share }
      }
    } else {
      content.toolbar {
        ToolbarItem(placement: .topBarLeading) { doneButton }
        ToolbarItem(placement: .topBarTrailing) { share }
      }
    }
    #else
    content.toolbar {
      ToolbarItem(placement: .topBarLeading) { doneButton }
      ToolbarItem(placement: .topBarTrailing) { share }
    }
    #endif
  }

  private var doneButton: some View {
    Button("Done", action: onDone)
      .fontWeight(.semibold)
  }
}

struct WorkArtifactShareItem: Identifiable {
  let id = UUID()
  let items: [Any]
}

struct WorkActivityViewController: UIViewControllerRepresentable {
  let items: [Any]

  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }

  func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}

func workArtifactIsImage(_ artifact: ComputerUseArtifactSummary) -> Bool {
  artifact.artifactKind == "screenshot" || artifact.mimeType?.lowercased().hasPrefix("image/") == true
}

func workArtifactIsVideo(_ artifact: ComputerUseArtifactSummary) -> Bool {
  artifact.artifactKind == "video_recording" || artifact.mimeType?.lowercased().hasPrefix("video/") == true
}

func workArtifactKindLabel(_ kind: String) -> String {
  kind
    .replacingOccurrences(of: "_", with: " ")
    .split(separator: " ")
    .map { $0.capitalized }
    .joined(separator: " ")
}
