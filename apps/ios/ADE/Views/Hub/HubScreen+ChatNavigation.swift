import SwiftUI

// Opening a chat FROM THE HUB. The chat is presented as a full-screen cover over
// the hub so Back returns to the all-projects list (the second entry point —
// inside a project — pushes the same `WorkSessionDestinationView` onto the Work
// tab's stack instead, where Back returns to Work). Chat rows render immediately
// from the roster stub when the owner is active or the host supports
// cross-project subscribe; older hosts wait on activation. The owning project
// activates in the background so Send/approve are ready. Backing out cancels an
// uncommitted switch so the next tap can start a different one.

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

/// How long a CLI hub row waits for in-place project activation before Retry.
/// Chat rows do not wait on this — they paint immediately from the roster stub.
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

/// A non-active owner still needs a background activate so Send/approve land
/// on the right project. Chat rows no longer wait for that activate to paint.
func hubChatRequiresProjectActivation(isActiveProject: Bool) -> Bool {
  !isActiveProject
}

func hubChatShouldAbandonActivationOnDismiss(
  isSwitchingTargetProject: Bool,
  targetAlreadyActive: Bool
) -> Bool {
  isSwitchingTargetProject && !targetAlreadyActive
}

func hubChatCrossProjectContext(
  project: MobileProjectSummary,
  isActiveProject: Bool
) -> WorkChatCrossProjectContext? {
  guard !isActiveProject else { return nil }
  return WorkChatCrossProjectContext(
    projectId: project.id,
    projectRootPath: project.rootPath,
    displayName: project.displayName
  )
}

func hubChatIsForeignProject(
  context: WorkChatCrossProjectContext?,
  ownerIsActive: Bool
) -> Bool {
  context != nil && !ownerIsActive
}

/// Instant Hub chat paint is only safe when the owner is already active, or
/// the host can route `chat_subscribe` to a foreign project. Older hosts drop
/// the scope and bind the stream to the *current* project, so those chats
/// wait on activation the way CLI rows always do.
func hubChatCanPaintFromRosterStub(
  hasChatStub: Bool,
  ownerIsActive: Bool,
  supportsCrossProjectChat: Bool
) -> Bool {
  hasChatStub && (ownerIsActive || supportsCrossProjectChat)
}

/// CLI rows have no stub. If activation is not required they must still leave
/// `.deciding` so the destination hydrates instead of spinning forever.
func hubChatLeavesDecidingWithoutActivationWait(
  canPaintFromStub: Bool,
  requiresActivation: Bool
) -> Bool {
  canPaintFromStub || !requiresActivation
}

/// Watchdog Retry must not apply the first `openProjectForHubChat` wait after a
/// newer attempt has started.
func hubChatActivationAttemptIsCurrent(started: UInt64, current: UInt64) -> Bool {
  started == current
}

/// Rebind after Hub activate must stop once the destination is gone, otherwise
/// a late `retainChatEventSubscription` undoes leave.
func hubChatShouldContinueActivationRebind(
  destinationVisible: Bool,
  taskCancelled: Bool
) -> Bool {
  destinationVisible && !taskCancelled
}

/// After Hub activate commits, `isCrossProject` falls and the destination
/// rebinds onto the active project. If that switch then rolls the previous
/// project back, `isCrossProject` rises again. Callers must install foreign
/// command scope *synchronously* on `.restoreForeign` before any `await`, or a
/// same-turn send routes to the restored active project.
enum HubChatActivationScopeTransition: Equatable {
  case rebindToActive
  case restoreForeign
  case none
}

func hubChatActivationScopeTransition(
  wasForeign: Bool,
  isForeign: Bool
) -> HubChatActivationScopeTransition {
  if wasForeign && !isForeign { return .rebindToActive }
  if !wasForeign && isForeign { return .restoreForeign }
  return .none
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
  guard chat.isChatTool, !chat.isIdentityChat else { return nil }
  return chat.asTerminalSessionSummary(laneName: lane?.name ?? chat.laneId)
}

private struct HubChatCover: View {
  let target: HubChatTarget
  let syncService: SyncService
  let onClose: () -> Void
  @State private var mode: HubChatOpenMode
  /// Bounds the CLI activation wait. Cancelled as soon as activation resolves,
  /// on Retry, and when the cover goes away.
  @State private var activationWatchdog: Task<Void, Never>?
  @State private var abandoned = false
  @State private var activationGeneration: UInt64 = 0

  init(target: HubChatTarget, syncService: SyncService, onClose: @escaping () -> Void) {
    self.target = target
    self.syncService = syncService
    self.onClose = onClose
    let stub = makeRosterSessionStub(chat: target.chat, lane: target.lane)
    let ownerIsActive = syncService.isActiveProject(target.project)
    let canPaint = hubChatCanPaintFromRosterStub(
      hasChatStub: stub != nil,
      ownerIsActive: ownerIsActive,
      supportsCrossProjectChat: syncService.supportsCrossProjectChat
    )
    let requiresActivation = hubChatRequiresProjectActivation(isActiveProject: ownerIsActive)
    _mode = State(
      initialValue: hubChatLeavesDecidingWithoutActivationWait(
        canPaintFromStub: canPaint,
        requiresActivation: requiresActivation
      ) ? .activated(stub) : .deciding
    )
  }

