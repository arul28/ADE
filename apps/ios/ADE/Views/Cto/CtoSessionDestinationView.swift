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

  @State private var state: LoadState = .loading
  @State private var ensureTask: Task<Void, Never>?

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
        isLive: true
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
    .navigationTitle(navigationTitle)
    .navigationBarTitleDisplayMode(.inline)
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
    .navigationTitle(navigationTitle)
    .navigationBarTitleDisplayMode(.inline)
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
    ensureTask?.cancel()
    let task = Task { @MainActor in
      if case .ready = state, !force { return }
      state = .loading
      do {
        let summary: AgentChatSessionSummary
        switch kind {
        case .cto:
          summary = try await syncService.ensureCtoSession()
        case .worker(let agentId, _):
          summary = try await syncService.ensureCtoAgentSession(agentId: agentId)
        }
        guard !Task.isCancelled else { return }
        state = .ready(summary)
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
    // NOTE: We pass a human-readable `laneName` so the Work overflow menu shows
    // "Lane: CTO control room" / "Lane: Worker: Build Bot" rather than the raw
    // lane id (e.g. "cto:root"). The "Go to lane" entry in that menu still
    // points at `summary.laneId`, which is not a real lane — tapping it lands
    // on the Lanes tab and shows a "not cached" error. Benign dead-end UX;
    // fixing it cleanly needs a flag on WorkSessionDestinationView which is
    // out of scope for this pass. TODO: thread an `isCtoSession` flag through
    // and hide the menu item for CTO chats.
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
