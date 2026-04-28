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

struct WorkArtifactVideoPlayerView: View {
  let url: URL
  @StateObject var model: WorkArtifactVideoPlayerModel

  init(url: URL) {
    self.url = url
    _model = StateObject(wrappedValue: WorkArtifactVideoPlayerModel(url: url))
  }

  var body: some View {
    VideoPlayer(player: model.player)
      .frame(height: 220)
      .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      .onChange(of: url) { _, newValue in
        model.update(url: newValue)
      }
  }
}

struct WorkArtifactView: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let onAppear: () -> Void
  let onOpenImage: (UIImage) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 10) {
        Image(systemName: artifact.artifactKind == "video_recording" ? "video.fill" : "photo.fill")
          .foregroundStyle(ADEColor.accent)
        VStack(alignment: .leading, spacing: 3) {
          Text(artifact.title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(artifact.artifactKind.replacingOccurrences(of: "_", with: " ").capitalized)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer()
        Text(relativeTimestamp(artifact.createdAt))
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

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
        case .remoteURL(let url):
          if artifact.artifactKind == "video_recording" {
            WorkArtifactVideoPlayerView(url: url)
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
          Text(message)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
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
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.7), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .task {
      onAppear()
    }
  }
}

/// Terminal session view. Subscribes to the host PTY for `session.id`,
/// streams output into a monospaced buffer, and offers a one-shot input bar
/// that forwards typed lines back to the host as `terminal_input`.
///
/// Future work (tracked in PTY foundation): swap this replay-backed SwiftUI
/// view for a real terminal emulator (SwiftTerm) so we can render alt-screen
/// apps (vim, htop, fzf). Today we replay the common cursor/erase sequences
/// and preserve SGR colours/bold so agent CLIs stay readable on iPhone.
struct WorkTerminalSessionView: View {
  @EnvironmentObject var syncService: SyncService
  let session: TerminalSessionSummary
  let transitionNamespace: Namespace.ID?
  let onOpenLane: (() -> Void)?

  /// Termius-style char-by-char input: as the user types, each new character
  /// is forwarded to the live PTY and the field is immediately cleared so the
  /// PTY's own echo (rendered in the scrollback) is the only source of truth.
  /// We never buffer a command on-device — `↵` and the keyboard return both
  /// just send `\r` to the shell.
  @State private var inputBuffer = ""
  @FocusState private var inputFocused: Bool
  @State private var sendingFeedback = 0
  @State private var lastSentTerminalSize: TerminalViewportSize?

  private var rawBuffer: String {
    syncService.terminalBuffers[session.id] ?? session.lastOutputPreview ?? ""
  }

  var terminalDisplay: WorkTerminalDisplay {
    workTerminalDisplay(raw: rawBuffer, fallback: nil)
  }

  private var renderedText: AttributedString {
    terminalDisplay.attributedText.characters.isEmpty
      ? workTerminalPlainAttributedString("  ")
      : terminalDisplay.attributedText
  }

  private var canSendInput: Bool {
    syncService.connectionState == .connected || syncService.connectionState == .syncing
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      laneStrip

      GeometryReader { proxy in
        ScrollView([.horizontal, .vertical]) {
          Text(renderedText)
            .textSelection(.enabled)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .fixedSize(horizontal: true, vertical: false)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(Color.black)
        .scrollIndicators(.visible)
        .overlay(alignment: .topTrailing) {
          if terminalDisplay.truncated {
            Image(systemName: "text.line.last.and.arrowtriangle.forward")
              .font(.system(size: 10, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
              .padding(6)
              .accessibilityLabel("Older output truncated for performance")
          }
        }
        .onAppear { sendTerminalResize(for: proxy.size) }
        .onChange(of: proxy.size) { _, newSize in sendTerminalResize(for: newSize) }
        .onChange(of: syncService.connectionState) { _, _ in sendTerminalResize(for: proxy.size) }
      }

      terminalKeyBar
      terminalInputBar
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .sensoryFeedback(.impact(weight: .light), trigger: sendingFeedback)
    .task {
      try? await syncService.subscribeTerminal(sessionId: session.id)
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

  /// Slim composer. Each typed character streams straight to the PTY and we
  /// then clear the field so it acts as a keyboard mount, not a buffer. The
  /// `↵` button (and keyboard Return) explicitly send `\r` so the remote
  /// shell submits — works for plain shells AND for TUI prompts that read
  /// input character-by-character.
  private var terminalInputBar: some View {
    HStack(spacing: 8) {
      TextField("Type to send keystrokes", text: $inputBuffer)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.return)
        .focused($inputFocused)
        .font(.system(size: 13, design: .monospaced))
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(minHeight: 32)
        .frame(maxWidth: .infinity)
        .background(ADEColor.surfaceBackground.opacity(0.55), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.5)
        )
        .onChange(of: inputBuffer) { _, newValue in
          guard !newValue.isEmpty, canSendInput else {
            if !newValue.isEmpty { inputBuffer = "" }
            return
          }
          syncService.sendTerminalInput(sessionId: session.id, data: newValue)
          inputBuffer = ""
        }
        .onSubmit { submitReturn() }
        .disabled(!canSendInput)

      Button(action: submitReturn) {
        Image(systemName: "return")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(canSendInput ? ADEColor.accent : ADEColor.textMuted)
          .frame(width: 36, height: 32)
      }
      .buttonStyle(.plain)
      .background(
        (canSendInput ? ADEColor.accent.opacity(0.14) : ADEColor.surfaceBackground.opacity(0.5)),
        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 9, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )
      .accessibilityLabel("Send Return")
      .disabled(!canSendInput)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(.ultraThinMaterial)
    .overlay(alignment: .top) {
      Rectangle().fill(ADEColor.glassBorder).frame(height: 0.5)
    }
  }

  private func submitReturn() {
    guard canSendInput else { return }
    if !inputBuffer.isEmpty {
      syncService.sendTerminalInput(sessionId: session.id, data: inputBuffer)
      inputBuffer = ""
    }
    syncService.sendTerminalInput(sessionId: session.id, data: "\r")
    sendingFeedback &+= 1
    inputFocused = true
  }

  private func sendTerminalResize(for size: CGSize) {
    guard canSendInput else { return }
    let viewport = TerminalViewportSize(size: size)
    guard viewport != lastSentTerminalSize else { return }
    lastSentTerminalSize = viewport
    syncService.sendTerminalResize(sessionId: session.id, cols: viewport.cols, rows: viewport.rows)
  }
}

private struct TerminalViewportSize: Equatable {
  let cols: Int
  let rows: Int

  init(size: CGSize) {
    // Matches the 12pt monospaced transcript text closely enough for PTY
    // reflow until this screen hosts a full terminal emulator.
    let contentWidth = max(0, size.width - 28)
    let contentHeight = max(0, size.height - 24)
    cols = max(20, min(240, Int(floor(contentWidth / 7.2))))
    rows = max(4, min(80, Int(floor(contentHeight / 15.0))))
  }
}

struct WorkFullscreenImageView: View {
  @Environment(\.dismiss) var dismiss
  let image: WorkFullscreenImage

  @State var scale: CGFloat = 1
  @State var lastScale: CGFloat = 1

  var body: some View {
    NavigationStack {
      ScrollView([.horizontal, .vertical]) {
        Image(uiImage: image.image)
          .resizable()
          .scaledToFit()
          .scaleEffect(scale)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .padding(24)
          .gesture(
            MagnifyGesture()
              .onChanged { value in
                scale = max(1, min(6, lastScale * value.magnification))
              }
              .onEnded { _ in
                lastScale = scale
              }
          )
      }
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

struct WorkArtifactEntryPoint: View {
  let count: Int
  let latestArtifact: ComputerUseArtifactSummary?
  let isRefreshing: Bool
  let refreshError: String?
  let onOpen: () -> Void
  let onRefresh: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Button(action: onOpen) {
        HStack(spacing: 10) {
          ZStack(alignment: .topTrailing) {
            Image(systemName: "photo.stack")
              .font(.system(size: 16, weight: .semibold))
              .foregroundStyle(ADEColor.accent)
              .frame(width: 34, height: 34)
              .background(ADEColor.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

            Text("\(count)")
              .font(.caption2.weight(.bold).monospacedDigit())
              .foregroundStyle(Color.white)
              .frame(minWidth: 17, minHeight: 17)
              .background(ADEColor.accent, in: Capsule())
              .offset(x: 5, y: -5)
          }

          VStack(alignment: .leading, spacing: 2) {
            Text("Proof artifacts")
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
            Text(entrySubtitle)
              .font(.caption)
              .foregroundStyle(refreshError == nil ? ADEColor.textSecondary : ADEColor.danger)
              .lineLimit(1)
          }

          Spacer(minLength: 0)

          Image(systemName: "chevron.up")
            .font(.caption.weight(.bold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Proof artifacts, \(count) item\(count == 1 ? "" : "s"). Tap to open.")

      Button(action: onRefresh) {
        if isRefreshing {
          ProgressView()
            .controlSize(.mini)
        } else {
          Image(systemName: "arrow.clockwise")
            .font(.system(size: 13, weight: .semibold))
        }
      }
      .buttonStyle(.plain)
      .frame(width: 34, height: 34)
      .background(ADEColor.surfaceBackground.opacity(0.62), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(ADEColor.border.opacity(0.32), lineWidth: 0.8)
      )
      .disabled(isRefreshing)
      .accessibilityLabel(isRefreshing ? "Refreshing proof artifacts" : "Refresh proof artifacts")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(ADEColor.surfaceBackground.opacity(0.58), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 16, style: .continuous)
        .stroke(ADEColor.border.opacity(0.28), lineWidth: 0.8)
    )
  }

  private var entrySubtitle: String {
    if let refreshError {
      return refreshError
    }
    guard let latestArtifact else {
      return isRefreshing ? "Checking for captured proof..." : "No captured proof yet"
    }
    return "Latest \(workArtifactKindLabel(latestArtifact.artifactKind)) \(relativeTimestamp(latestArtifact.createdAt))"
  }
}

struct WorkArtifactDrawerSheet: View {
  let artifacts: [ComputerUseArtifactSummary]
  @Binding var artifactContent: [String: WorkLoadedArtifactContent]
  let isRefreshing: Bool
  let refreshError: String?
  let onRefresh: @MainActor () async -> Void
  let onLoadArtifact: @MainActor (ComputerUseArtifactSummary) async -> Void

  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var selectedArtifactId: String?
  @State private var shareItem: WorkArtifactShareItem?
  @State private var fullscreenImage: WorkFullscreenImage?

  private var selectedArtifact: ComputerUseArtifactSummary? {
    if let selectedArtifactId,
       let selected = artifacts.first(where: { $0.id == selectedArtifactId }) {
      return selected
    }
    return artifacts.last
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          WorkArtifactDrawerHeader(count: artifacts.count, isRefreshing: isRefreshing, refreshError: refreshError)

          if artifacts.isEmpty {
            WorkArtifactDrawerEmptyState(isRefreshing: isRefreshing) {
              Task { await onRefresh() }
            }
          } else if let selectedArtifact {
            WorkArtifactSelectedPreview(
              artifact: selectedArtifact,
              content: artifactContent[selectedArtifact.id],
              onOpenImage: { image in
                fullscreenImage = WorkFullscreenImage(title: selectedArtifact.title, image: image)
              },
              onOpenExternal: { url in
                openURL(url)
              }
            )
            .task(id: selectedArtifact.id) {
              await onLoadArtifact(selectedArtifact)
            }

            WorkArtifactActionRow(
              artifact: selectedArtifact,
              content: artifactContent[selectedArtifact.id],
              onOpen: {
                openArtifact(selectedArtifact)
              },
              onShare: {
                shareArtifact(selectedArtifact)
              }
            )

            WorkArtifactThumbnailStrip(
              artifacts: artifacts,
              selectedArtifactId: selectedArtifact.id,
              artifactContent: artifactContent,
              onSelect: { selectedArtifactId = $0.id }
            )

            WorkArtifactList(
              artifacts: artifacts,
              selectedArtifactId: selectedArtifact.id,
              artifactContent: artifactContent,
              onSelect: { selectedArtifactId = $0.id },
              onLoadArtifact: onLoadArtifact
            )
          }
        }
        .padding(16)
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle("Proof")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            Task { await onRefresh() }
          } label: {
            if isRefreshing {
              ProgressView()
                .controlSize(.mini)
            } else {
              Image(systemName: "arrow.clockwise")
            }
          }
          .disabled(isRefreshing)
          .accessibilityLabel(isRefreshing ? "Refreshing proof artifacts" : "Refresh proof artifacts")
        }
      }
      .onAppear(perform: reconcileSelection)
      .onChange(of: artifacts.map(\.id)) { _, _ in
        reconcileSelection()
      }
      .sheet(item: $shareItem) { item in
        WorkActivityViewController(items: item.items)
      }
      .fullScreenCover(item: $fullscreenImage) { image in
        WorkFullscreenImageView(image: image)
      }
    }
  }

  private func reconcileSelection() {
    if let selectedArtifactId,
       artifacts.contains(where: { $0.id == selectedArtifactId }) {
      return
    }
    selectedArtifactId = artifacts.last?.id
  }

  private func openArtifact(_ artifact: ComputerUseArtifactSummary) {
    if let url = workArtifactExternalURL(artifact.uri) {
      openURL(url)
      return
    }

    switch artifactContent[artifact.id] {
    case .image(let image):
      fullscreenImage = WorkFullscreenImage(title: artifact.title, image: image)
    case .video(let url), .remoteURL(let url):
      openURL(url)
    case .text(let text):
      shareItem = WorkArtifactShareItem(items: [text])
    case .error, .none:
      break
    }
  }

  private func shareArtifact(_ artifact: ComputerUseArtifactSummary) {
    guard let items = workArtifactShareItems(artifact: artifact, content: artifactContent[artifact.id]) else { return }
    shareItem = WorkArtifactShareItem(items: items)
  }
}

private struct WorkArtifactDrawerHeader: View {
  let count: Int
  let isRefreshing: Bool
  let refreshError: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Image(systemName: "photo.stack")
          .foregroundStyle(ADEColor.accent)
        Text("\(count) artifact\(count == 1 ? "" : "s")")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        if isRefreshing {
          ProgressView()
            .controlSize(.mini)
        }
      }

      if let refreshError {
        Text(refreshError)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
      } else {
        Text("Captured screenshots, recordings, browser evidence, and logs for this chat.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private struct WorkArtifactDrawerEmptyState: View {
  let isRefreshing: Bool
  let onRefresh: () -> Void

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: "photo.on.rectangle.angled")
        .font(.system(size: 34, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
      Text("No proof captured yet")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      Text("When this chat records screenshots, browser evidence, videos, or logs, they appear here.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
      Button {
        onRefresh()
      } label: {
        Label(isRefreshing ? "Refreshing" : "Refresh", systemImage: "arrow.clockwise")
      }
      .buttonStyle(.glassProminent)
      .tint(ADEColor.accent)
      .controlSize(.small)
      .disabled(isRefreshing)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 34)
  }
}

private struct WorkArtifactSelectedPreview: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let onOpenImage: (UIImage) -> Void
  let onOpenExternal: (URL) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: workArtifactKindIcon(artifact))
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 32, height: 32)
          .background(ADEColor.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

        VStack(alignment: .leading, spacing: 4) {
          Text(artifact.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .fixedSize(horizontal: false, vertical: true)

          Text([workArtifactKindLabel(artifact.artifactKind), artifact.backendName, relativeTimestamp(artifact.createdAt)].joined(separator: " · "))
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }

      previewContent

      if let description = artifact.description?.trimmingCharacters(in: .whitespacesAndNewlines), !description.isEmpty {
        Text(description)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }

      WorkArtifactReviewStateView(artifact: artifact)
    }
    .padding(14)
    .background(ADEColor.surfaceBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 18, style: .continuous)
        .stroke(ADEColor.border.opacity(0.28), lineWidth: 0.8)
    )
  }

  @ViewBuilder
  private var previewContent: some View {
    switch content {
    case .image(let image):
      Button {
        onOpenImage(image)
      } label: {
        Image(uiImage: image)
          .resizable()
          .scaledToFit()
          .frame(maxWidth: .infinity)
          .frame(minHeight: 180, maxHeight: 300)
          .background(Color.black.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open artifact image \(artifact.title)")
    case .video(let url):
      WorkArtifactVideoPlayerView(url: url)
    case .remoteURL(let url):
      if workArtifactIsVideo(artifact) {
        WorkArtifactVideoPlayerView(url: url)
      } else if workArtifactIsImage(artifact) {
        AsyncImage(url: url) { image in
          image
            .resizable()
            .scaledToFit()
        } placeholder: {
          ProgressView()
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 180, maxHeight: 300)
        .background(Color.black.opacity(0.12), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
      } else {
        WorkArtifactOpenFallback(message: "Remote artifact preview is unavailable.", url: url, onOpen: onOpenExternal)
      }
    case .text(let text):
      WorkStructuredOutputBlock(title: "Artifact", text: text)
    case .error(let message):
      WorkArtifactInlineStatus(icon: "exclamationmark.triangle.fill", message: message, tint: ADEColor.danger)
    case .none:
      WorkArtifactInlineStatus(icon: "arrow.down.circle", message: "Loading artifact preview...", tint: ADEColor.textSecondary)
    }
  }
}

private struct WorkArtifactActionRow: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let onOpen: () -> Void
  let onShare: () -> Void

  private var canOpen: Bool {
    if workArtifactExternalURL(artifact.uri) != nil { return true }
    switch content {
    case .image, .video, .remoteURL, .text:
      return true
    case .error, .none:
      return false
    }
  }

  private var canShare: Bool {
    workArtifactShareItems(artifact: artifact, content: content) != nil
  }

  var body: some View {
    HStack(spacing: 10) {
      Button {
        onOpen()
      } label: {
        Label(workArtifactExternalURL(artifact.uri) != nil ? "Open" : "Preview", systemImage: "arrow.up.right.square")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.glass)
      .controlSize(.small)
      .disabled(!canOpen)

      Button {
        onShare()
      } label: {
        Label("Share", systemImage: "square.and.arrow.up")
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.glass)
      .controlSize(.small)
      .disabled(!canShare)
    }
  }
}

private struct WorkArtifactThumbnailStrip: View {
  let artifacts: [ComputerUseArtifactSummary]
  let selectedArtifactId: String
  let artifactContent: [String: WorkLoadedArtifactContent]
  let onSelect: (ComputerUseArtifactSummary) -> Void

  var body: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 10) {
        ForEach(artifacts) { artifact in
          Button {
            onSelect(artifact)
          } label: {
            WorkArtifactThumbnail(
              artifact: artifact,
              content: artifactContent[artifact.id],
              selected: artifact.id == selectedArtifactId
            )
          }
          .buttonStyle(.plain)
          .accessibilityLabel("\(artifact.title), \(workArtifactKindLabel(artifact.artifactKind))")
        }
      }
      .padding(.vertical, 2)
    }
    .scrollIndicators(.hidden)
  }
}

private struct WorkArtifactThumbnail: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let selected: Bool

  var body: some View {
    VStack(spacing: 6) {
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(ADEColor.recessedBackground.opacity(0.72))

        switch content {
        case .image(let image):
          Image(uiImage: image)
            .resizable()
            .scaledToFit()
            .padding(4)
        case .remoteURL(let url) where workArtifactIsImage(artifact):
          AsyncImage(url: url) { image in
            image
              .resizable()
              .scaledToFit()
              .padding(4)
          } placeholder: {
            ProgressView()
              .controlSize(.mini)
          }
        case .video, .remoteURL:
          Image(systemName: "play.rectangle.fill")
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(ADEColor.accent)
        case .text:
          Image(systemName: "doc.text.fill")
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
        case .error:
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(ADEColor.danger)
        case .none:
          Image(systemName: workArtifactKindIcon(artifact))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .frame(width: 74, height: 56)
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .stroke(selected ? ADEColor.accent : ADEColor.border.opacity(0.25), lineWidth: selected ? 1.4 : 0.8)
      )

      Text(workArtifactKindLabel(artifact.artifactKind))
        .font(.caption2.weight(.semibold))
        .foregroundStyle(selected ? ADEColor.accent : ADEColor.textSecondary)
        .lineLimit(1)
        .frame(width: 78)
    }
  }
}

private struct WorkArtifactList: View {
  let artifacts: [ComputerUseArtifactSummary]
  let selectedArtifactId: String
  let artifactContent: [String: WorkLoadedArtifactContent]
  let onSelect: (ComputerUseArtifactSummary) -> Void
  let onLoadArtifact: @MainActor (ComputerUseArtifactSummary) async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("All proof")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)

      LazyVStack(spacing: 8) {
        ForEach(artifacts.reversed()) { artifact in
          Button {
            onSelect(artifact)
          } label: {
            WorkArtifactListRow(
              artifact: artifact,
              content: artifactContent[artifact.id],
              selected: artifact.id == selectedArtifactId
            )
          }
          .buttonStyle(.plain)
          .task(id: artifact.id) {
            await onLoadArtifact(artifact)
          }
        }
      }
    }
  }
}