  var body: some View {
    NavigationStack {
      Group {
        switch mode {
        case .deciding:
          HubChatOpeningPlaceholder(projectName: target.project.displayName, onClose: onClose)
        case .activated(let sessionStub):
          // A chat still being launched into a new lane shows its setup
          // first, then hands over to the chat for the same session id.
          WorkChatLaunchGate(sessionId: target.chat.id) {
          WorkSessionDestinationView(
            sessionId: target.chat.id,
            initialOpeningPrompt: nil,
            // A chat roster row is authoritative enough to render and
            // subscribe before CRR catches up. CLI rows intentionally pass nil
            // here so the destination hydrates their real PTY-backed row.
            initialSession: sessionStub,
            initialChatSummary: nil,
            transitionNamespace: nil,
            isLive: true,
            navigationChrome: .pushedDetail,
            lanes: target.lane.map { [$0.asLaneSummary()] } ?? [],
            crossProjectContext: hubChatCrossProjectContext(
              project: target.project,
              isActiveProject: syncService.isActiveProject(target.project)
            )
          )
          }
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
      abandoned = true
      activationGeneration &+= 1
      activationWatchdog?.cancel()
      activationWatchdog = nil
      syncService.abandonInFlightHubProjectActivation(for: target.project)
    }
  }

  private func decideAndOpen() async {
    let generation = beginActivationAttempt()
    let sessionStub = makeRosterSessionStub(chat: target.chat, lane: target.lane)
    let ownerIsActive = syncService.isActiveProject(target.project)
    let canPaint = hubChatCanPaintFromRosterStub(
      hasChatStub: sessionStub != nil,
      ownerIsActive: ownerIsActive,
      supportsCrossProjectChat: syncService.supportsCrossProjectChat
    )
    let requiresActivation = hubChatRequiresProjectActivation(isActiveProject: ownerIsActive)
    if hubChatLeavesDecidingWithoutActivationWait(
      canPaintFromStub: canPaint,
      requiresActivation: requiresActivation
    ), mode == .deciding {
      mode = .activated(sessionStub)
    }
    guard requiresActivation else { return }

    // Painted chats (active owner, or foreign with host scope) keep streaming
    // while activate runs. CLI rows and older-host foreign chats wait.
    if !canPaint {
      startActivationWatchdog(generation: generation)
    }
    guard !abandoned, !Task.isCancelled,
          hubChatActivationAttemptIsCurrent(started: generation, current: activationGeneration)
    else { return }
    await syncService.openProjectForHubChat(target.project)
    activationWatchdog?.cancel()
    activationWatchdog = nil
    guard !abandoned,
          hubChatActivationAttemptIsCurrent(started: generation, current: activationGeneration)
    else { return }
    // A failed background switch must not tear down an already-painted chat.
    // Waiting covers (CLI, or foreign without host scope) still take Retry.
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

  /// Fail the CLI cover if activation has not resolved within the timeout, so
  /// the spinner can never run forever. Sleeping in a task keeps the MainActor free.
  private func startActivationWatchdog(generation: UInt64) {
    activationWatchdog?.cancel()
    activationWatchdog = Task { @MainActor in
      try? await Task.sleep(for: .seconds(hubChatActivationTimeoutSeconds))
      guard !Task.isCancelled, !abandoned,
            hubChatActivationAttemptIsCurrent(started: generation, current: activationGeneration),
            mode == .deciding
      else { return }
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

  private func beginActivationAttempt() -> UInt64 {
    activationGeneration &+= 1
    return activationGeneration
  }

  private func retryOpen() async {
    abandoned = false
    activationWatchdog?.cancel()
    activationWatchdog = nil
    mode = .deciding
    await decideAndOpen()
  }
}

/// Chat-shaped opening chrome for CLI hub rows that still have to wait on
/// project activation. Replaces the old spinner-in-a-blank-box.
private struct HubChatOpeningPlaceholder: View {
  let projectName: String
  let onClose: () -> Void

  var body: some View {
    ZStack {
      ADEColor.pageBackground.ignoresSafeArea()
      VStack(alignment: .leading, spacing: 12) {
        Text("Opening \(projectName)")
          .font(.system(.subheadline, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        ADESkeletonView(height: 14, cornerRadius: 8)
        ADESkeletonView(width: 220, height: 14, cornerRadius: 8)
        ADESkeletonView(width: 160, height: 14, cornerRadius: 8)
      }
      .padding(.horizontal, 16)
      .padding(.top, 12)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("Opening \(projectName)")
      .accessibilityAddTraits(.updatesFrequently)
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
