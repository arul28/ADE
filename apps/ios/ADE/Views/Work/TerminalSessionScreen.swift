import Combine
import SwiftUI
import UIKit

/// Full-bleed native terminal for a CLI session: SwiftTerm emulation, offset
/// streamed PTY output, tap-to-focus keyboard input, on-demand scrollback
/// paging, and phone-driven PTY resize.
struct TerminalSessionScreen: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  var syncService: SyncService { syncPublishes.service }
  @Environment(\.dismiss) private var dismiss

  let session: TerminalSessionSummary
  /// The top bar's leading control: Back (the pushed screen), or, as the
  /// Duo's detail column beside the sessions list, the way back to the list
  /// while it is away and nothing while it shows (a column has no stack to
  /// pop, so a Back there did nothing).
  var leading: TerminalLeadingControl = .back
  /// Set for another machine's session: it opens over that machine's light
  /// link, and every terminal action goes to that machine.
  var remoteTerminal: WorkRemoteTerminalContext? = nil

  @StateObject private var controller = TerminalSessionController()
  /// The session's machine, fixed when the screen opens. Nil for an older
  /// pairing with no machine identity.
  @State private var sessionMachineKey: String?
  /// Whether the connection the screen streams over still serves the
  /// session's machine. While false, the screen sends nothing.
  @State private var linkLive = true
  /// The remote terminal's controller is active on the machine's light link.
  @State private var remoteTerminalActivated = false
  @State private var keyboardVisible = false
  @State private var pasteboardHasStrings = false
  @State private var showReconnectingCaption = false
  @State private var statusDotFlash = false
  /// The message bar for an agent CLI: write a whole message and send it,
  /// instead of typing key by key. One choice for every CLI; off by default.
  @AppStorage("ade.work.cliMessageBar") private var messageBarOn = false
  @State private var messageDraft = ""
  @State private var messageSending = false
  @State private var messageNotice: String?
  @FocusState private var messageFocused: Bool

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
      .onDisappear {
        controller.deactivate()
        remoteTerminalActivated = false
      }
      .onChange(of: syncService.connectionState) { (_, _: RemoteConnectionState) in refreshLinkLive() }
      .onChange(of: syncService.focusedMachineKey) { (_, _: String?) in refreshLinkLive() }
      .onReceive(fleetPublisher) { _ in
        activateRemoteTerminalWhenLinked()
        refreshLinkLive()
      }
      .onChange(of: linkLive) { (_, live: Bool) in
        controller.handleConnectionChange(isConnected: live)
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
        } else if messageBarOn && isAgentCli {
          messageBar
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
        .adeReplayMasked()
        // A little air between the text and the screen's (or the column's)
        // edge; the black runs on behind it.
        .padding(.horizontal, 6)
        .overlay {
          terminalLoadOverlay
        }
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

  @ViewBuilder
  private var terminalLoadOverlay: some View {
    if controller.hasExited {
      EmptyView()
    } else if controller.hasPainted, let subscribeError = controller.subscribeError {
      // A painted screen keeps its text; a bar says the stream stopped.
      HStack(spacing: 10) {
        Text(subscribeError)
          .font(.caption)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Spacer(minLength: 8)
        Button("Retry") {
          controller.retrySubscribe()
        }
        .buttonStyle(.borderedProminent)
        .tint(ADEColor.accent)
        .controlSize(.small)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 10)
      .background(Color.black.opacity(0.85))
      .frame(maxHeight: .infinity, alignment: .top)
    } else if controller.hasPainted {
      EmptyView()
    } else if let subscribeError = controller.subscribeError {
      VStack(spacing: 12) {
        Text("Couldn’t load this terminal")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(subscribeError)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .multilineTextAlignment(.center)
          .padding(.horizontal, 24)
        Button("Retry") {
          controller.retrySubscribe()
        }
        .buttonStyle(.borderedProminent)
        .tint(ADEColor.accent)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(Color.black.opacity(0.72))
    } else if !controller.isSubscribed {
      ProgressView()
        .controlSize(.regular)
        .tint(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.opacity(0.35))
    }
  }

  private func handleAppear() {
    activateTerminal()
    pasteboardHasStrings = controller.pasteboardHasStrings
    refreshLinkLive()
  }

  /// Activates the controller on the terminal's transport. A remote terminal
  /// waits for its machine's light link. It activates once, when the link exists.
  private func activateTerminal() {
    if let remoteTerminal {
      sessionMachineKey = remoteTerminal.machineKey
      guard !remoteTerminalActivated, let connection = remoteConnection else { return }
      connection.setTerminalScope(
        sessionId: session.id,
        projectId: remoteTerminal.projectId,
        rootPath: remoteTerminal.rootPath
      )
      controller.activate(transport: connection, sessionId: session.id, sessionStatus: session.status)
      remoteTerminalActivated = true
    } else {
      sessionMachineKey = syncService.focusedMachineKey
      controller.activate(transport: syncService, sessionId: session.id, sessionStatus: session.status)
    }
  }

  /// A fleet change can bring a remote terminal's light link. Activate then.
  private func activateRemoteTerminalWhenLinked() {
    guard remoteTerminal != nil else { return }
    activateTerminal()
  }

  /// The light link of the session's machine, when the session is on another one.
  private var remoteConnection: MachineConnection? {
    remoteTerminal.flatMap { syncService.machineFleet?.connection(for: $0.machineKey) }
  }

  /// Fires when a machine's light link or the focused connection changes.
  private var fleetPublisher: AnyPublisher<Void, Never> {
    guard let fleet = syncService.machineFleet else {
      return Empty<Void, Never>().eraseToAnyPublisher()
    }
    return fleet.$machines.map { _ in () }.eraseToAnyPublisher()
  }

  /// The screen's connection is live only while it still serves the
  /// session's machine. After a focus change the focused connection serves
  /// another machine, and the screen shows offline instead of sending there.
  private func refreshLinkLive() {
    let live: Bool
    if remoteTerminal != nil {
      live = remoteConnection?.canStreamTerminals ?? false
    } else if let sessionMachineKey {
      live = syncService.connectionState == .connected
        && syncService.focusedMachineKey == sessionMachineKey
        && syncService.focusedSocketMachineKey == sessionMachineKey
    } else {
      live = syncService.connectionState == .connected
    }
    if linkLive != live { linkLive = live }
  }

  /// The state of the connection this terminal streams over.
  private var terminalConnectionState: RemoteConnectionState {
    guard remoteTerminal != nil || sessionMachineKey != nil else { return syncService.connectionState }
    return linkLive ? .connected : .disconnected
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
      switch leading {
      case .back:
        leadingButton(symbol: "chevron.left", label: "Back") { dismiss() }
      case .showChats(let action):
        leadingButton(symbol: "sidebar.left", label: "Show chats", action: action)
          .accessibilityIdentifier("Duo.Work.SidebarToggle")
      case .none:
        // Keeps the title clear of the column's edge.
        Color.clear.frame(width: 2, height: 36)
      }

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

      if isAgentCli && !controller.hasExited {
        Button {
          messageBarOn.toggle()
          messageFocused = messageBarOn
        } label: {
          Image(systemName: messageBarOn ? "text.bubble.fill" : "text.bubble")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(messageBarOn ? ADEColor.accent : ADEColor.textPrimary)
            .frame(width: 36, height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(messageBarOn ? "Type in the terminal" : "Write a message")
        .accessibilityIdentifier("Work.Terminal.MessageBarToggle")
      }
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 4)
    .background {
      ADEColor.pageBackground
        .opacity(0.98)
        .ignoresSafeArea(edges: .top)
    }
  }

  private func leadingButton(symbol: String, label: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol)
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(width: 36, height: 36)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
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
    switch terminalConnectionState {
    case .connected:
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

  // MARK: - Message bar

  /// A tracked agent CLI (Claude Code, Codex, ...): its computer can tell when
  /// its prompt is free, so a whole message can be typed there for you.
  private var isAgentCli: Bool {
    let raw = session.toolType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    return session.tracked && !raw.isEmpty && raw != "shell" && !raw.hasSuffix("-chat") && !raw.hasSuffix("-orchestrated")
  }

  private var canSendMessage: Bool {
    !messageSending && !messageDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var messageBar: some View {
    VStack(spacing: 6) {
      if let messageNotice {
        Text(messageNotice)
          .font(.caption2.weight(.medium))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(2)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 14)
      }
      HStack(alignment: .bottom, spacing: 8) {
        TextField("Message \(runtimeLabel)…", text: $messageDraft, axis: .vertical)
          .lineLimit(1...5)
          .font(.system(size: 15))
          .foregroundStyle(ADEColor.textPrimary)
          .focused($messageFocused)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(ADEColor.textPrimary.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .stroke(ADEColor.border.opacity(0.28), lineWidth: 0.6)
          )
          .accessibilityIdentifier("Work.Terminal.MessageField")
        Button {
          Task { await sendMessage() }
        } label: {
          Group {
            if messageSending {
              ProgressView().controlSize(.small).tint(.white)
            } else {
              Image(systemName: "arrow.up").font(.system(size: 14, weight: .bold))
            }
          }
          .foregroundStyle(.white)
          .frame(width: 34, height: 34)
          .background(canSendMessage ? ADEColor.accent : ADEColor.textMuted.opacity(0.35), in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSendMessage)
        .accessibilityLabel("Send")
        .accessibilityIdentifier("Work.Terminal.MessageSend")
      }
      .padding(.horizontal, 10)
    }
    .padding(.top, 8)
    .padding(.bottom, 8)
    .background(ADEColor.recessedBackground.opacity(0.92))
    .overlay(alignment: .top) {
      Rectangle().fill(ADEColor.glassBorder).frame(height: 0.5)
    }
  }

  /// Sends the message to the session's own computer, which types it at the
  /// CLI's prompt only once that prompt is free.
  private func sendMessage() async {
    let text = messageDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty, !messageSending else { return }
    messageSending = true
    defer { messageSending = false }
    do {
      let outcome: WorkCliTypeOutcome
      if remoteTerminal != nil {
        guard let connection = remoteConnection, connection.isLive else {
          messageNotice = "That computer isn't connected. Your message stays here; send it once it reconnects."
          return
        }
        outcome = try await connection.typeIntoCli(sessionId: session.id, text: text)
      } else {
        // Connected to a different computer than this session's: a send would
        // reach the wrong one.
        if sessionMachineKey != nil, syncService.connectionState == .connected, !linkLive {
          messageNotice = "This session's computer isn't the one connected now. Switch back to it to send."
          return
        }
        outcome = try await syncService.typeIntoCli(sessionId: session.id, text: text)
      }
      switch outcome {
      case .delivered:
        messageDraft = ""
        messageNotice = nil
      case .heldUntilFree:
        messageDraft = ""
        messageNotice = "Queued. It's typed when \(runtimeLabel) finishes its turn."
      case .queuedOffline:
        messageDraft = ""
        messageNotice = "You're offline. It's sent when the computer reconnects."
      case .ended:
        messageNotice = "This CLI has ended. Resume it to continue."
      }
    } catch {
      messageNotice = error.localizedDescription
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

/// The terminal top bar's leading control.
enum TerminalLeadingControl {
  /// Pops the pushed screen.
  case back
  /// Brings the sessions list back beside the terminal.
  case showChats(() -> Void)
  /// Nothing: the list is already beside it.
  case none
}
