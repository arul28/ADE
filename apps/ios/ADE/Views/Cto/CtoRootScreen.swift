import SwiftUI
import UIKit

/// Top-level CTO tab screen. Hosts a persistent NavigationStack and segmented
/// picker (Team / Workflows / Settings). The stack drives
/// drill-down into per-worker chat (CtoSessionDestinationView) and per-worker
/// detail (CtoWorkerDetailScreen).
struct CtoRootScreen: View {
  @EnvironmentObject private var syncService: SyncService
  var isTabActive = true

  @State private var selectedTab: CtoTab = .chat
  @State private var path = NavigationPath()
  @State private var snapshot: CtoSnapshot?
  @State private var snapshotError: String?
  @State private var isLoadingSnapshot = false

  var body: some View {
    NavigationStack(path: $path) {
      VStack(spacing: 0) {
        if let snapshotError {
          ADENoticeCard(
            title: "CTO failed to load",
            message: snapshotError,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await loadSnapshot() } }
          )
          .padding(.horizontal, 12)
          .padding(.top, 8)
        }

        CtoTabShell(active: $selectedTab)

        tabBody
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
      .tint(ADEColor.ctoAccent)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("CTO")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ADERootToolbarLeadingItems()
      }
      .task(id: isTabActive) {
        guard isTabActive, snapshot == nil else { return }
        await loadSnapshot()
      }
      .task(id: ctoLiveReloadKey) {
        guard ctoLiveReloadKey != nil else { return }
        await loadSnapshot()
      }
      .navigationDestination(for: CtoSessionRoute.self) { route in
        switch route {
        case .cto:
          CtoSessionDestinationView(kind: .cto)
            .environmentObject(syncService)
        case .worker(let agentId, let displayName):
          CtoSessionDestinationView(kind: .worker(agentId: agentId, displayName: displayName))
            .environmentObject(syncService)
        case .workerDetail(let agentId, let displayName):
          CtoWorkerDetailScreen(agentId: agentId, displayName: displayName)
            .environmentObject(syncService)
        }
      }
    }
  }

  @ViewBuilder
  private var tabBody: some View {
    switch selectedTab {
    case .chat:
      CtoChatScreen(path: $path)
        .environmentObject(syncService)
    case .team:
      CtoTeamScreen(path: $path)
        .environmentObject(syncService)
    case .workflows:
      CtoWorkflowsScreen()
        .environmentObject(syncService)
    case .settings:
      CtoSettingsScreen()
        .environmentObject(syncService)
    }
  }

  @MainActor
  private func loadSnapshot() async {
    if isLoadingSnapshot { return }
    isLoadingSnapshot = true
    defer { isLoadingSnapshot = false }
    do {
      snapshot = try await syncService.fetchCtoState()
      snapshotError = nil
    } catch {
      snapshotError = error.localizedDescription
    }
  }

  private var ctoLiveReloadKey: String? {
    guard isTabActive else { return nil }
    switch syncService.connectionState {
    case .connected, .syncing:
      return "live-\(syncService.localStateRevision)"
    case .connecting, .disconnected, .error:
      return nil
    }
  }
}

/// Routes surfaced by the CTO NavigationStack. `.cto` and `.worker` drill into
/// the shared chat destination; `.workerDetail` drills into the worker
/// dashboard (status, runs, memory, revisions).
enum CtoSessionRoute: Hashable {
  case cto
  case worker(agentId: String, displayName: String)
  case workerDetail(agentId: String, displayName: String)
}
