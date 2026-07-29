import SwiftUI

// Opening a chat FROM THE HUB. The chat is presented as a full-screen cover over
// the hub so Back returns to the all-projects list (the second entry point —
// inside a project — pushes the same `WorkSessionDestinationView` onto the Work
// tab's stack instead, where Back returns to Work). Before the chat renders we
// activate its project (without leaving the hub) so the transcript can stream.

extension View {
  func hubChatCover(target: Binding<HubChatTarget?>) -> some View {
    modifier(HubChatCoverModifier(target: target))
  }
}

private struct HubChatCoverModifier: ViewModifier {
  @Binding var target: HubChatTarget?
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var dictationController: DictationController

  func body(content: Content) -> some View {
    content.fullScreenCover(item: $target) { target in
      HubChatCover(target: target, syncService: syncService) { self.target = nil }
        .environmentObject(syncService)
        .environmentObject(dictationController)
    }
  }
}

/// Identifies the foreign project a hub chat streams from in cross-project
/// "quick look" mode. Passed to `WorkSessionDestinationView.crossProjectContext`.
struct WorkChatCrossProjectContext: Equatable {
  let projectId: String
  let projectRootPath: String?
  let displayName: String
}

/// How the hub decided to open a chat: still switching/hydrating its project,
/// activated and ready to open, or failed with a Retry affordance.
private enum HubChatOpenMode: Equatable {
  case deciding
  case activated(TerminalSessionSummary?)
  case failed(String)
}

/// The result of activating a project for a hub chat: either the chat can
/// render, or it cannot and the user needs a message plus Retry.
enum HubChatActivationOutcome: Equatable {
  case activated
  case failed(String)
}

/// How long the cover waits for an in-place project activation before giving up
/// and offering Retry.
///
/// `SyncService.openProjectForHubChat` already bounds its own internal wait for
/// fresh work hydration at 6s, but that wait only begins *after* the
/// `project_switch_request` round trip — whose own request timeout is 30s
/// (`SyncRequestTimeout.defaultTimeoutNanoseconds`) — tears the socket down and
/// kicks off a reconnect in a detached task. A healthy switch therefore lands in
/// a few seconds (round trip + reconnect + at most 6s of hydration), while a
/// machine that has gone away keeps the caller parked for 30s or more. 15s
/// clears the healthy path with room to spare and halves the dead-machine wait,
/// so the user gets an error with Retry instead of a spinner that never ends.
private let hubChatActivationTimeoutSeconds: TimeInterval = 15

/// Decide what a hub chat activation attempt produced. Pure so the failure
/// matrix is testable without a live `SyncService`.
///
/// A timeout wins over `isActiveProject` on purpose: `switchToDesktopProject`
/// flips `activeProjectId` immediately and only then tears down the socket and
/// reconnects, so the project can read as active while nothing is connected or
/// hydrated. If the wait ran out, that "active" project is not usable yet, and
/// `lastError` is likely unset (nothing failed — the machine just went quiet),
/// so the timeout copy is more accurate than either.
func hubChatActivationOutcome(
  projectName: String,
  isActiveProject: Bool,
  lastError: String?,
  timedOut: Bool
) -> HubChatActivationOutcome {
  if timedOut {
    return .failed("The machine took too long to open \(projectName). It may be offline or still reconnecting.")
  }
  if isActiveProject {
    return .activated
  }
  let trimmedError = lastError?.trimmingCharacters(in: .whitespacesAndNewlines)
  if let trimmedError, !trimmedError.isEmpty {
    return .failed(trimmedError)
  }
  return .failed("The machine could not switch to \(projectName). Check that it is online, then try again.")
}

/// Hub chat taps are project navigation. A non-active owner always activates
/// before the destination renders, even when the host could serve a
/// cross-project transcript quick look.
func hubChatRequiresProjectActivation(isActiveProject: Bool) -> Bool {
  !isActiveProject
}

/// Synthesize a `TerminalSessionSummary` from the Hub roster so a destination
/// can render immediately. A foreign session never enters the phone's active
/// project DB; a same-project session may simply be ahead of CRDT replication.
/// In both cases the live stream and eventual row remain authoritative.
func makeRosterSessionStub(chat: RemoteRosterChat, lane: RemoteRosterLane?) -> TerminalSessionSummary? {
  // The roster carries enough metadata to open a chat transcript, but not a
  // terminal: CLI rows omit the PTY id, transcript offsets, and tracked state
  // required by TerminalSessionScreen. Let CLI activation hydrate its real
  // project row instead of manufacturing a terminal that cannot subscribe.
  guard chat.isChatTool else { return nil }
  return chat.asTerminalSessionSummary(laneName: lane?.name ?? chat.laneId)
}

private struct HubChatCover: View {
  let target: HubChatTarget
  let syncService: SyncService
  let onClose: () -> Void
  @State private var mode: HubChatOpenMode = .deciding
  /// Bounds the activation wait. Cancelled as soon as activation resolves, on
  /// Retry, and when the cover goes away.
  @State private var activationWatchdog: Task<Void, Never>?

