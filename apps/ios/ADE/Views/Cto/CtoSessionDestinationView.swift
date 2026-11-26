import SwiftUI
import UIKit

/// Thin loader that ensures the CTO chat session exists on the host, then hands
/// the resulting summary straight to `WorkSessionDestinationView` so the CTO tab
/// reuses the Work chat pipeline verbatim.
struct CtoSessionDestinationView: View {
  enum LoadState {
    case loading
    case ready(AgentChatSessionSummary)
    case failed(String)
  }

  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }

  var navigationChrome: WorkSessionNavigationChrome = .pushedDetail
  /// A wide display: the thread with Work's chat chrome (title pill, rail,
  /// pane at the hinge), its settings in that pane.
  var duoPane: DuoWorkPaneModel? = nil
  var duoPaneOpen = false
  var title = "CTO"
  /// The CTO's live state: the header pill reads it, the thread writes it.
  var live: CtoLiveModel? = nil
  var store: CtoStore? = nil
  var duoSettings: (() -> AnyView)? = nil

  @State private var state: LoadState = .loading
  /// The CTO's account copy, read once while its home can't answer.
  @StateObject private var accountCopy = CtoAccountCopyModel()
  @State private var ensureTask: Task<Void, Never>?
  @State private var ensured = false

  var body: some View {
    Group {
      if duoPane != nil, case .ready = state {
        // The thread builds its own stack (its toolbar is the rail).
        content
      } else if duoPane != nil {
        // Loading or failed on a wide display: still a stack, so the rail
        // keeps the way back to the Hub and the app tabs.
        NavigationStack {
          content
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
              DuoHubBackToolbarItem()
              DuoAppTabsToolbar()
            }
        }
      } else {
        content
      }
    }
      .adeScreenBackground()
      .adeNavigationGlass()
      .tint(live?.look.ctoAccent ?? ADEColor.ctoAccent)
      .environment(\.ctoLiveModel, live)
      .environment(\.ctoStore, store)
      .task {
        await MainActor.run { startEnsureSession(force: false) }
      }
      .onDisappear {
        ensureTask?.cancel()
        ensureTask = nil
      }
  }

  @ViewBuilder
  private var content: some View {
    switch state {
    case .loading:
      loadingView
    case .failed(let message):
      failureView(message: message)
    case .ready(let summary):
      WorkSessionDestinationView(
        sessionId: summary.sessionId,
        initialOpeningPrompt: nil,
        initialSession: makeCtoSession(from: summary),
        initialChatSummary: summary,
        transitionNamespace: nil,
        isLive: isLive,
        navigationChrome: navigationChrome,
        showsLaneActions: false,
        navigationTitleOverride: navigationTitle,
        compactComposer: true,
        // The CTO never queues: new input redirects the running turn. The host
        // enforces this (steer queue cap of zero on the identity session); this
        // keeps the composer menu from offering a wait it would not honor.
        liveRedirectOnlySends: true,
        duoPane: duoPane,
        duoPaneOpen: duoPaneOpen,
        duoCtoSettings: duoSettings
      )
      .environmentObject(syncService)
    }
  }

  private var loadingView: some View {
    CtoStateCard(look: live?.look, name: title, state: .thinking, line: "Waking up…")
      .ctoSessionNavigationChrome(mode: navigationChrome, title: navigationTitle)
  }

  @ViewBuilder
  private func failureView(message: String) -> some View {
    // Offline is the asleep avatar, not a red card.
    if syncService.connectionState.isHostUnreachable || syncService.ctoHomeIsOffline {
      let copy = ctoHomeOfflineCopy(sync: syncService)
      CtoStateCard(
        look: live?.look,
        name: title,
        state: .asleep,
        line: copy.line,
        message: copy.message,
        actionTitle: "Reconnect",
        action: {
          Task {
            await syncService.reconnectCtoHome()
            await startEnsureSession(force: true)
          }
        }
      )
      .safeAreaInset(edge: .bottom, spacing: 0) {
        CtoAccountCopyEntry(name: title, model: accountCopy)
      }
      .ctoSessionNavigationChrome(mode: navigationChrome, title: navigationTitle)
    } else {
      CtoStateCard(
        look: live?.look,
        name: title,
        state: .error,
        line: "Couldn't open the chat",
        detail: message,
        actionTitle: "Try again",
        action: { Task { @MainActor in startEnsureSession(force: true) } }
      )
      .ctoSessionNavigationChrome(mode: navigationChrome, title: navigationTitle)
    }
  }

  private var navigationTitle: String { title }

  private var isLive: Bool {
    let workStatus = syncService.status(for: .work)
    return workStatus.phase == .ready
      && syncService.connectionState == .connected
  }

  /// Cancels any in-flight ensure and starts a fresh one. Without this guard,
  /// rapid retry taps or a `.task` re-entry could run two concurrent ensure
  /// calls and race to overwrite `state`.
  @MainActor
  private func startEnsureSession(force: Bool) {
    if !force, ensured { return }
    ensureTask?.cancel()
    let task = Task { @MainActor in
      state = .loading
      do {
        let summary = try await syncService.ensureCtoSession()
        guard !Task.isCancelled else { return }
        state = .ready(summary)
        ensured = true
        live?.sessionId = summary.sessionId
        store?.bind(sessionId: summary.sessionId, homeMachineKey: syncService.ctoHomeMachineKey)
        store?.ctoSession = summary
      } catch {
        guard !Task.isCancelled else { return }
        state = .failed(error.localizedDescription)
      }
    }
    ensureTask = task
  }

  /// Builds a lightweight `TerminalSessionSummary` from an `AgentChatSessionSummary`
  /// so the existing `WorkSessionDestinationView` can render the chat. Mirrors
  /// the shape used by `WorkRootScreen.makeOptimisticSession` — the Work layer
  /// later refreshes this via `syncService.fetchSessions()` once the session
  /// lands in the shared session list.
  private func makeCtoSession(from summary: AgentChatSessionSummary) -> TerminalSessionSummary {
    // Use a human-readable lane label for the shared Work header. CTO chats pass
    // `showsLaneActions: false`, because their synthetic lane ids are not real
    // Lanes tab destinations.
    TerminalSessionSummary(
      id: summary.sessionId,
      laneId: summary.laneId,
      laneName: "CTO",
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: summary.goal,
      toolType: toolTypeForProvider(summary.provider),
      title: summary.title ?? "CTO",
      status: summary.endedAt == nil ? "running" : "completed",
      startedAt: summary.startedAt,
      endedAt: summary.endedAt,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: summary.lastOutputPreview,
      summary: summary.summary,
      runtimeState: normalizedRuntimeState(for: summary),
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: summary.idleSinceAt
    )
  }
}

private extension View {
  @ViewBuilder
  func ctoSessionNavigationChrome(mode: WorkSessionNavigationChrome, title: String) -> some View {
    switch mode {
    case .pushedDetail:
      self
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .adeRootTabBarHidden()
    case .column:
      // A column chat keeps the root tabs and has no stack to push a title
      // onto; the Work header already names it.
      self
    case .embedded:
      self
    }
  }
}
