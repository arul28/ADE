import SwiftUI
import UIKit
import AVKit

final class WorkArtifactVideoPlayerModel: ObservableObject {
  let player: AVPlayer

  init(url: URL) {
    player = AVPlayer(url: url)
  }

  func update(url: URL) {
    if let currentURL = (player.currentItem?.asset as? AVURLAsset)?.url, currentURL == url {
      return
    }
    player.replaceCurrentItem(with: AVPlayerItem(url: url))
  }
}

/// The one AVKit player in the Work views. It carries no chrome of its own so
/// that a caller wanting an inline card (fixed height, rounded) and a caller
/// wanting a full-bleed proof page can both use it; the transcript adds its own
/// via `.workArtifactInlineVideoChrome()`.
struct WorkArtifactVideoPlayerView: View {
  let url: URL
  @StateObject var model: WorkArtifactVideoPlayerModel

  init(url: URL) {
    self.url = url
    _model = StateObject(wrappedValue: WorkArtifactVideoPlayerModel(url: url))
  }

  var body: some View {
    VideoPlayer(player: model.player)
      .onChange(of: url) { _, newValue in
        model.update(url: newValue)
      }
  }
}

extension View {
  /// Inline-card chrome for a video in the chat transcript: the same fixed
  /// height and corner radius the image branch beside it uses.
  func workArtifactInlineVideoChrome() -> some View {
    frame(height: 220)
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

struct WorkArtifactView: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let isExpanded: Bool
  let onToggle: () -> Void
  let onAppear: () -> Void
  let onOpenImage: (UIImage) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Button {
        onToggle()
      } label: {
        HStack(spacing: 8) {
          Image(systemName: workArtifactKindIcon(artifact))
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(width: 16)
          VStack(alignment: .leading, spacing: 3) {
            Text(artifact.title)
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
              .truncationMode(.tail)
            Text([workArtifactKindLabel(artifact.artifactKind), relativeTimestamp(artifact.createdAt)].joined(separator: " · "))
              .font(.caption2)
              .foregroundStyle(ADEColor.textMuted)
          }
          Spacer(minLength: 0)
          compactPreview
          Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("\(artifact.title), proof added")
      .accessibilityHint(isExpanded ? "Collapses proof preview" : "Expands proof preview")

      if isExpanded {
        Group {
          switch content {
          case .image(let image):
            Button {
              onOpenImage(image)
            } label: {
              Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity)
                .frame(height: 180)
                .background(Color.black.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open artifact image \(artifact.title)")
          case .video(let url):
            WorkArtifactVideoPlayerView(url: url)
              .workArtifactInlineVideoChrome()
          case .remoteURL(let url):
            if artifact.artifactKind == "video_recording" {
              WorkArtifactVideoPlayerView(url: url)
                .workArtifactInlineVideoChrome()
            } else {
              AsyncImage(url: url) { image in
                image
                  .resizable()
                  .scaledToFit()
              } placeholder: {
                ProgressView()
              }
              .frame(height: 180)
              .frame(maxWidth: .infinity)
              .background(Color.black.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
              .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
          case .text(let text):
            WorkStructuredOutputBlock(title: "Artifact", text: text)
          case .error(let message):
            WorkArtifactInlineStatus(icon: "photo", message: message, tint: ADEColor.textMuted)
          case .none:
            HStack(spacing: 10) {
              ProgressView()
              Text("Loading artifact preview…")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
      }
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(ADEColor.surfaceBackground.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .task {
      onAppear()
    }
  }

  @ViewBuilder
  private var compactPreview: some View {
    switch content {
    case .image(let image):
      Image(uiImage: image)
        .resizable()
        .scaledToFill()
        .frame(width: 40, height: 30)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    case .remoteURL(let url) where workArtifactIsImage(artifact):
      AsyncImage(url: url) { image in
        image.resizable().scaledToFill()
      } placeholder: {
        Color.clear
      }
      .frame(width: 40, height: 30)
      .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    case .video, .remoteURL:
      Image(systemName: "play.rectangle.fill")
        .foregroundStyle(ADEColor.accent)
        .frame(width: 40, height: 30)
    case .text:
      Image(systemName: "doc.text.fill")
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 40, height: 30)
    case .error:
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(ADEColor.warning)
        .frame(width: 40, height: 30)
    case .none:
      ProgressView()
        .controlSize(.mini)
        .frame(width: 40, height: 30)
    }
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
      WorkProofZoomableImage(image: image.image)
        .ignoresSafeArea(edges: .bottom)
        .accessibilityLabel(image.title)
        .background(Color.black.ignoresSafeArea())
        .navigationTitle(image.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Done") { dismiss() }
          }
        }
    }
  }
}

private struct WorkArtifactInlineStatus: View {
  let icon: String
  let message: String
  let tint: Color

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: icon)
        .foregroundStyle(tint)
      Text(message)
        .font(.caption)
        .foregroundStyle(tint)
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(ADEColor.recessedBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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

func workArtifactKindIcon(_ artifact: ComputerUseArtifactSummary) -> String {
  switch artifact.artifactKind {
  case "screenshot":
    return "photo.fill"
  case "video_recording":
    return "video.fill"
  case "browser_trace":
    return "waveform.path.ecg.rectangle"
  case "browser_verification":
    return "checkmark.rectangle.stack.fill"
  case "console_logs":
    return "terminal.fill"
  default:
    return artifact.mimeType?.lowercased().hasPrefix("video/") == true ? "video.fill" : "doc.fill"
  }
}

func workArtifactKindLabel(_ kind: String) -> String {
  kind
    .replacingOccurrences(of: "_", with: " ")
    .split(separator: " ")
    .map { $0.capitalized }
    .joined(separator: " ")
}