private struct WorkArtifactListRow: View {
  let artifact: ComputerUseArtifactSummary
  let content: WorkLoadedArtifactContent?
  let selected: Bool

  var body: some View {
    HStack(spacing: 10) {
      WorkArtifactThumbnail(artifact: artifact, content: content, selected: selected)
        .scaleEffect(0.82)
        .frame(width: 64, height: 58)

      VStack(alignment: .leading, spacing: 4) {
        Text(artifact.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Text([workArtifactKindLabel(artifact.artifactKind), relativeTimestamp(artifact.createdAt)].joined(separator: " · "))
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
        if let reviewState = artifact.reviewState?.trimmingCharacters(in: .whitespacesAndNewlines), !reviewState.isEmpty {
          Text(workArtifactReviewLabel(reviewState))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(workArtifactReviewTint(reviewState))
        }
      }

      Spacer(minLength: 0)
    }
    .padding(10)
    .background(selected ? ADEColor.accent.opacity(0.08) : ADEColor.surfaceBackground.opacity(0.62), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(selected ? ADEColor.accent.opacity(0.38) : ADEColor.border.opacity(0.24), lineWidth: 0.8)
    )
  }
}

private struct WorkArtifactReviewStateView: View {
  let artifact: ComputerUseArtifactSummary

  @ViewBuilder
  var body: some View {
    let reviewState = artifact.reviewState?.trimmingCharacters(in: .whitespacesAndNewlines)
    let workflowState = artifact.workflowState?.trimmingCharacters(in: .whitespacesAndNewlines)
    let reviewNote = artifact.reviewNote?.trimmingCharacters(in: .whitespacesAndNewlines)

    if reviewState?.isEmpty == false || workflowState?.isEmpty == false || reviewNote?.isEmpty == false {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          if let reviewState, !reviewState.isEmpty {
            ADEStatusPill(text: workArtifactReviewLabel(reviewState), tint: workArtifactReviewTint(reviewState))
          }
          if let workflowState, !workflowState.isEmpty {
            ADEStatusPill(text: workArtifactWorkflowLabel(workflowState), tint: ADEColor.textSecondary)
          }
        }

        if let reviewNote, !reviewNote.isEmpty {
          Text(reviewNote)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ADEColor.recessedBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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

private struct WorkArtifactOpenFallback: View {
  let message: String
  let url: URL
  let onOpen: (URL) -> Void

  var body: some View {
    VStack(spacing: 10) {
      Text(message)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
      Button {
        onOpen(url)
      } label: {
        Label("Open", systemImage: "arrow.up.right.square")
      }
      .buttonStyle(.glass)
      .controlSize(.small)
    }
    .frame(maxWidth: .infinity, minHeight: 150)
    .padding(12)
    .background(ADEColor.recessedBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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

func workArtifactReviewLabel(_ value: String) -> String {
  switch value {
  case "needs_more":
    return "Needs more"
  default:
    return workArtifactKindLabel(value)
  }
}

func workArtifactWorkflowLabel(_ value: String) -> String {
  switch value {
  case "evidence_only":
    return "Evidence only"
  default:
    return workArtifactKindLabel(value)
  }
}

func workArtifactReviewTint(_ value: String) -> Color {
  switch value {
  case "accepted":
    return ADEColor.success
  case "needs_more":
    return ADEColor.warning
  case "dismissed":
    return ADEColor.danger
  default:
    return ADEColor.textSecondary
  }
}

func workArtifactExternalURL(_ uri: String) -> URL? {
  guard let url = URL(string: uri),
        url.scheme?.lowercased().hasPrefix("http") == true
  else { return nil }
  return url
}

func workArtifactShareItems(artifact: ComputerUseArtifactSummary, content: WorkLoadedArtifactContent?) -> [Any]? {
  if let url = workArtifactExternalURL(artifact.uri) {
    return [url]
  }

  switch content {
  case .image(let image):
    return [image]
  case .video(let url), .remoteURL(let url):
    return [url]
  case .text(let text):
    return [text]
  case .error, .none:
    return nil
  }
}
