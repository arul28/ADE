import SwiftUI
import UIKit

/// Thin loader that ensures a CTO or worker chat session exists on the host,
/// then hands the resulting summary straight to `WorkSessionDestinationView`
/// so the CTO tab reuses the Work chat pipeline verbatim.
struct CtoSessionDestinationView: View {
  enum Kind: Hashable {
    case cto
    case worker(agentId: String, displayName: String)
  }

  enum LoadState {
    case loading
    case ready(AgentChatSessionSummary)
    case failed(String)
  }

  @EnvironmentObject private var syncService: SyncService

  let kind: Kind
  var navigationChrome: WorkSessionNavigationChrome = .pushedDetail

  @State private var state: LoadState = .loading
  @State private var ensureTask: Task<Void, Never>?
  @State private var ensuredKind: Kind?

  var body: some View {
    content
      .adeScreenBackground()
      .adeNavigationGlass()
      .tint(ADEColor.ctoAccent)
      .task(id: kindKey) {
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
        initialTranscript: nil,
        transitionNamespace: nil,
        isLive: isLive,
        navigationChrome: navigationChrome,
        showsLaneActions: false,
        navigationTitleOverride: navigationTitle
      )
      .environmentObject(syncService)
    }
  }

  private var loadingView: some View {
    VStack(spacing: 16) {
      ProgressView()
        .controlSize(.large)
        .tint(ADEColor.ctoAccent)
      Text(loadingLabel)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .ctoSessionNavigationChrome(mode: navigationChrome, title: navigationTitle)
  }

  private func failureView(message: String) -> some View {
    VStack(spacing: 16) {
      ADENoticeCard(
        title: "Could not open CTO chat",
        message: message,
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: {
          Task { @MainActor in startEnsureSession(force: true) }
        }
      )
    }
    .padding(16)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .ctoSessionNavigationChrome(mode: navigationChrome, title: navigationTitle)
  }

  private var navigationTitle: String {
    switch kind {
    case .cto: return "CTO"
    case .worker(let agentId, let displayName):
      let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? agentId : trimmed
    }
  }

  private var loadingLabel: String {
    switch kind {
    case .cto: return "Waking the CTO chat…"
    case .worker: return "Opening worker chat…"
    }
  }

  private var isLive: Bool {
    let workStatus = syncService.status(for: .work)
    return workStatus.phase == .ready
      && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var kindKey: String {
    switch kind {
    case .cto: return "cto"
    case .worker(let agentId, _): return "worker:\(agentId)"
    }
  }

  /// Cancels any in-flight ensure and starts a fresh one. Without this guard,
  /// rapid retry taps or a `.task(id:)` re-entry could run two concurrent
  /// ensure calls and race to overwrite `state`.
  @MainActor
  private func startEnsureSession(force: Bool) {
    if !force, ensuredKind == kind { return }
    ensureTask?.cancel()
    let requestedKind = kind
    let task = Task { @MainActor in
      state = .loading
      do {
        let summary: AgentChatSessionSummary
        switch requestedKind {
        case .cto:
          summary = try await syncService.ensureCtoSession()
        case .worker(let agentId, _):
          summary = try await syncService.ensureCtoAgentSession(agentId: agentId)
        }
        guard !Task.isCancelled else { return }
        state = .ready(summary)
        ensuredKind = requestedKind
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
      laneName: ctoSessionLaneName(for: kind),
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: summary.goal,
      toolType: toolTypeForProvider(summary.provider),
      title: summary.title ?? ctoSessionFallbackTitle(for: kind),
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
    case .embedded:
      self
    }
  }
}

private func ctoSessionFallbackTitle(for kind: CtoSessionDestinationView.Kind) -> String {
  switch kind {
  case .cto: return "CTO"
  case .worker(let agentId, let displayName):
    let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? agentId : trimmed
  }
}

private func ctoSessionLaneName(for kind: CtoSessionDestinationView.Kind) -> String {
  switch kind {
  case .cto:
    return "CTO control room"
  case .worker(let agentId, let displayName):
    let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "Worker: \(agentId)" : "Worker: \(trimmed)"
  }
}