  var body: some View {
    NavigationStack {
      Group {
        switch mode {
        case .deciding:
          HubChatActivatingView(projectName: target.project.displayName, onClose: onClose)
        case .activated(let sessionStub):
          WorkSessionDestinationView(
            sessionId: target.chat.id,
            initialOpeningPrompt: nil,
            // A chat roster row is authoritative enough to render and
            // subscribe before CRR catches up. CLI rows intentionally pass nil
            // here so the destination hydrates their real PTY-backed row.
            initialSession: sessionStub,
            initialChatSummary: nil,
            initialTranscript: nil,
            transitionNamespace: nil,
            isLive: true,
            navigationChrome: .pushedDetail,
            forceFreshTranscriptOnOpen: true,
            lanes: target.lane.map { [$0.asLaneSummary()] } ?? []
          )
          .id(target.id)
        case .failed(let message):
          HubChatActivationFailedView(
            projectName: target.project.displayName,
            message: message,
            onRetry: { Task { await retryOpen() } },
            onClose: onClose
          )
        }
      }
    }
    .task { await decideAndOpen() }
    .onDisappear {
      activationWatchdog?.cancel()
      activationWatchdog = nil
    }
  }

  private func decideAndOpen() async {
    let sessionStub = makeRosterSessionStub(chat: target.chat, lane: target.lane)
    // Already the active project → the full-detail path (existing infra).
    if !hubChatRequiresProjectActivation(
      isActiveProject: syncService.isActiveProject(target.project)
    ) {
      mode = .activated(sessionStub)
      return
    }
    // A Hub row is navigation, not a quick-look read: activate the owning
    // project first (keeping the Hub mounted under this cover), show the
    // switch/hydration state, then open the requested chat. This guarantees a
    // non-active project's row is never a silent no-op and leaves the phone in
    // the project the user explicitly chose.
    startActivationWatchdog()
    await syncService.openProjectForHubChat(target.project)
    activationWatchdog?.cancel()
    activationWatchdog = nil
    // The watchdog may have already given up and moved us to `.failed` while
    // this call was still parked; leave its verdict (and the user's Retry
    // button) alone rather than resolving a wait nobody is watching anymore.
    guard mode == .deciding else { return }
    let outcome = hubChatActivationOutcome(
      projectName: target.project.displayName,
      isActiveProject: syncService.isActiveProject(target.project),
      lastError: syncService.lastError,
      timedOut: false
    )
    switch outcome {
    case .activated:
      mode = .activated(sessionStub)
    case .failed(let message):
      mode = .failed(message)
    }
  }

  /// Fail the cover if activation has not resolved within the timeout, so the
  /// spinner can never run forever. Sleeping in a task keeps the MainActor free.
  private func startActivationWatchdog() {
    activationWatchdog?.cancel()
    activationWatchdog = Task { @MainActor in
      try? await Task.sleep(for: .seconds(hubChatActivationTimeoutSeconds))
      guard !Task.isCancelled, mode == .deciding else { return }
      let outcome = hubChatActivationOutcome(
        projectName: target.project.displayName,
        isActiveProject: syncService.isActiveProject(target.project),
        lastError: syncService.lastError,
        timedOut: true
      )
      if case .failed(let message) = outcome {
        mode = .failed(message)
      }
    }
  }

  private func retryOpen() async {
    activationWatchdog?.cancel()
    activationWatchdog = nil
    mode = .deciding
    await decideAndOpen()
  }
}

private struct HubChatActivatingView: View {
  let projectName: String
  let onClose: () -> Void

  var body: some View {
    ZStack {
      ADEColor.pageBackground.ignoresSafeArea()
      VStack(spacing: 14) {
        ProgressView().controlSize(.large)
        Text("Opening \(projectName)…")
          .font(.system(.subheadline, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      HubChatBackBar(onClose: onClose)
    }
  }
}

/// Activation failed or timed out. Always offers Retry plus the Hub back
/// affordance so the cover is never a dead end.
private struct HubChatActivationFailedView: View {
  let projectName: String
  let message: String
  let onRetry: () -> Void
  let onClose: () -> Void

  var body: some View {
    ZStack {
      ADEColor.pageBackground.ignoresSafeArea()
      ADEEmptyStateView(
        symbol: "exclamationmark.triangle.fill",
        title: "Couldn't open \(projectName)",
        message: message
      ) {
        Button("Retry", action: onRetry)
          .buttonStyle(.glassProminent)
          .tint(ADEColor.accent)
      }
      .padding(.horizontal, 20)
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      HubChatBackBar(onClose: onClose)
    }
  }
}

/// The cover's own Back control. The chat is a full-screen cover over the hub,
/// so there is no navigation bar to inherit one from.
private struct HubChatBackBar: View {
  let onClose: () -> Void

  var body: some View {
    HStack {
      Button(action: onClose) {
        HStack(spacing: 4) {
          Image(systemName: "chevron.left").font(.system(size: 15, weight: .semibold))
          Text("Hub")
        }
        .foregroundStyle(ADEColor.accent)
      }
      .buttonStyle(.plain)
      Spacer()
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
  }
}
