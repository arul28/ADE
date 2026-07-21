import SwiftUI
import UIKit

/// Full-bleed native terminal for a CLI session: SwiftTerm emulation, offset
/// streamed PTY output, tap-to-focus keyboard input, on-demand scrollback
/// paging, and phone-driven PTY resize.
struct TerminalSessionScreen: View {
  @EnvironmentObject var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let session: TerminalSessionSummary

  @StateObject private var controller = TerminalSessionController()
  @State private var keyboardVisible = false
  @State private var pasteboardHasStrings = false
  @State private var showReconnectingCaption = false
  @State private var statusDotFlash = false

  private var bottomIgnoredEdges: Edge.Set {
    // The resume bar renders without the keyboard; it needs the bottom safe
    // area so it doesn't sit under the home indicator.
    (keyboardVisible || controller.hasExited) ? [] : [.bottom]
  }

  private let keyboardShowPublisher: NotificationCenter.Publisher =
    NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)
  private let keyboardHidePublisher: NotificationCenter.Publisher =
    NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)
  private let pasteboardPublisher: NotificationCenter.Publisher =
    NotificationCenter.default.publisher(for: UIPasteboard.changedNotification)

  var body: some View {
    lifecycleDecorated
      .adeAnalyticsScreen(.terminal)
      .onReceive(keyboardShowPublisher) { _ in handleKeyboardWillShow() }
      .onReceive(keyboardHidePublisher) { _ in keyboardVisible = false }
      .onReceive(pasteboardPublisher) { _ in refreshPasteboardState() }
  }

  private var lifecycleDecorated: some View {
    chromeDecorated
      .task(id: session.id) { handleAppear() }
      .onDisappear { controller.deactivate() }
      .onChange(of: syncService.connectionState) { (_, state: RemoteConnectionState) in
        handleConnectionState(state)
      }
      .onChange(of: controller.bellPulse) { (_, _: Int) in flashStatusDot() }
      .onChange(of: controller.blockedInputPulse) { (_, _: Int) in showReconnectingCaption = true }
      .task(id: showReconnectingCaption) { await hideReconnectingCaptionSoon() }
  }

  private var chromeDecorated: some View {
    terminalStack
      .background(Color.black.ignoresSafeArea())
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if controller.hasExited {
          resumeBar
        } else if keyboardVisible {
          keyBarStack
        }
      }
      .ignoresSafeArea(.container, edges: bottomIgnoredEdges)
      .navigationTitle("")
      .toolbar(.hidden, for: .navigationBar)
      .toolbar(.hidden, for: .tabBar)
      .adeRootTabBarHidden()
  }

  private var terminalStack: some View {
    VStack(spacing: 0) {
      topBar
      SwiftTermSessionView(controller: controller)
        .overlay(alignment: .top) {
          if controller.isLoadingHistory {
            TerminalHistoryShimmer()
          }
        }
        .overlay(alignment: .bottomTrailing) {
          if !controller.isPinnedToBottom {
            livePill
              .padding(.trailing, 14)
              .padding(.bottom, 14)
          }
        }
    }
  }

  private func handleAppear() {
    controller.activate(syncService: syncService, sessionId: session.id, sessionStatus: session.status)
    pasteboardHasStrings = controller.pasteboardHasStrings
  }

  private func handleConnectionState(_ state: RemoteConnectionState) {
    controller.handleConnectionChange(isConnected: state == .connected || state == .syncing)
  }

  private func handleKeyboardWillShow() {
    keyboardVisible = true
    pasteboardHasStrings = controller.pasteboardHasStrings
  }

  private func refreshPasteboardState() {
    pasteboardHasStrings = controller.pasteboardHasStrings
  }

  private func hideReconnectingCaptionSoon() async {
    guard showReconnectingCaption else { return }
    try? await Task.sleep(nanoseconds: 1_600_000_000)
    guard !Task.isCancelled else { return }
    showReconnectingCaption = false
  }

  private func flashStatusDot() {
    statusDotFlash = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 140_000_000)
      withAnimation(.easeOut(duration: 0.4)) {
        statusDotFlash = false
      }
    }
  }

  // MARK: - Top bar

  private var topBar: some View {
    HStack(spacing: 10) {
      Button {
        dismiss()
      } label: {
        Image(systemName: "chevron.left")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(width: 36, height: 36)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Back")

      Circle()
        .fill(statusColor)
        .frame(width: 7, height: 7)
        .scaleEffect(statusDotFlash ? 1.6 : 1)

      Text(titleText)
        .font(.system(size: 13, weight: .semibold, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .truncationMode(.middle)

      Spacer(minLength: 0)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background {
      ADEColor.pageBackground
        .opacity(0.98)
        .ignoresSafeArea(edges: .top)
    }
  }

  private var titleText: String {
    "\(runtimeLabel) · \(session.laneName)"
  }

  private var runtimeLabel: String {
    let raw = session.toolType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    return raw.isEmpty ? "shell" : raw
  }

  private var statusColor: Color {
    if controller.hasExited {
      return ADEColor.textMuted
    }
    switch syncService.connectionState {
    case .connected, .syncing:
      return controller.isSubscribed ? ADEColor.success : ADEColor.warning
    case .connecting:
      return ADEColor.warning
    case .disconnected, .error:
      return ADEColor.textMuted
    }
  }

  // MARK: - Live pill

  private var livePill: some View {
    Button {
      controller.scrollToLive()
    } label: {
      HStack(spacing: 5) {
        Image(systemName: "arrow.down")
          .font(.system(size: 10, weight: .bold))
        Text(controller.liveChunksWhileScrolledUp > 0 ? "Live \(controller.liveChunksWhileScrolledUp)" : "Live")
          .font(.system(size: 12, weight: .semibold, design: .monospaced))
      }
      .foregroundStyle(ADEColor.textPrimary)
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .background(.ultraThinMaterial, in: Capsule())
      .overlay(Capsule().stroke(ADEColor.glassBorder, lineWidth: 0.6))
    }
    .buttonStyle(.plain)
  }

  // MARK: - Resume bar

  /// Whether the host can relaunch this session's runtime: agent CLI sessions
  /// carry resume metadata; plain shells do not.
  private var sessionIsResumable: Bool {
    terminalSessionHasResumeTarget(session)
  }

  private var resumeBar: some View {
    VStack(spacing: 6) {
      if let resumeError = controller.resumeError {
        Text(resumeError)
          .font(.caption2.weight(.medium))
          .foregroundStyle(ADEColor.warning)
          .lineLimit(2)
          .padding(.horizontal, 12)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      HStack(spacing: 10) {
        Text("Session ended")
          .font(.system(size: 13, weight: .medium, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
        Spacer(minLength: 0)
        if sessionIsResumable {
          Button {
            controller.resume()
          } label: {
            HStack(spacing: 6) {
              if controller.isResuming {
                ProgressView()
                  .controlSize(.small)
                  .tint(.white)
              } else {
                Image(systemName: "arrow.counterclockwise")
                  .font(.system(size: 11, weight: .bold))
              }
              Text(controller.isResuming ? "Resuming…" : "Resume")
                .font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(ADEColor.accent, in: Capsule())
          }
          .buttonStyle(.plain)
          .disabled(controller.isResuming)
        }
      }
      .padding(.horizontal, 12)
    }
    .padding(.top, 8)
    .padding(.bottom, 8)
    .background(ADEColor.recessedBackground.opacity(0.92))
    .overlay(alignment: .top) {
      Rectangle().fill(ADEColor.glassBorder).frame(height: 0.5)
    }
  }

  // MARK: - Key bar

  private var keyBarStack: some View {
    VStack(spacing: 6) {
      if showReconnectingCaption || pasteboardHasStrings {
        HStack {
          if showReconnectingCaption {
            Text(controller.inputStatusMessage ?? "Reconnecting")
              .font(.caption2.weight(.medium))
              .foregroundStyle(ADEColor.warning)
          }
          Spacer(minLength: 0)
          if pasteboardHasStrings {
            pasteChip
          }
        }
        .padding(.horizontal, 12)
      }
      keyBar
        .modifier(ADEShakeEffect(animatableData: CGFloat(controller.blockedInputPulse)))
        .animation(.linear(duration: 0.3), value: controller.blockedInputPulse)
    }
    .padding(.top, 6)
    .padding(.bottom, 6)
    .background(ADEColor.recessedBackground.opacity(0.92))
    .overlay(alignment: .top) {
      Rectangle().fill(ADEColor.glassBorder).frame(height: 0.5)
    }
  }

  private var pasteChip: some View {
    Button {
      controller.pasteFromClipboard()
    } label: {
      HStack(spacing: 5) {
        Image(systemName: "doc.on.clipboard")
          .font(.system(size: 10, weight: .semibold))
        Text("Paste")
          .font(.system(size: 12, weight: .semibold))
      }
      .foregroundStyle(ADEColor.accent)
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .background(ADEColor.accent.opacity(0.12), in: Capsule())
    }
    .buttonStyle(.plain)
  }

  private var keyBar: some View {
    HStack(spacing: 4) {
      keyButton("esc", sends: "\u{1B}")
      keyButton("⇥", sends: "\t")
      // Back-tab (ESC[Z) — cycles permission modes in Claude Code.
      keyButton("⇧⇥", sends: "\u{1B}[Z")
      ctrlButton
      keyButton("↑", sends: "\u{1B}[A")
      keyButton("↓", sends: "\u{1B}[B")
      keyButton("←", sends: "\u{1B}[D")
      keyButton("→", sends: "\u{1B}[C")
      keyButton("⏎", sends: "\r")
      // Backslash + return: newline in agent TUIs (Claude Code treats `\`
      // + Enter as soft return) and line continuation in shells.
      keyButton("⇧⏎", sends: "\\\r")
      overflowMenu
      dismissKeyboardButton
    }
    .padding(.horizontal, 6)
    .disabled(controller.hasExited)
    .opacity(controller.hasExited ? 0.4 : 1)
  }

  private func keyButton(_ label: String, sends data: String) -> some View {
    Button {
      controller.sendKeySequence(data)
    } label: {
      Text(label)
        .font(.system(size: label.count > 1 && label != "esc" ? 11 : 13, weight: .semibold, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, minHeight: 32)
        .background(ADEColor.textPrimary.opacity(0.06), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .stroke(ADEColor.border.opacity(0.28), lineWidth: 0.6)
        )
    }
    .buttonStyle(.plain)
  }

  private var dismissKeyboardButton: some View {
    Button {
      controller.dismissKeyboard()
    } label: {
      Image(systemName: "keyboard.chevron.compact.down")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, minHeight: 32)
        .background(ADEColor.textPrimary.opacity(0.06), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .stroke(ADEColor.border.opacity(0.28), lineWidth: 0.6)
        )
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Hide keyboard")
  }

  private var ctrlButton: some View {
    Button {
      controller.toggleCtrl()
    } label: {
      Text("⌃")
        .font(.system(size: 14, weight: .bold, design: .monospaced))
        .foregroundStyle(controller.ctrlArmed ? Color.white : ADEColor.textPrimary)
        .frame(maxWidth: .infinity, minHeight: 32)
        .background(
          controller.ctrlArmed ? AnyShapeStyle(ADEColor.accent) : AnyShapeStyle(ADEColor.textPrimary.opacity(0.06)),
          in: RoundedRectangle(cornerRadius: 7, style: .continuous)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .stroke(controller.ctrlArmed ? ADEColor.accent : ADEColor.border.opacity(0.28), lineWidth: 0.6)
        )
    }
    .buttonStyle(.plain)
    .accessibilityLabel(controller.ctrlArmed ? "Control armed" : "Control")
  }

  private var overflowMenu: some View {
    Menu {
      overflowKey("^C", sends: "\u{03}")
      overflowKey("^D", sends: "\u{04}")
      overflowKey("^Z", sends: "\u{1A}")
      overflowKey("^L", sends: "\u{0C}")
      overflowKey("^R", sends: "\u{12}")
      overflowKey("^U", sends: "\u{15}")
      overflowKey("^A", sends: "\u{01}")
      overflowKey("^E", sends: "\u{05}")
      overflowKey("^K", sends: "\u{0B}")
      Divider()
      overflowKey("|", sends: "|")
      overflowKey("~", sends: "~")
      overflowKey("/", sends: "/")
      overflowKey("-", sends: "-")
    } label: {
      Text("⋯")
        .font(.system(size: 14, weight: .bold, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(maxWidth: .infinity, minHeight: 32)
        .background(ADEColor.textPrimary.opacity(0.06), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .stroke(ADEColor.border.opacity(0.28), lineWidth: 0.6)
        )
    }
    .buttonStyle(.plain)
  }

  private func overflowKey(_ label: String, sends data: String) -> some View {
    Button(label) {
      controller.sendKeySequence(data)
    }
  }
}

/// Horizontal shake for the key bar when typed input has nowhere to go.
private struct ADEShakeEffect: GeometryEffect {
  var animatableData: CGFloat

  func effectValue(size: CGSize) -> ProjectionTransform {
    ProjectionTransform(CGAffineTransform(translationX: 7 * sin(animatableData * .pi * 3), y: 0))
  }
}

/// Thin animated bar shown while older scrollback pages in.
private struct TerminalHistoryShimmer: View {
  @State private var phase: CGFloat = -1

  var body: some View {
    GeometryReader { proxy in
      Rectangle()
        .fill(
          LinearGradient(
            colors: [.clear, ADEColor.accent.opacity(0.85), .clear],
            startPoint: .leading,
            endPoint: .trailing
          )
        )
        .frame(width: proxy.size.width * 0.45)
        .offset(x: phase * proxy.size.width)
    }
    .frame(height: 2.5)
    .clipped()
    .onAppear {
      phase = -0.45
      withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
        phase = 1
      }
    }
  }
}
